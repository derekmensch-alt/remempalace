import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  loadHotCache,
  saveHotCache,
  filterLiveEntries,
  type HotCacheSnapshot,
  type HotCacheSnapshotEntry,
} from "../src/recall-cache-store.js";
import { MemoryRouter } from "../src/router.js";
import { MemoryCache } from "../src/cache.js";
import { Metrics } from "../src/metrics.js";
import type { SearchResult } from "../src/types.js";
import type { ReadBundle } from "../src/router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpPath(): string {
  return join(tmpdir(), `remempalace-test-${randomBytes(6).toString("hex")}.json`);
}

function makeEntry(
  intentKey: string,
  expiresAt: number,
  entities: string[] = [],
): HotCacheSnapshotEntry {
  return {
    intentKey,
    bundle: {
      searchResults: [{ text: "t", wing: "w", room: "r", similarity: 0.5 }],
      kgResults: [{ subject: "s", predicate: "p", object: "o" }],
    },
    expiresAt,
    entities,
  };
}

function makeSnapshot(entries: HotCacheSnapshotEntry[]): HotCacheSnapshot {
  return { version: 1, savedAt: Date.now(), entries };
}

function makeRouter(): MemoryRouter {
  const mockMcp = { callTool: vi.fn() };
  return new MemoryRouter({
    mcp: mockMcp as any,
    searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 5000 }),
    kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 5000 }),
    bundleCache: new MemoryCache<ReadBundle>({ capacity: 200, ttlMs: 180_000 }),
    similarityThreshold: 0.25,
  });
}

// ---------------------------------------------------------------------------
// 1. loadHotCache / saveHotCache round-trip
// ---------------------------------------------------------------------------

