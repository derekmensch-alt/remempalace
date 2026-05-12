import { MemoryCache, hashKey } from "./cache.js";
import {
  BackendUnavailable,
  type MemPalaceRepository,
} from "./ports/mempalace-repository.js";
import type { SearchResult, KgFact } from "./types.js";
import { dedupeWithKey } from "./dedup.js";
import { extractEntityCandidates } from "./entity-extractor.js";
import type { Metrics } from "./metrics.js";
import { McpMemPalaceRepository } from "./adapters/mcp-mempalace-repository.js";
import type { HotCacheSnapshotEntry } from "./recall-cache-store.js";

// ---------------------------------------------------------------------------
// Intent normalisation
// ---------------------------------------------------------------------------

// Common English stop-words to drop before computing the intent key.
// Exported so recall-service.ts (and tests) can extend the single source.
export const INTENT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "do",
  "for",
  "from",
  "get",
  "got",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "let",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "so",
  "the",
  "to",
  "up",
  "was",
  "we",
  "what",
  "when",
  "who",
  "will",
  "you",
  // Recall-service stop-words mirrored here so both lists stay in sync
  "about",
  "again",
  "after",
  "before",
  "continue",
  "could",
  "please",
  "proceed",
  "should",
  "that",
  "their",
  "there",
  "these",
  "this",
  "with",
  "would",
]);

// Remempalace runtime injection blocks — strip before normalising, using the
// same pattern as stripRuntimeInjectionBlocks in index.ts so we don't
// duplicate the regex.
const INTENT_INJECTION_BLOCK_RE =
  /^##\s+(?:Active Memory Plugin|Memory Context|Identity|System Notes|Timeline Context)\s*\(remempalace\)[^\n]*(?:\n(?!##\s)[^\n]*)*/gm;

/**
 * Trivial suffix stemmer — strips trailing `ing`, `ed`, `s` (in that order so
 * `running` → `runn` → `run`-ish; good enough for clustering without a full
 * Porter stemmer).
 */
function trivialStem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/**
 * Produce a stable, normalised intent key from a prompt + extracted entity
 * candidates.  Two prompts with the same meaningful content should yield the
 * same key even when phrased differently.
 *
 * Key format: `entities:e1,e2|tokens:t1,t2,t3`
 */
