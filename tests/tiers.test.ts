import { describe, it, expect } from "vitest";
import { buildTieredInjection } from "../src/tiers.js";
import { Metrics } from "../src/metrics.js";
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

  it("filters out non-current KG facts", () => {
    const facts: KgFact[] = [
      { subject: "remempalace", predicate: "status", object: "disabled", valid_from: "2026-04-20", current: false },
      { subject: "remempalace", predicate: "status", object: "enabled", valid_from: "2026-04-23", current: true },
    ];
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L0"], contextFillRatio: 0.5 };
    const out = buildTieredInjection({
      kgFacts: facts,
      searchResults: [],
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined).toContain("remempalace:status=enabled");
    expect(joined).not.toContain("remempalace:status=disabled");
  });

  it("sorts KG facts by valid_from descending (newest first)", () => {
    const facts: KgFact[] = [
      { subject: "remempalace", predicate: "phase", object: "1", valid_from: "2026-04-20" },
      { subject: "remempalace", predicate: "phase", object: "3", valid_from: "2026-04-23" },
      { subject: "remempalace", predicate: "phase", object: "2", valid_from: "2026-04-21" },
    ];
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L0"], contextFillRatio: 0.5 };
    const out = buildTieredInjection({
      kgFacts: facts,
      searchResults: [],
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    const posP3 = joined.indexOf("phase=3");
    const posP2 = joined.indexOf("phase=2");
    const posP1 = joined.indexOf("phase=1");
    expect(posP3).toBeGreaterThanOrEqual(0);
    expect(posP3).toBeLessThan(posP2);
    expect(posP2).toBeLessThan(posP1);
  });

  it("places facts without valid_from after dated facts", () => {
    const facts: KgFact[] = [
      { subject: "x", predicate: "p", object: "undated" },
      { subject: "x", predicate: "p", object: "dated", valid_from: "2026-04-23" },
    ];
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L0"], contextFillRatio: 0.5 };
    const out = buildTieredInjection({
      kgFacts: facts,
      searchResults: [],
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined.indexOf("=dated")).toBeLessThan(joined.indexOf("=undated"));
  });

  it("injects newest KG facts greedily when total facts exceed budget (no all-or-nothing drop)", () => {
    // Build 50 facts — monolithic line would exceed a tight budget
    const facts: KgFact[] = Array.from({ length: 50 }, (_, i) => ({
      subject: "remempalace",
      predicate: "completed_task",
      object: `task-${String(i).padStart(2, "0")}`,
      valid_from: `2026-04-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    // Budget just big enough for a few facts but not all
    const budget: InjectionBudget = { maxTokens: 80, allowedTiers: ["L0"], contextFillRatio: 0.5 };
    const out = buildTieredInjection({
      kgFacts: facts,
      searchResults: [],
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    // At least one fact should land (not all-or-nothing drop)
    expect(joined).toMatch(/remempalace:completed_task=task-/);
    // Newest date should be present (2026-04-28 = i where i%28+1 = 28 → i=27)
    expect(joined).toContain("task-27");
  });

  it("labels KG facts as authoritative so the model can distinguish them from search drawers", () => {
    const facts: KgFact[] = [
      {
        subject: "remempalace",
        predicate: "status",
        object: "enabled",
        valid_from: "2026-04-23",
        source_closet: "openclaw:user",
      },
    ];
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L0"], contextFillRatio: 0.5 };
    const out = buildTieredInjection({
      kgFacts: facts,
      searchResults: [],
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined.toLowerCase()).toContain("authoritative");
    expect(joined).toContain("source=remempalace KG");
    expect(joined).toContain("source=openclaw:user");
  });

  it("labels search hits with source and confidence", () => {
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L1"], contextFillRatio: 0.5 };
    const out = buildTieredInjection({
      kgFacts: [],
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined).toContain("source=remempalace search");
    expect(joined).toContain("confidence=0.50");
  });

  it("records per-tier injection token totals into metrics", () => {
    const metrics = new Metrics();
    const budget: InjectionBudget = {
      maxTokens: 500,
      allowedTiers: ["L0", "L1", "L2"],
      contextFillRatio: 0.7,
    };
    buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
      metrics,
    });
    const snap = metrics.snapshot();
    // L0 line plus L1 hits should produce non-zero tokens for L0 and L1.
    expect(snap["injection.tokens.l0"]).toBeGreaterThan(0);
    expect(snap["injection.tokens.l1"]).toBeGreaterThan(0);
  });

  it("does not record tokens when no tiers allowed", () => {
    const metrics = new Metrics();
    const budget: InjectionBudget = { maxTokens: 0, allowedTiers: [], contextFillRatio: 0.9 };
    buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
      metrics,
    });
    expect(metrics.snapshot()).toEqual({});
  });
});
