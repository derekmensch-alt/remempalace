import { describe, it, expect } from "vitest";
import { detectContradictions, classifyPredicate } from "../src/contradiction.js";
import type { ExtractedFact, KgFact } from "../src/types.js";

function ef(
  subject: string,
  predicate: string,
  object: string,
  confidence = 0.9,
): ExtractedFact {
  return { subject, predicate, object, category: "preference", confidence };
}

describe("classifyPredicate", () => {
  it("treats 'favorite_*' / 'preferred_*' / 'default_*' / 'primary_*' as single-cardinality", () => {
    expect(classifyPredicate("favorite_model")).toBe("single");
    expect(classifyPredicate("preferred_editor")).toBe("single");
    expect(classifyPredicate("default_browser")).toBe("single");
    expect(classifyPredicate("primary_email")).toBe("single");
  });

  it("treats 'is_a' as single-cardinality (one role at a time)", () => {
    expect(classifyPredicate("is_a")).toBe("single");
  });

  it("treats 'works_at' as single-cardinality (typical case)", () => {
    expect(classifyPredicate("works_at")).toBe("single");
  });

  it("treats 'uses', 'owns', 'runs', 'likes' as list-cardinality", () => {
    expect(classifyPredicate("uses")).toBe("list");
    expect(classifyPredicate("owns")).toBe("list");
    expect(classifyPredicate("runs")).toBe("list");
    expect(classifyPredicate("likes")).toBe("list");
  });

  it("defaults unknown predicates to list-cardinality (conservative — don't auto-invalidate)", () => {
    expect(classifyPredicate("frobnicates")).toBe("list");
  });
});

describe("detectContradictions", () => {
  it("detects same (subject,predicate) with different object on single-cardinality predicate", () => {
    const prior: KgFact[] = [
      { subject: "Derek", predicate: "favorite_model", object: "Kimi" },
    ];
    const next = [ef("Derek", "favorite_model", "Claude")];
    const contradictions = detectContradictions(prior, next);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].prior.object).toBe("Kimi");
    expect(contradictions[0].next.object).toBe("Claude");
    expect(contradictions[0].type).toBe("single");
  });

  it("does NOT contradict on list-cardinality predicate even with different object", () => {
    const prior: KgFact[] = [{ subject: "Derek", predicate: "uses", object: "OpenClaw" }];
    const next = [ef("Derek", "uses", "Vitest")];
    expect(detectContradictions(prior, next)).toEqual([]);
  });

  it("does NOT mark same (subject,predicate,object) as contradiction (idempotent reassertion)", () => {
    const prior: KgFact[] = [
      { subject: "Derek", predicate: "favorite_model", object: "Kimi" },
    ];
    const next = [ef("Derek", "favorite_model", "Kimi")];
    expect(detectContradictions(prior, next)).toEqual([]);
  });

  it("ignores prior facts whose subject/predicate is not present in next", () => {
    const prior: KgFact[] = [
      { subject: "Derek", predicate: "favorite_model", object: "Kimi" },
    ];
    const next = [ef("Sarah", "favorite_model", "Claude")];
    expect(detectContradictions(prior, next)).toEqual([]);
  });

  it("returns multiple contradictions when multiple priors disagree", () => {
    const prior: KgFact[] = [
      { subject: "Derek", predicate: "favorite_model", object: "Kimi" },
      { subject: "Derek", predicate: "is_a", object: "engineer" },
    ];
    const next = [
      ef("Derek", "favorite_model", "Claude"),
      ef("Derek", "is_a", "manager"),
    ];
    const c = detectContradictions(prior, next);
    expect(c).toHaveLength(2);
  });

  it("treats prior with multiple objects on single-card predicate (legacy data) as all contradictory", () => {
    const prior: KgFact[] = [
      { subject: "Derek", predicate: "favorite_model", object: "Kimi" },
      { subject: "Derek", predicate: "favorite_model", object: "Sonnet" },
    ];
    const next = [ef("Derek", "favorite_model", "Claude")];
    const c = detectContradictions(prior, next);
    expect(c).toHaveLength(2);
  });

  it("respects the 'current' flag — invalidated priors are skipped", () => {
    const prior: KgFact[] = [
      { subject: "Derek", predicate: "favorite_model", object: "Kimi", current: false },
    ];
    const next = [ef("Derek", "favorite_model", "Claude")];
    expect(detectContradictions(prior, next)).toEqual([]);
  });
});