export function normalizeIntent(prompt: string, candidates: string[]): string {
  // Strip runtime injection blocks before tokenising.
  const stripped = prompt.replace(INTENT_INJECTION_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();

  // Tokenise on non-alphanumerics, lowercase.
  const rawTokens = stripped.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  // Keep tokens ≥ 3 chars, not a stop-word; apply trivial stemmer.
  const tokens = rawTokens
    .filter((t) => t.length >= 3 && !INTENT_STOP_WORDS.has(t))
    .map(trivialStem)
    .sort();

  // Normalise + dedup entity candidates.
  const entityKey = [...new Set(candidates.map((c) => c.toLowerCase().trim()))].sort().join(",");

  return `entities:${entityKey}|tokens:${tokens.join(",")}`;
}

export interface MemoryRouterOptions {
  /** Full repository implementation. Provide either `repository` or `mcp`. */
  repository?: Pick<MemPalaceRepository, "searchMemory" | "queryKgEntity">;
  /**
   * Raw MCP client — used when a full `repository` is not provided (e.g. in
   * tests). A `McpMemPalaceRepository` is constructed from it automatically.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcp?: any;
  searchCache: MemoryCache<SearchResult[]>;
  kgCache: MemoryCache<unknown>;
  /**
   * Pre-built bundle cache to inject (e.g. from tests or for persistence warm-
   * load). When omitted a new cache is created using `bundleCacheTtlMs` /
   * `bundleCacheCapacity`.
   */
  bundleCache?: MemoryCache<ReadBundle>;
  similarityThreshold: number;
  callTimeoutMs?: number;
  knownEntities?: string[];
  maxKgEntityQueries?: number;
  metrics?: Metrics;
  /** TTL for the intent-keyed bundle cache. Defaults to 180 000 ms (3 min). */
  bundleCacheTtlMs?: number;
  /** Capacity for the intent-keyed bundle cache. Defaults to 200. */
  bundleCacheCapacity?: number;
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
const DEFAULT_MAX_KG_ENTITY_QUERIES = 2;
const GENERIC_KG_ENTITY_ALIASES = new Set([
  "it",
  "memory",
  "open claw",
  "openclaw",
  "project",
  "this",
]);
const GENERIC_KG_ENTITY_SUFFIXES = new Set(["memory", "project"]);

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

function normalizeEntityAlias(entity: string): string {
  return entity
    .trim()
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedEntityRoot(entity: string): string {
  const tokens = normalizeEntityAlias(entity).split(" ").filter(Boolean);
  while (
    tokens.length > 1 &&
    GENERIC_KG_ENTITY_SUFFIXES.has(tokens[tokens.length - 1])
  ) {
    tokens.pop();
  }
  return tokens.join(" ");
}

function entityIndexKeys(entity: string): string[] {
  const normalized = normalizeEntityAlias(entity);
  const root = normalizedEntityRoot(entity);
  return [...new Set([normalized, root].filter(Boolean))];
}

function isGenericKgEntity(entity: string): boolean {
  const normalized = normalizeEntityAlias(entity);
  return normalized.length === 0 || GENERIC_KG_ENTITY_ALIASES.has(normalized);
}

function selectKgEntityCandidates(
  entities: string[],
  maxCandidates: number,
): string[] {
  const cap = Math.max(0, Math.floor(maxCandidates));
  if (cap === 0) return [];
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const entity of entities) {
    if (isGenericKgEntity(entity)) continue;
    const root = normalizedEntityRoot(entity);
    const rootKey = root.replace(/\s+/g, "");
    if (!rootKey || seen.has(rootKey)) continue;
    seen.add(rootKey);
    selected.push(entity);
    if (selected.length >= cap) break;
  }
  return selected;
}

const DEFAULT_BUNDLE_CACHE_TTL_MS = 180_000;

export class MemoryRouter {
  private readonly timeoutMs: number;
  private readonly knownEntities: string[];
  private readonly maxKgEntityQueries: number;
  private readonly metrics?: Metrics;
  private readonly repository: Pick<MemPalaceRepository, "searchMemory" | "queryKgEntity">;
  // Intent-keyed bundle cache — keyed by normalizeIntent() output.
  readonly bundleCache: MemoryCache<ReadBundle>;
  // Reverse index: normalized entity alias/root → Set of live intent-cache keys
  // that mention it. Used for O(entities) KG-write invalidation.
  readonly bundleKeysByEntity = new Map<string, Set<string>>();
  // First-seen original-case label for each normalized entity key.
  // Used by exportHotEntries to preserve original casing in snapshots.
  private readonly bundleEntityLabels = new Map<string, string>();
  private readonly kgCacheKeysByEntity = new Map<string, Set<string>>();

  constructor(private readonly opts: MemoryRouterOptions) {
    this.timeoutMs = opts.callTimeoutMs ?? 8000;
    this.knownEntities = opts.knownEntities ?? [];
    this.maxKgEntityQueries = opts.maxKgEntityQueries ?? DEFAULT_MAX_KG_ENTITY_QUERIES;
    this.metrics = opts.metrics;
    // Resolve repository: prefer explicit `repository`, fall back to wrapping `mcp`.
    if (opts.repository) {
      this.repository = opts.repository;
    } else if (opts.mcp) {
      this.repository = new McpMemPalaceRepository(opts.mcp);
    } else {
      throw new Error("MemoryRouter: either `repository` or `mcp` must be provided");
    }
    // Use injected bundleCache when provided (e.g. tests, hot-cache warm-load).
    this.bundleCache = opts.bundleCache ?? new MemoryCache<ReadBundle>({
      capacity: opts.bundleCacheCapacity ?? 200,
      ttlMs: opts.bundleCacheTtlMs ?? DEFAULT_BUNDLE_CACHE_TTL_MS,
    });
  }

  /**
   * Export the current hot bundle cache entries as a serialisable snapshot.
   * Entries are taken in LRU-most-recent order (as `entries()` returns them)
   * and capped at `maxEntries`.  For each entry the entity list is derived by
   * scanning `bundleKeysByEntity` for every entity that references the key.
   */
  exportHotEntries(maxEntries: number): HotCacheSnapshotEntry[] {
    this.pruneBundleReverseIndex();
    const all = this.bundleCache.entries();
    const capped = all.slice(0, maxEntries);
    return capped.map(([intentKey, bundle, expiresAt]) => {
      const entities: string[] = [];
      for (const [entityKey, keys] of this.bundleKeysByEntity) {
        if (keys.has(intentKey)) {
          // Use original-case label when available, fall back to stored key.
          entities.push(this.bundleEntityLabels.get(entityKey) ?? entityKey);
        }
      }
      return { intentKey, bundle, expiresAt, entities };
    });
  }

  /**
   * Import hot cache entries from a persisted snapshot.
   * Only entries with `expiresAt > now` are loaded.
   * Rebuilds the `bundleKeysByEntity` reverse index for each loaded entry.
   * Returns the count of entries actually loaded.
   */
  importHotEntries(entries: HotCacheSnapshotEntry[], now: number): number {
    let loaded = 0;
    for (const entry of entries) {
      if (entry.expiresAt <= now) continue;
      if (this.bundleCache.has(entry.intentKey)) continue;
      this.bundleCache.setWithExpiry(entry.intentKey, entry.bundle, entry.expiresAt);
      for (const entity of entry.entities) {
        this.addBundleReverseIndexEntry(entity, entry.intentKey);
      }
      loaded++;
    }
    return loaded;
  }

  private addBundleReverseIndexEntry(entity: string, intentKey: string): void {
    for (const entityKey of entityIndexKeys(entity)) {
      let keys = this.bundleKeysByEntity.get(entityKey);
      if (!keys) {
        keys = new Set<string>();
        this.bundleKeysByEntity.set(entityKey, keys);
      }
      keys.add(intentKey);
      if (!this.bundleEntityLabels.has(entityKey)) {
        this.bundleEntityLabels.set(entityKey, entity);
      }
    }
  }

  private pruneBundleReverseIndex(): Set<string> {
    const liveKeys = new Set(this.bundleCache.entries().map(([key]) => key));
    for (const [entityKey, keys] of this.bundleKeysByEntity) {
      for (const intentKey of [...keys]) {
        if (!liveKeys.has(intentKey)) keys.delete(intentKey);
      }
      if (keys.size === 0) {
        this.bundleKeysByEntity.delete(entityKey);
        this.bundleEntityLabels.delete(entityKey);
      }
    }
    return liveKeys;
  }

  private addKgReverseIndexEntry(entity: string, cacheKey: string): void {
    for (const entityKey of entityIndexKeys(entity)) {
      let keys = this.kgCacheKeysByEntity.get(entityKey);
      if (!keys) {
        keys = new Set<string>();
        this.kgCacheKeysByEntity.set(entityKey, keys);
      }
      keys.add(cacheKey);
    }
  }

  private pruneKgReverseIndex(): void {
    for (const [entityKey, keys] of this.kgCacheKeysByEntity) {
      for (const cacheKey of [...keys]) {
        if (!this.opts.kgCache.has(cacheKey)) keys.delete(cacheKey);
      }
      if (keys.size === 0) {
        this.kgCacheKeysByEntity.delete(entityKey);
      }
    }
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
    let results: SearchResult[];
    try {
      results = await this.repository.searchMemory({
        query: mcpQuery,
        limit,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (!isNegativeCacheableReadError(err)) throw err;
      this.metrics?.inc("recall.search.timeout_negative_cached");
      this.opts.searchCache.set(key, []);
      return [];
    }
    const filtered = results.filter(
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
    let raw: unknown;
    try {
      raw = await this.repository.queryKgEntity({ entity, timeoutMs: this.timeoutMs });
    } catch (err) {
      if (!isNegativeCacheableReadError(err)) throw err;
      const empty = { facts: [] };
      this.metrics?.inc("recall.kg.timeout_negative_cached");
      this.opts.kgCache.set(key, empty);
      this.addKgReverseIndexEntry(entity, key);
      return empty;
    }
    if (normalizeKgResult(raw).length === 0) this.metrics?.inc("recall.kg.empty_results");
    this.opts.kgCache.set(key, raw);
    this.addKgReverseIndexEntry(entity, key);
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
    this.pruneKgReverseIndex();
    const keysToDelete = new Set<string>();
    for (const entityKey of entityIndexKeys(entity)) {
      const keys = this.kgCacheKeysByEntity.get(entityKey);
      if (!keys) continue;
      for (const cacheKey of keys) {
        if (this.opts.kgCache.has(cacheKey)) keysToDelete.add(cacheKey);
      }
    }
    keysToDelete.add(hashKey("mempalace_kg_query", { entity }));
    for (const cacheKey of keysToDelete) {
      this.opts.kgCache.delete(cacheKey);
    }
    this.pruneKgReverseIndex();
  }

  /**
   * Drop all intent-bundle cache entries that are associated with the given
   * entity (e.g. when fresh KG facts have been written for it).
   * Uses a reverse-index (entity → intent-keys) for O(1) lookup per entity.
   */
  deleteBundleCacheEntriesForEntity(entity: string): void {
    const liveKeys = this.pruneBundleReverseIndex();
    const keysToDelete = new Set<string>();
    for (const entityKey of entityIndexKeys(entity)) {
      const keys = this.bundleKeysByEntity.get(entityKey);
      if (!keys) continue;
      for (const intentKey of keys) {
        if (liveKeys.has(intentKey)) keysToDelete.add(intentKey);
      }
    }
    for (const intentKey of keysToDelete) {
      this.bundleCache.delete(intentKey);
      this.metrics?.inc("recall.bundle.invalidated_by_kg");
    }
    for (const entityKey of entityIndexKeys(entity)) {
      this.bundleKeysByEntity.delete(entityKey);
      this.bundleEntityLabels.delete(entityKey);
    }
    this.pruneBundleReverseIndex();
  }

  async readBundle(
    query: string,
    limit: number,
    opts?: { entityCandidates?: string[]; maxKgEntityQueries?: number; includeSearch?: boolean },
  ): Promise<ReadBundle> {
    const candidates = opts?.entityCandidates ?? this.extractCandidates(query);
    const includeSearch = opts?.includeSearch ?? true;
    const maxKgEntityQueries = opts?.maxKgEntityQueries ?? this.maxKgEntityQueries;
    const selectedCandidates = selectKgEntityCandidates(
      candidates,
      maxKgEntityQueries,
    );

    // --- Intent-keyed bundle cache lookup ---
    const intentKey = [
      includeSearch ? "full" : "kg",
      `limit:${limit}`,
      `kg:${candidates.length > 0 ? maxKgEntityQueries : "query"}`,
      normalizeIntent(query, candidates),
    ].join(":");
    const cached = this.bundleCache.get(intentKey);
    if (cached) {
      // Only treat as a genuine hit when the cached bundle has content.
      // Empty-result bundles are stored so the hot-cache can export entity
      // associations, but the intent-cache should keep missing on them so that
      // per-query negative caches (searchCache / kgCache) remain the source of
      // truth for empty results — avoiding stale empty-bundle cache hits that
      // mask newly-written KG data before the invalidation hook fires.
      if (isBundleNonEmpty(cached)) {
        this.metrics?.inc("recall.bundle.cache_hits");
        return cached;
      }
      // Fall through: empty bundle — count as miss; per-query caches serve it.
    }
    this.metrics?.inc("recall.bundle.cache_misses");

    const kgRequest =
      candidates.length > 0
        ? selectedCandidates.length > 0
          ? this.kgQueryMulti(selectedCandidates)
          : Promise.resolve([])
        : this.kgQuery(query);
    const [searchResults, kgResults] = await Promise.all([
      includeSearch ? this.search(query, limit) : Promise.resolve([]),
      kgRequest,
    ]);
    const bundle: ReadBundle = { searchResults, kgResults };

    // Cache the bundle unconditionally so that:
    // (a) hot-cache export can always snapshot entity associations, and
    // (b) the intent-level negative cache avoids redundant MCP round-trips.
    // KG-write invalidation (deleteBundleCacheEntriesForEntity) handles
    // freshness when new facts are written.
    this.bundleCache.set(intentKey, bundle);
    // Update reverse index so KG invalidation can drop this key.
    for (const c of candidates) {
      this.addBundleReverseIndexEntry(c, intentKey);
    }

    return bundle;
  }
}

function isBundleNonEmpty(bundle: ReadBundle): boolean {
  if (bundle.searchResults.length > 0) return true;
  const kg = bundle.kgResults;
  if (Array.isArray(kg)) return kg.length > 0;
  if (kg != null && typeof kg === "object") {
    const facts = (kg as { facts?: unknown[] }).facts;
    if (Array.isArray(facts)) return facts.length > 0;
    // Non-array object without a `facts` key — treat as potentially non-empty.
    return Object.keys(kg as object).length > 0;
  }
  return false;
}

function isNegativeCacheableReadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/timed out|timeout|deadline/i.test(err.message)) return true;
  if (err instanceof BackendUnavailable && err.cause instanceof Error) {
    return /timed out|timeout|deadline/i.test(err.cause.message);
  }
  return false;
}
