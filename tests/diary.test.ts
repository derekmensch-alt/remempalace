import { describe, it, expect, vi } from "vitest";
import { summarizeSession, writeDiaryAsync } from "../src/diary.js";
import { Metrics } from "../src/metrics.js";
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

  it("records diary.write.attempted + mcp_succeeded when mcp write resolves", async () => {
    const metrics = new Metrics();
    const mockMcp = {
      hasDiaryWrite: true,
      callTool: vi.fn().mockResolvedValue({}),
    };
    writeDiaryAsync(mockMcp as any, "summary", metrics);
    await new Promise((r) => setTimeout(r, 10));
    const snap = metrics.snapshot();
    expect(snap["diary.write.attempted"]).toBe(1);
    expect(snap["diary.write.mcp_succeeded"]).toBe(1);
    expect(snap["diary.write.mcp_failed"]).toBeUndefined();
    expect(snap["diary.write.fallback"]).toBeUndefined();
  });

  it("records diary.write.mcp_failed when mcp write rejects", async () => {
    const metrics = new Metrics();
    const mockMcp = {
      hasDiaryWrite: true,
      callTool: vi.fn().mockRejectedValue(new Error("boom")),
    };
    writeDiaryAsync(mockMcp as any, "summary", metrics);
    await new Promise((r) => setTimeout(r, 10));
    const snap = metrics.snapshot();
    expect(snap["diary.write.attempted"]).toBe(1);
    expect(snap["diary.write.mcp_failed"]).toBe(1);
  });

  it("falls back to JSONL when mcp write rejects (transient failure recovery)", async () => {
    const metrics = new Metrics();
    const mockMcp = {
      hasDiaryWrite: true,
      callTool: vi.fn().mockRejectedValue(new Error("boom")),
    };
    writeDiaryAsync(mockMcp as any, "summary", metrics);
    await new Promise((r) => setTimeout(r, 20));
    const snap = metrics.snapshot();
    expect(snap["diary.write.mcp_failed"]).toBe(1);
    expect(snap["diary.write.fallback"]).toBe(1);
  });

  it("records diary.write.fallback when hasDiaryWrite is false", async () => {
    const metrics = new Metrics();
    const mockMcp = {
      hasDiaryWrite: false,
      callTool: vi.fn(),
    };
    writeDiaryAsync(mockMcp as any, "summary", metrics);
    await new Promise((r) => setTimeout(r, 10));
    const snap = metrics.snapshot();
    expect(snap["diary.write.attempted"]).toBe(1);
    expect(snap["diary.write.fallback"]).toBe(1);
    expect(mockMcp.callTool).not.toHaveBeenCalled();
  });
});
