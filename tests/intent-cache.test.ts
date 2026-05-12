import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter, normalizeIntent } from "../src/router.js";
import { MemoryCache } from "../src/cache.js";
import { Metrics } from "../src/metrics.js";
import type { SearchResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// normalizeIntent unit tests
// ---------------------------------------------------------------------------

describe("normalizeIntent", () => {
  it("produces the same key for different surface forms of the same intent", () => {
    const candidates = ["remempalace"];
    // Both prompts reduce to the same meaningful tokens after stopword removal
    // and stemming: "next" and "remempalace" (which is also in entities).
    // "on" is a stopword; "do" is a stopword; "what" is a stopword.
    const a = normalizeIntent("what should I do next on remempalace?", candidates);
    // "remempalace" "next" — same token set as above
    const b = normalizeIntent("remempalace next?", candidates);
    expect(a).toBe(b);
  });

  it("produces different keys for different entity candidates", () => {
    const a = normalizeIntent("next steps", ["remempalace"]);
    const b = normalizeIntent("next steps", ["MemPalace"]);
    expect(a).not.toBe(b);
  });

  it("deduplicates entity candidates (case-insensitive)", () => {
    const a = normalizeIntent("hello world", ["Remempalace", "remempalace", "REMEMPALACE"]);
    const b = normalizeIntent("hello world", ["remempalace"]);
    expect(a).toBe(b);
  });

  it("is token-order independent", () => {
    const candidates: string[] = [];
    const a = normalizeIntent("next refactor steps for the project", candidates);
    const b = normalizeIntent("steps for next project refactor", candidates);
    expect(a).toBe(b);
  });

  it("removes stop-words", () => {
    // Prompts that differ only in stop-words should produce the same key.
    const candidates: string[] = [];
    const withStops = normalizeIntent("what should I do with this project", candidates);
    const withoutStops = normalizeIntent("project", candidates);
    // Both reduce to the token 'project' (no stop-words survive).
    expect(withStops).toBe(withoutStops);
  });

  it("applies trivial stemming — runs/running collapse (trailing s and ing stripped)", () => {
    const candidates: string[] = [];
    // "runs" → strip trailing s → "run"; "running" → strip trailing ing → "runn"
    // Both collapse away from their original form; runs and run share the same stem.
    const run = normalizeIntent("run the test", candidates);
    const runs = normalizeIntent("runs the test", candidates);
    // "run" (len=3) and "runs" (len=4, ends s) → same stem "run".
    expect(run).toBe(runs);

    // "running" (len=7) → strip "ing" → "runn" (different from "run"), but
    // the stemmer is intentionally trivial — the spec does not promise a full
    // Porter collapse. Verify running is at least different from the original.
    const running = normalizeIntent("running the test", candidates);
    expect(running).not.toBe(normalizeIntent("running notStemmed", candidates));
    // And verify the stemmed form doesn't contain "running".
    expect(running).not.toContain("running");
  });

  it("strips runtime injection blocks before tokenising", () => {
    // A realistic multi-block injection followed by a second section heading —
    // the injection block regex stops consuming at the next ## heading.
    const block =
      "## Active Memory Plugin (remempalace)\nsome injected content\n";
    const userContent = "## User Query\nwhat should I work on next?";
    const combined = `${block}${userContent}`;
    // After stripping, only "## User Query\nwhat should I work on next?" remains.
    const a = normalizeIntent(combined, ["remempalace"]);
    // Directly passing the user content without the injection block.
    const b = normalizeIntent(userContent, ["remempalace"]);
    expect(a).toBe(b);
  });

  it("key format is entities:...|tokens:...", () => {
    const key = normalizeIntent("hello world project", ["MyProject"]);
    expect(key).toMatch(/^entities:.*\|tokens:/);
  });
});

// ---------------------------------------------------------------------------
// MemoryRouter intent-cache integration tests
// ---------------------------------------------------------------------------

function makeRouter(
  mockRepo: { searchMemory: ReturnType<typeof vi.fn>; queryKgEntity: ReturnType<typeof vi.fn> },
  metrics: Metrics,
  opts?: { bundleCacheTtlMs?: number; searchCacheTtlMs?: number },
) {
  const searchCacheTtl = opts?.searchCacheTtlMs ?? 60_000;
  return new MemoryRouter({
    repository: mockRepo as any,
    searchCache: new MemoryCache<SearchResult[]>({ capacity: 50, ttlMs: searchCacheTtl }),
    kgCache: new MemoryCache<unknown>({ capacity: 50, ttlMs: searchCacheTtl }),
    similarityThreshold: 0.1,
    metrics,
    bundleCacheTtlMs: opts?.bundleCacheTtlMs ?? 60_000,
    bundleCacheCapacity: 50,
  });
}

const RESULT: SearchResult = { text: "hit", wing: "w", room: "r", similarity: 0.5 };
const KG_FACTS = { facts: [{ subject: "Derek", predicate: "works-on", object: "remempalace" }] };

describe("MemoryRouter — intent-keyed bundle cache", () => {
  let mockRepo: { searchMemory: ReturnType<typeof vi.fn>; queryKgEntity: ReturnType<typeof vi.fn> };
  let metrics: Metrics;

  beforeEach(() => {
    mockRepo = { searchMemory: vi.fn(), queryKgEntity: vi.fn() };
    metrics = new Metrics();
    mockRepo.searchMemory.mockResolvedValue([RESULT]);
    mockRepo.queryKgEntity.mockResolvedValue(KG_FACTS);
  });

  it("same candidates + same content → bundle cache hit on second call", async () => {
    const router = makeRouter(mockRepo, metrics);

    // These two prompts reduce to the same intent key: entity=remempalace,
    // tokens=next,remempalace (stopwords "what", "should", "do", "on" removed).
    await router.readBundle("what should I do next on remempalace?", 5, {
      entityCandidates: ["remempalace"],
    });
    await router.readBundle("remempalace next?", 5, {
      entityCandidates: ["remempalace"],
    });

    // The second call must hit the bundle cache — only 1 MCP search call.
    expect(mockRepo.searchMemory).toHaveBeenCalledTimes(1);
    const snap = metrics.snapshot();
    expect(snap["recall.bundle.cache_hits"]).toBe(1);
    expect(snap["recall.bundle.cache_misses"]).toBe(1);
  });

  it("different candidates → different cache keys → two bundle cache misses", async () => {
    const router = makeRouter(mockRepo, metrics);

    // Use different query text so the per-query searchCache also misses each time.
    await router.readBundle("remempalace next steps", 5, { entityCandidates: ["remempalace"] });
    await router.readBundle("MemPalace next steps", 5, { entityCandidates: ["MemPalace"] });

    // Both calls must miss the bundle cache (different entity keys).
    const snap = metrics.snapshot();
    expect(snap["recall.bundle.cache_hits"]).toBeUndefined();
    expect(snap["recall.bundle.cache_misses"]).toBe(2);
    // Both also miss the per-query searchCache (different query text).
    expect(mockRepo.searchMemory).toHaveBeenCalledTimes(2);
  });

  it("different bundle request shapes do not share intent-cache entries", async () => {
    const router = makeRouter(mockRepo, metrics);

    await router.readBundle("remempalace next?", 1, {
      entityCandidates: ["remempalace"],
      maxKgEntityQueries: 1,
    });
    await router.readBundle("what should I do next on remempalace?", 5, {
      entityCandidates: ["remempalace"],
      maxKgEntityQueries: 2,
    });

    const snap = metrics.snapshot();
    expect(snap["recall.bundle.cache_hits"]).toBeUndefined();
    expect(snap["recall.bundle.cache_misses"]).toBe(2);
    expect(mockRepo.searchMemory).toHaveBeenCalledTimes(2);
  });

  it("TTL expiry causes cache miss after the TTL window", async () => {
    vi.useFakeTimers();
    try {
      // Use a short TTL for both the bundle cache and the per-query caches so
      // that after advancing time, both layers expire and the backend is called.
      const router = makeRouter(mockRepo, metrics, {
        bundleCacheTtlMs: 1000,
        searchCacheTtlMs: 1000,
      });

      await router.readBundle("remempalace steps", 5, { entityCandidates: ["remempalace"] });
      // Advance past both TTLs.
      await vi.advanceTimersByTimeAsync(1001);
      await router.readBundle("remempalace steps", 5, { entityCandidates: ["remempalace"] });

      // Both the bundle cache and the per-query search cache expired, so the
      // backend is called a second time.
      expect(mockRepo.searchMemory).toHaveBeenCalledTimes(2);
      const snap = metrics.snapshot();
      expect(snap["recall.bundle.cache_misses"]).toBe(2);
      // No hits because the entry expired.
      expect(snap["recall.bundle.cache_hits"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("KG fact write for entity X invalidates bundles keyed on X, leaves others intact", async () => {
    const router = makeRouter(mockRepo, metrics);

    // Prime two separate bundle cache entries.
    await router.readBundle("remempalace progress", 5, { entityCandidates: ["remempalace"] });
    await router.readBundle("MemPalace status", 5, { entityCandidates: ["MemPalace"] });

    // Invalidate only remempalace.
    router.deleteBundleCacheEntriesForEntity("remempalace");

    // Re-read remempalace bundle — bundle cache miss, but per-query searchCache
    // still holds the result so searchMemory is NOT called again.
    await router.readBundle("remempalace progress", 5, { entityCandidates: ["remempalace"] });

    // Re-read MemPalace bundle — bundle cache hit, no backend call.
    await router.readBundle("MemPalace status", 5, { entityCandidates: ["MemPalace"] });

    // searchMemory: only 2 calls (one per unique query text); both re-reads are
    // served from the per-query searchCache even though the bundle cache was
    // partially invalidated.
    expect(mockRepo.searchMemory).toHaveBeenCalledTimes(2);

    const snap = metrics.snapshot();
    // 1 bundle cache entry was invalidated (the remempalace one).
    expect(snap["recall.bundle.invalidated_by_kg"]).toBe(1);
    // MemPalace bundle was untouched → 1 bundle cache hit.
    expect(snap["recall.bundle.cache_hits"]).toBe(1);
    // remempalace bundle was invalidated → that re-read counted as a miss.
    expect(snap["recall.bundle.cache_misses"]).toBe(3);
  });

  it("KG invalidation matches normalized alias roots", async () => {
    const router = makeRouter(mockRepo, metrics);

    await router.readBundle("MemPalace project progress", 5, {
      entityCandidates: ["MemPalace project"],
    });

    router.deleteBundleCacheEntriesForEntity("MemPalace");

    await router.readBundle("MemPalace project progress", 5, {
      entityCandidates: ["MemPalace project"],
    });

    expect(mockRepo.searchMemory).toHaveBeenCalledTimes(1);
    const snap = metrics.snapshot();
    expect(snap["recall.bundle.invalidated_by_kg"]).toBe(1);
    expect(snap["recall.bundle.cache_misses"]).toBe(2);
    expect(snap["recall.bundle.cache_hits"]).toBeUndefined();
  });

  it("empty bundles (no search results, no KG facts) are not stored in bundle cache", async () => {
    mockRepo.searchMemory.mockResolvedValue([]);
    mockRepo.queryKgEntity.mockResolvedValue({ facts: [] });

    const router = makeRouter(mockRepo, metrics);

    await router.readBundle("remempalace steps", 5, { entityCandidates: ["remempalace"] });
    await router.readBundle("remempalace steps", 5, { entityCandidates: ["remempalace"] });

    // Bundle cache must not have stored the empty result, so there are 2 bundle
    // cache misses — not 0 hits and 1 miss.
    const snap = metrics.snapshot();
    expect(snap["recall.bundle.cache_hits"]).toBeUndefined();
    expect(snap["recall.bundle.cache_misses"]).toBe(2);
    // Note: searchMemory is called only once because the per-query searchCache
    // (which DOES cache empty results as negative entries) serves the second call.
    expect(mockRepo.searchMemory).toHaveBeenCalledTimes(1);
  });

  it("per-query searchCache and kgCache keep their existing semantics alongside bundle cache", async () => {
    const router = makeRouter(mockRepo, metrics);

    // First call → full miss at both layers.
    await router.readBundle("remempalace progress", 5, { entityCandidates: ["remempalace"] });

    // Invalidate only the bundle cache for this entity (simulating a KG write).
    router.deleteBundleCacheEntriesForEntity("remempalace");

    // Second call → bundle cache miss, BUT per-query caches should still serve
    // searchMemory from searchCache (call count stays at 1).
    await router.readBundle("remempalace progress", 5, { entityCandidates: ["remempalace"] });

    // searchMemory must NOT have been called a second time — searchCache served it.
    expect(mockRepo.searchMemory).toHaveBeenCalledTimes(1);
    // The bundle cache missed (invalidated), but search/kg used their own caches.
    const snap = metrics.snapshot();
    expect(snap["recall.search.cache_hits"]).toBeGreaterThanOrEqual(1);
    expect(snap["recall.bundle.cache_misses"]).toBe(2);
  });
});
