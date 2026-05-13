import { describe, it, expect } from "vitest";
import { dedupeByContent } from "../src/dedup.js";

describe("dedupeByContent", () => {
  it("removes exact duplicate strings", () => {
    expect(dedupeByContent(["a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("treats whitespace-normalized strings as duplicates", () => {
    const out = dedupeByContent(["hello world", "hello   world", "hello\nworld"]);
    expect(out).toHaveLength(1);
  });

  it("preserves insertion order", () => {
    expect(dedupeByContent(["c", "a", "b", "c", "a"])).toEqual(["c", "a", "b"]);
  });
});
