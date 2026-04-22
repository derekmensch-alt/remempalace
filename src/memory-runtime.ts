import type { McpClient } from "./mcp-client.js";
import type { SearchResult } from "./types.js";

export interface MempalaceMemoryRuntimeOptions {
  mcp: McpClient;
  similarityThreshold: number;
  callTimeoutMs?: number;
}

interface BackendConfig {
  backend: "builtin";
}

interface HostSearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
  citation?: string;
}

interface ProviderStatus {
  backend: "builtin";
  provider: string;
  model?: string;
}

interface EmbeddingProbe {
  ok: boolean;
  error?: string;
}

interface ReadResult {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
}

export interface MempalaceSearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<HostSearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<ReadResult>;
  status(): ProviderStatus;
  probeEmbeddingAvailability(): Promise<EmbeddingProbe>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}

function mapMempalaceResult(r: SearchResult): HostSearchResult {
  const lineCount = Math.max(1, (r.text ?? "").split("\n").length);
  const path = r.source_file && r.source_file.length > 0 ? r.source_file : `${r.wing}/${r.room}`;
  return {
    path,
    startLine: 1,
    endLine: lineCount,
    score: r.similarity,
    snippet: r.text,
    source: "memory",
  };
}

export class MempalaceMemoryRuntime {
  private readonly timeoutMs: number;
  private cachedManager: MempalaceSearchManager | null = null;

  constructor(private readonly opts: MempalaceMemoryRuntimeOptions) {
    this.timeoutMs = opts.callTimeoutMs ?? 8000;
  }

  resolveMemoryBackendConfig(_params: { cfg: unknown; agentId: string }): BackendConfig {
    return { backend: "builtin" };
  }

  async getMemorySearchManager(_params: {
    cfg: unknown;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<{ manager: MempalaceSearchManager | null; error?: string }> {
    if (!this.opts.mcp.isReady()) {
      return { manager: null, error: "mempalace MCP client is not ready" };
    }
    if (!this.cachedManager) {
      this.cachedManager = this.buildManager();
    }
    return { manager: this.cachedManager };
  }

  async closeAllMemorySearchManagers(): Promise<void> {
    this.cachedManager = null;
  }

  private buildManager(): MempalaceSearchManager {
    const { mcp, similarityThreshold } = this.opts;
    const timeoutMs = this.timeoutMs;

    return {
      async search(query, opts) {
        const limit = opts?.maxResults ?? 5;
        const raw = await mcp.callTool<{ results?: SearchResult[] }>(
          "mempalace_search",
          { query, limit },
          timeoutMs,
        );
        const threshold = opts?.minScore ?? similarityThreshold;
        return (raw.results ?? [])
          .filter((r) => r.similarity >= threshold)
          .map(mapMempalaceResult);
      },

      async readFile(params) {
        const { promises: fs } = await import("node:fs");
        try {
          const text = await fs.readFile(params.relPath, "utf8");
          const allLines = text.split("\n");
          const from = params.from && params.from > 0 ? params.from : 1;
          const sliceStart = from - 1;
          const sliceEnd =
            params.lines && params.lines > 0 ? sliceStart + params.lines : allLines.length;
          const sliced = allLines.slice(sliceStart, sliceEnd).join("\n");
          return {
            text: sliced,
            path: params.relPath,
            truncated: sliceEnd < allLines.length,
            from,
            lines: Math.min(params.lines ?? allLines.length, allLines.length - sliceStart),
          };
        } catch (err) {
          return {
            text: `[remempalace] cannot read ${params.relPath}: ${(err as Error).message}`,
            path: params.relPath,
            truncated: false,
          };
        }
      },

      status() {
        return { backend: "builtin", provider: "mempalace" };
      },

      async probeEmbeddingAvailability() {
        if (!mcp.isReady()) {
          return { ok: false, error: "mempalace MCP subprocess not ready" };
        }
        return { ok: true };
      },

      async probeVectorAvailability() {
        return true;
      },
    };
  }
}
