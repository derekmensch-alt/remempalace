/**
 * Lifecycle tests for src/index.ts lazy-start behaviour.
 *
 * Validates that:
 *   - mcp.start() is NOT called during plugin registration
 *   - mcp.start() IS called on the first session_start / before_prompt_build event
 *   - Concurrent first-events coalesce to a single mcp.start() call
 *   - heartbeat.start() is deferred until after MCP probe succeeds
 *   - Diary replay fires only when hasDiaryWrite is true and replayOnStart is true
 *   - A failed mcp.start() resets the cached promise so the next event retries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpClient } from "../src/mcp-client.js";
import { HeartbeatWarmer } from "../src/heartbeat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface FakeApi {
  on: ReturnType<typeof vi.fn>;
  registerMemoryCapability: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  /** Trigger a registered event by name. */
  emit: (name: string, event?: unknown, ctx?: unknown) => Promise<void>;
}

function makeFakeApi(): FakeApi {
  const handlers = new Map<string, EventHandler>();

  const api: FakeApi = {
    on: vi.fn((name: string, handler: EventHandler) => {
      handlers.set(name, handler);
    }),
    registerMemoryCapability: vi.fn(),
    registerCommand: vi.fn(),
    async emit(name, event = {}, ctx = {}) {
      const h = handlers.get(name);
      if (h) await h(event, ctx);
    },
  };
  return api;
}

interface MockMcpClient {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  probeCapabilities: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
  hasDiaryWrite: boolean;
  hasDiaryRead: boolean;
  hasKgInvalidate: boolean;
}

function makeMockMcpClient(): MockMcpClient {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    probeCapabilities: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({}),
    call: vi.fn().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    isReady: vi.fn().mockReturnValue(true),
    hasDiaryWrite: false,
    hasDiaryRead: false,
    hasKgInvalidate: false,
  };
}

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// We mock McpClient.shared so register() never touches a real python process.
let mockMcp: MockMcpClient;
let heartbeatStartSpy: ReturnType<typeof vi.spyOn>;
let heartbeatStopSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockMcp = makeMockMcpClient();

  vi.spyOn(McpClient, "shared").mockReturnValue(mockMcp as unknown as McpClient);

  heartbeatStartSpy = vi.spyOn(HeartbeatWarmer.prototype, "start").mockImplementation(function () {
    /* noop */
  });
  heartbeatStopSpy = vi.spyOn(HeartbeatWarmer.prototype, "stop").mockImplementation(function () {
    /* noop */
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await McpClient.resetSharedForTests();
});

// ---------------------------------------------------------------------------
// Import plugin after mocks are in place (dynamic import per test is not
// needed because vi.spyOn patches the prototype/static before any call).
// ---------------------------------------------------------------------------

async function importPlugin() {
  // Re-import fresh copy via cache bust to avoid cross-test state.
  // Because vitest clears module cache between files (not between tests in the
  // same file), we use the stable import path and rely on the mock stubs set
  // up in beforeEach to intercept calls.
  const mod = await import("../src/index.js");
  return mod.default;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lazy-start: register() does not start MCP eagerly", () => {
  it("does not call mcp.start() during plugin registration", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);
    // Give microtasks a chance to flush
    await new Promise((r) => setImmediate(r));
    expect(mockMcp.start).not.toHaveBeenCalled();
  });

  it("does not call heartbeat.start() during plugin registration", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);
    await new Promise((r) => setImmediate(r));
    expect(heartbeatStartSpy).not.toHaveBeenCalled();
  });
});

describe("lazy-start: first session_start triggers mcp.start()", () => {
  it("calls mcp.start() on the first session_start event", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit("session_start", {}, { sessionKey: "s1" });

    expect(mockMcp.start).toHaveBeenCalledTimes(1);
  });

  it("calls probeCapabilities after mcp.start() resolves", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit("session_start", {}, { sessionKey: "s1" });

    expect(mockMcp.probeCapabilities).toHaveBeenCalledTimes(1);
  });

  it("starts heartbeat after successful MCP probe", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit("session_start", {}, { sessionKey: "s1" });

    expect(heartbeatStartSpy).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent session_start calls to a single mcp.start()", async () => {
    // Simulate mcp.start() taking some time so concurrent calls overlap
    let resolveStart!: () => void;
    mockMcp.start.mockReturnValue(
      new Promise<void>((r) => {
        resolveStart = r;
      }),
    );

    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    const p1 = api.emit("session_start", {}, { sessionKey: "s1" });
    const p2 = api.emit("session_start", {}, { sessionKey: "s2" });
    resolveStart();
    await Promise.all([p1, p2]);

    expect(mockMcp.start).toHaveBeenCalledTimes(1);
  });

  it("does not call mcp.start() a second time on subsequent session_start events", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit("session_start", {}, { sessionKey: "s1" });
    await api.emit("session_start", {}, { sessionKey: "s2" });

    expect(mockMcp.start).toHaveBeenCalledTimes(1);
  });
});

