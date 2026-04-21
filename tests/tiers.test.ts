import { describe, it, expect } from "vitest";
import { buildTieredInjection } from "../src/tiers.js";
import type { SearchResult, KgFact, InjectionBudget } from "../src/types.js";

describe("buildTieredInjection", () => {
  const sampleResults: SearchResult[] = [
    { text: "top hit content about project X", wing: "w", room: "r", similarity: 0.5 },
    { text: "second hit content about project X", wing: "w", room: "r", similarity: 0.35 },
    { text: "deep context hit", wing: "w", room: "r", similarity: 0.27 },
  ];
  const sampleFacts: KgFact[] = [
    { subject: "Derek", predicate: "works_on", object: "remempalace" },
  ];

  it("returns empty when no tiers allowed", () => {
    const budget: InjectionBudget = { maxTokens: 0, allowedTiers: [], contextFillRatio: 0.9 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    expect(out).toEqual([]);
  });

  it("includes L0 facts only when L0 is the only allowed tier", () => {
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L0"], contextFillRatio: 0.7 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined).toContain("Derek:works_on=remempalace");
    expect(joined).not.toContain("top hit content");
  });

  it("includes L0 + L1 when budget allows", () => {
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L0", "L1"], contextFillRatio: 0.4 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined).toContain("Derek:works_on=remempalace");
    expect(joined).toContain("top hit content");
    expect(joined).not.toContain("deep context hit");
  });

  it("includes L0 + L1 + L2 when budget is generous", () => {
    const budget: InjectionBudget = { maxTokens: 2000, allowedTiers: ["L0", "L1", "L2"], contextFillRatio: 0.1 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined).toContain("deep context hit");
  });

  it("respects token budget cap", () => {
    const budget: InjectionBudget = { maxTokens: 10, allowedTiers: ["L0", "L1", "L2"], contextFillRatio: 0.1 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined.length).toBeLessThanOrEqual(10 * 4 + 50);
  });
});
