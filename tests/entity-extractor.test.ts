import { describe, it, expect } from "vitest";
import { extractEntityCandidates } from "../src/entity-extractor.js";

describe("extractEntityCandidates", () => {
  it("returns capitalized token from prompt", () => {
    const result = extractEntityCandidates("what is Derek working on today?", {
      knownEntities: [],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toEqual(["Derek"]);
  });

  it("returns multiple candidates from prompt", () => {
    const result = extractEntityCandidates("is remempalace running under OpenClaw?", {
      knownEntities: ["OpenClaw", "remempalace"],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toContain("OpenClaw");
    expect(result).toContain("remempalace");
    expect(result.length).toBe(2);
  });

  it("caps results at maxCandidates", () => {
    const result = extractEntityCandidates("Alpha Beta Gamma Delta Epsilon Zeta", {
      knownEntities: [],
      maxCandidates: 3,
      minLength: 3,
    });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("catches lowercase knownEntity mention using whitelist casing", () => {
    const result = extractEntityCandidates("how does openclaw work", {
      knownEntities: ["OpenClaw"],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toEqual(["OpenClaw"]);
  });

  it("returns empty array when no caps and no whitelist hits", () => {
    const result = extractEntityCandidates("what time is it?", {
      knownEntities: [],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toEqual([]);
  });

  it("deduplicates case-insensitively, keeping first-seen casing", () => {
    const result = extractEntityCandidates("Derek and derek went to the store", {
      knownEntities: [],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toEqual(["Derek"]);
  });
});
