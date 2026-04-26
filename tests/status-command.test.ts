import { describe, it, expect } from "vitest";
import { buildStatusReport } from "../src/status-command.js";

describe("buildStatusReport", () => {
  it("reports mcp ready + diary capabilities", () => {
    const text = buildStatusReport({
      mcpReady: true,
      hasDiaryWrite: true,
      hasDiaryRead: true,
      hasKgInvalidate: true,
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
      hasDiaryWrite: false,
      hasDiaryRead: true,
      hasKgInvalidate: false,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
    });
    expect(text).toMatch(/diary_write.*(missing|fallback|jsonl)/i);
    expect(text).toMatch(/kg_invalidate.*(missing|disabled)/i);
  });

  it("flags MCP down when not ready", () => {
    const text = buildStatusReport({
      mcpReady: false,
      hasDiaryWrite: false,
      hasDiaryRead: false,
      hasKgInvalidate: false,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
    });
    expect(text).toMatch(/MCP.*(down|not ready|unavailable)/i);
  });

  it("renders a Metrics section when metrics provided", () => {
    const text = buildStatusReport({
      mcpReady: true,
      hasDiaryWrite: true,
      hasDiaryRead: true,
      hasKgInvalidate: true,
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

  it("renders 'no counters yet' when metrics is empty", () => {
    const text = buildStatusReport({
      mcpReady: true,
      hasDiaryWrite: true,
      hasDiaryRead: true,
      hasKgInvalidate: true,
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
      hasDiaryWrite: true,
      hasDiaryRead: true,
      hasKgInvalidate: true,
      searchCache: { hits: 0, misses: 0, size: 0 },
      kgCache: { hits: 0, misses: 0, size: 0 },
    });
    expect(text).not.toMatch(/Metrics/);
  });
});
