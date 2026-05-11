/**
 * Lifecycle tests for src/index.ts lazy-start behaviour.
 *
 * Validates that:
 *   - mcp.start() is NOT called during plugin registration
 *   - mcp.start() IS called on the first session_start / before_prompt_build event
 *   - Concurrent first-events coalesce to a single mcp.start() call
 *   - heartbeat.start() is deferred until after MCP probe succeeds
 *   - Diary replay fires only when diary persistence is verified and replayOnStart is true
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
  emit: (name: string, event?: unknown, ctx?: unknown) => Promise<unknown>;
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
      if (h) return await h(event, ctx);
      return undefined;
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

describe("recall gating: low-semantic prompts", () => {
  it("skips KG/search recall for low-semantic acknowledgements", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    const result = await api.emit(
      "before_prompt_build",
      { prompt: "thank you!", messages: [] },
      { sessionKey: "skip-ack" },
    );

    expect(result).toBeUndefined();
    expect(mockMcp.callTool).not.toHaveBeenCalledWith(
      "mempalace_search",
      expect.anything(),
    );
    expect(mockMcp.callTool).not.toHaveBeenCalledWith(
      "mempalace_kg_query",
      expect.anything(),
    );
  });

  it("keeps full recall for project and question prompts", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_search") return Promise.resolve({ results: [] });
      if (name === "mempalace_kg_query") return Promise.resolve({ facts: [] });
      return Promise.resolve({});
    });
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit(
      "before_prompt_build",
      { prompt: "what should I do next on remempalace?", messages: [] },
      { sessionKey: "recall-question" },
    );

    expect(mockMcp.callTool).toHaveBeenCalledWith("mempalace_search", {
      query: "what should I do next on remempalace?",
      limit: 5,
    });
    expect(mockMcp.callTool).toHaveBeenCalledWith("mempalace_kg_query", {
      entity: "remempalace",
    });
  });

  it("uses cheap recall without KG/search for ordinary non-specific prompts", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    const result = await api.emit(
      "before_prompt_build",
      { prompt: "please proceed with the next edit", messages: [] },
      { sessionKey: "cheap-ordinary" },
    );

    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("Active Memory Plugin (remempalace)"),
    });
    expect(mockMcp.callTool).not.toHaveBeenCalledWith(
      "mempalace_search",
      expect.anything(),
    );
    expect(mockMcp.callTool).not.toHaveBeenCalledWith(
      "mempalace_kg_query",
      expect.anything(),
    );
  });

  it("injects cheap diary-prefetch context without prompt-path KG/search", async () => {
    mockMcp.hasDiaryRead = true;
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_diary_read") {
        return Promise.resolve({
          entries: [
            { content: "worked on the diary health persistence refactor" },
            { content: "unrelated grocery note" },
          ],
        });
      }
      if (name === "mempalace_search") return Promise.resolve({ results: [] });
      return Promise.resolve({});
    });
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit("session_start", {}, { sessionKey: "cheap-prefetch" });
    mockMcp.callTool.mockClear();

    const result = await api.emit(
      "before_prompt_build",
      { prompt: "continue diary health refactor", messages: [] },
      { sessionKey: "cheap-prefetch" },
    );

    expect(result).toEqual({
      prependSystemContext: expect.stringContaining(
        "RECENT DIARY (source=remempalace diary prefetch, cheap tier):",
      ),
    });
    expect((result as { prependSystemContext: string }).prependSystemContext)
      .toMatchInlineSnapshot(`
        "## Active Memory Plugin (remempalace)

        runtime slot: OpenClaw memory plugin = remempalace
        scope: remempalace recall is separate from workspace files or local markdown notes
        audit: use /remempalace status to see the most recent recall candidates and counts

        ## Memory Context (remempalace)

        RECENT DIARY (source=remempalace diary prefetch, cheap tier):
        - worked on the diary health persistence refactor
        "
      `);
    expect(mockMcp.callTool).not.toHaveBeenCalledWith(
      "mempalace_search",
      expect.anything(),
    );
    expect(mockMcp.callTool).not.toHaveBeenCalledWith(
      "mempalace_kg_query",
      expect.anything(),
    );
  });

  it("reuses full recall precomputed from llm_input", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_search") {
        return Promise.resolve({
          results: [{ text: "remempalace status note", wing: "w", room: "r", similarity: 0.9 }],
        });
      }
      if (name === "mempalace_kg_query") {
        return Promise.resolve({
          facts: [{ subject: "remempalace", predicate: "status", object: "Phase 3" }],
        });
      }
      return Promise.resolve({});
    });
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);
    const prompt = "what should I do next on remempalace?";

    await api.emit(
      "llm_input",
      { historyMessages: [{ role: "user", content: prompt }] },
      { sessionKey: "precompute-full" },
    );
    const result = await api.emit(
      "before_prompt_build",
      { prompt, messages: [{ role: "user", content: prompt }] },
      { sessionKey: "precompute-full" },
    );

    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("Memory Context (remempalace)"),
    });
    expect(mockMcp.callTool).toHaveBeenCalledTimes(2);
    expect(mockMcp.callTool).toHaveBeenCalledWith("mempalace_search", {
      query: prompt,
      limit: 5,
    });
    expect(mockMcp.callTool).toHaveBeenCalledWith("mempalace_kg_query", {
      entity: "remempalace",
    });
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
  it("does not call replay when diary persistence is unverified", async () => {
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

  it("calls replay when diary persistence is verified", async () => {
    mockMcp.hasDiaryWrite = true;
    mockMcp.hasDiaryRead = true;
    let probeEntry = "";
    mockMcp.callTool.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "mempalace_diary_write") {
        probeEntry = String(args.entry);
        return Promise.resolve({ success: true });
      }
      if (name === "mempalace_diary_read") {
        return Promise.resolve({ entries: [{ content: probeEntry, topic: "health-probe" }] });
      }
      return Promise.resolve({});
    });
    // probeCapabilities sets diary tool presence — simulate it by mutating after probe
    mockMcp.probeCapabilities.mockImplementation(async () => {
      mockMcp.hasDiaryWrite = true;
      mockMcp.hasDiaryRead = true;
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

// ---------------------------------------------------------------------------
// Injection deduplication: exactly one path fires per prompt
// ---------------------------------------------------------------------------
//
// Problem: Two injection paths exist —
//   1. before_prompt_build returns { prependSystemContext: block } (modern path)
//   2. The registered builder (legacy path for old OpenClaw hosts)
//
// If a modern OpenClaw host calls BOTH (uses hook return AND calls the
// registered builder), the same block appears twice in the prompt.
//
// Fix: hookFiredSessions tracks sessions where before_prompt_build has fired.
// The builder returns [] for those sessions, making it a no-op when the hook
// already handled injection.
// ---------------------------------------------------------------------------

describe("injection deduplication: builder is no-op when hook fired", () => {
  it("builder returns [] after before_prompt_build fires for the same session", async () => {
    const plugin = await importPlugin();

    // Capture the registered builder
    let capturedBuilder: ((params: unknown) => string[]) | null = null;
    const api = makeFakeApi();
    // Override registerMemoryCapability to capture the builder
    api.registerMemoryCapability.mockImplementation(
      (cap: { promptBuilder?: (p: unknown) => string[] }) => {
        if (cap.promptBuilder) capturedBuilder = cap.promptBuilder;
      },
    );

    plugin.register(api);

    const sessionKey = "session-dedup-test";

    // Fire before_prompt_build (the modern hook path)
    const hookResult = await api.emit(
      "before_prompt_build",
      { prompt: "what do you remember about my projects?", messages: [] },
      { sessionKey },
    );

    // Verify a builder was registered
    expect(capturedBuilder).not.toBeNull();
    expect(hookResult).toEqual({
      prependSystemContext: expect.stringContaining("Active Memory Plugin (remempalace)"),
    });

    // Now simulate OpenClaw also calling the builder (legacy-compat path)
    const result = capturedBuilder!({ sessionKey });

    // Must be empty — hook already handled injection, no duplication
    expect(result).toEqual([]);
  });

  it("builder returns [] on first call after hook fired, then flag is consumed", async () => {
    const plugin = await importPlugin();

    let capturedBuilder: ((params: unknown) => string[]) | null = null;
    const api = makeFakeApi();
    api.registerMemoryCapability.mockImplementation(
      (cap: { promptBuilder?: (p: unknown) => string[] }) => {
        if (cap.promptBuilder) capturedBuilder = cap.promptBuilder;
      },
    );

    plugin.register(api);

    const sessionKey = "session-dedup-repeated";

    await api.emit(
      "before_prompt_build",
      { prompt: "tell me about my recent conversations with Sarah", messages: [] },
      { sessionKey },
    );

    expect(capturedBuilder).not.toBeNull();

    // First call: hook flag consumed, builder returns [] (no duplication)
    const first = capturedBuilder!({ sessionKey });
    expect(first).toEqual([]);

    // Second call: flag already consumed, falls through to normal path.
    // No duplicate content risk here — the session cache is already empty.
    const second = capturedBuilder!({ sessionKey });
    expect(Array.isArray(second)).toBe(true);
  });

  it("hook flag is session-scoped: other sessions are not affected", async () => {
    const plugin = await importPlugin();

    let capturedBuilder: ((params: unknown) => string[]) | null = null;
    const api = makeFakeApi();
    api.registerMemoryCapability.mockImplementation(
      (cap: { promptBuilder?: (p: unknown) => string[] }) => {
        if (cap.promptBuilder) capturedBuilder = cap.promptBuilder;
      },
    );

    plugin.register(api);

    // Fire hook for session A only
    await api.emit(
      "before_prompt_build",
      { prompt: "what did I work on last week?", messages: [] },
      { sessionKey: "session-A" },
    );

    expect(capturedBuilder).not.toBeNull();

    // Session A builder: no-op (hook fired)
    expect(capturedBuilder!({ sessionKey: "session-A" })).toEqual([]);

    // Session B builder: not affected by session A's flag.
    // cachedBySession has no entry for B, so result is [] too —
    // but crucially it reaches the normal (non-flag) code path.
    const resultB = capturedBuilder!({ sessionKey: "session-B" });
    expect(Array.isArray(resultB)).toBe(true);
  });

  it("builder follows normal path when api.on is absent (legacy host, no flag set)", async () => {
    const plugin = await importPlugin();

    let capturedBuilder: ((params: unknown) => string[]) | null = null;

    // Minimal legacy API: has registerMemoryCapability but NO api.on.
    // register() wraps all api.on calls in `if (typeof api.on === "function")`,
    // so hookFiredSessions is never populated for this session.
    const legacyApi = {
      config: {},
      registerMemoryCapability: vi.fn(
        (cap: { promptBuilder?: (p: unknown) => string[] }) => {
          if (cap.promptBuilder) capturedBuilder = cap.promptBuilder;
        },
      ),
      registerCommand: vi.fn(),
      // No api.on property at all
    };

    plugin.register(legacyApi as unknown as Parameters<typeof plugin.register>[0]);

    expect(capturedBuilder).not.toBeNull();

    // Before any hook fires (api.on never called), hookFiredSessions is empty.
    // cachedBySession also has no entry. Health/fallback state belongs in
    // status/logs, not prompt notes, so the normal path returns no prompt lines.
    const sessionKey = "legacy-session";
    const result = capturedBuilder!({ sessionKey });

    expect(result).toEqual([]);
  });
});
