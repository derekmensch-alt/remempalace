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

  it("returns runtime disclosure when MCP init exceeds the shared prompt deadline", async () => {
    vi.useFakeTimers();
    try {
      mockMcp.start.mockReturnValue(new Promise(() => {}));
      const plugin = await importPlugin();
      const api = makeFakeApi();
      plugin.register(api);

      const pending = api.emit(
        "before_prompt_build",
        { prompt: "what should I do next on remempalace?", messages: [] },
        { sessionKey: "init-timeout" },
      );
      await vi.advanceTimersByTimeAsync(1500);
      const result = await pending;

      expect(result).toEqual({
        prependSystemContext: expect.stringContaining("Active Memory Plugin (remempalace)"),
      });
      expect(mockMcp.start).toHaveBeenCalledTimes(1);
      expect(mockMcp.callTool).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the init sub-budget so prompt path does not wait the full shared deadline", async () => {
    vi.useFakeTimers();
    try {
      mockMcp.start.mockReturnValue(new Promise(() => {}));
      const plugin = await importPlugin();
      const api = makeFakeApi();
      plugin.register(api);

      const pending = api.emit(
        "before_prompt_build",
        { prompt: "what should I do next on remempalace?", messages: [] },
        { sessionKey: "init-subbudget-timeout" },
      );
      await vi.advanceTimersByTimeAsync(400);
      const result = await pending;

      expect(result).toEqual({
        prependSystemContext: expect.stringContaining("Active Memory Plugin (remempalace)"),
      });
      expect(mockMcp.callTool).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

    expect(mockMcp.callTool).toHaveBeenCalledWith(
      "mempalace_search",
      {
        query: "what should I do next on remempalace?",
        limit: 5,
      },
      8000,
    );
    expect(mockMcp.callTool).toHaveBeenCalledWith(
      "mempalace_kg_query",
      {
        entity: "remempalace",
      },
      8000,
    );
  });

  it("snapshots bounded full-recall injection under a tight token budget", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_search") {
        return Promise.resolve({
          results: [
            { text: "top hit content about project X", wing: "w", room: "r", similarity: 0.5 },
            { text: "second hit content about project X", wing: "w", room: "r", similarity: 0.35 },
            { text: "deep context hit", wing: "w", room: "r", similarity: 0.27 },
          ],
        });
      }
      if (name === "mempalace_kg_query") {
        return Promise.resolve({
          facts: [
            {
              subject: "remempalace",
              predicate: "status",
              object: "phase-2",
              valid_from: "2026-05-11",
              source_closet: "openclaw:user",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api, {
      injection: {
        maxTokens: 120,
        budgetPercent: 1,
      },
    });

    const result = await api.emit(
      "before_prompt_build",
      { prompt: "what should I do next on remempalace?", messages: [] },
      { sessionKey: "tight-budget-snapshot" },
    );

    expect((result as { prependSystemContext: string }).prependSystemContext)
      .toMatchInlineSnapshot(`
        "## Active Memory Plugin (remempalace)

        runtime slot: OpenClaw memory plugin = remempalace
        scope: remempalace recall is separate from workspace files or local markdown notes
        audit: use /remempalace status to see the most recent recall candidates and counts

        ## Memory Context (remempalace)

        KG FACTS (source=remempalace KG, authoritative, newest first):
        - remempalace:status=phase-2 [2026-05-11] [source=openclaw:user]
        "
      `);
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

  it("uses cheap+kg1 recall for entity-bearing continuation prompts without semantic search", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_kg_query") {
        return Promise.resolve({
          facts: [
            {
              subject: "remempalace",
              predicate: "phase",
              object: "3",
              valid_from: "2026-05-12",
              source_closet: "openclaw:user",
            },
          ],
        });
      }
      if (name === "mempalace_search") {
        return Promise.resolve({
          results: [{ text: "semantic search should not be used", wing: "w", room: "r", similarity: 0.9 }],
        });
      }
      return Promise.resolve({});
    });
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    const result = await api.emit(
      "before_prompt_build",
      { prompt: "continue the remempalace refactor", messages: [] },
      { sessionKey: "cheap-kg1-continuation" },
    );

    expect(mockMcp.callTool).toHaveBeenCalledWith(
      "mempalace_kg_query",
      {
        entity: "remempalace",
      },
      8000,
    );
    expect(mockMcp.callTool).not.toHaveBeenCalledWith(
      "mempalace_search",
      expect.anything(),
      expect.anything(),
    );
    expect((result as { prependSystemContext: string }).prependSystemContext)
      .toMatchInlineSnapshot(`
        "## Active Memory Plugin (remempalace)

        runtime slot: OpenClaw memory plugin = remempalace
        scope: remempalace recall is separate from workspace files or local markdown notes
        audit: use /remempalace status to see the most recent recall candidates and counts

        ## Memory Context (remempalace)

        KG FACTS (source=remempalace KG, authoritative, newest first):
        - remempalace:phase=3 [2026-05-12] [source=openclaw:user]
        "
      `);
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
    expect(mockMcp.callTool).toHaveBeenCalledWith(
      "mempalace_search",
      {
        query: prompt,
        limit: 5,
      },
      8000,
    );
    expect(mockMcp.callTool).toHaveBeenCalledWith(
      "mempalace_kg_query",
      {
        entity: "remempalace",
      },
      8000,
    );
  });

  it("falls back to an empty full-recall bundle when prompt-path recall times out", async () => {
    vi.useFakeTimers();
    try {
      mockMcp.callTool.mockImplementation((name: string) => {
        if (name === "mempalace_search" || name === "mempalace_kg_query") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });
      const plugin = await importPlugin();
      const api = makeFakeApi();
      plugin.register(api);
      const prompt = "what should I do next on remempalace?";

      const pending = api.emit(
        "before_prompt_build",
        { prompt, messages: [{ role: "user", content: prompt }] },
        { sessionKey: "timeout-full" },
      );
      await vi.advanceTimersByTimeAsync(1500);
      const result = await pending;

      expect(result).toEqual({
        prependSystemContext: expect.stringContaining("Active Memory Plugin (remempalace)"),
      });
      expect((result as { prependSystemContext: string }).prependSystemContext).not.toContain(
        "Memory Context (remempalace)",
      );
      expect(mockMcp.callTool).toHaveBeenCalledWith(
        "mempalace_search",
        {
          query: prompt,
          limit: 5,
        },
        8000,
      );
      expect(mockMcp.callTool).toHaveBeenCalledWith(
        "mempalace_kg_query",
        {
          entity: "remempalace",
        },
        8000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to empty timeline context when timeline recall exceeds the shared prompt deadline", async () => {
    vi.useFakeTimers();
    try {
      mockMcp.hasDiaryRead = true;
      mockMcp.callTool.mockImplementation((name: string) => {
        if (name === "mempalace_kg_timeline") {
          return new Promise(() => {});
        }
        if (name === "mempalace_diary_read") {
          return Promise.resolve({ entries: [] });
        }
        return Promise.resolve({});
      });
      const plugin = await importPlugin();
      const api = makeFakeApi();
      plugin.register(api);

      const pending = api.emit(
        "before_prompt_build",
        { prompt: "what happened last week?", messages: [] },
        { sessionKey: "timeout-timeline" },
      );
      await vi.advanceTimersByTimeAsync(1500);
      const result = await pending;

      expect(result).toEqual({
        prependSystemContext: expect.stringContaining("Timeline Context (remempalace)"),
      });
      expect((result as { prependSystemContext: string }).prependSystemContext).toContain(
        "Active Memory Plugin (remempalace)",
      );
      expect(mockMcp.callTool).toHaveBeenCalledWith("mempalace_kg_timeline", {
        days_back: 7,
      });
    } finally {
      vi.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// before_prompt_build injection snapshot tests: budget-bounded formatting
//
// These tests verify that, after wrapper overhead is subtracted, the tiered
// packer produces stable output across different budget regimes.  The mock
// data is the same across all scenarios so only the budget changes.
// ---------------------------------------------------------------------------

function makeBudgetMock() {
  return (name: string) => {
    if (name === "mempalace_search") {
      return Promise.resolve({
        results: [
          { text: "top hit content about project X", wing: "w", room: "r", similarity: 0.5 },
          { text: "second hit content about project X", wing: "w", room: "r", similarity: 0.35 },
          { text: "deep context hit", wing: "w", room: "r", similarity: 0.27 },
        ],
      });
    }
    if (name === "mempalace_kg_query") {
      return Promise.resolve({
        facts: [
          {
            subject: "remempalace",
            predicate: "status",
            object: "phase-2",
            valid_from: "2026-05-11",
            source_closet: "openclaw:user",
          },
        ],
      });
    }
    return Promise.resolve({});
  };
}

describe("before_prompt_build injection snapshots: budget regimes", () => {
  it("generous budget (maxTokens: 800) includes L0 KG + L1 hits + L2 hit", async () => {
    mockMcp.callTool.mockImplementation(makeBudgetMock());
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api, {
      injection: {
        maxTokens: 800,
        budgetPercent: 1,
      },
    });

    const result = await api.emit(
      "before_prompt_build",
      { prompt: "what should I do next on remempalace?", messages: [] },
      { sessionKey: "generous-budget-snapshot" },
    );

    expect((result as { prependSystemContext: string }).prependSystemContext)
      .toMatchInlineSnapshot(`
        "## Active Memory Plugin (remempalace)

        runtime slot: OpenClaw memory plugin = remempalace
        scope: remempalace recall is separate from workspace files or local markdown notes
        audit: use /remempalace status to see the most recent recall candidates and counts

        ## Memory Context (remempalace)

        KG FACTS (source=remempalace KG, authoritative, newest first):
        - remempalace:status=phase-2 [2026-05-11] [source=openclaw:user]
        [w/r ★0.50] top hit content about project X [source=remempalace search, confidence=0.50]
        [w/r ★0.35] second hit content about project X [source=remempalace search, confidence=0.35]
        [w/r ★0.27] deep context hit [source=remempalace search, confidence=0.27]
        "
      `);
  });

  it("moderate budget (maxTokens: 153) includes L0 KG + L1 hits but drops L2", async () => {
    mockMcp.callTool.mockImplementation(makeBudgetMock());
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api, {
      injection: {
        maxTokens: 153,
        budgetPercent: 1,
      },
    });

    const result = await api.emit(
      "before_prompt_build",
      { prompt: "what should I do next on remempalace?", messages: [] },
      { sessionKey: "moderate-budget-snapshot" },
    );

    const ctx = result as { prependSystemContext: string };
    // L2 hit must be absent
    expect(ctx.prependSystemContext).not.toContain("deep context hit");
    // L1 hits must be present
    expect(ctx.prependSystemContext).toContain("top hit content about project X");
    expect(ctx.prependSystemContext).toContain("second hit content about project X");
    expect(ctx.prependSystemContext).toMatchInlineSnapshot(`
      "## Active Memory Plugin (remempalace)

      runtime slot: OpenClaw memory plugin = remempalace
      scope: remempalace recall is separate from workspace files or local markdown notes
      audit: use /remempalace status to see the most recent recall candidates and counts

      ## Memory Context (remempalace)

      KG FACTS (source=remempalace KG, authoritative, newest first):
      - remempalace:status=phase-2 [2026-05-11] [source=openclaw:user]
      [w/r ★0.50] top hit content about project X [source=remempalace search, confidence=0.50]
      [w/r ★0.35] second hit content about project X [source=remempalace search, confidence=0.35]
      "
    `);
  });
});
