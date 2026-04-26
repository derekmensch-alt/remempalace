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
import { MemoryCache } from "./cache.js";
import { McpClient } from "./mcp-client.js";
import { MemoryRouter } from "./router.js";
import type { SearchResult, RemempalaceConfig } from "./types.js";
import { BudgetManager } from "./budget.js";
import { buildTieredInjection } from "./tiers.js";
import { countTokens } from "./token-counter.js";
import type { KgFact } from "./types.js";
import { summarizeSession, writeDiaryAsync } from "./diary.js";
import { KgBatcher, extractFacts } from "./kg.js";
import { prefetchWakeUp } from "./prefetch.js";
import { HeartbeatWarmer } from "./heartbeat.js";
import { loadIdentityContext } from "./identity.js";
import { compactIdentity } from "./identity-compact.js";
import { isTimelineQuery, queryTimeline } from "./timeline.js";
import { MempalaceMemoryRuntime } from "./memory-runtime.js";
import { buildStatusReport } from "./status-command.js";
import { Metrics } from "./metrics.js";
import { DiaryReconciler, computeDiaryHealth } from "./diary-replay.js";

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

function normalizeKgResult(raw: unknown): KgFact[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw as KgFact[];
  if ("facts" in raw && Array.isArray((raw as { facts: unknown[] }).facts)) {
    return (raw as { facts: KgFact[] }).facts;
  }
  return [];
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

    const metrics = new Metrics();
    const mcp = new McpClient({ pythonBin: cfg.mcpPythonBin });
    const searchCache = new MemoryCache<SearchResult[]>({
      capacity: cfg.cache.capacity,
      ttlMs: cfg.cache.ttlMs,
    });
    const kgCache = new MemoryCache<unknown>({
      capacity: cfg.cache.capacity,
      ttlMs: cfg.cache.kgTtlMs,
    });
    const router = new MemoryRouter({
      mcp,
      searchCache,
      kgCache,
      similarityThreshold: cfg.injection.similarityThreshold,
      knownEntities: cfg.injection.knownEntities,
      metrics,
    });

    const memoryRuntime = new MempalaceMemoryRuntime({
      mcp,
      similarityThreshold: cfg.injection.similarityThreshold,
      allowedReadRoots: cfg.memoryRuntime.allowedReadRoots,
    });

    const diaryReconciler = new DiaryReconciler({
      diaryDir: cfg.diary.localDir,
      mcp,
      metrics,
    });

    const initPromise = mcp
      .start()
      .then(async () => {
        logger.info("MCP client started");
        await mcp.probeCapabilities().catch(() => {});
        if (cfg.diary.replayOnStart && mcp.hasDiaryWrite) {
          diaryReconciler
            .replay()
            .then((r) => {
              if (r.attempted > 0) {
                logger.info(
                  `diary replay: ${r.succeeded}/${r.attempted} succeeded, ${r.failed} failed`,
                );
              }
            })
            .catch((err: Error) => {
              logger.warn(`diary replay failed: ${err.message}`);
            });
        }
      })
      .catch((err: Error) => {
        logger.error(`MCP start failed: ${err.message}`);
      });

    const cachedBySession = new Map<string, string[] | null>();
    const sessionMessages = new Map<string, SessionMessage[]>();
    const sessionStartCache = new Map<
      string,
      { status: unknown; diaryEntries: unknown[]; identity: { soul: string; identity: string } }
    >();

    const budgetManager = new BudgetManager({
      maxMemoryTokens: cfg.injection.maxTokens,
      budgetPercent: cfg.injection.budgetPercent,
      l2BudgetFloor: cfg.tiers.l2BudgetFloor,
    });

    const kgBatcher = cfg.kg.autoLearn
      ? new KgBatcher(mcp, {
          batchSize: cfg.kg.batchSize,
          flushIntervalMs: cfg.kg.flushIntervalMs,
          invalidateOnConflict: cfg.kg.invalidateOnConflict,
          getMcpCaps: () => ({ hasKgInvalidate: mcp.hasKgInvalidate }),
          metrics,
        })
      : null;

    const heartbeat = new HeartbeatWarmer({
      intervalMs: 30 * 60 * 1000,
      warm: async () => {
        await prefetchWakeUp(mcp, { diaryCount: cfg.prefetch.diaryCount });
      },
    });
    heartbeat.start();

    if (typeof api.on === "function") {
      api.on("session_start", async (_event: unknown, ctx: unknown) => {
        await initPromise;
        const hctx = ctx as HookContext;
        const key = hctx?.sessionKey ?? "default";
        try {
          const [prefetch, identity] = await Promise.all([
            prefetchWakeUp(mcp, { diaryCount: cfg.prefetch.diaryCount }),
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
          sessionMessages.set(key, ev.historyMessages as SessionMessage[]);
        }
      });

      if (cfg.diary.enabled) {
        api.on("session_end", (event: unknown, ctx: unknown) => {
          const hctx = ctx as HookContext;
          const key = hctx?.sessionKey ?? "default";
          const messages = sessionMessages.get(key) ?? [];
          sessionMessages.delete(key);
          const summary = summarizeSession(messages, { maxTokens: cfg.diary.maxEntryTokens });
          if (!summary) return;
          writeDiaryAsync(mcp, summary, metrics);
        });
      }

      if (kgBatcher) {
        api.on("llm_output", (event: unknown) => {
          const ev = event as { assistantTexts?: string[] };
          if (!ev.assistantTexts) return;
          for (const text of ev.assistantTexts) {
            const facts = extractFacts(text);
            metrics.inc("kg.facts.extracted", facts.length);
            for (const fact of facts) kgBatcher.add(fact);
          }
        });
      }

      api.on("before_prompt_build", async (event: unknown, ctx: unknown) => {
        await initPromise;
        metrics.inc("recall.invoked");
        const ev = event as PromptBuildEvent;
        const hctx = ctx as HookContext & { modelId?: string; contextWindow?: number };
        const sessionKey = hctx?.sessionKey ?? "default";
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

        // Timeline branch: bypass tiered recall for temporal queries
        if (isTimelineQuery(prompt)) {
          metrics.inc("recall.timeline.calls");
          try {
            const tl = await queryTimeline(mcp, { daysBack: 7 });
            const lines = [
              "## Timeline Context (remempalace)",
              "",
              ...tl.diary.map((d) => `- ${d.date}: ${d.content.slice(0, 200)}`),
              ...tl.events.map((e) => `- ${e.date}: ${e.fact}`),
              "",
            ];
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

        const contextWindow = hctx.contextWindow ?? 200000;
        const conversationTokens = ev.messages
          ? ev.messages.reduce((sum, m) => sum + countTokens(extractText(m)), 0)
          : 0;

        const budget = budgetManager.compute({ conversationTokens, contextWindow });

        if (budget.allowedTiers.length === 0) return;

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
          const candidates = router.extractCandidates(prompt);
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
          const bundle = await router.readBundle(prompt, 5, { entityCandidates: candidates });
          const kgFacts = normalizeKgResult(bundle.kgResults);
          const injected = buildTieredInjection({
            kgFacts,
            searchResults: bundle.searchResults,
            budget,
            tiers: cfg.tiers,
            useAaak: cfg.injection.useAaak,
            metrics,
          });

          const lines: string[] = [];

          if (identityCompacted) {
            lines.push("## Identity (remempalace)", "", identityCompacted, "");
          }

          if (injected.length > 0) {
            lines.push("## Memory Context (remempalace)", "", ...injected, "");
          }

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
          if (lines.length === 0) return;
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
        }
      });

      api.on("gateway_stop", async () => {
        heartbeat.stop();
        if (kgBatcher) await kgBatcher.stop();
        await mcp.stop();
      });
    }

    const builder = (params: unknown) => {
      const p = params as { sessionKey?: string };
      const key = p?.sessionKey ?? "default";
      const recallLines = cachedBySession.get(key) ?? [];
      cachedBySession.delete(key);
      const out = !mcp.hasDiaryWrite
        ? [
            ...recallLines,
            "## System Notes (remempalace)",
            "",
            "diary: falling back to local JSONL (~/.mempalace/palace/diary/) — mempalace_diary_write returned Internal tool error",
            "",
          ]
        : recallLines;
      void debugLog("builder:called", {
        sessionKey: key,
        paramKeys: params && typeof params === "object" ? Object.keys(params) : null,
        recallLineCount: recallLines.length,
        hasDiaryWrite: mcp.hasDiaryWrite,
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

    if (typeof api.registerCommand === "function") {
      api.registerCommand({
        name: "remempalace",
        description: "Show remempalace memory plugin status (MCP, caches, diary fallback)",
        acceptsArgs: false,
        handler: async () => {
          const pending = await diaryReconciler.loadPending().catch(() => []);
          const diaryStatus = {
            state: computeDiaryHealth({
              hasDiaryWrite: mcp.hasDiaryWrite,
              pending: pending.length,
              lastReplay: diaryReconciler.lastReplayResult,
            }),
            pending: pending.length,
            lastReplay: diaryReconciler.lastReplayResult,
          };
          return {
            text: buildStatusReport({
              mcpReady: mcp.isReady(),
              hasDiaryWrite: mcp.hasDiaryWrite,
              hasDiaryRead: mcp.hasDiaryRead,
              hasKgInvalidate: mcp.hasKgInvalidate,
              searchCache: searchCache.stats(),
              kgCache: kgCache.stats(),
              metrics: metrics.snapshot(),
              diary: diaryStatus,
            }),
          };
        },
      });
    }
  },
};

export default plugin;
