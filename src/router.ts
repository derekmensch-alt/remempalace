import { MemoryCache, hashKey } from "./cache.js";
import type { McpClient } from "./mcp-client.js";
import type { SearchResult, KgFact } from "./types.js";
import { dedupeWithKey } from "./dedup.js";
import { extractEntityCandidates } from "./entity-extractor.js";
import type { Metrics } from "./metrics.js";

export interface MemoryRouterOptions {
  mcp: McpClient;
  searchCache: MemoryCache<SearchResult[]>;
  kgCache: MemoryCache<unknown>;
  similarityThreshold: number;
  callTimeoutMs?: number;
  knownEntities?: string[];
  metrics?: Metrics;
}

export interface ReadBundle {
  searchResults: SearchResult[];
  kgResults: unknown;
}

function normalizeKgResult(raw: unknown): KgFact[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw as KgFact[];
  if ("facts" in raw && Array.isArray((raw as { facts: unknown[] }).facts)) {
    return (raw as { facts: KgFact[] }).facts;
  }
  return [];
}

export class MemoryRouter {
  private readonly timeoutMs: number;
  private readonly knownEntities: string[];
  private readonly metrics?: Metrics;

  constructor(private readonly opts: MemoryRouterOptions) {
    this.timeoutMs = opts.callTimeoutMs ?? 8000;
    this.knownEntities = opts.knownEntities ?? [];
    this.metrics = opts.metrics;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    this.metrics?.inc("recall.search.calls");
    const key = hashKey("mempalace_search", { query, limit });
    const cached = this.opts.searchCache.get(key);
    if (cached) {
      this.metrics?.inc("recall.search.cache_hits");
      return cached;
    }
    this.metrics?.inc("recall.search.cache_misses");
    const raw = await this.opts.mcp.callTool<{ results: SearchResult[] }>(
      "mempalace_search",
      { query, limit },
      this.timeoutMs,
    );
    const filtered = (raw.results ?? []).filter(
      (r) => r.similarity >= this.opts.similarityThreshold,
    );
    if (filtered.length === 0) this.metrics?.inc("recall.search.empty_results");
    this.opts.searchCache.set(key, filtered);
    return filtered;
  }

  async kgQuery(entity: string): Promise<unknown> {
    this.metrics?.inc("recall.kg.calls");
    const key = hashKey("mempalace_kg_query", { entity });
    const cached = this.opts.kgCache.get(key);
    if (cached !== undefined) {
      this.metrics?.inc("recall.kg.cache_hits");
      return cached;
    }
    this.metrics?.inc("recall.kg.cache_misses");
    const raw = await this.opts.mcp.callTool<unknown>(
      "mempalace_kg_query",
      { entity },
      this.timeoutMs,
    );
    if (normalizeKgResult(raw).length === 0) this.metrics?.inc("recall.kg.empty_results");
    this.opts.kgCache.set(key, raw);
    return raw;
  }

  async kgQueryMulti(entities: string[]): Promise<unknown> {
    const results = await Promise.all(entities.map((e) => this.kgQuery(e)));
    const facts = results.flatMap((r) => normalizeKgResult(r));
    return dedupeWithKey(facts, (f) => `${f.subject}|${f.predicate}|${f.object}`);
  }

  extractCandidates(prompt: string): string[] {
    return extractEntityCandidates(prompt, {
      knownEntities: this.knownEntities,
      maxCandidates: 4,
      minLength: 3,
    });
  }

  async readBundle(
    query: string,
    limit: number,
    opts?: { entityCandidates?: string[] },
  ): Promise<ReadBundle> {
    const candidates = opts?.entityCandidates ?? this.extractCandidates(query);
    const [searchResults, kgResults] = await Promise.all([
      this.search(query, limit),
      candidates.length > 0 ? this.kgQueryMulti(candidates) : this.kgQuery(query),
    ]);
    return { searchResults, kgResults };
  }
}
