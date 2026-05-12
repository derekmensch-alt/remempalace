/**
 * Fast-race recall tests for src/index.ts before_prompt_build.
 *
 * Validates that:
 *   - When the precomputed bundle resolves within fastRaceMs, full recall is used
 *     and recall.fast_race.hit is incremented.
 *   - When the bundle does not resolve within fastRaceMs, cheap mode is used,
 *     recall.fast_race.miss is incremented, and the bundle promise still runs in
 *     the background (populating LRU caches via its router calls).
 *   - Metrics fire correctly for hit, miss, and cheap-mode-bypassed cases.
 *   - Identity is always injected when present in sessionStartCache, regardless
 *     of which race outcome fires.
 *   - Cheap-mode prompts bypass the fast race entirely (no fast_race.miss recorded).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpClient } from "../src/mcp-client.js";
import { HeartbeatWarmer } from "../src/heartbeat.js";

// ---------------------------------------------------------------------------
// Helpers (mirror lifecycle.test.ts patterns)
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface FakeApi {
  on: ReturnType<typeof vi.fn>;
  registerMemoryCapability: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  emit: (name: string, event?: unknown, ctx?: unknown) => Promise<unknown>;
}

function makeFakeApi(): FakeApi {
  const handlers = new Map<string, EventHandler>();
  return {
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

let mockMcp: MockMcpClient;

beforeEach(() => {
  mockMcp = makeMockMcpClient();
  vi.spyOn(McpClient, "shared").mockReturnValue(mockMcp as unknown as McpClient);
  vi.spyOn(HeartbeatWarmer.prototype, "start").mockImplementation(function () {});
  vi.spyOn(HeartbeatWarmer.prototype, "stop").mockImplementation(function () {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await McpClient.resetSharedForTests();
});

async function importPlugin() {
  const mod = await import("../src/index.js");
  return mod.default;
}

/** Read the metrics snapshot via the registered status command. */
async function getStatusText(api: FakeApi): Promise<string> {
  const allCalls = api.registerCommand.mock.calls as Array<
    [{ name: string; handler: () => Promise<{ text: string }> }]
  >;
  const cmd = allCalls.find((c) => c[0]?.name === "remempalace");
  if (!cmd) throw new Error("remempalace command not registered");
  return (await cmd[0].handler()).text;
}

// ---------------------------------------------------------------------------
// 1. Bundle resolves within fastRaceMs → full recall injected
// ---------------------------------------------------------------------------

describe("fast-race: bundle resolves within fastRaceMs", () => {
  it("uses full recall (KG + search hits) when MCP resolves before fastRaceMs elapses", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_search") {
        return Promise.resolve({
          results: [
            { text: "remempalace is in Phase 3", wing: "w", room: "r", similarity: 0.8 },
          ],
        });
      }
      if (name === "mempalace_kg_query") {
        return Promise.resolve({
          facts: [{ subject: "remempalace", predicate: "phase", object: "3" }],
        });
      }
      return Promise.resolve({});
    });

    const plugin = await importPlugin();
    const api = makeFakeApi();
    // Large fastRaceMs so an immediately-resolving mock always wins the race.
    plugin.register(api, { injection: { fastRaceMs: 5000 } });

    const prompt = "what should I do next on remempalace?";
    const result = await api.emit(
      "before_prompt_build",
      { prompt, messages: [] },
      { sessionKey: "fast-race-hit" },
    );

    const ctx = result as { prependSystemContext: string };
    // Full recall: Memory Context header present with KG fact.
    expect(ctx.prependSystemContext).toContain("Memory Context (remempalace)");
    expect(ctx.prependSystemContext).toContain("remempalace:phase=3");
  });

  it("records recall.fast_race.hit metric when bundle resolves in time", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_search") return Promise.resolve({ results: [] });
      if (name === "mempalace_kg_query") return Promise.resolve({ facts: [] });
      return Promise.resolve({});
    });

    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api, { injection: { fastRaceMs: 5000 } });

    const prompt = "what should I do next on remempalace?";
    await api.emit("before_prompt_build", { prompt, messages: [] }, { sessionKey: "metric-hit" });

    const statusText = await getStatusText(api);
    expect(statusText).toContain("recall.fast_race.hit: 1");
    expect(statusText).not.toContain("recall.fast_race.miss: 1");
  });
});

