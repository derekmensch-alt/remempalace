import { describe, it, expect } from "vitest";
import { BudgetManager } from "../src/budget.js";

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
});
