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
}

export function hashKey(toolName: string, params: Record<string, unknown>): string {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  return `${toolName}:${sorted}`;
}
