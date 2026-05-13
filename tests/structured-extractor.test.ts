import { describe, it, expect } from "vitest";
import { extractStructuredFacts, extractMemoryCommands } from "../src/structured-extractor.js";

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
    expect(
      facts.some(
        (f) =>
          f.category === "preference" &&
          f.subject === "Derek" &&
          f.predicate === "prefers" &&
          f.object === "Rust over Go",
      ),
    ).toBe(true);
  });

  it("captures conjoined likes as separate stable preference facts", () => {
    const facts = extractStructuredFacts("Derek likes TypeScript and Rust.");
    expect(
      facts.filter((f) => f.subject === "Derek" && f.predicate === "likes").map((f) => f.object),
    ).toEqual(["TypeScript", "Rust"]);
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

  it("captures conjoined employers as separate stable identity facts", () => {
    const facts = extractStructuredFacts("Derek works at OpenAI and Anthropic.");
    expect(
      facts
        .filter((f) => f.subject === "Derek" && f.predicate === "works_at")
        .map((f) => f.object),
    ).toEqual(["OpenAI", "Anthropic"]);
  });

  it("captures conjoined roles as separate identity facts", () => {
    const facts = extractStructuredFacts("Derek is an engineer and founder.");
    expect(
      facts.filter((f) => f.subject === "Derek" && f.predicate === "is_a").map((f) => f.object),
    ).toEqual(["engineer", "founder"]);
  });
});

