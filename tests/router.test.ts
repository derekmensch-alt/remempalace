import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "../src/router.js";
import { MemoryCache } from "../src/cache.js";
import { Metrics } from "../src/metrics.js";
import type { SearchResult } from "../src/types.js";

describe("MemoryRouter", () => {
  let mockMcp: { callTool: ReturnType<typeof vi.fn> };
  let router: MemoryRouter;

  beforeEach(() => {
    mockMcp = { callTool: vi.fn() };
    router = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
    });
  });

  it("calls MCP search on cache miss", async () => {
    mockMcp.callTool.mockResolvedValue({
      results: [{ text: "hit", wing: "w", room: "r", similarity: 0.5 }],
    });
    const result = await router.search("hello", 5);
    expect(mockMcp.callTool).toHaveBeenCalledWith(
      "mempalace_search",
      { query: "hello", limit: 5 },
      expect.any(Number),
    );
    expect(result).toHaveLength(1);
  });

  it("returns cached results on second call with same query", async () => {
    mockMcp.callTool.mockResolvedValue({
      results: [{ text: "hit", wing: "w", room: "r", similarity: 0.5 }],
    });
    await router.search("hello", 5);
    await router.search("hello", 5);
    expect(mockMcp.callTool).toHaveBeenCalledTimes(1);
  });

  it("filters out results below similarity threshold", async () => {
    mockMcp.callTool.mockResolvedValue({
      results: [
        { text: "high", wing: "w", room: "r", similarity: 0.5 },
        { text: "low", wing: "w", room: "r", similarity: 0.1 },
      ],
    });
    const result = await router.search("hello", 5);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("high");
  });

  it("records search miss → call → empty results in metrics", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      metrics,
    });
    mockMcp.callTool.mockResolvedValue({ results: [] });
    await r.search("query", 5);
    const snap = metrics.snapshot();
    expect(snap["recall.search.calls"]).toBe(1);
    expect(snap["recall.search.cache_misses"]).toBe(1);
    expect(snap["recall.search.empty_results"]).toBe(1);
  });

  it("records search cache hit on second call", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      metrics,
    });
    mockMcp.callTool.mockResolvedValue({
      results: [{ text: "x", wing: "w", room: "r", similarity: 0.5 }],
    });
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
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      metrics,
    });
    mockMcp.callTool.mockResolvedValue({});
    await r.kgQuery("Derek");
    const snap = metrics.snapshot();
    expect(snap["recall.kg.calls"]).toBe(1);
    expect(snap["recall.kg.cache_misses"]).toBe(1);
    expect(snap["recall.kg.empty_results"]).toBe(1);
  });

  it("records kg cache hit on second call", async () => {
    const metrics = new Metrics();
    const r = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
      metrics,
    });
    mockMcp.callTool.mockResolvedValue({ facts: [{ subject: "x", predicate: "y", object: "z" }] });
    await r.kgQuery("Derek");
    await r.kgQuery("Derek");
    const snap = metrics.snapshot();
    expect(snap["recall.kg.cache_hits"]).toBe(1);
    expect(snap["recall.kg.cache_misses"]).toBe(1);
  });

  it("fires search and KG query in parallel", async () => {
    const callOrder: string[] = [];
    mockMcp.callTool.mockImplementation(async (name: string) => {
      callOrder.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`end:${name}`);
      return name.includes("search") ? { results: [] } : {};
    });
    await router.readBundle("hello", 5);
    // Both should start before either ends
    expect(callOrder[0].startsWith("start:")).toBe(true);
    expect(callOrder[1].startsWith("start:")).toBe(true);
  });
});
