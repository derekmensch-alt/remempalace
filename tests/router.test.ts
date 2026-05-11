import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "../src/router.js";
import { MemoryCache } from "../src/cache.js";
import { Metrics } from "../src/metrics.js";
import type { SearchResult } from "../src/types.js";

describe("MemoryRouter", () => {
  let mockRepository: { searchMemory: ReturnType<typeof vi.fn>; queryKgEntity: ReturnType<typeof vi.fn> };
  let router: MemoryRouter;

  beforeEach(() => {
    mockRepository = { searchMemory: vi.fn(), queryKgEntity: vi.fn() };
    router = new MemoryRouter({
      repository: mockRepository as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
    });
  });

  it("calls repository search on cache miss", async () => {
    mockRepository.searchMemory.mockResolvedValue([
      { text: "hit", wing: "w", room: "r", similarity: 0.5 },
    ]);
    const result = await router.search("hello", 5);
    expect(mockRepository.searchMemory).toHaveBeenCalledWith({ query: "hello", limit: 5 });
    expect(result).toHaveLength(1);
  });

  it("returns cached results on second call with same query", async () => {
    mockRepository.searchMemory.mockResolvedValue([
      { text: "hit", wing: "w", room: "r", similarity: 0.5 },
    ]);
    await router.search("hello", 5);
    await router.search("hello", 5);
    expect(mockRepository.searchMemory).toHaveBeenCalledTimes(1);
  });

  it("filters out results below similarity threshold", async () => {
    mockRepository.searchMemory.mockResolvedValue([
      { text: "high", wing: "w", room: "r", similarity: 0.5 },
      { text: "low", wing: "w", room: "r", similarity: 0.1 },
    ]);
    const result = await router.search("hello", 5);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("high");
  });

  it("records search miss → call → empty results in metrics", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      repository: mockRepository as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      metrics,
    });
    mockRepository.searchMemory.mockResolvedValue([]);
    await r.search("query", 5);
    const snap = metrics.snapshot();
    expect(snap["recall.search.calls"]).toBe(1);
    expect(snap["recall.search.cache_misses"]).toBe(1);
    expect(snap["recall.search.empty_results"]).toBe(1);
  });

  it("records search cache hit on second call", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      repository: mockRepository as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      metrics,
    });
    mockRepository.searchMemory.mockResolvedValue([
      { text: "x", wing: "w", room: "r", similarity: 0.5 },
    ]);
    await r.search("q", 5);
    await r.search("q", 5);
    const snap = metrics.snapshot();
    expect(snap["recall.search.calls"]).toBe(2);
    expect(snap["recall.search.cache_hits"]).toBe(1);
    expect(snap["recall.search.cache_misses"]).toBe(1);
  });

  it("records kg cache miss + call + empty result", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      repository: mockRepository as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      metrics,
    });
    mockRepository.queryKgEntity.mockResolvedValue({});
    await r.kgQuery("Derek");
    expect(mockRepository.queryKgEntity).toHaveBeenCalledWith({ entity: "Derek" });
    const snap = metrics.snapshot();
    expect(snap["recall.kg.calls"]).toBe(1);
    expect(snap["recall.kg.cache_misses"]).toBe(1);
    expect(snap["recall.kg.empty_results"]).toBe(1);
  });

  it("records kg cache hit on second call", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      repository: mockRepository as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      metrics,
    });
    mockRepository.queryKgEntity.mockResolvedValue({ facts: [{ subject: "x", predicate: "y", object: "z" }] });
    await r.kgQuery("Derek");
    await r.kgQuery("Derek");
    const snap = metrics.snapshot();
    expect(snap["recall.kg.cache_hits"]).toBe(1);
    expect(snap["recall.kg.cache_misses"]).toBe(1);
  });

  it("fires search and KG query in parallel", async () => {
    const callOrder: string[] = [];
    mockRepository.searchMemory.mockImplementation(async () => {
      callOrder.push("start:mempalace_search");
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push("end:mempalace_search");
      return [];
    });
    mockRepository.queryKgEntity.mockImplementation(async (request: { entity: string }) => {
      callOrder.push(`start:${request.entity}`);
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`end:${request.entity}`);
      return {};
    });
    await router.readBundle("hello", 5);
    // Both should start before either ends
    expect(callOrder[0].startsWith("start:")).toBe(true);
    expect(callOrder[1].startsWith("start:")).toBe(true);
  });
});
