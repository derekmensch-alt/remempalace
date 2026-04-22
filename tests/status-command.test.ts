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
});
