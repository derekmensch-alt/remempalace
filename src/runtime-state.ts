// Shared runtime state container.
//
// OpenClaw calls `plugin.register()` multiple times per gateway process (once
// per registration mode: setup-only, setup-runtime, tool-discovery, discovery,
// full, cli-metadata). Without sharing, each closure would construct its own
// `McpMemPalaceRepository`, `DiaryReconciler`, caches, init promise, and health
// state — but only one closure's `before_prompt_build` handler actually runs
// (OpenClaw dedupes hooks by name), so the probe + replay land in that one
// closure. Other closures (e.g. the one serving `remempalace_status`) keep
// stale defaults and report `diary_persistent: no` even after a successful run.
//
// This module mirrors `McpClient.shared({pythonBin})` — it caches the entire
// long-lived state container keyed by the shared `McpClient` instance. Since
// the McpClient is itself keyed by `pythonBin`, two register calls with the
// same pythonBin reuse the same RuntimeState, and all closures see live
// updates.
//
// Edge case — config divergence across register calls: same trade-off as
// `McpClient.shared` makes today. The first register call seeds the cached
// state; later calls with different configs reuse the cached instance and
// their config values are silently ignored. This is acceptable because
// OpenClaw passes the same userConfig to every register call within a process.

import { join, dirname } from "node:path";
import type { McpClient } from "./mcp-client.js";
import type { RemempalaceConfig, SearchResult } from "./types.js";
import type { Logger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { LatencyMetricsService } from "./services/metrics-service.js";
import { BackendCircuitBreakers } from "./services/circuit-breaker.js";
import { MemoryCache } from "./cache.js";
import { McpMemPalaceRepository } from "./adapters/mcp-mempalace-repository.js";
import { MemoryRouter } from "./router.js";
import { DiaryService } from "./services/diary-service.js";
import { RecallService } from "./services/recall-service.js";
import { DiaryReconciler, type ReplayResult } from "./diary-replay.js";
import { KgBatcher } from "./kg.js";
import { LearningService } from "./services/learning-service.js";
import { HeartbeatWarmer } from "./heartbeat.js";
import { MempalaceMemoryRuntime } from "./memory-runtime.js";
import { prefetchWakeUp } from "./prefetch.js";
import { loadHotCache, saveHotCache } from "./recall-cache-store.js";
import {
  loadHealthCache,
  type LoadedHealthCache,
} from "./services/health-cache-store.js";

export interface SessionMessageLite {
  role?: string;
  content?: unknown;
}

export interface PrecomputedRecallEntry {
  prompt: string;
  candidates: string[];
  intentKey: string;
  expiresAt: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  promise: Promise<any>;
}

export interface SessionStartEntry {
  status: unknown;
  diaryEntries: unknown[];
  identity: { soul: string; identity: string };
}

export interface HealthState {
  lastProbeAt: number | null;
  lastProbeReason: string | null;
  lastReplay: ReplayResult | null;
  coldStart: LoadedHealthCache | null;
}

export interface RuntimeState {
  readonly cfg: RemempalaceConfig;
  readonly mcp: McpClient;
  readonly metrics: Metrics;
  readonly latencyMetrics: LatencyMetricsService;
  readonly breakers: BackendCircuitBreakers;
  readonly searchCache: MemoryCache<SearchResult[]>;
  readonly kgCache: MemoryCache<unknown>;
  readonly mempalaceRepository: McpMemPalaceRepository;
  readonly router: MemoryRouter;
  readonly diaryService: DiaryService;
  readonly recallService: RecallService;
  readonly diaryReconciler: DiaryReconciler;
  readonly kgBatcher: KgBatcher | null;
  readonly learningService: LearningService | null;
  readonly heartbeat: HeartbeatWarmer;
  readonly memoryRuntime: MempalaceMemoryRuntime;
  readonly health: HealthState;
  readonly healthCachePath: string;
  // Per-session maps — shared so all closures observe the same lifecycle.
  readonly hookFiredSessions: Set<string>;
  readonly sessionMessages: Map<string, SessionMessageLite[]>;
  readonly lastIngestedIndexBySession: Map<string, number>;
  readonly precomputedRecallBySession: Map<string, PrecomputedRecallEntry>;
  readonly sessionStartCache: Map<string, SessionStartEntry>;
  readonly cachedBySession: Map<string, string[] | null>;
  // Lifecycle helpers.
  ensureInit(): Promise<void>;
  /** Promise-like that calls ensureInit() lazily on .then/.catch/.finally. */
  readonly initPromise: Promise<void>;
  /** Clear the cached init promise so the next call retries (used on failure). */
  resetInitPromise(): void;
  /** True after the hot-cache periodic flush has been wired up. */
  startHotCacheTimerOnce(flush: () => void): void;
  /** Stop the hot-cache periodic flush (idempotent). */
  stopHotCacheTimer(): void;
}

interface RuntimeStateDeps {
  logger: Logger;
}

const states = new Map<McpClient, RuntimeState>();

export function getRuntimeState(
  mcp: McpClient,
  cfg: RemempalaceConfig,
  deps: RuntimeStateDeps,
): RuntimeState {
  const existing = states.get(mcp);
  if (existing) return existing;
  const built = buildRuntimeState(mcp, cfg, deps);
  states.set(mcp, built);
  return built;
}

export async function resetRuntimeStateForTests(): Promise<void> {
  const all = Array.from(states.values());
  states.clear();
  for (const s of all) {
    try {
      s.stopHotCacheTimer();
    } catch {
      // ignore
    }
    try {
      s.heartbeat.stop();
    } catch {
      // ignore
    }
    if (s.kgBatcher) {
      try {
        await s.kgBatcher.stop();
      } catch {
        // ignore
      }
    }
  }
}

function buildRuntimeState(
  mcp: McpClient,
  cfg: RemempalaceConfig,
  deps: RuntimeStateDeps,
): RuntimeState {
  const { logger } = deps;
  const metrics = new Metrics();
  const latencyMetrics = new LatencyMetricsService();
  const breakers = new BackendCircuitBreakers({
    search: cfg.breaker.search,
    kg: cfg.breaker.kg,
    diary: cfg.breaker.diary,
  });
  const searchCache = new MemoryCache<SearchResult[]>({
    capacity: cfg.cache.capacity,
    ttlMs: cfg.cache.ttlMs,
  });
  const kgCache = new MemoryCache<unknown>({
    capacity: cfg.cache.capacity,
    ttlMs: cfg.cache.kgTtlMs,
  });
  const mempalaceRepository = new McpMemPalaceRepository(mcp, {
    latency: latencyMetrics,
    breakers,
  });
  const router = new MemoryRouter({
    repository: mempalaceRepository,
    searchCache,
    kgCache,
    similarityThreshold: cfg.injection.similarityThreshold,
    knownEntities: cfg.injection.knownEntities,
    metrics,
    bundleCacheTtlMs: cfg.cache.bundleTtlMs,
    bundleCacheCapacity: cfg.cache.capacity,
  });
  const diaryService = new DiaryService({
    repository: mempalaceRepository,
    metrics,
    localDir: cfg.diary.localDir,
    persistenceProbeTimeoutMs: cfg.diary.persistenceProbeTimeoutMs,
  });
  const recallService = new RecallService(router);
  const diaryReconciler = new DiaryReconciler({
    diaryDir: cfg.diary.localDir,
    repository: mempalaceRepository,
    metrics,
    minIntervalMs: 5 * 60 * 1000,
    persistenceProbeTimeoutMs: cfg.diary.persistenceProbeTimeoutMs,
  });

  const kgBatcher = cfg.kg.autoLearn
    ? new KgBatcher(mempalaceRepository, {
        batchSize: cfg.kg.batchSize,
        flushIntervalMs: cfg.kg.flushIntervalMs,
        invalidateOnConflict: cfg.kg.invalidateOnConflict,
        metrics,
        onFactsWritten: (facts) => {
          for (const f of facts) {
            router.deleteKgEntity(f.subject);
            router.deleteKgEntity(f.object);
            router.deleteBundleCacheEntriesForEntity(f.subject);
            router.deleteBundleCacheEntriesForEntity(f.object);
          }
        },
      })
    : null;

  const learningService = kgBatcher
    ? new LearningService({
        batcher: kgBatcher,
        minConfidence: cfg.kg.minConfidence,
        config: cfg.learning,
        metrics,
        logger,
      })
    : null;

  const heartbeat = new HeartbeatWarmer({
    intervalMs: 30 * 60 * 1000,
    warm: async () => {
      await prefetchWakeUp(mempalaceRepository, { diaryCount: cfg.prefetch.diaryCount });
    },
  });

  const health: HealthState = {
    lastProbeAt: null,
    lastProbeReason: null,
    lastReplay: null,
    coldStart: null,
  };

  const healthCachePath = join(dirname(cfg.hotCache.path), "health-cache.json");

  // Warm-load health/hot cache exactly once per RuntimeState.
  if (cfg.hotCache.enabled) {
    loadHealthCache(healthCachePath)
      .then((loaded) => {
        if (loaded) {
          health.coldStart = loaded;
          metrics.inc("health_cache.loaded");
        }
      })
      .catch(() => metrics.inc("health_cache.load_failed"));

    loadHotCache(cfg.hotCache.path)
      .then((snapshot) => {
        if (snapshot) {
          const loaded = router.importHotEntries(snapshot.entries, Date.now());
          metrics.inc("recall.hot_cache.loaded_entries", loaded);
        }
      })
      .catch(() => metrics.inc("recall.hot_cache.load_failed"));
  }

  // Init promise / ensureInit (shared across all closures).
  let _initPromise: Promise<void> | null = null;

  const ensureInit = (): Promise<void> => {
    if (_initPromise) return _initPromise;
    _initPromise = mcp
      .start()
      .then(async () => {
        logger.info("MCP client started");
        await mcp.probeCapabilities().catch(() => {});
        await diaryService.verifyPersistenceAndReplay({
          replayOnStart: cfg.diary.replayOnStart,
          reconciler: diaryReconciler,
          onProbeError: (err) => {
            health.lastProbeAt = Date.now();
            health.lastProbeReason = `probe-error: ${err.message}`;
            logger.warn(`diary persistence probe failed: ${err.message}`);
          },
          onProbeResult: (result) => {
            health.lastProbeAt = Date.now();
            health.lastProbeReason = result.verified
              ? `verified: ${result.state}`
              : `unverified: ${result.state}${result.error ? ` (${result.error})` : ""}`;
            if (!result.verified) {
              logger.warn(
                `diary persistence unverified: state=${result.state}${result.error ? ` error=${result.error}` : ""}`,
              );
            }
          },
          onReplayResult: (r) => {
            health.lastReplay = r;
            if (r.attempted > 0) {
              logger.info(
                `diary replay: ${r.succeeded}/${r.attempted} succeeded, ${r.failed} failed`,
              );
            }
          },
          onReplayError: (err) => {
            logger.warn(`diary replay failed: ${err.message}`);
          },
        });
        heartbeat.start();
      })
      .catch((err: Error) => {
        _initPromise = null;
        logger.error(`MCP start failed: ${err.message}`);
      });
    return _initPromise;
  };

  const initPromise: Promise<void> = {
    then: (...args: Parameters<Promise<void>["then"]>) => ensureInit().then(...args),
    catch: (...args: Parameters<Promise<void>["catch"]>) => ensureInit().catch(...args),
    finally: (...args: Parameters<Promise<void>["finally"]>) => ensureInit().finally(...args),
    [Symbol.toStringTag]: "Promise",
  } as Promise<void>;

  const memoryRuntime = new MempalaceMemoryRuntime({
    mcp,
    repository: mempalaceRepository,
    similarityThreshold: cfg.injection.similarityThreshold,
    allowedReadRoots: cfg.memoryRuntime.allowedReadRoots,
    allowedWriteRoots: cfg.memoryRuntime.allowedWriteRoots,
    waitUntilReady: () => initPromise,
  });

  // Hot-cache periodic flush — wire exactly once per RuntimeState.
  let hotCacheInterval: ReturnType<typeof setInterval> | null = null;
  let hotCacheTimerStarted = false;

  const startHotCacheTimerOnce = (flush: () => void): void => {
    if (hotCacheTimerStarted) return;
    if (!cfg.hotCache.enabled) return;
    hotCacheTimerStarted = true;
    hotCacheInterval = setInterval(flush, cfg.hotCache.flushIntervalMs);
  };

  const stopHotCacheTimer = (): void => {
    if (hotCacheInterval !== null) {
      clearInterval(hotCacheInterval);
      hotCacheInterval = null;
    }
  };

  return {
    cfg,
    mcp,
    metrics,
    latencyMetrics,
    breakers,
    searchCache,
    kgCache,
    mempalaceRepository,
    router,
    diaryService,
    recallService,
    diaryReconciler,
    kgBatcher,
    learningService,
    heartbeat,
    memoryRuntime,
    health,
    healthCachePath,
    hookFiredSessions: new Set<string>(),
    sessionMessages: new Map(),
    lastIngestedIndexBySession: new Map(),
    precomputedRecallBySession: new Map(),
    sessionStartCache: new Map(),
    cachedBySession: new Map(),
    ensureInit,
    initPromise,
    resetInitPromise: () => {
      _initPromise = null;
    },
    startHotCacheTimerOnce,
    stopHotCacheTimer,
  };
}

// Re-export so tests can keep working with a single saveHotCache import path
// if needed in the future. (No code currently depends on this re-export.)
export { saveHotCache };
