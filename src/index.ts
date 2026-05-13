import { promises as fs } from "node:fs";
import { mergeConfig } from "./config.js";
import { createLogger } from "./logger.js";

const DEBUG_PATH = "/tmp/remempalace-last-inject.log";
async function debugLog(label: string, data: unknown): Promise<void> {
  if (process.env.REMEMPALACE_DEBUG !== "1") return;
  try {
    const ts = new Date().toISOString();
    const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await fs.appendFile(DEBUG_PATH, `\n==== ${ts} ${label} ====\n${body}\n`);
  } catch {
    // swallow
  }
}
import { McpClient } from "./mcp-client.js";
import { normalizeIntent, type ReadBundle } from "./router.js";
import type { RemempalaceConfig } from "./types.js";
import { BudgetManager, DEFAULT_CONTEXT_WINDOW } from "./budget.js";
import { buildTieredInjection } from "./tiers.js";
import { countTokens } from "./token-counter.js";
import type { KgFact } from "./types.js";
import { summarizeSession } from "./diary.js";
import { loadIdentityContext } from "./identity.js";
import { prefetchWakeUp } from "./prefetch.js";
import { compactIdentity } from "./identity-compact.js";
import { isTimelineQuery, queryTimeline } from "./timeline.js";
import { registerRemempalaceAgentTools } from "./agent-tools.js";
import { StatusController } from "./controllers/status-controller.js";
import {
  buildDefaultRuntimeDisclosure,
  PromptInjectionService,
} from "./services/prompt-injection-service.js";
import { kgSourceClosetForRole } from "./services/learning-service.js";
import {
  buildHealthSnapshot,
  saveHealthCache,
} from "./services/health-cache-store.js";
import { saveHotCache } from "./recall-cache-store.js";
import { getRuntimeState } from "./runtime-state.js";

interface SessionMessage {
  role?: string;
  content?: unknown;
}

interface MemoryCapability {
  promptBuilder?: (params: unknown) => string[];
  runtime?: unknown;
}

interface PluginCommandContext {
  args?: string;
  [key: string]: unknown;
}

interface PluginCommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: PluginCommandContext) => { text: string } | Promise<{ text: string }>;
}

