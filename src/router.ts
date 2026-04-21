import { MemoryCache, hashKey } from "./cache.js";
import type { McpClient } from "./mcp-client.js";
import type { SearchResult } from "./types.js";

export interface MemoryRouterOptions {
  mcp: McpClient;
  searchCache: MemoryCache<SearchResult[]>;
  kgCache: MemoryCache<unknown>;
  similarityThreshold: number;
  callTimeoutMs?: number;
}

export interface ReadBundle {
  searchResults: SearchResult[];
  kgResults: unknown;
}

export class MemoryRouter {
  private readonly timeoutMs: number;

  constructor(private readonly opts: MemoryRouterOptions) {
    this.timeoutMs = opts.callTimeoutMs ?? 8000;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const key = hashKey("mempalace_search", { query, limit });
    const cached = this.opts.searchCache.get(key);
    if (cached) return cached;
    const raw = await this.opts.mcp.callTool<{ results: SearchResult[] }>(
      "mempalace_search",
      { query, limit },
      this.timeoutMs,
    );
    const filtered = (raw.results ?? []).filter(
      (r) => r.similarity >= this.opts.similarityThreshold,
    );
    this.opts.searchCache.set(key, filtered);
    return filtered;
  }

  async kgQuery(entity: string): Promise<unknown> {
    const key = hashKey("mempalace_kg_query", { entity });
    const cached = this.opts.kgCache.get(key);
    if (cached !== undefined) return cached;
    const raw = await this.opts.mcp.callTool<unknown>(
      "mempalace_kg_query",
      { entity },
      this.timeoutMs,
    );
    this.opts.kgCache.set(key, raw);
    return raw;
  }

  async readBundle(query: string, limit: number): Promise<ReadBundle> {
    const [searchResults, kgResults] = await Promise.all([
      this.search(query, limit),
      this.kgQuery(query),
    ]);
    return { searchResults, kgResults };
  }
}
