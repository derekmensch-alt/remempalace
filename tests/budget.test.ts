import { describe, it, expect } from "vitest";
import { BudgetManager, DEFAULT_CONTEXT_WINDOW } from "../src/budget.js";

describe("BudgetManager", () => {
  const opts = {
    maxMemoryTokens: 800,
    budgetPercent: 0.15,
    l2BudgetFloor: 0.5,
  };
  const contextWindow = 100000;

  it("allows L0/L1/L2 when conversation is tiny", () => {
    const bm = new BudgetManager(opts);
    const b = bm.compute({ conversationTokens: 1000, contextWindow });
    expect(b.allowedTiers).toEqual(["L0", "L1", "L2"]);
  });

  it("allows L0/L1 only when conversation is medium", () => {
    const bm = new BudgetManager(opts);
    const b = bm.compute({ conversationTokens: 65000, contextWindow });
    expect(b.allowedTiers).toEqual(["L0", "L1"]);
  });

  it("allows L0 only when conversation is large", () => {
    const bm = new BudgetManager(opts);
    const b = bm.compute({ conversationTokens: 72000, contextWindow });
    expect(b.allowedTiers).toEqual(["L0"]);
  });

  it("blocks all injection near context limit", () => {
    const bm = new BudgetManager(opts);
    const b = bm.compute({ conversationTokens: 85000, contextWindow });
    expect(b.allowedTiers).toEqual([]);
  });

  it("caps maxTokens at configured limit", () => {
    const bm = new BudgetManager(opts);
    const b = bm.compute({ conversationTokens: 1000, contextWindow });
    expect(b.maxTokens).toBeLessThanOrEqual(800);
  });

  it("uses a conservative 32000-token context window when none is provided", () => {
    const bm = new BudgetManager({ ...opts, maxMemoryTokens: 10_000 });
    const b = bm.compute({ conversationTokens: 16_000 });

    expect(DEFAULT_CONTEXT_WINDOW).toBe(32_000);
    expect(b.contextFillRatio).toBe(0.5);
    expect(b.maxTokens).toBe(1920);
    expect(b.allowedTiers).toEqual(["L0", "L1", "L2"]);
  });
});
