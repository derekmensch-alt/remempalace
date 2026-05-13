import { LRUCache } from "lru-cache";

export interface CacheOptions {
  capacity: number;
  ttlMs: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export class MemoryCache<V> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private lru: LRUCache<string, any>;
  private hitCount = 0;
  private missCount = 0;

  constructor(opts: CacheOptions) {
    // Use Date.now()-based perf so vitest fake timers can control TTL expiry
    const perf = { now: () => Date.now() };
    this.lru = new LRUCache<string, object>({
      max: opts.capacity,
      ttl: opts.ttlMs,
      perf,
    });
  }

  get(key: string): V | undefined {
    const value = this.lru.get(key) as V | undefined;
    if (value === undefined) {
      this.missCount++;
    } else {
      this.hitCount++;
    }
    return value;
  }

  set(key: string, value: V): void {
    this.lru.set(key, value);
  }

  delete(key: string): void {
    this.lru.delete(key);
  }

  has(key: string): boolean {
    return this.lru.has(key);
  }

  clear(): void {
    this.lru.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  stats(): CacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      size: this.lru.size,
    };
  }

  /**
   * Returns all live entries as [key, value, expiresAt] triples.
   * expiresAt is derived from getRemainingTTL so fake-timer behaviour is correct.
   * Expired entries are excluded.
   */
  entries(): Array<[string, V, number]> {
    const result: Array<[string, V, number]> = [];
    for (const [key, value] of this.lru.entries()) {
      const remaining = this.lru.getRemainingTTL(key);
      if (remaining <= 0) continue; // expired or no TTL — skip
      const expiresAt = Date.now() + remaining;
      result.push([key, value as V, expiresAt]);
    }
    return result;
  }

  /**
   * Insert key/value with a specific absolute expiry epoch ms.
   * Silently drops entries that are already expired.
   */
  setWithExpiry(key: string, value: V, expiresAt: number): void {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return; // already expired — drop silently
    this.lru.set(key, value, { ttl: remaining });
  }
}

export function hashKey(toolName: string, params: Record<string, unknown>): string {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  return `${toolName}:${sorted}`;
}
