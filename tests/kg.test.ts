import { describe, it, expect, vi } from "vitest";
import { extractFacts, KgBatcher } from "../src/kg.js";
import { Metrics } from "../src/metrics.js";

describe("extractFacts", () => {
  it("extracts SUBJ is PRED OBJ patterns", () => {
    const text = "Derek's favorite model is Kimi K2.5.";
    const facts = extractFacts(text);
    expect(facts.length).toBeGreaterThan(0);
  });

  it("extracts SUBJ uses OBJ patterns", () => {
    const text = "Derek uses OpenClaw as his daily driver.";
    const facts = extractFacts(text);
    expect(facts).toContainEqual(
      expect.objectContaining({
        subject: "Derek",
        predicate: "uses",
        object: "OpenClaw",
      }),
    );
  });

  it("returns empty array for text with no recognizable patterns", () => {
    const facts = extractFacts("hello there how are you");
    expect(facts).toEqual([]);
  });

  it("deduplicates facts across a single extraction run", () => {
    const text = "Derek uses OpenClaw. Derek uses OpenClaw daily.";
    const facts = extractFacts(text);
    const openclawFacts = facts.filter(
      (f) => f.subject === "Derek" && f.object === "OpenClaw",
    );
    expect(openclawFacts).toHaveLength(1);
  });
});

describe("KgBatcher", () => {
  it("flushes when batch size is reached", async () => {
    const mockMcp = { callTool: vi.fn().mockResolvedValue({}) };
    const batcher = new KgBatcher(mockMcp as any, { batchSize: 2, flushIntervalMs: 10000 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    expect(mockMcp.callTool).not.toHaveBeenCalled();
    batcher.add({ subject: "B", predicate: "p", object: "2" });
    await new Promise((r) => setTimeout(r, 5));
    expect(mockMcp.callTool).toHaveBeenCalledTimes(2);
    await batcher.stop();
  });

  it("flushes on timer if batch not full", async () => {
    const mockMcp = { callTool: vi.fn().mockResolvedValue({}) };
    const batcher = new KgBatcher(mockMcp as any, { batchSize: 10, flushIntervalMs: 20 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    await new Promise((r) => setTimeout(r, 40));
    expect(mockMcp.callTool).toHaveBeenCalled();
    await batcher.stop();
  });

  it("coalesces duplicates in the same batch", async () => {
    const mockMcp = { callTool: vi.fn().mockResolvedValue({}) };
    const batcher = new KgBatcher(mockMcp as any, { batchSize: 3, flushIntervalMs: 10000 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    await new Promise((r) => setTimeout(r, 5));
    expect(mockMcp.callTool).toHaveBeenCalledTimes(1);
    await batcher.stop();
  });

  it("records kg.facts.batched on add and kg.facts.flushed on flush", async () => {
    const metrics = new Metrics();
    const mockMcp = { callTool: vi.fn().mockResolvedValue({}) };
    const batcher = new KgBatcher(mockMcp as any, {
      batchSize: 2,
      flushIntervalMs: 10000,
      metrics,
    });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    batcher.add({ subject: "B", predicate: "p", object: "2" });
    await new Promise((r) => setTimeout(r, 5));
    const snap = metrics.snapshot();
    expect(snap["kg.facts.batched"]).toBe(2);
    expect(snap["kg.facts.flushed"]).toBe(2);
    await batcher.stop();
  });

  it("does not increment kg.facts.batched when stopped", async () => {
    const metrics = new Metrics();
    const mockMcp = { callTool: vi.fn().mockResolvedValue({}) };
    const batcher = new KgBatcher(mockMcp as any, {
      batchSize: 5,
      flushIntervalMs: 10000,
      metrics,
    });
    await batcher.stop();
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    expect(metrics.snapshot()["kg.facts.batched"]).toBeUndefined();
  });
});
