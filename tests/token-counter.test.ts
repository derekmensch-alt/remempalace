import { describe, it, expect } from "vitest";
import { countTokens, countLines } from "../src/token-counter.js";

describe("token-counter", () => {
  it("approximates tokens as chars/4 rounded up", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("test")).toBe(1);
    expect(countTokens("hello world")).toBe(3);
  });

  it("counts array of lines", () => {
    expect(countLines(["a", "bb", "cccc"])).toBe(countTokens("a\nbb\ncccc"));
  });
});
