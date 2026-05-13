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

  it("does NOT match a knownEntity that is only a substring of another word", () => {
    // Regression: previously "MemPalace" matched via .includes() whenever the prompt
    // mentioned "remempalace", so both entities became candidates and KG facts got
    // mixed across the plugin and its backend.
    const result = extractEntityCandidates("what do you know about remempalace", {
      knownEntities: ["MemPalace", "remempalace"],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toEqual(["remempalace"]);
  });

  it("still matches a knownEntity surrounded by non-word characters", () => {
    const result = extractEntityCandidates("how is MemPalace's storage doing?", {
      knownEntities: ["MemPalace"],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toEqual(["MemPalace"]);
  });

  it("matches knownEntity at end of prompt without trailing space", () => {
    const result = extractEntityCandidates("tell me about OpenClaw", {
      knownEntities: ["OpenClaw"],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toEqual(["OpenClaw"]);
  });

  it("prioritizes knownEntities over cap-pattern noise when slots are limited", () => {
    // Regression: a Telegram metadata preamble full of capitalized JSON keys
    // ("Conversation", "Rock", "Fri", "EDT") was filling all 4 maxCandidates
    // slots before the knownEntities loop ran, so "remempalace" (lowercase,
    // only matchable via the whitelist) never made it into the result.
    const prompt =
      "Conversation info (untrusted metadata):\n" +
      '```json\n{ "sender": "De Rock", "timestamp": "Fri 2026-04-24 16:54 EDT" }\n```\n' +
      "according to memory, what is remempalace's critique_verdict?";
    const result = extractEntityCandidates(prompt, {
      knownEntities: ["Derek", "OpenClaw", "MemPalace", "remempalace"],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toContain("remempalace");
  });

  it("maps generic memory-plugin questions to remempalace when configured", () => {
    const result = extractEntityCandidates("What memory plugin are you using?", {
      knownEntities: ["OpenClaw", "MemPalace", "remempalace"],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toContain("remempalace");
  });

  it("maps generic memory-system questions to remempalace when configured", () => {
    const result = extractEntityCandidates("Which memory system is active?", {
      knownEntities: ["OpenClaw", "MemPalace", "remempalace"],
      maxCandidates: 4,
      minLength: 3,
    });
    expect(result).toContain("remempalace");
  });
});
