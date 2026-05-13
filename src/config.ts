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
  // Default assumes `python3` is on PATH and has the `mempalace` package
  // installed (e.g. `pip install mempalace`). Users installing via pipx
  // should point this at their venv python, e.g.
  // `~/.local/share/pipx/venvs/mempalace/bin/python`.
  mcpPythonBin: "python3",
  cache: { capacity: 200, ttlMs: 300000, kgTtlMs: 600000, bundleTtlMs: 180000 },
  injection: {
    maxTokens: 800,
    budgetPercent: 0.15,
    similarityThreshold: 0.25,
    useAaak: true,
    // Framework-level entities that should always be considered for KG lookup
    // even if not extracted by the NER heuristic. Add the user's own canonical
    // entities (name, project names, etc.) via injection.knownEntities in
    // openclaw.json.
    knownEntities: ["OpenClaw", "MemPalace", "remempalace", "Anthropic", "Claude"],
    identityMaxTokens: 150,
    rawIdentity: false,
    fastRaceMs: 50,
    budgets: {
      initMs: 200,
      fetchMs: 1100,
      formatMs: 200,
    },
  },
  tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
  diary: {
    enabled: true,
    maxEntryTokens: 500,
    localDir: `${homedir()}/.mempalace/palace/diary`,
    replayOnStart: true,
    // Cold-start mempalace needs ~1.5–2s to load the embedding model and
    // complete the first chromadb write. The legacy 500ms hot-path budget
    // would always fail on the very first probe after a restart, leaving
    // diary persistence stuck in `tool-present` and gating replay.
    persistenceProbeTimeoutMs: 3000,
  },
  kg: {
    autoLearn: true,
    batchSize: 5,
    flushIntervalMs: 30000,
    invalidateOnConflict: false,
    minConfidence: 0.6,
  },
  learning: {
    fromUser: true,
    fromAssistant: false,
    fromSystem: false,
  },
  prefetch: { diaryCount: 3, identityEntities: true },
  identity: {
    soulPath: `${homedir()}/SOUL.md`,
    identityPath: `${homedir()}/IDENTITY.md`,
    maxChars: 2000,
  },
  memoryRuntime: {
    allowedReadRoots: [`${homedir()}/.mempalace`, `${homedir()}/.openclaw/workspace`],
    // Write safety: default empty — all writeFile calls are rejected unless the
    // user explicitly enumerates allowed write roots. This is a defence-in-depth
    // gate at the adapter boundary; MCP diary/KG writes are gated separately by
    // the repository's canWriteDiary / canInvalidateKg capabilities.
    allowedWriteRoots: [] as string[],
  },
  hotCache: {
    enabled: true,
    path: `${homedir()}/.mempalace/remempalace/hot-cache.json`,
    maxEntries: 50,
    flushIntervalMs: 60_000,
  },
  breaker: {
    search: { failureThreshold: 3, windowMs: 10_000, cooldownMs: 15_000 },
    kg: { failureThreshold: 3, windowMs: 10_000, cooldownMs: 15_000 },
    diary: { failureThreshold: 3, windowMs: 10_000, cooldownMs: 15_000 },
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
  const userWriteRoots = user.memoryRuntime?.allowedWriteRoots;
  const memoryRuntime = {
    allowedReadRoots: userRoots
      ? userRoots.map(expandTilde)
      : DEFAULT_CONFIG.memoryRuntime.allowedReadRoots,
    allowedWriteRoots: userWriteRoots
      ? userWriteRoots.map(expandTilde)
      : DEFAULT_CONFIG.memoryRuntime.allowedWriteRoots,
  };

  const mergedHotCache = { ...DEFAULT_CONFIG.hotCache, ...user.hotCache };

  return {
    mcpPythonBin: user.mcpPythonBin ?? DEFAULT_CONFIG.mcpPythonBin,
    cache: { ...DEFAULT_CONFIG.cache, ...user.cache },
    injection: {
      ...DEFAULT_CONFIG.injection,
      ...user.injection,
      budgets: {
        ...DEFAULT_CONFIG.injection.budgets,
        ...user.injection?.budgets,
      },
    },
    tiers: { ...DEFAULT_CONFIG.tiers, ...user.tiers },
    diary: {
      ...DEFAULT_CONFIG.diary,
      ...user.diary,
      localDir: expandTilde(user.diary?.localDir ?? DEFAULT_CONFIG.diary.localDir),
    },
    kg: { ...DEFAULT_CONFIG.kg, ...user.kg },
    learning: { ...DEFAULT_CONFIG.learning, ...user.learning },
    prefetch: { ...DEFAULT_CONFIG.prefetch, ...user.prefetch },
    identity,
    memoryRuntime,
    hotCache: {
      enabled: mergedHotCache.enabled,
      path: expandTilde(mergedHotCache.path),
      maxEntries: mergedHotCache.maxEntries,
      flushIntervalMs: mergedHotCache.flushIntervalMs,
    },
    breaker: {
      search: { ...DEFAULT_CONFIG.breaker.search, ...user.breaker?.search },
      kg: { ...DEFAULT_CONFIG.breaker.kg, ...user.breaker?.kg },
      diary: { ...DEFAULT_CONFIG.breaker.diary, ...user.breaker?.diary },
    },
  };
}
