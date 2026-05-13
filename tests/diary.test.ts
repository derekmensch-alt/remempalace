import { describe, it, expect, vi } from "vitest";
import { summarizeSession, writeDiaryAsync } from "../src/diary.js";
import { Metrics } from "../src/metrics.js";
import { countTokens } from "../src/token-counter.js";
import type { AgentMessage } from "../src/types-messages.js";

describe("summarizeSession", () => {
  it("returns valid JSON for a normal session", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "update TODO" },
      { role: "assistant", content: "done" },
    ];
    const out = summarizeSession(messages, { maxTokens: 500 });
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.turns).toBe(4);
  });

  it("captures goals from early user turns", () => {
    const messages = [
      { role: "user", content: "I want to refactor the login flow" },
      { role: "assistant", content: "Sure." },
      { role: "user", content: "second user message" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third user message" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "late user message not in goals" },
    ];
    const out = summarizeSession(messages, { maxTokens: 1000 });
    const parsed = JSON.parse(out);
    expect(parsed.goals).toContain("I want to refactor the login flow");
    expect(parsed.goals).not.toContain("late user message not in goals");
  });

  it("captures important decision from last assistant turn in decisions", () => {
    const messages = [
      { role: "user", content: "what should we do?" },
      { role: "assistant", content: "early unimportant response" },
      { role: "user", content: "and the final answer?" },
      { role: "assistant", content: "The final decision is to use PostgreSQL" },
    ];
    const out = summarizeSession(messages, { maxTokens: 1000 });
    const parsed = JSON.parse(out);
    expect(parsed.decisions.some((d: string) => d.includes("The final decision is to use PostgreSQL"))).toBe(true);
  });

  it("extracts facts from user turns matching fact patterns", () => {
    const messages = [
      { role: "user", content: "I use TypeScript. My project is a CLI tool." },
      { role: "assistant", content: "Great." },
    ];
    const out = summarizeSession(messages, { maxTokens: 1000 });
    const parsed = JSON.parse(out);
    expect(parsed.facts_to_remember.some((f: string) => /typescript/i.test(f))).toBe(true);
  });

  it("extracts open threads from last 2 user turns", () => {
    const messages = [
      { role: "user", content: "let's start" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "TODO: handle error cases" },
      { role: "assistant", content: "noted" },
    ];
    const out = summarizeSession(messages, { maxTokens: 1000 });
    const parsed = JSON.parse(out);
    expect(parsed.open_threads.some((t: string) => /TODO/i.test(t))).toBe(true);
  });

  it("respects maxTokens budget by dropping fields", () => {
    // Use a generous-content session with a tight-but-achievable budget
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    // With maxTokens=50 the arrays should be stripped down to minimum
    const outTight = summarizeSession(messages, { maxTokens: 50 });
    const parsedTight = JSON.parse(outTight);
    // Budget-trimming drops open_threads first, then facts, then decisions, then goals
    // With a tiny budget the arrays should be empty or minimal
    expect(parsedTight.open_threads.length).toBe(0);
    expect(parsedTight.facts_to_remember.length).toBe(0);

    // With a generous budget nothing is dropped
    const outGenerous = summarizeSession(messages, { maxTokens: 1000 });
    const parsedGenerous = JSON.parse(outGenerous);
    expect(parsedGenerous.turns).toBe(10);
  });

  it("returns empty string for empty session", () => {
    expect(summarizeSession([], { maxTokens: 200 })).toBe("");
  });
});

describe("writeDiaryAsync", () => {
  it("returns an awaitable promise that settles after the diary write", async () => {
    let resolveWrite!: () => void;
    const mockMcp = {
      canPersistDiary: true,
      writeDiary: vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
        resolveWrite = resolve;
      })),
    };

    let settled = false;
    const pending = writeDiaryAsync(mockMcp as any, "summary content").then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveWrite();
    await pending;
    expect(settled).toBe(true);
  });

  it("swallows errors silently", async () => {
    const mockMcp = {
      canPersistDiary: true,
      writeDiary: vi.fn().mockRejectedValue(new Error("boom")),
    };
    await expect(writeDiaryAsync(mockMcp as any, "summary")).resolves.toBeUndefined();
  });

  it("records diary.write.attempted + mcp_succeeded when verified mcp write resolves", async () => {
    const metrics = new Metrics();
    const mockMcp = {
      canPersistDiary: true,
      writeDiary: vi.fn().mockResolvedValue({}),
    };
    await writeDiaryAsync(mockMcp as any, "summary", metrics);
    const snap = metrics.snapshot();
    expect(snap["diary.write.attempted"]).toBe(1);
    expect(snap["diary.write.mcp_succeeded"]).toBe(1);
    expect(snap["diary.write.mcp_failed"]).toBeUndefined();
    expect(snap["diary.write.fallback"]).toBeUndefined();
  });

  it("records diary.write.mcp_failed when mcp write rejects", async () => {
    const metrics = new Metrics();
    const mockMcp = {
      canPersistDiary: true,
      writeDiary: vi.fn().mockRejectedValue(new Error("boom")),
    };
    await writeDiaryAsync(mockMcp as any, "summary", metrics);
    const snap = metrics.snapshot();
    expect(snap["diary.write.attempted"]).toBe(1);
    expect(snap["diary.write.mcp_failed"]).toBe(1);
  });

  it("falls back to JSONL when mcp write rejects (transient failure recovery)", async () => {
    const metrics = new Metrics();
    const mockMcp = {
      canPersistDiary: true,
      writeDiary: vi.fn().mockRejectedValue(new Error("boom")),
    };
    await writeDiaryAsync(mockMcp as any, "summary", metrics);
    const snap = metrics.snapshot();
    expect(snap["diary.write.mcp_failed"]).toBe(1);
    expect(snap["diary.write.fallback"]).toBe(1);
  });

  it("records diary.write.fallback when canPersistDiary is false", async () => {
    const metrics = new Metrics();
    const mockMcp = {
      canPersistDiary: false,
      writeDiary: vi.fn(),
    };
    await writeDiaryAsync(mockMcp as any, "summary", metrics);
    const snap = metrics.snapshot();
    expect(snap["diary.write.attempted"]).toBe(1);
    expect(snap["diary.write.persistence_unverified"]).toBe(1);
    expect(snap["diary.write.fallback"]).toBe(1);
    expect(mockMcp.writeDiary).not.toHaveBeenCalled();
  });
});