describe("extractStructuredFacts — project_state category", () => {
  it("captures 'X is using Y for Z' as project_state", () => {
    const facts = extractStructuredFacts("remempalace is using vitest for testing.");
    const ps = facts.find((f) => f.category === "project_state");
    expect(ps).toBeDefined();
  });

  it("keeps tool/purpose predicates stable for compound usage", () => {
    const facts = extractStructuredFacts(
      "Derek is using vitest for testing and playwright for e2e.",
    );
    expect(facts.map((f) => f.predicate)).not.toContain("uses_for_testing_and_playwright_for_e2e");
    expect(
      facts
        .filter((f) => f.subject === "Derek" && f.predicate === "uses")
        .map((f) => f.object),
    ).toEqual(["vitest", "playwright"]);
    expect(
      facts
        .filter((f) => f.subject === "Derek" && f.predicate === "used_for")
        .map((f) => f.object),
    ).toEqual(["vitest for testing", "playwright for e2e"]);
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

  it("skips explicit denials instead of emitting low-confidence positive facts", () => {
    const facts = extractStructuredFacts("Derek does not use OpenClaw.");
    expect(
      facts.some((f) => f.subject === "Derek" && f.object === "OpenClaw" && f.predicate === "uses"),
    ).toBe(false);
  });

  it("applies the skip policy consistently across common negation forms", () => {
    const examples = [
      "Derek is not a manager.",
      "Derek no longer uses OpenClaw.",
      "Derek doesn't like Rust.",
      "Derek is using vitest for testing, but not playwright.",
    ];
    for (const example of examples) {
      expect(extractStructuredFacts(example)).toEqual([]);
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

describe("extractStructuredFacts — adversarial critique matrix", () => {
  const cases: Array<{
    name: string;
    text: string;
    expected: Array<{ subject: string; predicate: string; object: string }>;
  }> = [
    {
      name: "preference comparisons preserve comparison text",
      text: "Derek prefers Rust over Go.",
      expected: [{ subject: "Derek", predicate: "prefers", object: "Rust over Go" }],
    },
    {
      name: "conjoined preferences are split",
      text: "Derek likes TypeScript and Rust.",
      expected: [
        { subject: "Derek", predicate: "likes", object: "TypeScript" },
        { subject: "Derek", predicate: "likes", object: "Rust" },
      ],
    },
    {
      name: "conjoined employers are split",
      text: "Derek works at OpenAI and Anthropic.",
      expected: [
        { subject: "Derek", predicate: "works_at", object: "OpenAI" },
        { subject: "Derek", predicate: "works_at", object: "Anthropic" },
      ],
    },
    {
      name: "compound tool/purpose clauses use stable predicates",
      text: "Derek is using vitest for testing and playwright for e2e.",
      expected: [
        { subject: "Derek", predicate: "uses", object: "vitest" },
        { subject: "Derek", predicate: "used_for", object: "vitest for testing" },
        { subject: "Derek", predicate: "uses", object: "playwright" },
        { subject: "Derek", predicate: "used_for", object: "playwright for e2e" },
      ],
    },
    {
      name: "multiple roles are split",
      text: "Derek is an engineer and founder.",
      expected: [
        { subject: "Derek", predicate: "is_a", object: "engineer" },
        { subject: "Derek", predicate: "is_a", object: "founder" },
      ],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const facts = extractStructuredFacts(c.text);
      expect(facts.map((f) => `${f.subject}|${f.predicate}|${f.object}`)).toEqual(
        expect.arrayContaining(c.expected.map((f) => `${f.subject}|${f.predicate}|${f.object}`)),
      );
    });
  }

  it("skips negated critique examples", () => {
    expect(extractStructuredFacts("Derek is not a manager.")).toEqual([]);
  });

  it("does not emit predicates outside the controlled vocabulary for critique examples", () => {
    const facts = extractStructuredFacts(
      [
        "Derek prefers Rust over Go.",
        "Derek likes TypeScript and Rust.",
        "Derek works at OpenAI and Anthropic.",
        "Derek is using vitest for testing and playwright for e2e.",
        "Derek is an engineer and founder.",
      ].join(" "),
    );
    expect(facts.every((f) => !f.predicate.startsWith("uses_for_"))).toBe(true);
  });
});

describe("extractStructuredFacts — false positive / negative examples", () => {
  it("does not extract facts from text inside double quotes (quoted attribution)", () => {
    const facts = extractStructuredFacts('He said "I use Python"');
    expect(facts).toEqual([]);
  });

  it("does not extract facts from sarcastic negations", () => {
    const facts = extractStructuredFacts("Yeah right, I totally love Windows");
    expect(facts).toEqual([]);
  });

  it("does not extract facts from hypotheticals", () => {
    const facts = extractStructuredFacts("What if I used React instead?");
    expect(facts).toEqual([]);
  });

  it("does not extract facts from assistant corrections", () => {
    const facts = extractStructuredFacts("No, that's wrong, I don't use Java");
    expect(facts).toEqual([]);
  });

  it("does not extract facts from inside backtick code spans", () => {
    // The fact-bearing text lives only inside the backtick span.
    const facts = extractStructuredFacts("Run `Derek uses Python` in your terminal");
    expect(facts).toEqual([]);
  });
});

describe("extractMemoryCommands", () => {
  it("detects 'remember that X' → remember array", () => {
    const result = extractMemoryCommands("Remember that my API key is in .env");
    expect(result.remember).toHaveLength(1);
    expect(result.remember[0]).toContain("my API key is in .env");
    expect(result.forget).toHaveLength(0);
  });

  it("detects 'please remember X' → remember array", () => {
    const result = extractMemoryCommands("Please remember my timezone is UTC+2");
    expect(result.remember).toHaveLength(1);
    expect(result.remember[0]).toContain("my timezone is UTC+2");
  });

  it("detects 'make a note that X' → remember array", () => {
    const result = extractMemoryCommands("Make a note that the repo is on GitLab");
    expect(result.remember).toHaveLength(1);
    expect(result.remember[0]).toContain("the repo is on GitLab");
  });

  it("detects \"don't store this: X\" → forget array", () => {
    const result = extractMemoryCommands("Don't store this: my password is hunter2");
    expect(result.forget).toHaveLength(1);
    expect(result.forget[0]).toContain("my password is hunter2");
    expect(result.remember).toHaveLength(0);
  });

  it("detects 'forget that X' → forget array", () => {
    const result = extractMemoryCommands("Forget that I mentioned React");
    expect(result.forget).toHaveLength(1);
    expect(result.forget[0]).toContain("I mentioned React");
  });

  it("detects \"don't remember X\" → forget array", () => {
    const result = extractMemoryCommands("Don't remember my old address");
    expect(result.forget).toHaveLength(1);
    expect(result.forget[0]).toContain("my old address");
  });

  it("returns empty arrays for plain text with no commands", () => {
    const result = extractMemoryCommands("Derek likes TypeScript");
    expect(result.remember).toHaveLength(0);
    expect(result.forget).toHaveLength(0);
  });
});
