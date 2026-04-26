import { describe, it, expect } from "vitest";
import { extractStructuredFacts } from "../src/structured-extractor.js";

describe("extractStructuredFacts — preference category", () => {
  it("captures 'X's favorite/preferred Y is Z' as preference with high confidence", () => {
    const facts = extractStructuredFacts("Derek's favorite model is Kimi K2.5.");
    const pref = facts.find((f) => f.category === "preference");
    expect(pref).toBeDefined();
    expect(pref?.subject).toBe("Derek");
    expect(pref?.object.toLowerCase()).toContain("kimi");
    expect(pref?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("captures 'X prefers Y' as preference", () => {
    const facts = extractStructuredFacts("Derek prefers Rust over Go.");
    expect(facts.some((f) => f.category === "preference" && f.subject === "Derek")).toBe(true);
  });

  it("downscores hedged preferences", () => {
    const facts = extractStructuredFacts("Derek might prefer Rust sometimes.");
    const pref = facts.find((f) => f.category === "preference");
    if (pref) {
      expect(pref.confidence).toBeLessThan(0.7);
    }
  });
});

describe("extractStructuredFacts — identity category", () => {
  it("captures 'X is a Y' role/identity claims", () => {
    const facts = extractStructuredFacts("Derek is a senior software engineer.");
    const id = facts.find((f) => f.category === "identity");
    expect(id).toBeDefined();
    expect(id?.subject).toBe("Derek");
  });

  it("captures 'X works at Y' as identity", () => {
    const facts = extractStructuredFacts("Sarah works at Anthropic.");
    expect(
      facts.some(
        (f) => f.category === "identity" && f.subject === "Sarah" && f.object === "Anthropic",
      ),
    ).toBe(true);
  });
});

describe("extractStructuredFacts — project_state category", () => {
  it("captures 'X is using Y for Z' as project_state", () => {
    const facts = extractStructuredFacts("remempalace is using vitest for testing.");
    const ps = facts.find((f) => f.category === "project_state");
    expect(ps).toBeDefined();
  });

  it("captures 'we shipped X' as project_state decision-adjacent", () => {
    const facts = extractStructuredFacts("We shipped the diary replay feature today.");
    expect(
      facts.some((f) => f.category === "project_state" || f.category === "decision"),
    ).toBe(true);
  });
});

describe("extractStructuredFacts — decision category", () => {
  it("captures 'we decided to X' as a decision", () => {
    const facts = extractStructuredFacts("We decided to use TypeScript for the new service.");
    const d = facts.find((f) => f.category === "decision");
    expect(d).toBeDefined();
  });

  it("captures 'I chose X over Y' as a decision", () => {
    const facts = extractStructuredFacts("I chose Postgres over MySQL for this project.");
    expect(facts.some((f) => f.category === "decision")).toBe(true);
  });
});

describe("extractStructuredFacts — environment category", () => {
  it("captures 'X runs on Y' system facts as environment", () => {
    const facts = extractStructuredFacts("The gateway runs on port 18789.");
    const env = facts.find((f) => f.category === "environment");
    expect(env).toBeDefined();
  });

  it("captures path-style environment claims", () => {
    const facts = extractStructuredFacts("Config lives at ~/.openclaw/openclaw.json.");
    expect(facts.some((f) => f.category === "environment")).toBe(true);
  });
});

describe("extractStructuredFacts — confidence + filtering", () => {
  it("returns [] for unrelated chatter", () => {
    expect(extractStructuredFacts("hello there how are you today")).toEqual([]);
  });

  it("never returns confidence > 1 or < 0", () => {
    const facts = extractStructuredFacts(
      "Derek's favorite model is Kimi. Derek uses OpenClaw. Derek is a developer.",
    );
    for (const f of facts) {
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("downscores facts inside negation/uncertainty clauses", () => {
    const factsHedged = extractStructuredFacts("Derek probably uses OpenClaw sometimes.");
    const factsConfident = extractStructuredFacts("Derek uses OpenClaw daily.");
    const hedged = factsHedged.find((f) => f.subject === "Derek" && f.object === "OpenClaw");
    const confident = factsConfident.find(
      (f) => f.subject === "Derek" && f.object === "OpenClaw",
    );
    if (hedged && confident) {
      expect(hedged.confidence).toBeLessThan(confident.confidence);
    }
  });

  it("emits zero-confidence (or skips) for explicit denials", () => {
    const facts = extractStructuredFacts("Derek does not use OpenClaw.");
    const deniedFact = facts.find(
      (f) => f.subject === "Derek" && f.object === "OpenClaw" && f.predicate === "uses",
    );
    if (deniedFact) {
      expect(deniedFact.confidence).toBeLessThanOrEqual(0.2);
    }
  });

  it("captures source_span for each fact", () => {
    const facts = extractStructuredFacts("Derek's favorite model is Kimi K2.5.");
    for (const f of facts) {
      expect(typeof f.source_span).toBe("string");
      expect(f.source_span!.length).toBeGreaterThan(0);
    }
  });

  it("dedupes identical facts within a single call", () => {
    const facts = extractStructuredFacts("Derek uses OpenClaw. Derek uses OpenClaw.");
    const matches = facts.filter(
      (f) => f.subject === "Derek" && f.predicate === "uses" && f.object === "OpenClaw",
    );
    expect(matches).toHaveLength(1);
  });
});

describe("extractStructuredFacts — opts", () => {
  it("filters out facts below minConfidence when passed", () => {
    const facts = extractStructuredFacts(
      "Derek might prefer Rust. Derek's favorite model is Kimi.",
      { minConfidence: 0.8 },
    );
    for (const f of facts) {
      expect(f.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });
});
