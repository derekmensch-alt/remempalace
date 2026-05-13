export interface SearchResult {
  text: string;
  wing: string;
  room: string;
  similarity: number;
  source_file?: string;
}

export interface KgFact {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string;
  valid_to?: string;
  source_closet?: string;
  current?: boolean;
}

export type FactCategory =
  | "preference"
  | "identity"
  | "project_state"
  | "decision"
  | "environment";

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  category: FactCategory;
  confidence: number;
  source_span?: string;
  valid_from?: string;
}

export interface DiaryEntry {
  date: string;
  content: string;
}

export interface PalaceStatus {
  total_drawers: number;
  wings: Record<string, number>;
  rooms: Record<string, number>;
  palace_path: string;
}

export interface RemempalaceConfig {
  mcpPythonBin: string;
  cache: {
    capacity: number;
    ttlMs: number;
    kgTtlMs: number;
    bundleTtlMs: number;
  };
  injection: {
    maxTokens: number;
    budgetPercent: number;
    similarityThreshold: number;
    useAaak: boolean;
    knownEntities: string[];
    identityMaxTokens: number;
    rawIdentity: boolean;
    fastRaceMs: number;
    /** Stage-level sub-budgets within the shared prompt-path deadline. */
    budgets: {
      initMs: number;
      fetchMs: number;
      formatMs: number;
    };
  };
  tiers: {
    l1Threshold: number;
    l2Threshold: number;
    l2BudgetFloor: number;
  };
  diary: {
    enabled: boolean;
    maxEntryTokens: number;
    localDir: string;
    replayOnStart: boolean;
    persistenceProbeTimeoutMs: number;
  };
  kg: {
    autoLearn: boolean;
    batchSize: number;
    flushIntervalMs: number;
    invalidateOnConflict: boolean;
    minConfidence: number;
  };
  learning: {
    /** Extract KG facts from user turns. Default: true. */
    fromUser: boolean;
    /** Extract KG facts from assistant turns. Default: false (avoid self-poisoning). */
    fromAssistant: boolean;
    /** Extract KG facts from system turns. Default: false (restricted). */
    fromSystem: boolean;
  };
  prefetch: {
    diaryCount: number;
    identityEntities: boolean;
  };
  identity: {
    soulPath: string;
    identityPath: string;
    maxChars: number;
  };
  memoryRuntime: {
    allowedReadRoots: string[];
    /** Paths the runtime may write to. Empty list (default) rejects all writes. */
    allowedWriteRoots: string[];
  };
  hotCache: {
    enabled: boolean;
    path: string;
    maxEntries: number;
    flushIntervalMs: number;
  };
  /** Per-backend circuit-breaker configuration. */
  breaker: {
    search: { failureThreshold: number; windowMs: number; cooldownMs: number };
    kg: { failureThreshold: number; windowMs: number; cooldownMs: number };
    diary: { failureThreshold: number; windowMs: number; cooldownMs: number };
  };
}

export type Tier = "L0" | "L1" | "L2";

export interface InjectionBudget {
  maxTokens: number;
  allowedTiers: Tier[];
  contextFillRatio: number;
}
