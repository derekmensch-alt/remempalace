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

const SEARCH_QUERY_MAX_CHARS = 250;

// Remempalace injection headers to strip before sending to mempalace_search.
const INJECTION_HEADER_RE =
  /^##\s+(?:Active Memory Plugin|Memory Context|Identity|System Notes|Timeline Context)\s*\(remempalace\)[^\n]*\n(?:(?!##\s).*\n?)*/gm;

export function buildSearchQuery(prompt: string): string {
  const stripped = prompt.replace(INJECTION_HEADER_RE, "").trim();
  // Prefer the last user-turn when the prompt contains role-separated blocks.
  const userTurn = stripped.match(
    /(?:^|\n)\s*(?:user|human)\s*:\s*([^\n]*(?:\n(?!\s*(?:assistant|system)\s*:)[^\n]*)*)/i,
  );
  const candidate = userTurn ? userTurn[1].trim() : stripped;
  const collapsed = candidate.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SEARCH_QUERY_MAX_CHARS) return collapsed;
  const hardCap = collapsed.slice(0, SEARCH_QUERY_MAX_CHARS);
  const lastSpace = hardCap.lastIndexOf(" ");
  return lastSpace > 0 ? hardCap.slice(0, lastSpace) : hardCap;
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
    const mcpQuery = buildSearchQuery(query);
    const key = hashKey("mempalace_search", { query: mcpQuery, limit });
    const cached = this.opts.searchCache.get(key);
    if (cached) {
      this.metrics?.inc("recall.search.cache_hits");
      return cached;
    }
    this.metrics?.inc("recall.search.cache_misses");
    const raw = await this.opts.mcp.callTool<{ results: SearchResult[] }>(
      "mempalace_search",
      { query: mcpQuery, limit },
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

  deleteKgEntity(entity: string): void {
    const key = hashKey("mempalace_kg_query", { entity });
    this.opts.kgCache.delete(key);
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
