import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryCache } from "../src/cache.js";

describe("MemoryCache", () => {
  let cache: MemoryCache<string>;

  beforeEach(() => {
    cache = new MemoryCache<string>({ capacity: 3, ttlMs: 1000 });
  });

  it("returns undefined for missing keys", () => {
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves values", () => {
    cache.set("a", "value-a");
    expect(cache.get("a")).toBe("value-a");
  });

  it("evicts LRU entries when at capacity", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe("4");
  });

  it("expires entries after ttlMs", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    cache.set("a", "value-a");
    vi.setSystemTime(start + 1500);
    expect(cache.get("a")).toBeUndefined();
    vi.useRealTimers();
  });

  it("reports hits and misses", () => {
    cache.set("a", "1");
    cache.get("a");
    cache.get("b");
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });
});
