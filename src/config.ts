import type { RemempalaceConfig } from "./types.js";

export const DEFAULT_CONFIG: RemempalaceConfig = {
  mcpPythonBin: "/home/derek/.local/share/pipx/venvs/mempalace/bin/python",
  cache: { capacity: 200, ttlMs: 300000, kgTtlMs: 600000 },
  injection: {
    maxTokens: 800,
    budgetPercent: 0.15,
    similarityThreshold: 0.25,
    useAaak: true,
  },
  tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
  diary: { enabled: true, maxEntryTokens: 500 },
  kg: { autoLearn: true, batchSize: 5, flushIntervalMs: 30000 },
  prefetch: { diaryCount: 3, identityEntities: true },
};

export function mergeConfig(
  user: Partial<RemempalaceConfig> | undefined,
): RemempalaceConfig {
  if (!user) return DEFAULT_CONFIG;
  return {
    mcpPythonBin: user.mcpPythonBin ?? DEFAULT_CONFIG.mcpPythonBin,
    cache: { ...DEFAULT_CONFIG.cache, ...user.cache },
    injection: { ...DEFAULT_CONFIG.injection, ...user.injection },
    tiers: { ...DEFAULT_CONFIG.tiers, ...user.tiers },
    diary: { ...DEFAULT_CONFIG.diary, ...user.diary },
    kg: { ...DEFAULT_CONFIG.kg, ...user.kg },
    prefetch: { ...DEFAULT_CONFIG.prefetch, ...user.prefetch },
  };
}
