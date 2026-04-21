import { describe, it, expect, vi } from "vitest";
import { summarizeSession, writeDiaryAsync } from "../src/diary.js";
import type { AgentMessage } from "../src/types-messages.js";

describe("summarizeSession", () => {
  it("extracts user and assistant turns into AAAK format", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "update TODO" },
      { role: "assistant", content: "done" },
    ];
    const out = summarizeSession(messages, { maxTokens: 200 });
    expect(out).toContain("TURNS:4");
    expect(out).toContain("hello");
    expect(out).toContain("hi");
  });

  it("truncates to token budget", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} with some content to make it longer`,
    }));
    const out = summarizeSession(messages, { maxTokens: 50 });
    expect(out.length).toBeLessThanOrEqual(50 * 4 + 50);
  });

  it("returns empty string for empty session", () => {
    expect(summarizeSession([], { maxTokens: 200 })).toBe("");
  });
});

describe("writeDiaryAsync", () => {
  it("is fire-and-forget (does not await)", () => {
    const mockMcp = {
      callTool: vi.fn().mockImplementation(
        () => new Promise((r) => setTimeout(r, 1000)),
      ),
    };
    const t0 = Date.now();
    writeDiaryAsync(mockMcp as any, "summary content");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });

  it("swallows errors silently", async () => {
    const mockMcp = {
      callTool: vi.fn().mockRejectedValue(new Error("boom")),
    };
    expect(() => writeDiaryAsync(mockMcp as any, "summary")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
