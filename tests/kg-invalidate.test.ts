import { describe, it, expect, vi, beforeEach } from "vitest";
import { KgBatcher } from "../src/kg.js";

function makeRepository(overrides: Record<string, unknown> = {}) {
  return {
    canInvalidateKg: true,
    queryKgEntity: vi.fn().mockResolvedValue({}),
    addKgFact: vi.fn().mockResolvedValue({}),
    invalidateKgFact: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe("KgBatcher invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flag off: never calls kg_invalidate or kg_query", async () => {
    const repository = makeRepository();
    const batcher = new KgBatcher(repository as any, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: false,
    });
    batcher.add({ subject: "Derek", predicate: "favorite_model", object: "Kimi K3.0" });
    await batcher.flush();

    expect(repository.queryKgEntity).not.toHaveBeenCalled();
    expect(repository.invalidateKgFact).not.toHaveBeenCalled();
    expect(repository.addKgFact).toHaveBeenCalled();
    await batcher.stop();
  });

  it("flag on but upstream broken: no invalidation calls", async () => {
    const repository = makeRepository({ canInvalidateKg: false });
    const batcher = new KgBatcher(repository as any, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: true,
    });
    batcher.add({ subject: "Derek", predicate: "favorite_model", object: "Kimi K3.0" });
    await batcher.flush();

    expect(repository.invalidateKgFact).not.toHaveBeenCalled();
    expect(repository.queryKgEntity).not.toHaveBeenCalled();
    await batcher.stop();
  });

  it("flag on + upstream healthy: invalidates stale facts before adding", async () => {
    const repository = makeRepository({
      queryKgEntity: vi.fn().mockResolvedValue({
        facts: [
          { subject: "Derek", predicate: "favorite_model", object: "Kimi K2.5", current: true },
        ],
      }),
    });

    const batcher = new KgBatcher(repository as any, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: true,
    });
    batcher.add({ subject: "Derek", predicate: "favorite_model", object: "Kimi K3.0" });
    await batcher.flush();

    expect(repository.invalidateKgFact).toHaveBeenCalledWith({
      subject: "Derek",
      predicate: "favorite_model",
      object: "Kimi K2.5",
    });
    expect(repository.addKgFact).toHaveBeenCalledWith(expect.objectContaining({ object: "Kimi K3.0" }));
    await batcher.stop();
  });

  it("list-cardinality predicate (uses): never invalidates even with different object", async () => {
    const repository = makeRepository({
      queryKgEntity: vi.fn().mockResolvedValue({
        facts: [
          { subject: "Derek", predicate: "uses", object: "OpenClaw", current: true },
        ],
      }),
    });

    const batcher = new KgBatcher(repository as any, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: true,
    });
    batcher.add({ subject: "Derek", predicate: "uses", object: "Vitest" });
    await batcher.flush();

    expect(repository.invalidateKgFact).not.toHaveBeenCalled();
    expect(repository.queryKgEntity).not.toHaveBeenCalled();
    await batcher.stop();
  });

  it("same object: does NOT call kg_invalidate", async () => {
    const repository = makeRepository({
      queryKgEntity: vi.fn().mockResolvedValue({
        facts: [
          { subject: "Derek", predicate: "favorite_model", object: "Kimi K2.5", current: true },
        ],
      }),
    });

    const batcher = new KgBatcher(repository as any, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: true,
    });
    batcher.add({ subject: "Derek", predicate: "favorite_model", object: "Kimi K2.5" });
    await batcher.flush();

    expect(repository.invalidateKgFact).not.toHaveBeenCalled();
    await batcher.stop();
  });
});
