import { describe, it, expect } from "vitest";
import { buildStatusReport } from "../src/status-command.js";

describe("buildStatusReport", () => {
  it("reports mcp ready + diary capabilities", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 10, misses: 2, size: 7 },
      kgCache: { hits: 4, misses: 1, size: 3 },
    });

    expect(text).toMatch(/MCP.*ready/i);
    expect(text).toMatch(/diary_write.*ok/i);
    expect(text).toMatch(/diary_read.*ok/i);
    expect(text).toMatch(/kg_invalidate.*ok/i);
    expect(text).toMatch(/search cache.*10 hits.*2 misses.*7 entries/i);
    expect(text).toMatch(/kg cache.*4 hits.*1 misses.*3 entries/i);
  });

  it("flags diary fallback when write is missing", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: false,
      canReadDiary: true,
      canInvalidateKg: false,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
    });
    expect(text).toMatch(/diary_write.*(missing|fallback|jsonl)/i);
    expect(text).toMatch(/kg_invalidate.*(missing|disabled)/i);
  });

  it("flags MCP down when not ready", () => {
    const text = buildStatusReport({
      mcpReady: false,
      canWriteDiary: false,
      canReadDiary: false,
      canInvalidateKg: false,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
    });
    expect(text).toMatch(/MCP.*(down|not ready|unavailable)/i);
  });

  it("renders a Metrics section when metrics provided", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
      metrics: {
        "recall.search.calls": 12,
        "recall.search.cache_hits": 7,
        "diary.write.attempted": 3,
        "diary.write.fallback": 1,
        "injection.tokens.l0": 480,
      },
    });
    expect(text).toMatch(/Metrics/);
    expect(text).toMatch(/recall\.search\.calls.*12/);
    expect(text).toMatch(/diary\.write\.fallback.*1/);
    expect(text).toMatch(/injection\.tokens\.l0.*480/);
  });

  it("renders before_prompt_build latency summary from metrics", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
      metrics: {
        "latency.before_prompt_build.init.ms_total": 40,
        "latency.before_prompt_build.init.count": 2,
        "latency.before_prompt_build.fetch.ms_total": 90,
        "latency.before_prompt_build.fetch.count": 3,
        "latency.before_prompt_build.format.ms_total": 20,
        "latency.before_prompt_build.format.count": 2,
        "latency.before_prompt_build.total.ms_total": 170,
        "latency.before_prompt_build.total.count": 2,
        "latency.before_prompt_build.total.max_ms": 120,
      },
    });

    expect(text).toMatch(/Latency/);
    expect(text).toMatch(/init: avg=20.0ms n=2/);
    expect(text).toMatch(/fetch: avg=30.0ms n=3/);
    expect(text).toMatch(/format: avg=10.0ms n=2/);
    expect(text).toMatch(/total: avg=85.0ms max=120.0ms n=2/);
  });

  it("renders 'no counters yet' when metrics is empty", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
      metrics: {},
    });
    expect(text).toMatch(/Metrics/);
    expect(text).toMatch(/no counters yet/i);
  });

  it("omits Metrics section when metrics is undefined", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
    });
    expect(text).not.toMatch(/Metrics/);
  });

  it("renders Diary section with persistent state when no pending entries", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
      diary: { state: "persistent", persistenceState: "persistent", pending: 0 },
    });
    expect(text).toMatch(/Diary/);
    expect(text).toMatch(/state.*persistent/i);
    expect(text).toMatch(/persistence.*verified/i);
    expect(text).toMatch(/pending.*0/i);
  });

  it("renders Diary section with fallback-active warning when pending > 0", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
      diary: { state: "fallback-active", persistenceState: "persistent", pending: 75 },
    });
    expect(text).toMatch(/state.*fallback-active/i);
    expect(text).toMatch(/pending.*75/i);
  });

  it("renders Diary section with last replay result when present", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
      diary: {
        state: "degraded",
        persistenceState: "persistent",
        pending: 5,
        lastReplay: {
          attempted: 10,
          succeeded: 5,
          failed: 5,
          at: new Date("2026-04-26T00:00:00Z").getTime(),
        },
      },
    });
    expect(text).toMatch(/last replay/i);
    expect(text).toMatch(/10.*attempted/i);
    expect(text).toMatch(/5.*succeeded/i);
    expect(text).toMatch(/5.*failed/i);
  });

  it("omits Diary section when diary is undefined", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
    });
    expect(text).not.toMatch(/^Diary:/m);
  });

  it("renders last recall audit details when available", () => {
    const text = buildStatusReport({
      mcpReady: true,
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
      lastRecall: {
        sessionKey: "chat-1",
        promptPreview: "what memory plugin are you using?",
        candidates: ["remempalace"],
        kgFactCount: 2,
        searchResultCount: 1,
        injectedLineCount: 4,
        identityIncluded: false,
        at: new Date("2026-04-30T09:26:00Z").getTime(),
      },
    });

    expect(text).toMatch(/Last recall/);
    expect(text).toMatch(/chat-1/);
    expect(text).toMatch(/remempalace/);
    expect(text).toMatch(/KG facts.*2/i);
    expect(text).toMatch(/search results.*1/i);
  });
});
