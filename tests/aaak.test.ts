import { describe, it, expect } from "vitest";
import { formatKgFact, formatSearchResult, formatSearchResultsAaak } from "../src/aaak.js";

describe("aaak formatter", () => {
  it("formats KG fact as SUBJ:PRED=OBJ", () => {
    const out = formatKgFact({
      subject: "Derek",
      predicate: "prefers_model",
      object: "Kimi K2.5",
    });
    expect(out).toBe("Derek:prefers_model=Kimi K2.5");
  });

  it("adds valid_from annotation when present", () => {
    const out = formatKgFact({
      subject: "Derek",
      predicate: "owns",
      object: "Legion 5",
      valid_from: "2025-01-01",
    });
    expect(out).toBe("Derek:owns=Legion 5 [2025-01-01]");
  });

  it("formats search result with wing/room prefix and similarity", () => {
    const out = formatSearchResult({
      text: "test content",
      wing: "technical",
      room: "notes",
      similarity: 0.73,
    });
    expect(out).toBe("[technical/notes ★0.73] test content");
  });

  it("joins search results with pipe separators", () => {
    const out = formatSearchResultsAaak([
      { text: "a", wing: "w1", room: "r1", similarity: 0.5 },
      { text: "b", wing: "w2", room: "r2", similarity: 0.4 },
    ]);
    expect(out).toContain("[w1/r1 ★0.50] a");
    expect(out).toContain("[w2/r2 ★0.40] b");
  });
});
