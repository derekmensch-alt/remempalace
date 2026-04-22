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
  };
  injection: {
    maxTokens: number;
    budgetPercent: number;
    similarityThreshold: number;
    useAaak: boolean;
    knownEntities: string[];
  };
  tiers: {
    l1Threshold: number;
    l2Threshold: number;
    l2BudgetFloor: number;
  };
  diary: {
    enabled: boolean;
    maxEntryTokens: number;
  };
  kg: {
    autoLearn: boolean;
    batchSize: number;
    flushIntervalMs: number;
  };
  prefetch: {
    diaryCount: number;
    identityEntities: boolean;
  };
}

export type Tier = "L0" | "L1" | "L2";

export interface InjectionBudget {
  maxTokens: number;
  allowedTiers: Tier[];
  contextFillRatio: number;
}