interface PluginApi {
  config?: {
    plugins?: {
      entries?: Record<string, { config?: Partial<RemempalaceConfig> }>;
    };
  };
  registerMemoryCapability?: (capability: MemoryCapability) => void;
  registerMemoryPromptSection?: (fn: (params: unknown) => string[]) => void;
  registerCommand?: (command: PluginCommandDefinition) => void;
  registerTool?: (
    tool: unknown,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => void;
  on?: (
    event: string,
    handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
  ) => void;
}

export function resolvePluginUserConfig(
  api: PluginApi | undefined,
  fallback: Partial<RemempalaceConfig> | undefined,
  pluginId: string,
): Partial<RemempalaceConfig> | undefined {
  const fromApi = api?.config?.plugins?.entries?.[pluginId]?.config;
  if (fromApi && Object.keys(fromApi).length > 0) return fromApi;
  return fallback;
}

interface PromptBuildEvent {
  prompt?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
}

interface HookContext {
  sessionKey?: string;
}

interface PrecomputedRecall {
  prompt: string;
  candidates: string[];
  intentKey: string;
  expiresAt: number;
  promise: Promise<ReadBundle>;
}

export const PROMPT_RECALL_DEADLINE_MS = 1500;
export const PROMPT_STAGE_BUDGETS_MS = {
  init: 400,
  fetch: 900,
  format: 200,
} as const;

export interface PromptMemoryDeadline {
  readonly startedAt: number;
  readonly timeoutMs: number;
  elapsedMs(): number;
  remainingMs(): number;
}

export function createPromptMemoryDeadline(
  timeoutMs = PROMPT_RECALL_DEADLINE_MS,
  now: () => number = Date.now,
): PromptMemoryDeadline {
  const startedAt = now();
  return {
    startedAt,
    timeoutMs,
    elapsedMs: () => Math.max(0, now() - startedAt),
    remainingMs: () => Math.max(0, timeoutMs - Math.max(0, now() - startedAt)),
  };
}

export async function withPromptMemoryDeadline<T>(
  promise: Promise<T>,
  fallback: T,
  deadlineOrTimeout: PromptMemoryDeadline | number = PROMPT_RECALL_DEADLINE_MS,
): Promise<{ value: T; timedOut: boolean }> {
  const timeoutMs =
    typeof deadlineOrTimeout === "number"
      ? deadlineOrTimeout
      : deadlineOrTimeout.remainingMs();
  if (timeoutMs <= 0) return { value: fallback, timedOut: true };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value, timedOut: false })),
      new Promise<{ value: T; timedOut: boolean }>((resolve) => {
        timeout = setTimeout(() => resolve({ value: fallback, timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const withPromptRecallDeadline = withPromptMemoryDeadline;

export function stageBudgetMs(
  deadline: PromptMemoryDeadline,
  stageCapMs: number,
): number {
  return Math.max(0, Math.min(deadline.remainingMs(), Math.max(0, stageCapMs)));
}

export type {
  KgFactSourceRole,
} from "./services/learning-service.js";
export {
  kgConfidenceThresholdForSource,
  kgSourceClosetForRole,
} from "./services/learning-service.js";

function extractText(msg: { role?: string; content?: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part && typeof part.text === "string"
            ? part.text
            : "",
      )
      .join(" ");
  }
  return "";
}

function resolvePrompt(ev: PromptBuildEvent): string {
  if (typeof ev.prompt === "string" && ev.prompt.length >= 5) return ev.prompt;
  const messages = ev.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      const txt = extractText(m);
      if (txt.length >= 5) return txt;
    }
  }
  return "";
}

function latestUserPrompt(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const clean = stripRuntimeInjectionBlocks(extractText(message));
    if (clean.length >= 5) return clean;
  }
  return "";
}

function emptyRecallBundle(): ReadBundle {
  return { searchResults: [], kgResults: { facts: [] } };
}

function normalizeKgResult(raw: unknown): KgFact[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw as KgFact[];
  if ("facts" in raw && Array.isArray((raw as { facts: unknown[] }).facts)) {
    return (raw as { facts: KgFact[] }).facts;
  }
  return [];
}

const RUNTIME_BLOCK_RE =
  /^##\s+(?:Active Memory Plugin|Memory Context|Identity|System Notes|Timeline Context)\s*\(remempalace\)[^\n]*(?:\n(?!##\s)[^\n]*)*/gm;

export function stripRuntimeInjectionBlocks(text: string): string {
  return text.replace(RUNTIME_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildRuntimeDisclosure(): string[] {
  return buildDefaultRuntimeDisclosure();
}

const plugin = {
  id: "remempalace",
  name: "remempalace",
  description: "Full-lifecycle memory plugin for OpenClaw, powered by MemPalace.",
  register(api: PluginApi, userConfig?: Partial<RemempalaceConfig>) {
    const resolved = resolvePluginUserConfig(api, userConfig, "remempalace");
    const cfg = mergeConfig(resolved);
    const logger = createLogger("remempalace");
    logger.info(`config resolved: pythonBin=${cfg.mcpPythonBin}`);

    const mcp = McpClient.shared({ pythonBin: cfg.mcpPythonBin });
    // Shared runtime state — survives across multiple register() invocations.
    // OpenClaw calls register() once per registration mode (setup-only,
    // setup-runtime, tool-discovery, discovery, full, cli-metadata) and only
    // one closure's before_prompt_build hook will fire; we route every closure
    // through this shared container so all of them observe the same live state.
    const runtime = getRuntimeState(mcp, cfg, { logger });
    const {
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
      hookFiredSessions,
      sessionMessages,
      lastIngestedIndexBySession,
      precomputedRecallBySession,
      sessionStartCache,
      cachedBySession,
      initPromise,
    } = runtime;
    const stageBudgets = {
      init: cfg.injection.budgets.initMs,
      fetch: cfg.injection.budgets.fetchMs,
      format: cfg.injection.budgets.formatMs,
    };
    const promptInjectionService = new PromptInjectionService();

    const flushHealthCache = async (): Promise<void> => {
      try {
        const snapshot = buildHealthSnapshot({
          mcpReady: mcp.isReady(),
          capabilities: {
            canWriteDiary: mempalaceRepository.canWriteDiary,
            canReadDiary: mempalaceRepository.canReadDiary,
            canInvalidateKg: mempalaceRepository.canInvalidateKg,
            canPersistDiary: mempalaceRepository.canPersistDiary,
          },
          diaryPersistenceState: mempalaceRepository.diaryPersistenceState,
          lastProbeAt: health.lastProbeAt,
          lastProbeReason: health.lastProbeReason,
          lastReplay: health.lastReplay,
        });
        await saveHealthCache(healthCachePath, snapshot);
        metrics.inc("health_cache.flushed");
      } catch {
        metrics.inc("health_cache.flush_failed");
      }
    };

    const flushHotCache = async (): Promise<void> => {
      try {
        const entries = router.exportHotEntries(cfg.hotCache.maxEntries);
        await saveHotCache(cfg.hotCache.path, {
          version: 1,
          savedAt: Date.now(),
          entries,
        });
        metrics.inc("recall.hot_cache.flushed_entries", entries.length);
      } catch {
        metrics.inc("recall.hot_cache.flush_failed");
      }
    };

    // Idempotent: only the first register call wires up the periodic flush.
    runtime.startHotCacheTimerOnce(() => {
      void flushHotCache();
    });

    const statusController = new StatusController({
      isMcpReady: () => mcp.isReady(),
      canWriteDiary: () => mempalaceRepository.canWriteDiary,
      canReadDiary: () => mempalaceRepository.canReadDiary,
      canInvalidateKg: () => mempalaceRepository.canInvalidateKg,
      canPersistDiary: () => mempalaceRepository.canPersistDiary,
      searchCacheStats: () => searchCache.stats(),
      kgCacheStats: () => kgCache.stats(),
      metricsSnapshot: () => metrics.snapshot(),
      latencySnapshot: () => latencyMetrics.snapshot(),
      breakersSnapshot: () => breakers.snapshot(),
      diaryStatus: () => diaryService.getStatus({ reconciler: diaryReconciler }),
      lastProbeAt: () => health.lastProbeAt,
      lastProbeReason: () => health.lastProbeReason,
      coldStartHealth: () => health.coldStart,
    });

    const budgetManager = new BudgetManager({
      maxMemoryTokens: cfg.injection.maxTokens,
      budgetPercent: cfg.injection.budgetPercent,
      l2BudgetFloor: cfg.tiers.l2BudgetFloor,
    });

    if (typeof api.on === "function") {
      api.on("session_start", async (_event: unknown, ctx: unknown) => {
        await initPromise;
        const hctx = ctx as HookContext;
        const key = hctx?.sessionKey ?? "default";
        try {
          const [prefetch, identity] = await Promise.all([
            prefetchWakeUp(mempalaceRepository, { diaryCount: cfg.prefetch.diaryCount }),
            cfg.prefetch.identityEntities
              ? loadIdentityContext({
                  soulPath: cfg.identity.soulPath,
                  identityPath: cfg.identity.identityPath,
                  maxChars: cfg.identity.maxChars,
                })
              : Promise.resolve({ soul: "", identity: "" }),
          ]);
          sessionStartCache.set(key, { ...prefetch, identity });
        } catch (err) {
          logger.warn(`session_start prefetch failed: ${(err as Error).message}`);
        }
      });

      api.on("llm_input", (event: unknown, ctx: unknown) => {
        const ev = event as { historyMessages?: unknown[] };
        const hctx = ctx as HookContext;
        const key = hctx?.sessionKey ?? "default";
        if (ev.historyMessages) {
          const messages = ev.historyMessages as SessionMessage[];
          sessionMessages.set(key, messages);
          if (learningService) {
            const previousIndex = lastIngestedIndexBySession.get(key) ?? 0;
            const startIndex = previousIndex <= messages.length ? previousIndex : 0;
            for (const message of messages.slice(startIndex)) {
              if (message.role !== "user") continue;
              const clean = stripRuntimeInjectionBlocks(extractText(message));
              learningService.ingestTurn(clean, "user");
            }
            lastIngestedIndexBySession.set(key, messages.length);
          }
          const prompt = latestUserPrompt(messages);
          if (!prompt || prompt.length < 10 || isTimelineQuery(prompt) || recallService.shouldSkipRecall(prompt)) {
            precomputedRecallBySession.delete(key);
            return;
          }
          const candidates = recallService.extractCandidates(prompt);
          const recallMode = recallService.selectRecallMode(prompt, candidates);
          if (recallMode !== "full") {
            precomputedRecallBySession.delete(key);
            return;
          }
          const intentKey = normalizeIntent(prompt, candidates);
          const expiresAt = Date.now() + cfg.cache.bundleTtlMs;
          const existing = precomputedRecallBySession.get(key);
          if (
            existing &&
            existing.intentKey === intentKey &&
            existing.expiresAt > Date.now()
          ) {
            return;
          }
          metrics.inc("recall.precompute.started");
          const promise = initPromise.then(() =>
            recallService.readBundle(prompt, 5, candidates, { mode: "full" }),
          );
          promise.catch((err: Error) => {
            metrics.inc("recall.precompute.failed");
            void debugLog("llm_input:recall-precompute-error", {
              sessionKey: key,
              error: err.message,
            });
          });
          precomputedRecallBySession.set(key, {
            prompt,
            candidates,
            intentKey,
            expiresAt,
            promise,
          });
        }
      });

      if (cfg.diary.enabled) {
        api.on("session_end", async (event: unknown, ctx: unknown) => {
          const hctx = ctx as HookContext;
          const key = hctx?.sessionKey ?? "default";
          const messages = sessionMessages.get(key) ?? [];
          sessionMessages.delete(key);
          lastIngestedIndexBySession.delete(key);
          const summary = summarizeSession(messages, { maxTokens: cfg.diary.maxEntryTokens });
          if (!summary) return;
          await diaryService.writeSessionSummaryAsync(summary);
        });
      }

      if (learningService && cfg.learning.fromAssistant) {
        api.on("llm_output", (event: unknown) => {
          const ev = event as { assistantTexts?: string[] };
          if (!ev.assistantTexts) return;
          for (const text of ev.assistantTexts) {
            learningService.ingestTurn(text, "assistant");
          }
        });
      }

      api.on("before_prompt_build", async (event: unknown, ctx: unknown) => {
        metrics.inc("recall.invoked");
        const promptStartedAt = Date.now();
        const ev = event as PromptBuildEvent;
        const hctx = ctx as HookContext & { modelId?: string; contextWindow?: number };
        const sessionKey = hctx?.sessionKey ?? "default";
        // Mark that this hook has fired for the session.  The builder checks
        // this flag and returns [] so it never duplicates content that has
        // already been delivered via prependSystemContext.
        hookFiredSessions.add(sessionKey);
        cachedBySession.set(sessionKey, null);
        const prompt = resolvePrompt(ev);
        await debugLog("before_prompt_build:enter", {
          sessionKey,
          promptLen: prompt.length,
          promptPreview: prompt.slice(0, 200),
          modelId: hctx?.modelId,
          contextWindow: hctx?.contextWindow,
        });
        if (!prompt || prompt.length < 10) {
          await debugLog("before_prompt_build:skip-short-prompt", { sessionKey, promptLen: prompt.length });
          return;
        }

        const memoryDeadline = createPromptMemoryDeadline();
        const initBudgetMs = stageBudgetMs(memoryDeadline, stageBudgets.init);
        const initResult = await withPromptMemoryDeadline(
          initPromise.then(() => true),
          false,
          initBudgetMs,
        );
        const initLatencyMs = Math.max(0, Date.now() - promptStartedAt);
        latencyMetrics.recordLatency("before_prompt_build.init", initLatencyMs);
        metrics.inc("latency.before_prompt_build.init.ms_total", initLatencyMs);
        metrics.inc("latency.before_prompt_build.init.count");
        if (initLatencyMs > stageBudgets.init) {
          metrics.inc("latency.before_prompt_build.init.overrun");
          void debugLog("before_prompt_build:init-overrun", {
            sessionKey,
            initLatencyMs,
            budgetMs: stageBudgets.init,
          });
          logger.warn(`prompt-path init overran sub-budget: ${initLatencyMs}ms > ${stageBudgets.init}ms`);
        }
        if (initResult.timedOut || !initResult.value) {
          metrics.inc("recall.init.timeout");
          await debugLog("before_prompt_build:init-timeout", {
            sessionKey,
            deadlineMs: memoryDeadline.timeoutMs,
          });
          const lines = promptInjectionService.buildRuntimeDisclosure();
          cachedBySession.set(sessionKey, lines);
          return { prependSystemContext: lines.join("\n") };
        }

        // Timeline branch: bypass tiered recall for temporal queries
        if (isTimelineQuery(prompt)) {
          metrics.inc("recall.timeline.calls");
          try {
            const timelineResult = await withPromptMemoryDeadline(
              queryTimeline(mempalaceRepository, {
                daysBack: 7,
                diaryReadTimeoutMs: Math.min(
                  500,
                  stageBudgetMs(memoryDeadline, stageBudgets.fetch),
                ),
              }),
              { diary: [], events: [] },
              stageBudgetMs(memoryDeadline, stageBudgets.fetch),
            );
            const tl = timelineResult.value;
            if (timelineResult.timedOut) {
              metrics.inc("recall.timeline.timeout");
              await debugLog("before_prompt_build:timeline-timeout", {
                sessionKey,
                deadlineMs: memoryDeadline.timeoutMs,
              });
            }
            const lines = promptInjectionService.buildTimelineContext(tl);
            cachedBySession.set(sessionKey, lines);
            const block = lines.join("\n");
            await debugLog("before_prompt_build:timeline-returning", {
              sessionKey,
              blockLen: block.length,
            });
            return { prependSystemContext: block };
          } catch (err) {
            logger.warn(`timeline query failed: ${(err as Error).message}`);
          }
        }

        if (recallService.shouldSkipRecall(prompt)) {
          metrics.inc("recall.skipped.low_semantic");
          await debugLog("before_prompt_build:skip-low-semantic", {
            sessionKey,
            promptLen: prompt.length,
          });
          return;
        }

        const contextWindow = hctx.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const conversationTokens = ev.messages
          ? ev.messages.reduce((sum, m) => sum + countTokens(extractText(m)), 0)
          : 0;

        const budget = budgetManager.compute({ conversationTokens, contextWindow });

        let lines: string[] = promptInjectionService.buildRuntimeDisclosure();

        // Compact identity and prepend when L0 tier is allowed
        const start = sessionStartCache.get(sessionKey);
        const identityCompacted =
          start?.identity && budget.allowedTiers.includes("L0")
            ? compactIdentity(start.identity, {
                maxTokens: cfg.injection.identityMaxTokens,
                rawIdentity: cfg.injection.rawIdentity,
              })
            : "";

        try {
          const fetchStartedAt = Date.now();
          const candidates = recallService.extractCandidates(prompt);
          if (process.env.REMEMPALACE_DEBUG === "1") {
            await debugLog("before_prompt_build:candidates", {
              sessionKey,
              promptFull: prompt.slice(0, 3000),
              promptLen: prompt.length,
              candidates,
            });
            const perEntityKg = await Promise.all(
              candidates.map(async (c) => {
                try {
                  const raw = await router.kgQuery(c);
                  const facts = normalizeKgResult(raw);
                  return { entity: c, rawFactsCount: facts.length, rawSample: facts.slice(0, 2) };
                } catch (e) {
                  const message = e instanceof Error ? e.message : String(e);
                  return { entity: c, rawFactsCount: -1, rawSample: message };
                }
              }),
            );
            await debugLog("before_prompt_build:per-entity-kg", { sessionKey, perEntityKg });
          }
          const recallMode = recallService.selectRecallMode(prompt, candidates);
          if (recallMode === "cheap") {
            metrics.inc("recall.cheap.calls");
          } else if (recallMode === "cheap+kg1") {
            metrics.inc("recall.cheap_kg1.calls");
          }
          await debugLog("before_prompt_build:recall-mode", {
            sessionKey,
            recallMode,
            candidateCount: candidates.length,
          });
          const precomputed = precomputedRecallBySession.get(sessionKey);
          const intentKey = normalizeIntent(prompt, candidates);
          const precomputedExpired =
            precomputed !== undefined && precomputed.expiresAt <= Date.now();
          if (precomputedExpired) {
            precomputedRecallBySession.delete(sessionKey);
          }
          const canUsePrecomputed =
            recallMode === "full" &&
            precomputed !== undefined &&
            !precomputedExpired &&
            precomputed.intentKey === intentKey;
          const bundlePromise = canUsePrecomputed
            ? precomputed.promise
            : recallService.readBundle(prompt, 5, candidates, { mode: recallMode });
          bundlePromise.catch((err: Error) => {
            void debugLog("before_prompt_build:background-recall-error", {
              sessionKey,
              recallMode,
              error: err.message,
            });
          });

          // Fast-race for full-recall mode: only await the bundle for a short
          // window (fastRaceMs). If the bundle is already resolved (precomputed),
          // this wins immediately. If the MCP call is still in-flight, we fall
          // back to cheap mode and let the bundle keep running in the background
          // — its router.search / router.kgQuery calls will still populate the
          // LRU caches for the next turn.
          let bundle: ReadBundle;
          let usedFastRace = false;
          let usedCheapKgFallback = false;
          if (recallMode === "full") {
            const fastRaceMs = Math.min(
              cfg.injection.fastRaceMs,
              stageBudgetMs(memoryDeadline, stageBudgets.fetch),
            );
            const fastResult = await withPromptMemoryDeadline(
              bundlePromise,
              null as unknown as ReadBundle,
              fastRaceMs,
            );
            if (!fastResult.timedOut) {
              // Bundle resolved within the fast window — use it.
              metrics.inc("recall.fast_race.hit");
              bundle = fastResult.value;
            } else {
              // Bundle not ready yet — fall back to cheap mode for this prompt.
              // The bundle promise keeps running and writes to LRU caches.
              metrics.inc("recall.fast_race.miss");
              usedFastRace = true;
              // Keep a reference so the promise is not GC'd before it resolves.
              bundlePromise.catch(() => {
                // errors already handled by the precompute catch above
              });
              bundle = emptyRecallBundle();
            }

            // Emit recall.full.timeout if the overall prompt-path deadline is
            // exhausted (covers edge cases where init consumed nearly all of
            // memoryDeadline before the fast race ran).
            if (memoryDeadline.remainingMs() <= 0) {
              metrics.inc("recall.full.timeout");
              await debugLog("before_prompt_build:recall-timeout", {
                sessionKey,
                recallMode,
                deadlineMs: PROMPT_RECALL_DEADLINE_MS,
                usedPrecomputed: canUsePrecomputed,
                fastRaceMiss: usedFastRace,
              });
            }
          } else if (recallMode === "cheap+kg1") {
            const cheapKgResult = await withPromptMemoryDeadline(
              bundlePromise,
              emptyRecallBundle(),
              Math.min(
                cfg.injection.fastRaceMs,
                stageBudgetMs(memoryDeadline, stageBudgets.fetch),
              ),
            );
            if (cheapKgResult.timedOut) {
              metrics.inc("recall.cheap_kg1.timeout");
              usedCheapKgFallback = true;
            }
            bundle = cheapKgResult.value;
          } else {
            bundle = await bundlePromise;
          }

          if (canUsePrecomputed) {
            metrics.inc("recall.precompute.used");
            if (precomputed.prompt !== prompt) {
              metrics.inc("recall.precompute.intent_used");
            }
            precomputedRecallBySession.delete(sessionKey);
          }
          const fetchLatencyMs = Math.max(0, Date.now() - fetchStartedAt);
          latencyMetrics.recordLatency("before_prompt_build.fetch", fetchLatencyMs);
          metrics.inc("latency.before_prompt_build.fetch.ms_total", fetchLatencyMs);
          metrics.inc("latency.before_prompt_build.fetch.count");
          if (fetchLatencyMs > stageBudgets.fetch) {
            metrics.inc("latency.before_prompt_build.fetch.overrun");
            void debugLog("before_prompt_build:fetch-overrun", {
              sessionKey,
              fetchLatencyMs,
              budgetMs: stageBudgets.fetch,
            });
            logger.warn(`prompt-path fetch overran sub-budget: ${fetchLatencyMs}ms > ${stageBudgets.fetch}ms`);
          }
          const formatStartedAt = Date.now();
          const formatBudgetMs = stageBudgetMs(memoryDeadline, stageBudgets.format);
          const kgFacts = normalizeKgResult(bundle.kgResults);
          const overheadTokens = promptInjectionService.computeOverheadTokens({
            identityIncluded: identityCompacted.length > 0,
          });
          const injected =
            formatBudgetMs <= 0
              ? []
              : recallMode === "cheap" || usedFastRace || usedCheapKgFallback
              ? recallService.buildCheapMemoryLines({
                  prompt,
                  diaryEntries: start?.diaryEntries,
                  maxDiaryEntries: 2,
                })
              : buildTieredInjection({
                  kgFacts,
                  searchResults: bundle.searchResults,
                  budget,
                  tiers: cfg.tiers,
                  useAaak: cfg.injection.useAaak,
                  metrics,
                  fixedOverheadTokens: overheadTokens,
                });

          lines = promptInjectionService.buildRecallContext({
            identity: identityCompacted,
            memoryLines: injected,
          });
          const formatLatencyMs = Math.max(0, Date.now() - formatStartedAt);
          latencyMetrics.recordLatency("before_prompt_build.format", formatLatencyMs);
          metrics.inc("latency.before_prompt_build.format.ms_total", formatLatencyMs);
          metrics.inc("latency.before_prompt_build.format.count");
          if (formatLatencyMs > stageBudgets.format) {
            metrics.inc("latency.before_prompt_build.format.overrun");
            void debugLog("before_prompt_build:format-overrun", {
              sessionKey,
              formatLatencyMs,
              budgetMs: stageBudgets.format,
            });
            logger.warn(`prompt-path format overran sub-budget: ${formatLatencyMs}ms > ${stageBudgets.format}ms`);
          }
          const totalLatencyMs = Math.max(0, Date.now() - promptStartedAt);
          latencyMetrics.recordLatency("before_prompt_build.total", totalLatencyMs);
          metrics.inc("latency.before_prompt_build.total.ms_total", totalLatencyMs);
          metrics.inc("latency.before_prompt_build.total.count");
          metrics.setMax("latency.before_prompt_build.total.max_ms", totalLatencyMs);

          await debugLog("before_prompt_build:assembled", {
            sessionKey,
            kgFactCount: kgFacts.length,
            searchResultCount: bundle.searchResults.length,
            injectedLineCount: injected.length,
            identityIncluded: identityCompacted.length > 0,
            budget,
            finalLineCount: lines.length,
            finalBlock: lines.join("\n"),
          });
          statusController.recordRecall({
            sessionKey,
            promptPreview: prompt.slice(0, 160),
            candidates,
            kgFactCount: kgFacts.length,
            searchResultCount: bundle.searchResults.length,
            injectedLineCount: injected.length,
            identityIncluded: identityCompacted.length > 0,
            at: Date.now(),
          });
          cachedBySession.set(sessionKey, lines);

          // Return the block as prependSystemContext — openclaw's
          // before_prompt_build dispatcher reads the handler's return value and
          // merges {systemPrompt, prependContext, prependSystemContext,
          // appendSystemContext} into the outgoing prompt. Event mutation is
          // ignored; only the return shape flows through.
          //   selection-DmkxuIQC.js:4033 resolvePromptBuildHookResult
          //   hook-runner-global-CImEMsgK.js:54 mergeBeforePromptBuild
          const block = lines.join("\n");
          await debugLog("before_prompt_build:returning", {
            sessionKey,
            blockLen: block.length,
            channel: "prependSystemContext",
          });
          return { prependSystemContext: block };
        } catch (err) {
          await debugLog("before_prompt_build:error", { sessionKey, error: (err as Error).message });
          logger.warn(`recall failed: ${(err as Error).message}`);
          cachedBySession.set(sessionKey, lines);
          statusController.recordRecall({
            sessionKey,
            promptPreview: prompt.slice(0, 160),
            candidates: [],
            kgFactCount: 0,
            searchResultCount: 0,
            injectedLineCount: 0,
            identityIncluded: false,
            at: Date.now(),
          });
          return { prependSystemContext: lines.join("\n") };
        }
      });

      api.on("gateway_stop", async () => {
        heartbeat.stop();
        if (kgBatcher) await kgBatcher.stop();
        runtime.stopHotCacheTimer();
        if (cfg.hotCache.enabled) await flushHotCache();
        if (cfg.hotCache.enabled) await flushHealthCache();
        await mcp.stop();
      });
    }

    const builder = (params: unknown) => {
      const p = params as { sessionKey?: string };
      const key = p?.sessionKey ?? "default";
      // If before_prompt_build already fired for this session, the hook return
      // value (prependSystemContext) is the authoritative injection path.
      // Returning [] here prevents a duplicate block when a modern OpenClaw
      // host calls both the hook handler AND the registered memory builder.
      // Legacy hosts that do not wire api.on events never set hookFiredSessions,
      // so the builder remains the sole injection path for them.
      if (hookFiredSessions.has(key)) {
        void debugLog("builder:skipped-hook-fired", { sessionKey: key });
        hookFiredSessions.delete(key);
        cachedBySession.delete(key);
        return [];
      }
      const recallLines = cachedBySession.get(key) ?? [];
      cachedBySession.delete(key);
      const out = recallLines;
      void debugLog("builder:called", {
        sessionKey: key,
        paramKeys: params && typeof params === "object" ? Object.keys(params) : null,
        recallLineCount: recallLines.length,
        canWriteDiary: mempalaceRepository.canWriteDiary,
        diaryPersistenceState: mempalaceRepository.diaryPersistenceState,
        outLineCount: out.length,
        outBlock: out.join("\n"),
      });
      return out;
    };

    if (typeof api.registerMemoryCapability === "function") {
      api.registerMemoryCapability({ promptBuilder: builder, runtime: memoryRuntime });
    } else if (typeof api.registerMemoryPromptSection === "function") {
      api.registerMemoryPromptSection(builder);
    }

    const buildLiveStatusText = (): Promise<string> => statusController.buildText();

    registerRemempalaceAgentTools(api, {
      ensureReady: () => initPromise,
      recallService,
      rememberFact: async (memory: string) => {
        const fact = {
          subject: "I",
          predicate: "user_note",
          object: memory,
          source_closet: kgSourceClosetForRole("user"),
        };
        if (kgBatcher) {
          kgBatcher.add(fact);
          await kgBatcher.flush();
        } else {
          await mempalaceRepository.addKgFact(fact);
          router.deleteKgEntity(fact.subject);
          router.deleteKgEntity(fact.object);
          router.deleteBundleCacheEntriesForEntity(fact.subject);
          router.deleteBundleCacheEntriesForEntity(fact.object);
        }
        return fact;
      },
      statusText: buildLiveStatusText,
      readRecentDiary: async (limit: number) => {
        if (!mempalaceRepository.canReadDiary) return { entries: [] };
        return await mempalaceRepository.readDiary({
          agentName: "remempalace",
          lastN: limit,
          timeoutMs: 500,
        });
      },
    });

    statusController.registerCommand(api);
  },
};

export default plugin;
