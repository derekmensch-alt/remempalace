import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "../src/router.js";
import { MemoryCache } from "../src/cache.js";
import { Metrics } from "../src/metrics.js";
import { BackendUnavailable } from "../src/ports/mempalace-repository.js";
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
    expect(mockRepository.searchMemory).toHaveBeenCalledWith({
      query: "hello",
      limit: 5,
      timeoutMs: 8000,
    });
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
    expect(mockRepository.queryKgEntity).toHaveBeenCalledWith({
      entity: "Derek",
      timeoutMs: 8000,
    });
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

  it("invalidates KG cache entries by normalized alias root", async () => {
    mockRepository.queryKgEntity
      .mockResolvedValueOnce({ facts: [{ subject: "MemPalace", predicate: "status", object: "old" }] })
      .mockResolvedValueOnce({ facts: [{ subject: "MemPalace", predicate: "status", object: "new" }] });

    await router.kgQuery("MemPalace project");
    router.deleteKgEntity("MemPalace");
    const fresh = await router.kgQuery("MemPalace project");

    expect(mockRepository.queryKgEntity).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual({
      facts: [{ subject: "MemPalace", predicate: "status", object: "new" }],
    });
  });

  it("invalidates timeout-negative KG cache entries by normalized alias root", async () => {
    mockRepository.queryKgEntity
      .mockRejectedValueOnce(new Error("deadline exceeded"))
      .mockResolvedValueOnce({ facts: [{ subject: "MemPalace", predicate: "status", object: "fresh" }] });

    await expect(router.kgQuery("MemPalace project")).resolves.toEqual({ facts: [] });
    router.deleteKgEntity("MemPalace");
    const fresh = await router.kgQuery("MemPalace project");

    expect(mockRepository.queryKgEntity).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual({
      facts: [{ subject: "MemPalace", predicate: "status", object: "fresh" }],
    });
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

  it("caps readBundle KG entity queries when multiple candidates are supplied", async () => {
    mockRepository.searchMemory.mockResolvedValue([]);
    mockRepository.queryKgEntity.mockResolvedValue({ facts: [] });

    await router.readBundle("compare project names", 5, {
      entityCandidates: ["Derek", "MemPalace", "remempalace"],
    });

    expect(mockRepository.queryKgEntity).toHaveBeenCalledTimes(2);
    expect(mockRepository.queryKgEntity).toHaveBeenNthCalledWith(1, {
      entity: "Derek",
      timeoutMs: 8000,
    });
    expect(mockRepository.queryKgEntity).toHaveBeenNthCalledWith(2, {
      entity: "MemPalace",
      timeoutMs: 8000,
    });
  });

  it("deduplicates readBundle KG candidates by normalized alias root", async () => {
    mockRepository.searchMemory.mockResolvedValue([]);
    mockRepository.queryKgEntity.mockResolvedValue({ facts: [] });

    await router.readBundle("tell me about mempalace and Derek", 5, {
      entityCandidates: ["MemPalace", "mempalace", "MemPalace project", "Derek"],
    });

    expect(mockRepository.queryKgEntity).toHaveBeenCalledTimes(2);
    expect(mockRepository.queryKgEntity).toHaveBeenNthCalledWith(1, {
      entity: "MemPalace",
      timeoutMs: 8000,
    });
    expect(mockRepository.queryKgEntity).toHaveBeenNthCalledWith(2, {
      entity: "Derek",
      timeoutMs: 8000,
    });
  });

  it("filters generic readBundle KG entity candidates", async () => {
    mockRepository.searchMemory.mockResolvedValue([]);
    mockRepository.queryKgEntity.mockResolvedValue({ facts: [] });

    await router.readBundle("what about this project memory", 5, {
      entityCandidates: ["project", "this", "it", "memory", "OpenClaw", "Derek", "remempalace"],
    });

    expect(mockRepository.queryKgEntity).toHaveBeenCalledTimes(2);
    expect(mockRepository.queryKgEntity).toHaveBeenNthCalledWith(1, {
      entity: "Derek",
      timeoutMs: 8000,
    });
    expect(mockRepository.queryKgEntity).toHaveBeenNthCalledWith(2, {
      entity: "remempalace",
      timeoutMs: 8000,
    });
  });

  it("keeps readBundle single entity KG query behavior", async () => {
    mockRepository.searchMemory.mockResolvedValue([]);
    mockRepository.queryKgEntity.mockResolvedValue({ facts: [] });

    await router.readBundle("who is Derek", 5, {
      entityCandidates: ["Derek"],
    });

    expect(mockRepository.queryKgEntity).toHaveBeenCalledTimes(1);
    expect(mockRepository.queryKgEntity).toHaveBeenCalledWith({
      entity: "Derek",
      timeoutMs: 8000,
    });
  });

  it("can read a KG-only bundle without semantic search", async () => {
    mockRepository.searchMemory.mockResolvedValue([
      { text: "should not be used", wing: "w", room: "r", similarity: 0.8 },
    ]);
    mockRepository.queryKgEntity.mockResolvedValue({
      facts: [{ subject: "remempalace", predicate: "phase", object: "3" }],
    });

    const bundle = await router.readBundle("continue the remempalace refactor", 5, {
      entityCandidates: ["remempalace", "MemPalace"],
      includeSearch: false,
      maxKgEntityQueries: 1,
    });

    expect(mockRepository.searchMemory).not.toHaveBeenCalled();
    expect(mockRepository.queryKgEntity).toHaveBeenCalledTimes(1);
    expect(mockRepository.queryKgEntity).toHaveBeenCalledWith({
      entity: "remempalace",
      timeoutMs: 8000,
    });
    expect(bundle.searchResults).toEqual([]);
    expect(bundle.kgResults).toEqual([
      { subject: "remempalace", predicate: "phase", object: "3" },
    ]);
  });

  it("passes router timeout to search and caches empty fallback on backend timeout", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      repository: mockRepository as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      callTimeoutMs: 250,
      metrics,
    });
    mockRepository.searchMemory.mockRejectedValueOnce(new BackendUnavailable(new Error("timed out")));

    await expect(r.search("q", 5)).resolves.toEqual([]);
    await expect(r.search("q", 5)).resolves.toEqual([]);

    expect(mockRepository.searchMemory).toHaveBeenCalledTimes(1);
    expect(mockRepository.searchMemory).toHaveBeenCalledWith({
      query: "q",
      limit: 5,
      timeoutMs: 250,
    });
    const snap = metrics.snapshot();
    expect(snap["recall.search.timeout_negative_cached"]).toBe(1);
    expect(snap["recall.search.cache_hits"]).toBe(1);
  });

  it("does not negative-cache non-timeout backend failures", async () => {
    const r = new MemoryRouter({
      repository: mockRepository as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      callTimeoutMs: 250,
    });
    mockRepository.searchMemory
      .mockRejectedValueOnce(new BackendUnavailable(new Error("MCP process died")))
      .mockResolvedValueOnce([{ text: "fresh", wing: "w", room: "r", similarity: 0.8 }]);

    await expect(r.search("q", 5)).rejects.toBeInstanceOf(BackendUnavailable);
    await expect(r.search("q", 5)).resolves.toEqual([
      { text: "fresh", wing: "w", room: "r", similarity: 0.8 },
    ]);

    expect(mockRepository.searchMemory).toHaveBeenCalledTimes(2);
  });

  it("passes router timeout to KG and caches empty fallback on backend timeout", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      repository: mockRepository as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      callTimeoutMs: 250,
      metrics,
    });
    mockRepository.queryKgEntity.mockRejectedValueOnce(new Error("deadline exceeded"));

    await expect(r.kgQuery("Derek")).resolves.toEqual({ facts: [] });
    await expect(r.kgQuery("Derek")).resolves.toEqual({ facts: [] });

    expect(mockRepository.queryKgEntity).toHaveBeenCalledTimes(1);
    expect(mockRepository.queryKgEntity).toHaveBeenCalledWith({
      entity: "Derek",
      timeoutMs: 250,
    });
    const snap = metrics.snapshot();
    expect(snap["recall.kg.timeout_negative_cached"]).toBe(1);
    expect(snap["recall.kg.cache_hits"]).toBe(1);
  });

  it("expires timeout negative cache entries with the normal cache TTL", async () => {
    vi.useFakeTimers();
    try {
      const r = new MemoryRouter({
        repository: mockRepository as any,
        searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
        kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
        similarityThreshold: 0.25,
        callTimeoutMs: 250,
      });
      mockRepository.searchMemory
        .mockRejectedValueOnce(new Error("request timeout"))
        .mockResolvedValueOnce([{ text: "fresh", wing: "w", room: "r", similarity: 0.8 }]);

      await expect(r.search("q", 5)).resolves.toEqual([]);
      await vi.advanceTimersByTimeAsync(1001);

      await expect(r.search("q", 5)).resolves.toEqual([
        { text: "fresh", wing: "w", room: "r", similarity: 0.8 },
      ]);
      expect(mockRepository.searchMemory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