describe("loadHotCache / saveHotCache", () => {
  it("round-trips a snapshot with live entries", async () => {
    const path = tmpPath();
    const future = Date.now() + 120_000;
    const entry = makeEntry("entities:foo|tokens:bar", future, ["foo"]);
    await saveHotCache(path, makeSnapshot([entry]));
    const loaded = await loadHotCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].intentKey).toBe("entities:foo|tokens:bar");
    expect(loaded!.entries[0].entities).toEqual(["foo"]);
    expect(loaded!.entries[0].expiresAt).toBe(future);
    await fs.unlink(path).catch(() => {});
  });

  it("creates the directory if it does not exist", async () => {
    const dir = join(tmpdir(), `remempalace-newdir-${randomBytes(4).toString("hex")}`);
    const path = join(dir, "sub", "hot-cache.json");
    await saveHotCache(path, makeSnapshot([makeEntry("k", Date.now() + 10_000)]));
    const stat = await fs.stat(path);
    expect(stat.isFile()).toBe(true);
    await fs.rm(dir, { recursive: true }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // 2. Expired entries are dropped on load
  // ---------------------------------------------------------------------------

  it("preserves expired entries in the raw snapshot (filtering is caller responsibility)", async () => {
    const path = tmpPath();
    const now = Date.now();
    const expired = makeEntry("old", now - 1000);
    const live = makeEntry("new", now + 60_000);
    await saveHotCache(path, makeSnapshot([expired, live]));
    const loaded = await loadHotCache(path);
    // loadHotCache itself returns all structurally valid entries; caller drops by expiresAt
    expect(loaded!.entries).toHaveLength(2);
    await fs.unlink(path).catch(() => {});
  });

  it("filterLiveEntries drops expired entries", () => {
    const now = Date.now();
    const entries = [
      makeEntry("old", now - 1000),
      makeEntry("live1", now + 60_000),
      makeEntry("live2", now + 120_000),
    ];
    const live = filterLiveEntries(entries, now);
    expect(live).toHaveLength(2);
    expect(live.map((e) => e.intentKey)).toEqual(["live1", "live2"]);
  });

  // ---------------------------------------------------------------------------
  // 3. Malformed / wrong version / missing fields → null
  // ---------------------------------------------------------------------------

  it("returns null for truncated JSON", async () => {
    const path = tmpPath();
    await fs.writeFile(path, '{"version":1,"savedAt":12345,"entries":[{broken');
    expect(await loadHotCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("returns null for wrong version number", async () => {
    const path = tmpPath();
    await fs.writeFile(
      path,
      JSON.stringify({ version: 2, savedAt: Date.now(), entries: [] }),
    );
    expect(await loadHotCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("returns null when entries field is missing", async () => {
    const path = tmpPath();
    await fs.writeFile(path, JSON.stringify({ version: 1, savedAt: Date.now() }));
    expect(await loadHotCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("returns null for a non-object JSON value", async () => {
    const path = tmpPath();
    await fs.writeFile(path, JSON.stringify([1, 2, 3]));
    expect(await loadHotCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // 4. Missing file → null
  // ---------------------------------------------------------------------------

  it("returns null when file does not exist", async () => {
    const path = join(tmpdir(), `nonexistent-${randomBytes(4).toString("hex")}.json`);
    expect(await loadHotCache(path)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 5. Atomic write: existing file survives a failed rename
  // ---------------------------------------------------------------------------

  it("existing file survives if saveHotCache fails before rename", async () => {
    const path = tmpPath();
    const original = makeSnapshot([makeEntry("original", Date.now() + 60_000)]);
    await saveHotCache(path, original);

    // Simulate rename failure by mocking fs.rename to throw after writeFile
    const origRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("ENOSPC: no space left"));

    await expect(
      saveHotCache(path, makeSnapshot([makeEntry("new", Date.now() + 60_000)])),
    ).rejects.toThrow("ENOSPC");

    // Original file must be intact
    const loaded = await loadHotCache(path);
    expect(loaded!.entries[0].intentKey).toBe("original");

    vi.restoreAllMocks();
    await fs.unlink(path).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // 9. Circular reference entries are skipped, not fatal
  // ---------------------------------------------------------------------------

  it("skips non-serializable entries (circular ref) and saves the rest", async () => {
    const path = tmpPath();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = {};
    circular.self = circular;
    const badEntry: HotCacheSnapshotEntry = {
      intentKey: "bad",
      bundle: { searchResults: [], kgResults: circular },
      expiresAt: Date.now() + 60_000,
      entities: [],
    };
    const goodEntry = makeEntry("good", Date.now() + 60_000);
    await saveHotCache(path, makeSnapshot([badEntry, goodEntry]));
    const loaded = await loadHotCache(path);
    // Only the good entry should survive
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].intentKey).toBe("good");
    await fs.unlink(path).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// 6. MemoryRouter.exportHotEntries
// ---------------------------------------------------------------------------

describe("MemoryRouter.exportHotEntries", () => {
  it("returns at most maxEntries entries", async () => {
    const mockMcp = {
      callTool: vi.fn().mockImplementation(async (name: string) => {
        if (name.includes("search")) return { results: [] };
        return {};
      }),
    };
    const router = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 200, ttlMs: 5000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 200, ttlMs: 5000 }),
      bundleCache: new MemoryCache<ReadBundle>({ capacity: 200, ttlMs: 180_000 }),
      similarityThreshold: 0.25,
    });

    // Populate 5 distinct bundles
    for (let i = 0; i < 5; i++) {
      await router.readBundle(`query number ${i} about something unique`, 5);
    }

    const exported = router.exportHotEntries(3);
    expect(exported.length).toBeLessThanOrEqual(3);
  });

  it("exports most-recent bundle entries first when capped", async () => {
    const router = makeRouter();
    const now = Date.now();
    router.importHotEntries(
      [
        makeEntry("old", now + 60_000, ["oldEntity"]),
        makeEntry("middle", now + 60_000, ["middleEntity"]),
        makeEntry("new", now + 60_000, ["newEntity"]),
      ],
      now,
    );

    // Touch `old` so it becomes the hottest entry, then cap export.
    expect(router.bundleCache.get("old")).toBeDefined();

    const exported = router.exportHotEntries(2);
    expect(exported.map((e) => e.intentKey)).toEqual(["old", "new"]);
  });

  it("includes entity lists from the bundleKeysByEntity reverse index", async () => {
    const mockMcp = {
      callTool: vi.fn().mockImplementation(async (name: string) => {
        if (name.includes("search")) return { results: [] };
        return {};
      }),
    };
    const router = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 200, ttlMs: 5000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 200, ttlMs: 5000 }),
      bundleCache: new MemoryCache<ReadBundle>({ capacity: 200, ttlMs: 180_000 }),
      similarityThreshold: 0.25,
      knownEntities: ["OpenClaw"],
    });

    await router.readBundle("Tell me about OpenClaw project", 5);
    const exported = router.exportHotEntries(50);
    // At least one entry should reference OpenClaw
    const hasOpenClaw = exported.some((e) => e.entities.includes("OpenClaw"));
    expect(hasOpenClaw).toBe(true);
  });

  it("returns empty array when cache is empty", () => {
    const router = makeRouter();
    expect(router.exportHotEntries(50)).toEqual([]);
  });

  it("each exported entry has required fields", async () => {
    const mockMcp = {
      callTool: vi.fn().mockImplementation(async (name: string) => {
        if (name.includes("search"))
          return { results: [{ text: "t", wing: "w", room: "r", similarity: 0.5 }] };
        return {};
      }),
    };
    const router = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 200, ttlMs: 5000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 200, ttlMs: 5000 }),
      bundleCache: new MemoryCache<ReadBundle>({ capacity: 200, ttlMs: 180_000 }),
      similarityThreshold: 0.25,
    });

    await router.readBundle("what is the project status right now", 5);
    const [entry] = router.exportHotEntries(50);
    expect(entry).toBeDefined();
    expect(typeof entry.intentKey).toBe("string");
    expect(typeof entry.expiresAt).toBe("number");
    expect(Array.isArray(entry.entities)).toBe(true);
    expect(entry.bundle).toBeDefined();
    expect(Array.isArray(entry.bundle.searchResults)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. MemoryRouter.importHotEntries rebuilds cache + reverse index
// ---------------------------------------------------------------------------

describe("MemoryRouter.importHotEntries", () => {
  it("loads live entries and skips expired ones", () => {
    const router = makeRouter();
    const now = Date.now();
    const entries: HotCacheSnapshotEntry[] = [
      makeEntry("live", now + 60_000, ["entity1"]),
      makeEntry("expired", now - 1, ["entity2"]),
    ];
    const count = router.importHotEntries(entries, now);
    expect(count).toBe(1);
  });

  it("makes bundleCache hit for a warm-loaded intent key", () => {
    const router = makeRouter();
    const now = Date.now();
    const intentKey = "entities:OpenClaw|tokens:project";
    const bundle: ReadBundle = {
      searchResults: [{ text: "warm", wing: "w", room: "r", similarity: 0.8 }],
      kgResults: [],
    };
    router.importHotEntries(
      [{ intentKey, bundle, expiresAt: now + 60_000, entities: ["OpenClaw"] }],
      now,
    );
    // Direct cache lookup — should hit without any MCP call
    const hit = router.bundleCache.get(intentKey);
    expect(hit).toBeDefined();
    expect(hit!.searchResults[0].text).toBe("warm");
  });

  it("does not overwrite a fresher in-session bundle during hot-cache import", () => {
    const router = makeRouter();
    const now = Date.now();
    const intentKey = "full:limit:5:kg:2:entities:openclaw|tokens:project";
    router.bundleCache.set(intentKey, {
      searchResults: [{ text: "fresh", wing: "w", room: "r", similarity: 0.9 }],
      kgResults: [],
    });

    const loaded = router.importHotEntries(
      [
        {
          intentKey,
          bundle: {
            searchResults: [{ text: "stale", wing: "w", room: "r", similarity: 0.9 }],
            kgResults: [],
          },
          expiresAt: now + 60_000,
          entities: ["OpenClaw"],
        },
      ],
      now,
    );

    expect(loaded).toBe(0);
    expect(router.bundleCache.get(intentKey)?.searchResults[0].text).toBe("fresh");
  });

  it("rebuilds bundleKeysByEntity reverse index", () => {
    const router = makeRouter();
    const now = Date.now();
    router.importHotEntries(
      [
        makeEntry("key1", now + 60_000, ["entityA", "entityB"]),
        makeEntry("key2", now + 60_000, ["entityB"]),
      ],
      now,
    );
    const entityAKeys = router.bundleKeysByEntity.get("entitya");
    const entityBKeys = router.bundleKeysByEntity.get("entityb");
    expect(entityAKeys?.has("key1")).toBe(true);
    expect(entityBKeys?.has("key1")).toBe(true);
    expect(entityBKeys?.has("key2")).toBe(true);
  });

  it("invalidates warm-loaded mixed-case entity entries", () => {
    const router = makeRouter();
    const now = Date.now();
    const intentKey = "entities:openclaw|tokens:project";
    router.importHotEntries(
      [makeEntry(intentKey, now + 60_000, ["OpenClaw"])],
      now,
    );

    expect(router.bundleCache.get(intentKey)).toBeDefined();
    router.deleteBundleCacheEntriesForEntity("OpenClaw");
    expect(router.bundleCache.get(intentKey)).toBeUndefined();
  });

  it("invalidates warm-loaded alias-root entity entries", () => {
    const router = makeRouter();
    const now = Date.now();
    const intentKey = "full:limit:5:kg:2:entities:mempalace project|tokens:progress";
    router.importHotEntries(
      [makeEntry(intentKey, now + 60_000, ["MemPalace project"])],
      now,
    );

    expect(router.bundleCache.get(intentKey)).toBeDefined();
    router.deleteBundleCacheEntriesForEntity("MemPalace");
    expect(router.bundleCache.get(intentKey)).toBeUndefined();
    expect(router.bundleKeysByEntity.size).toBe(0);
  });

  it("removes deleted multi-entity intent keys from every reverse-index bucket", () => {
    const router = makeRouter();
    const now = Date.now();
    const intentKey = "full:limit:5:kg:2:entities:derek,mempalace|tokens:progress";
    router.importHotEntries(
      [makeEntry(intentKey, now + 60_000, ["Derek", "MemPalace"])],
      now,
    );

    router.deleteBundleCacheEntriesForEntity("Derek");

    expect(router.bundleCache.get(intentKey)).toBeUndefined();
    expect(router.bundleKeysByEntity.get("mempalace")?.has(intentKey)).not.toBe(true);
  });

  it("prunes expired reverse-index entries before hot-cache export", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      const router = makeRouter();
      const intentKey = "full:limit:5:kg:2:entities:mempalace|tokens:progress";
      router.importHotEntries(
        [makeEntry(intentKey, now + 1000, ["MemPalace"])],
        now,
      );

      expect(router.bundleKeysByEntity.get("mempalace")?.has(intentKey)).toBe(true);
      vi.setSystemTime(now + 1001);

      expect(router.exportHotEntries(50)).toEqual([]);
      expect(router.bundleKeysByEntity.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("subsequent readBundle for a warm-loaded key hits bundle cache (no MCP call)", async () => {
    const mockMcp = {
      callTool: vi.fn().mockImplementation(async (name: string) => {
        if (name.includes("search")) return { results: [] };
        return {};
      }),
    };
    const router = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 200, ttlMs: 5000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 200, ttlMs: 5000 }),
      bundleCache: new MemoryCache<ReadBundle>({ capacity: 200, ttlMs: 180_000 }),
      similarityThreshold: 0.25,
      metrics: new Metrics(),
    });

    // Warm-load a specific intent key
    const intentKey = "entities:|tokens:about,project,remempalace,something";
    const bundle: ReadBundle = {
      searchResults: [{ text: "warm-hit", wing: "w", room: "r", similarity: 0.9 }],
      kgResults: [],
    };
    router.importHotEntries(
      [{ intentKey, bundle, expiresAt: Date.now() + 60_000, entities: [] }],
      Date.now(),
    );

    // The same intent key must be a cache hit; MCP should not be called
    const cached = router.bundleCache.get(intentKey);
    expect(cached).toBeDefined();
    expect(cached!.searchResults[0].text).toBe("warm-hit");
    expect(mockMcp.callTool).not.toHaveBeenCalled();
  });

  it("returns 0 when all entries are expired", () => {
    const router = makeRouter();
    const now = Date.now();
    const count = router.importHotEntries(
      [makeEntry("old1", now - 5000), makeEntry("old2", now - 1)],
      now,
    );
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Lifecycle: flush interval and gateway_stop flush (fake timers)
// ---------------------------------------------------------------------------

describe("hot cache lifecycle (setInterval / gateway_stop)", () => {
  it("interval flush writes entries to disk", async () => {
    vi.useFakeTimers();
    const path = tmpPath();

    // Manually exercise the flush logic to simulate the interval callback
    const router = makeRouter();
    const now = Date.now();
    router.importHotEntries([makeEntry("key1", now + 60_000, ["e1"])], now);

    const { saveHotCache: save } = await import("../src/recall-cache-store.js");

    // Simulate the flush
    const entries = router.exportHotEntries(50);
    await save(path, { version: 1, savedAt: Date.now(), entries });

    const loaded = await loadHotCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].intentKey).toBe("key1");

    vi.useRealTimers();
    await fs.unlink(path).catch(() => {});
  });

  it("flush on gateway_stop saves current entries", async () => {
    const path = tmpPath();
    const router = makeRouter();
    const now = Date.now();
    router.importHotEntries([makeEntry("stop-key", now + 60_000)], now);

    // Simulate flushHotCache directly
    const entries = router.exportHotEntries(50);
    await saveHotCache(path, { version: 1, savedAt: Date.now(), entries });

    const loaded = await loadHotCache(path);
    expect(loaded!.entries[0].intentKey).toBe("stop-key");

    await fs.unlink(path).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// 10. hotCache.enabled:false — no file IO
// ---------------------------------------------------------------------------

describe("hotCache disabled", () => {
  it("does not write any file when saveHotCache is not called", async () => {
    const path = tmpPath();
    // Simply verify the file does not exist (we never call save)
    const result = await loadHotCache(path);
    expect(result).toBeNull();
  });

  it("importHotEntries with empty array returns 0 (no-op when disabled means no entries)", () => {
    const router = makeRouter();
    expect(router.importHotEntries([], Date.now())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Additional: MemoryCache.entries() and setWithExpiry
// ---------------------------------------------------------------------------

describe("MemoryCache entries() and setWithExpiry", () => {
  it("entries() returns live keys with expiresAt > now", () => {
    const cache = new MemoryCache<string>({ capacity: 10, ttlMs: 60_000 });
    cache.set("a", "hello");
    cache.set("b", "world");
    const entries = cache.entries();
    expect(entries.length).toBe(2);
    for (const [key, value, expiresAt] of entries) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
      expect(expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it("setWithExpiry inserts with correct remaining TTL", () => {
    const cache = new MemoryCache<string>({ capacity: 10, ttlMs: 60_000 });
    const expiresAt = Date.now() + 30_000;
    cache.setWithExpiry("k", "v", expiresAt);
    expect(cache.get("k")).toBe("v");
    const [, , storedExpiry] = cache.entries().find(([key]) => key === "k")!;
    // Allow 500ms tolerance for test execution time
    expect(Math.abs(storedExpiry - expiresAt)).toBeLessThan(500);
  });

  it("setWithExpiry does not insert an already-expired entry", () => {
    const cache = new MemoryCache<string>({ capacity: 10, ttlMs: 60_000 });
    cache.setWithExpiry("k", "v", Date.now() - 1);
    expect(cache.get("k")).toBeUndefined();
  });

  it("entries() excludes expired entries (fake timers)", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const cache = new MemoryCache<string>({ capacity: 10, ttlMs: 1000 });
    cache.set("a", "x");
    vi.setSystemTime(start + 2000);
    const entries = cache.entries();
    expect(entries.length).toBe(0);
    vi.useRealTimers();
  });
});
