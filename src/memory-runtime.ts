import type { McpClient } from "./mcp-client.js";
import type { SearchResult } from "./types.js";

const MAX_READ_BYTES = 10 * 1024 * 1024;

export interface MempalaceMemoryRuntimeOptions {
  mcp: McpClient;
  similarityThreshold: number;
  callTimeoutMs?: number;
  allowedReadRoots?: string[];
  waitUntilReady?: () => Promise<unknown>;
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
  files?: number;
  chunks?: number;
  dirty?: boolean;
  sources?: Array<"memory" | "sessions">;
  cache?: {
    enabled: boolean;
  };
  fts?: {
    enabled: boolean;
    available: boolean;
  };
  vector?: {
    enabled: boolean;
    available?: boolean;
  };
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

type ManagedMcpClient = McpClient & {
  stop?: () => Promise<void>;
};

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
  // Cache the build PROMISE, not the resolved value, so concurrent callers
  // share a single in-flight build instead of racing to produce two managers.
  private managerPromise: Promise<MempalaceSearchManager> | null = null;

  constructor(private readonly opts: MempalaceMemoryRuntimeOptions) {
    this.timeoutMs = opts.callTimeoutMs ?? 8000;
  }

  resolveMemoryBackendConfig(_params: { cfg: unknown; agentId: string }): BackendConfig {
    return { backend: "builtin" };
  }

  async getMemorySearchManager(params: {
    cfg: unknown;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<{ manager: MempalaceSearchManager | null; error?: string }> {
    await this.opts.waitUntilReady?.();
    if (!this.opts.mcp.isReady()) {
      return { manager: null, error: "mempalace MCP client is not ready" };
    }
    if (!this.managerPromise) {
      // Clear the cache on build failure so the next caller retries instead of
      // re-awaiting a permanently-rejected promise.
      let wrapped: Promise<MempalaceSearchManager>;
      wrapped = this.buildManagerAsync(params.purpose).catch((err) => {
        if (this.managerPromise === wrapped) {
          this.managerPromise = null;
        }
        throw err;
      });
      this.managerPromise = wrapped;
    }
    const manager = await this.managerPromise;
    return { manager };
  }

  async closeAllMemorySearchManagers(): Promise<void> {
    this.managerPromise = null;
    await (this.opts.mcp as ManagedMcpClient).stop?.();
  }

  private async buildManagerAsync(purpose?: "default" | "status"): Promise<MempalaceSearchManager> {
    const { mcp, similarityThreshold, allowedReadRoots } = this.opts;
    const timeoutMs = this.timeoutMs;

    // Resolve each allowed root to its real path (resolving symlinks) once at setup time.
    // If a root doesn't exist yet, keep the normalised absolute path.
    const { promises: fsPromises } = await import("node:fs");
    const nodePath = await import("node:path");

    const resolvedAllowedRoots: string[] = await Promise.all(
      (allowedReadRoots ?? []).map(async (root) => {
        const abs = nodePath.resolve(root);
        return fsPromises.realpath(abs).catch(() => abs);
      }),
    );

    if (resolvedAllowedRoots.length === 0) {
      console.warn(
        "[remempalace] memoryRuntime.allowedReadRoots is empty — all readFile calls will be denied",
      );
    }

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
        const path = await import("node:path");

        // Resolve the requested path to an absolute, normalised path.
        const abs = path.resolve(params.relPath);

        // Resolve symlinks. Fail CLOSED if the target can't be resolved —
        // a missing file falling back to abs would open a TOCTOU race where
        // an attacker plants a symlink between the allowlist check and the
        // subsequent readFile call.
        let real: string;
        try {
          real = await fs.realpath(abs);
        } catch {
          return {
            text: "[remempalace] path not allowed",
            path: params.relPath,
            truncated: false,
          };
        }

        // Allowlist check using path.sep guard to prevent prefix-confusion attacks
        // (e.g. /allowed-evil would not match an allowlist entry of /allowed).
        const allowed = resolvedAllowedRoots.some(
          (root) => real === root || real.startsWith(root + path.sep),
        );

        if (!allowed) {
          return {
            text: "[remempalace] path not allowed",
            path: params.relPath,
            truncated: false,
          };
        }

        // Defense in depth: refuse non-regular files (directories, devices,
        // named pipes) and oversize files. fs.stat follows symlinks but
        // `real` is already the resolved target, so this is a no-op w.r.t.
        // symlinks.
        const stat = await fs.stat(real).catch(() => null);
        if (!stat || !stat.isFile()) {
          return {
            text: "[remempalace] cannot read: not a regular file",
            path: params.relPath,
            truncated: false,
          };
        }
        if (stat.size > MAX_READ_BYTES) {
          return {
            text: "[remempalace] cannot read: file too large",
            path: params.relPath,
            truncated: false,
          };
        }

        try {
          const text = await fs.readFile(real, "utf8");
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
          const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
          return {
            text: `[remempalace] cannot read file: ${code}`,
            path: params.relPath,
            truncated: false,
          };
        }
      },

      status() {
        return {
          backend: "builtin",
          provider: "mempalace",
          files: 0,
          chunks: 0,
          dirty: false,
          sources: ["memory"],
          cache: { enabled: true },
          fts: { enabled: false, available: false },
          vector: { enabled: true, available: mcp.isReady() },
        };
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

      close:
        purpose === "status"
          ? async () => {
              this.managerPromise = null;
              await (mcp as ManagedMcpClient).stop?.();
            }
          : undefined,
    };
  }
}
