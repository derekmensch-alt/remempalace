import type { RecallService } from "./services/recall-service.js";
import type { KgFact, SearchResult } from "./types.js";

interface ToolContent {
  type: "text";
  text: string;
}

export interface AgentToolResult {
  content: ToolContent[];
  details?: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parameters: Record<string, unknown>;
  handler(params: unknown, ctx?: unknown): Promise<AgentToolResult>;
  execute(toolCallId: string, params: unknown): Promise<AgentToolResult>;
}

export interface AgentToolApi {
  registerTool?: (tool: AgentTool, opts?: { name?: string; names?: string[]; optional?: boolean }) => void;
}

export interface RememberFactResult {
  subject: string;
  predicate: string;
  object: string;
}

export interface RemempalaceAgentToolOptions {
  ensureReady: () => Promise<unknown>;
  recallService: Pick<RecallService, "extractCandidates" | "readBundle">;
  rememberFact: (memory: string) => Promise<RememberFactResult>;
  statusText: () => Promise<string>;
  readRecentDiary: (limit: number) => Promise<unknown>;
}

export function registerRemempalaceAgentTools(
  api: AgentToolApi,
  opts: RemempalaceAgentToolOptions,
): void {
  if (typeof api.registerTool !== "function") return;

  for (const tool of createRemempalaceAgentTools(opts)) {
    api.registerTool(tool, { name: tool.name });
  }
}

export function createRemempalaceAgentTools(opts: RemempalaceAgentToolOptions): AgentTool[] {
  const tools = [
    defineTool({
      name: "remempalace_search",
      label: "Remempalace Search",
      description: "Search remempalace long-term memory and KG facts for relevant context.",
      parameters: objectSchema({
        query: stringSchema("Search query."),
        limit: numberSchema("Maximum results to return. Defaults to 5."),
      }, ["query"]),
      async execute(_toolCallId, params) {
        const query = requiredString(params, "query");
        const limit = optionalPositiveInt(params, "limit", 5, 10);
        await opts.ensureReady();
        const candidates = opts.recallService.extractCandidates(query);
        const bundle = await opts.recallService.readBundle(query, limit, candidates, { mode: "full" });
        const kgFacts = normalizeKgFacts(bundle.kgResults);
        const searchResults = bundle.searchResults;
        return textResult(formatSearchToolResult(kgFacts, searchResults), {
          query,
          candidates,
          kgFactCount: kgFacts.length,
          searchResultCount: searchResults.length,
        });
      },
    }),
    defineTool({
      name: "remempalace_remember",
      label: "Remempalace Remember",
      description: "Store an explicit user-provided memory note in remempalace.",
      parameters: objectSchema({
        memory: stringSchema("The fact, preference, decision, or note to remember."),
      }, ["memory"]),
      async execute(_toolCallId, params) {
        const memory = requiredString(params, "memory");
        await opts.ensureReady();
        const stored = await opts.rememberFact(memory);
        return textResult(`Stored memory: ${memory}`, { action: "stored", fact: stored });
      },
    }),
    defineTool({
      name: "remempalace_status",
      label: "Remempalace Status",
      description: "Show remempalace health, capabilities, cache, diary, and recall status.",
      parameters: objectSchema({}, []),
      async execute() {
        const status = await opts.statusText();
        return textResult(status, { action: "status" });
      },
    }),
    defineTool({
      name: "remempalace_recent",
      label: "Remempalace Recent",
      description: "Read recent remempalace diary entries for chronological session context.",
      parameters: objectSchema({
        limit: numberSchema("Maximum recent diary entries. Defaults to 5."),
      }, []),
      async execute(_toolCallId, params) {
        const limit = optionalPositiveInt(params, "limit", 5, 20);
        await opts.ensureReady();
        const raw = await opts.readRecentDiary(limit);
        const entries = normalizeDiaryEntries(raw);
        if (entries.length === 0) {
          return textResult("No recent diary entries found.", { count: 0 });
        }
        const text = entries
          .slice(0, limit)
          .map((entry, index) => `${index + 1}. ${entry.date ? `${entry.date}: ` : ""}${entry.content}`)
          .join("\n");
        return textResult(text, { count: entries.length, entries: entries.slice(0, limit) });
      },
    }),
  ];
  return tools;
}

function defineTool(input: Omit<AgentTool, "inputSchema" | "handler">): AgentTool {
  return {
    ...input,
    inputSchema: input.parameters,
    handler: (params) => input.execute("", params),
  };
}

function textResult(text: string, details?: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: "text", text }], details };
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function requiredString(params: unknown, key: string): string {
  const value = paramValue(params, key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required string parameter: ${key}`);
  }
  return value.trim();
}

function optionalPositiveInt(params: unknown, key: string, fallback: number, max: number): number {
  const value = paramValue(params, key);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function paramValue(params: unknown, key: string): unknown {
  if (!params || typeof params !== "object") return undefined;
  return (params as Record<string, unknown>)[key];
}

function normalizeKgFacts(raw: unknown): KgFact[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw as KgFact[];
  if ("facts" in raw && Array.isArray((raw as { facts: unknown[] }).facts)) {
    return (raw as { facts: KgFact[] }).facts;
  }
  return [];
}

function normalizeDiaryEntries(raw: unknown): Array<{ date: string; content: string }> {
  const entries = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown[] }).entries)
      ? (raw as { entries: unknown[] }).entries
      : [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") return { date: "", content: entry };
      if (!entry || typeof entry !== "object") return null;
      const rec = entry as Record<string, unknown>;
      const content = firstString(rec, ["content", "entry", "text", "summary"]);
      if (!content) return null;
      return {
        date: firstString(rec, ["date", "ts", "timestamp", "created_at"]) ?? "",
        content,
      };
    })
    .filter((entry): entry is { date: string; content: string } => entry !== null);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function formatSearchToolResult(kgFacts: KgFact[], searchResults: SearchResult[]): string {
  const lines: string[] = [];
  if (kgFacts.length > 0) {
    lines.push("KG facts:");
    for (const fact of kgFacts.slice(0, 10)) {
      lines.push(`- ${fact.subject} ${fact.predicate} ${fact.object}`);
    }
  }
  if (searchResults.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Search results:");
    for (const result of searchResults.slice(0, 10)) {
      lines.push(`- [${result.wing}/${result.room} ${(result.similarity * 100).toFixed(0)}%] ${result.text}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No relevant remempalace memories found.";
}
