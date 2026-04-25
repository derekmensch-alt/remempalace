import type { RemempalaceConfig } from "./types.js";
import { homedir } from "node:os";

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) {
    return `${homedir()}${path.slice(1)}`;
  }
  return path;
}

export const DEFAULT_CONFIG: RemempalaceConfig = {
  mcpPythonBin: "/home/derek/.local/share/pipx/venvs/mempalace/bin/python",
  cache: { capacity: 200, ttlMs: 300000, kgTtlMs: 600000 },
  injection: {
    maxTokens: 800,
    budgetPercent: 0.15,
    similarityThreshold: 0.25,
    useAaak: true,
    knownEntities: ["Derek", "OpenClaw", "MemPalace", "remempalace", "Anthropic", "Claude"],
    identityMaxTokens: 150,
    rawIdentity: false,
  },
  tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
  diary: { enabled: true, maxEntryTokens: 500 },
  kg: { autoLearn: true, batchSize: 5, flushIntervalMs: 30000, invalidateOnConflict: false },
  prefetch: { diaryCount: 3, identityEntities: true },
  identity: {
    soulPath: `${homedir()}/SOUL.md`,
    identityPath: `${homedir()}/IDENTITY.md`,
    maxChars: 2000,
  },
  memoryRuntime: {
    allowedReadRoots: [`${homedir()}/.mempalace`, `${homedir()}/.openclaw/workspace`],
  },
};

export function mergeConfig(
  user: Partial<RemempalaceConfig> | undefined,
): RemempalaceConfig {
  if (!user) return DEFAULT_CONFIG;

  const mergedIdentity = { ...DEFAULT_CONFIG.identity, ...user.identity };
  const identity = {
    soulPath: expandTilde(mergedIdentity.soulPath),
    identityPath: expandTilde(mergedIdentity.identityPath),
    maxChars: mergedIdentity.maxChars,
  };

  const userRoots = user.memoryRuntime?.allowedReadRoots;
  const memoryRuntime = {
    allowedReadRoots: userRoots
      ? userRoots.map(expandTilde)
      : DEFAULT_CONFIG.memoryRuntime.allowedReadRoots,
  };

  return {
    mcpPythonBin: user.mcpPythonBin ?? DEFAULT_CONFIG.mcpPythonBin,
    cache: { ...DEFAULT_CONFIG.cache, ...user.cache },
    injection: { ...DEFAULT_CONFIG.injection, ...user.injection },
    tiers: { ...DEFAULT_CONFIG.tiers, ...user.tiers },
    diary: { ...DEFAULT_CONFIG.diary, ...user.diary },
    kg: { ...DEFAULT_CONFIG.kg, ...user.kg },
    prefetch: { ...DEFAULT_CONFIG.prefetch, ...user.prefetch },
    identity,
    memoryRuntime,
  };
}