describe("lazy-start: first before_prompt_build triggers mcp.start()", () => {
  it("calls mcp.start() on the first before_prompt_build when session_start never fired", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit(
      "before_prompt_build",
      { prompt: "what is the capital of France?" },
      { sessionKey: "s1" },
    );

    expect(mockMcp.start).toHaveBeenCalledTimes(1);
  });

  it("does not double-start if session_start already ran", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit("session_start", {}, { sessionKey: "s1" });
    await api.emit(
      "before_prompt_build",
      { prompt: "what is the capital of France?" },
      { sessionKey: "s1" },
    );

    expect(mockMcp.start).toHaveBeenCalledTimes(1);
  });
});

describe("lazy-start: heartbeat is only started after MCP is ready", () => {
  it("does not start heartbeat before any event fires", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);
    await new Promise((r) => setImmediate(r));
    expect(heartbeatStartSpy).not.toHaveBeenCalled();
  });

  it("starts heartbeat exactly once even if before_prompt_build fires multiple times", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    const prompt = { prompt: "hello from user with enough chars" };
    await api.emit("before_prompt_build", prompt, { sessionKey: "s1" });
    await api.emit("before_prompt_build", prompt, { sessionKey: "s1" });

    expect(heartbeatStartSpy).toHaveBeenCalledTimes(1);
  });
});

describe("lazy-start: diary replay gating", () => {
  it("does not call replay when hasDiaryWrite is false", async () => {
    mockMcp.hasDiaryWrite = false;
    const replaySpy = vi.fn().mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0, at: 0 });

    // Spy on DiaryReconciler.prototype.replay before register() runs
    const { DiaryReconciler } = await import("../src/diary-replay.js");
    vi.spyOn(DiaryReconciler.prototype, "replay").mockImplementation(replaySpy);

    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit("session_start", {}, { sessionKey: "s1" });
    // Wait one more tick for the fire-and-forget replay branch
    await new Promise((r) => setImmediate(r));

    expect(replaySpy).not.toHaveBeenCalled();
  });

  it("calls replay when hasDiaryWrite is true", async () => {
    mockMcp.hasDiaryWrite = true;
    // probeCapabilities sets hasDiaryWrite — simulate it by mutating after probe
    mockMcp.probeCapabilities.mockImplementation(async () => {
      mockMcp.hasDiaryWrite = true;
    });

    const replaySpy = vi.fn().mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0, at: 0 });

    const { DiaryReconciler } = await import("../src/diary-replay.js");
    vi.spyOn(DiaryReconciler.prototype, "replay").mockImplementation(replaySpy);

    const plugin = await importPlugin();
    const api = makeFakeApi();
    // Enable replayOnStart via config (it defaults to true in DEFAULT_CONFIG)
    plugin.register(api);

    await api.emit("session_start", {}, { sessionKey: "s1" });
    await new Promise((r) => setImmediate(r));

    expect(replaySpy).toHaveBeenCalledTimes(1);
  });
});

describe("lazy-start: failure retry", () => {
  it("clears the cached init promise on mcp.start() failure so the next event retries", async () => {
    let callCount = 0;
    mockMcp.start.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("transient failure");
      // Second call succeeds
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    // First event — mcp.start() fails
    await api.emit("session_start", {}, { sessionKey: "s1" });
    // Wait for the error handler to run
    await new Promise((r) => setImmediate(r));

    // Second event — should retry (new promise created)
    await api.emit("session_start", {}, { sessionKey: "s2" });
    await new Promise((r) => setImmediate(r));

    expect(mockMcp.start).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});

describe("lazy-start: gateway_stop still stops everything", () => {
  it("calls heartbeat.stop() and mcp.stop() on gateway_stop", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    // Trigger init first so heartbeat is running
    await api.emit("session_start", {}, { sessionKey: "s1" });

    await api.emit("gateway_stop", {}, {});

    expect(heartbeatStopSpy).toHaveBeenCalledTimes(1);
    expect(mockMcp.stop).toHaveBeenCalledTimes(1);
  });
});
