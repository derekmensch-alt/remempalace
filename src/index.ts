import { mergeConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { MemoryCache } from "./cache.js";
import { McpClient } from "./mcp-client.js";
import { MemoryRouter } from "./router.js";
import type { SearchResult, RemempalaceConfig } from "./types.js";
import { BudgetManager } from "./budget.js";
import { buildTieredInjection } from "./tiers.js";
import { countTokens } from "./token-counter.js";
import type { KgFact } from "./types.js";
import { summarizeSession, writeDiaryAsync } from "./diary.js";

interface SessionMessage {
  role?: string;
  content?: unknown;
}

interface PluginApi {
  registerMemoryCapability?: (
    pluginId: string,
    capability: { promptBuilder?: (params: unknown) => string[] },
  ) => void;
  registerMemoryPromptSection?: (fn: (params: unknown) => string[]) => void;
  on?: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => void;
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
  async register(api: PluginApi, userConfig?: Partial<RemempalaceConfig>) {
    const cfg = mergeConfig(userConfig);
    const logger = createLogger("remempalace");

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
    });

    try {
      await mcp.start();
      logger.info("MCP client started");
    } catch (err) {
      logger.error(`MCP start failed: ${(err as Error).message}`);
    }

    const cachedBySession = new Map<string, string[] | null>();
    const sessionMessages = new Map<string, SessionMessage[]>();

    if (typeof api.on === "function") {
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
          writeDiaryAsync(mcp, summary);
        });
      }

      api.on("before_prompt_build", async (event: unknown, ctx: unknown) => {
        const ev = event as PromptBuildEvent;
        const hctx = ctx as HookContext & { modelId?: string; contextWindow?: number };
        const sessionKey = hctx?.sessionKey ?? "default";
        cachedBySession.set(sessionKey, null);
        const prompt = resolvePrompt(ev);
        if (!prompt || prompt.length < 10) return;

        const contextWindow = hctx.contextWindow ?? 200000;
        const conversationTokens = ev.messages
          ? ev.messages.reduce((sum, m) => sum + countTokens(extractText(m)), 0)
          : 0;

        const budget = new BudgetManager({
          contextWindow,
          maxMemoryTokens: cfg.injection.maxTokens,
          budgetPercent: cfg.injection.budgetPercent,
          l2BudgetFloor: cfg.tiers.l2BudgetFloor,
        }).compute({ conversationTokens });

        if (budget.allowedTiers.length === 0) return;

        try {
          const bundle = await router.readBundle(prompt, 5);
          const kgFacts = normalizeKgResult(bundle.kgResults);
          const injected = buildTieredInjection({
            kgFacts,
            searchResults: bundle.searchResults,
            budget,
            tiers: cfg.tiers,
            useAaak: cfg.injection.useAaak,
          });
          if (injected.length === 0) return;
          const lines = [
            "## Memory Context (remempalace)",
            "",
            ...injected,
            "",
          ];
          cachedBySession.set(sessionKey, lines);
        } catch (err) {
          logger.warn(`recall failed: ${(err as Error).message}`);
        }
      });
    }

    const builder = (params: unknown) => {
      const p = params as { sessionKey?: string };
      const key = p?.sessionKey ?? "default";
      const lines = cachedBySession.get(key) ?? null;
      cachedBySession.delete(key);
      return lines ?? [];
    };

    if (typeof api.registerMemoryCapability === "function") {
      api.registerMemoryCapability("remempalace", { promptBuilder: builder });
    } else if (typeof api.registerMemoryPromptSection === "function") {
      api.registerMemoryPromptSection(builder);
    }
  },
};

export default plugin;
