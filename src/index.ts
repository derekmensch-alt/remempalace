import { mergeConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { MemoryCache } from "./cache.js";
import { McpClient } from "./mcp-client.js";
import { MemoryRouter } from "./router.js";
import type { SearchResult, RemempalaceConfig } from "./types.js";

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

    if (typeof api.on === "function") {
      api.on("before_prompt_build", async (event: unknown, ctx: unknown) => {
        const ev = event as PromptBuildEvent;
        const hctx = ctx as HookContext;
        const sessionKey = hctx?.sessionKey ?? "default";
        cachedBySession.set(sessionKey, null);
        const prompt = resolvePrompt(ev);
        if (!prompt || prompt.length < 10) return;
        try {
          const bundle = await router.readBundle(prompt, 5);
          if (bundle.searchResults.length === 0) return;
          const lines = [
            "## Memory Context (remempalace)",
            "",
            ...bundle.searchResults.slice(0, 5).map(
              (r) => `- [${r.wing}/${r.room}] ${r.text.slice(0, 300)}`,
            ),
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