// ---------------------------------------------------------------------------
// 2. Bundle does NOT resolve within fastRaceMs → cheap mode, bundle keeps running
// ---------------------------------------------------------------------------

describe("fast-race: bundle does not resolve within fastRaceMs", () => {
  it("falls back to cheap mode when MCP is slow (fake timers, fastRaceMs=10)", async () => {
    vi.useFakeTimers();
    try {
      // Never-resolving MCP to simulate slow bundle
      mockMcp.callTool.mockImplementation((name: string) => {
        if (name === "mempalace_search" || name === "mempalace_kg_query") {
          return new Promise(() => {}); // never resolves
        }
        return Promise.resolve({});
      });

      const plugin = await importPlugin();
      const api = makeFakeApi();
      // Tiny fastRaceMs so we always lose the race
      plugin.register(api, { injection: { fastRaceMs: 10 } });

      const prompt = "what should I do next on remempalace?";

      const pending = api.emit(
        "before_prompt_build",
        { prompt, messages: [] },
        { sessionKey: "fast-race-miss" },
      );

      // Advance past fastRaceMs (10ms) but nowhere near 1500ms deadline.
      // before_prompt_build should return immediately after the fast race times out.
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      const ctx = result as { prependSystemContext: string };
      // Should return runtime disclosure (cheap mode, no diary prefetch → empty memoryLines)
      expect(ctx.prependSystemContext).toContain("Active Memory Plugin (remempalace)");
      // No full-recall "Memory Context" block since cheap mode + no diary
      expect(ctx.prependSystemContext).not.toContain("Memory Context (remempalace)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records recall.fast_race.miss metric when bundle is slow", async () => {
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
      plugin.register(api, { injection: { fastRaceMs: 10 } });

      const prompt = "what should I do next on remempalace?";
      const pending = api.emit(
        "before_prompt_build",
        { prompt, messages: [] },
        { sessionKey: "metric-miss" },
      );
      await vi.advanceTimersByTimeAsync(50);
      await pending;

      const statusText = await getStatusText(api);
      expect(statusText).toContain("recall.fast_race.miss: 1");
      expect(statusText).not.toContain("recall.fast_race.hit: 1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("MCP callTool is invoked even when the fast race misses (bundle runs in background)", async () => {
    vi.useFakeTimers();
    try {
      let searchCalled = false;
      mockMcp.callTool.mockImplementation((name: string) => {
        if (name === "mempalace_search") {
          searchCalled = true;
          return new Promise(() => {}); // never resolves — stays in background
        }
        if (name === "mempalace_kg_query") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });

      const plugin = await importPlugin();
      const api = makeFakeApi();
      plugin.register(api, { injection: { fastRaceMs: 10 } });

      const prompt = "what should I do next on remempalace?";
      const pending = api.emit(
        "before_prompt_build",
        { prompt, messages: [] },
        { sessionKey: "bg-bundle" },
      );

      await vi.advanceTimersByTimeAsync(50);
      await pending;

      // The MCP search call was initiated (even though it never resolved in time)
      expect(searchCalled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses cheap diary lines when session prefetch has relevant entries", async () => {
    // Use real timers for session_start (it does async MCP init + prefetch)
    // and fake timers only for the slow MCP calls during before_prompt_build.

    // Diary prefetch: returns relevant entry
    mockMcp.hasDiaryRead = true;
    mockMcp.probeCapabilities.mockImplementation(async () => {
      mockMcp.hasDiaryRead = true;
    });

    // During session_start, diary_read is fast; during before_prompt_build, search/kg are slow
    const diaryEntries = [{ content: "worked on remempalace fast recall architecture" }];
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_diary_read") {
        return Promise.resolve({ entries: diaryEntries });
      }
      // search/kg will be set to never-resolve below
      return Promise.resolve({});
    });

    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api, { injection: { fastRaceMs: 10 } });

    // Prefetch diary entries via session_start (real async, resolves immediately)
    await api.emit("session_start", {}, { sessionKey: "fast-race-diary" });
    // Give async prefetch time to complete
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Now switch to fake timers for the slow MCP bundle
    vi.useFakeTimers();
    try {
      mockMcp.callTool.mockImplementation((name: string) => {
        if (name === "mempalace_search" || name === "mempalace_kg_query") {
          return new Promise(() => {}); // never resolves during test
        }
        return Promise.resolve({});
      });

      const prompt = "continue remempalace fast recall work";
      const pending = api.emit(
        "before_prompt_build",
        { prompt, messages: [] },
        { sessionKey: "fast-race-diary" },
      );

      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      const ctx = result as { prependSystemContext: string };
      // Cheap mode with relevant diary entry
      expect(ctx.prependSystemContext).toContain("Memory Context (remempalace)");
      expect(ctx.prependSystemContext).toContain(
        "RECENT DIARY (source=remempalace diary prefetch, cheap tier):",
      );
      expect(ctx.prependSystemContext).toContain("remempalace fast recall");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Cheap-mode prompts bypass the fast race entirely
// ---------------------------------------------------------------------------

describe("fast-race: cheap-mode prompts bypass the race", () => {
  it("does not record fast_race.miss when recallMode is cheap", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    // "please proceed" has no candidates and no question mark → cheap mode
    await api.emit(
      "before_prompt_build",
      { prompt: "please proceed with the next edit", messages: [] },
      { sessionKey: "cheap-bypass" },
    );

    const statusText = await getStatusText(api);
    // Neither fast_race metric should increment for cheap-mode prompts
    expect(statusText).not.toContain("recall.fast_race.miss: 1");
    expect(statusText).not.toContain("recall.fast_race.hit: 1");
  });

  it("does not call MCP search/kg for cheap-mode prompts (no race started)", async () => {
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit(
      "before_prompt_build",
      { prompt: "please proceed with the next edit", messages: [] },
      { sessionKey: "cheap-no-mcp" },
    );

    expect(mockMcp.callTool).not.toHaveBeenCalledWith("mempalace_search", expect.anything());
    expect(mockMcp.callTool).not.toHaveBeenCalledWith("mempalace_kg_query", expect.anything());
  });

  it("does not record fast-race metrics for cheap+kg1 prompts", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_kg_query") return Promise.resolve({ facts: [] });
      if (name === "mempalace_search") return Promise.resolve({ results: [] });
      return Promise.resolve({});
    });
    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api);

    await api.emit(
      "before_prompt_build",
      { prompt: "continue the remempalace refactor", messages: [] },
      { sessionKey: "cheap-kg1-no-race" },
    );

    const statusText = await getStatusText(api);
    expect(statusText).not.toContain("recall.fast_race.miss: 1");
    expect(statusText).not.toContain("recall.fast_race.hit: 1");
    expect(mockMcp.callTool).toHaveBeenCalledWith(
      "mempalace_kg_query",
      { entity: "remempalace" },
      8000,
    );
    expect(mockMcp.callTool).not.toHaveBeenCalledWith(
      "mempalace_search",
      expect.anything(),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Identity is always injected regardless of race outcome
// ---------------------------------------------------------------------------

describe("fast-race: identity injection is race-outcome-independent", () => {
  it("does not throw and returns a valid block when race hits (no identity files present)", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_search") return Promise.resolve({ results: [] });
      if (name === "mempalace_kg_query") return Promise.resolve({ facts: [] });
      return Promise.resolve({});
    });

    const plugin = await importPlugin();
    const api = makeFakeApi();
    plugin.register(api, { injection: { fastRaceMs: 5000 } });

    const prompt = "what should I do next on remempalace?";
    const result = await api.emit(
      "before_prompt_build",
      { prompt, messages: [] },
      { sessionKey: "identity-hit" },
    );

    // No crash; runtime disclosure is always present
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("Active Memory Plugin (remempalace)"),
    });
  });

  it("does not throw and returns a valid block when fast race misses (no identity files present)", async () => {
    vi.useFakeTimers();
    try {
      mockMcp.callTool.mockImplementation((name: string) => {
        if (name === "mempalace_search" || name === "mempalace_kg_query") {
          return new Promise(() => {}); // never resolves
        }
        return Promise.resolve({});
      });

      const plugin = await importPlugin();
      const api = makeFakeApi();
      plugin.register(api, { injection: { fastRaceMs: 10 } });

      const prompt = "what should I do next on remempalace?";
      const pending = api.emit(
        "before_prompt_build",
        { prompt, messages: [] },
        { sessionKey: "identity-miss" },
      );
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      // No crash; runtime disclosure is always present even on fast race miss
      expect(result).toEqual({
        prependSystemContext: expect.stringContaining("Active Memory Plugin (remempalace)"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Precomputed bundle (llm_input → before_prompt_build) always hits fast race
// ---------------------------------------------------------------------------

describe("fast-race: precomputed bundle from llm_input always wins the fast race", () => {
  it("uses the precomputed bundle (fastRaceMs=1) when llm_input fired first", async () => {
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
    // Extremely short fastRaceMs — precomputed promise is already resolved, so
    // even 1ms is enough to pick it up via withPromptMemoryDeadline.
    plugin.register(api, { injection: { fastRaceMs: 1 } });

    const prompt = "what should I do next on remempalace?";

    // Precompute during llm_input (MCP resolves immediately)
    await api.emit(
      "llm_input",
      { historyMessages: [{ role: "user", content: prompt }] },
      { sessionKey: "precompute-fast" },
    );
    // Give the precompute promise time to resolve
    await new Promise((r) => setImmediate(r));

    const result = await api.emit(
      "before_prompt_build",
      { prompt, messages: [{ role: "user", content: prompt }] },
      { sessionKey: "precompute-fast" },
    );

    const ctx = result as { prependSystemContext: string };
    // Full recall from precomputed bundle
    expect(ctx.prependSystemContext).toContain("Memory Context (remempalace)");
    expect(ctx.prependSystemContext).toContain("remempalace:status=Phase 3");

    const statusText = await getStatusText(api);
    // Precomputed bundle was used and the fast race hit
    expect(statusText).toContain("recall.precompute.used: 1");
    expect(statusText).toContain("recall.fast_race.hit: 1");
  });

  it("reuses precomputed recall for normalized-equivalent prompts", async () => {
    mockMcp.callTool.mockImplementation((name: string) => {
      if (name === "mempalace_search") {
        return Promise.resolve({
          results: [{ text: "normalized intent recall", wing: "w", room: "r", similarity: 0.9 }],
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
    plugin.register(api, { injection: { fastRaceMs: 1 } });

    await api.emit(
      "llm_input",
      { historyMessages: [{ role: "user", content: "what should I do next on remempalace?" }] },
      { sessionKey: "precompute-normalized" },
    );
    await new Promise((r) => setImmediate(r));

    const result = await api.emit(
      "before_prompt_build",
      {
        prompt: "remempalace next?",
        messages: [{ role: "user", content: "remempalace next?" }],
      },
      { sessionKey: "precompute-normalized" },
    );

    const ctx = result as { prependSystemContext: string };
    expect(ctx.prependSystemContext).toContain("normalized intent recall");
    expect(mockMcp.callTool).toHaveBeenCalledTimes(2);
    const statusText = await getStatusText(api);
    expect(statusText).toContain("recall.precompute.used: 1");
    expect(statusText).toContain("recall.precompute.intent_used: 1");
    expect(statusText).toContain("recall.fast_race.hit: 1");
  });
});
