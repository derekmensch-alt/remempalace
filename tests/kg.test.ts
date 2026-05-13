import { describe, it, expect, vi } from "vitest";
import { extractFacts, KgBatcher } from "../src/kg.js";
import { Metrics } from "../src/metrics.js";

function makeRepository() {
  return {
    canInvalidateKg: true,
    queryKgEntity: vi.fn().mockResolvedValue({}),
    addKgFact: vi.fn().mockResolvedValue({}),
    invalidateKgFact: vi.fn().mockResolvedValue({}),
  };
}

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
    const mockRepository = makeRepository();
    const batcher = new KgBatcher(mockRepository as any, { batchSize: 2, flushIntervalMs: 10000 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    expect(mockRepository.addKgFact).not.toHaveBeenCalled();
    batcher.add({ subject: "B", predicate: "p", object: "2" });
    await new Promise((r) => setTimeout(r, 5));
    expect(mockRepository.addKgFact).toHaveBeenCalledTimes(2);
    await batcher.stop();
  });

  it("flushes on timer if batch not full", async () => {
    const mockRepository = makeRepository();
    const batcher = new KgBatcher(mockRepository as any, { batchSize: 10, flushIntervalMs: 20 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    await new Promise((r) => setTimeout(r, 40));
    expect(mockRepository.addKgFact).toHaveBeenCalled();
    await batcher.stop();
  });

  it("coalesces duplicates in the same batch", async () => {
    const mockRepository = makeRepository();
    const batcher = new KgBatcher(mockRepository as any, { batchSize: 3, flushIntervalMs: 10000 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    await new Promise((r) => setTimeout(r, 5));
    expect(mockRepository.addKgFact).toHaveBeenCalledTimes(1);
    await batcher.stop();
  });

  it("records kg.facts.batched on add and kg.facts.flushed on flush", async () => {
    const metrics = new Metrics();
    const mockRepository = makeRepository();
    const batcher = new KgBatcher(mockRepository as any, {
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
    const mockRepository = makeRepository();
    const batcher = new KgBatcher(mockRepository as any, {
      batchSize: 5,
      flushIntervalMs: 10000,
      metrics,
    });
    await batcher.stop();
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    expect(metrics.snapshot()["kg.facts.batched"]).toBeUndefined();
  });

  it("passes source_closet provenance through to addKgFact", async () => {
    const mockRepository = makeRepository();
    const batcher = new KgBatcher(mockRepository as any, { batchSize: 1, flushIntervalMs: 10000 });

    batcher.add({
      subject: "Derek",
      predicate: "uses",
      object: "OpenClaw",
      source_closet: "openclaw:user",
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(mockRepository.addKgFact).toHaveBeenCalledWith(
      expect.objectContaining({ source_closet: "openclaw:user" }),
    );
    await batcher.stop();
  });
});
