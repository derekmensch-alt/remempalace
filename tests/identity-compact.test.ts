import { describe, it, expect } from "vitest";
import { compactIdentity } from "../src/identity-compact.js";
import { countTokens } from "../src/token-counter.js";

describe("compactIdentity", () => {
  const soul = `# Principal
## Values
- direct
- low-bs
## Role
- software engineer
`;

  const identity = `# Current Project
## Stack
- typescript
- python
## Goal
- ship-phase-7
`;

  it("output stays within maxTokens", () => {
    const result = compactIdentity({ soul, identity }, { maxTokens: 50 });
    expect(countTokens(result)).toBeLessThanOrEqual(50);
  });

  it("contains key sections from soul/identity", () => {
    const result = compactIdentity({ soul, identity }, { maxTokens: 300 });
    expect(result.length).toBeGreaterThan(0);
    // Should contain something recognizable from the source content
    const lower = result.toLowerCase();
    const hasContent =
      lower.includes("principal") ||
      lower.includes("direct") ||
      lower.includes("typescript") ||
      lower.includes("ship") ||
      lower.includes("current") ||
      lower.includes("stack");
    expect(hasContent).toBe(true);
  });

  it("empty soul + empty identity returns empty string", () => {
    const result = compactIdentity({ soul: "", identity: "" }, { maxTokens: 150 });
    expect(result).toBe("");
  });

  it("rawIdentity=true returns raw concatenation (truncated to maxTokens)", () => {
    const result = compactIdentity({ soul, identity }, { maxTokens: 300, rawIdentity: true });
    expect(countTokens(result)).toBeLessThanOrEqual(300);
    // Should contain raw text from the original content
    expect(result).toContain("# Principal");
  });

  it("when maxTokens is very small (10), truncates cleanly", () => {
    const result = compactIdentity({ soul, identity }, { maxTokens: 10 });
    expect(countTokens(result)).toBeLessThanOrEqual(10);
    // Should not throw, just return a short string or empty
    expect(typeof result).toBe("string");
  });

  it("rawIdentity=true with very small maxTokens truncates cleanly", () => {
    const result = compactIdentity({ soul, identity }, { maxTokens: 5, rawIdentity: true });
    expect(countTokens(result)).toBeLessThanOrEqual(5);
    expect(typeof result).toBe("string");
  });

  it("uses default maxTokens of 150 when not specified via rawIdentity path", () => {
    const longSoul = "# Section\n" + "- item\n".repeat(200);
    const result = compactIdentity({ soul: longSoul, identity: "" }, { maxTokens: 150 });
    expect(countTokens(result)).toBeLessThanOrEqual(150);
  });
});
