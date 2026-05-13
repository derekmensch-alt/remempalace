import type { MemPalaceRepository } from "./ports/mempalace-repository.js";
import { WriteRejected } from "./ports/mempalace-repository.js";
import type { SearchResult } from "./types.js";

const MAX_READ_BYTES = 10 * 1024 * 1024;

/** Lifecycle-only surface of McpClient consumed by the memory runtime.
 *  No callTool usage here — raw MCP tool calls remain isolated in the adapter. */
export interface McpLifecycle {
  isReady(): boolean;
  stop?: () => Promise<void>;
}

export interface MempalaceMemoryRuntimeOptions {
  mcp: McpLifecycle;
  /** Full repository port — search, capabilities, and future write ops all go through this. */
  repository: MemPalaceRepository;
  similarityThreshold: number;
  callTimeoutMs?: number;
  allowedReadRoots?: string[];
  /** Paths the runtime may write to via writeFile. Empty (default) rejects all writes. */
  allowedWriteRoots?: string[];
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

interface WriteResult {
  ok: boolean;
  error?: string;
}

export interface MempalaceSearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<HostSearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<ReadResult>;
  /** Write text content to a file. The path must be inside an allowed write root;
   *  otherwise returns { ok: false, error: "WriteRejected: ..." }. */
  writeFile(params: { relPath: string; content: string }): Promise<WriteResult>;
  status(): ProviderStatus;
  probeEmbeddingAvailability(): Promise<EmbeddingProbe>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}

type ManagedMcpLifecycle = McpLifecycle & {
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
  private defaultManagerPromise: Promise<MempalaceSearchManager> | null = null;
  private statusManagerPromise: Promise<MempalaceSearchManager> | null = null;
  private defaultManagerRequested = false;

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
    const purpose = params.purpose === "status" ? "status" : "default";
    if (purpose === "default") this.defaultManagerRequested = true;
    const currentPromise =
      purpose === "status" ? this.statusManagerPromise : this.defaultManagerPromise;
    if (!currentPromise) {
      // Clear the cache on build failure so the next caller retries instead of
      // re-awaiting a permanently-rejected promise.
      let wrapped: Promise<MempalaceSearchManager>;
      wrapped = this.buildManagerAsync(purpose).catch((err) => {
        if (purpose === "status" && this.statusManagerPromise === wrapped) {
          this.statusManagerPromise = null;
        }
        if (purpose === "default" && this.defaultManagerPromise === wrapped) {
          this.defaultManagerPromise = null;
        }
        throw err;
      });
      if (purpose === "status") {
        this.statusManagerPromise = wrapped;
      } else {
        this.defaultManagerPromise = wrapped;
      }
    }
    const manager = await (purpose === "status"
      ? this.statusManagerPromise
      : this.defaultManagerPromise);
    return { manager };
  }

  async closeAllMemorySearchManagers(): Promise<void> {
    this.defaultManagerPromise = null;
    this.statusManagerPromise = null;
    await (this.opts.mcp as ManagedMcpLifecycle).stop?.();
  }

  private async buildManagerAsync(purpose?: "default" | "status"): Promise<MempalaceSearchManager> {
    const { mcp, repository, similarityThreshold, allowedReadRoots, allowedWriteRoots } = this.opts;

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

    const resolvedAllowedWriteRoots: string[] = await Promise.all(
      (allowedWriteRoots ?? []).map(async (root) => {
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
        const results = await repository.searchMemory({ query, limit });
        const threshold = opts?.minScore ?? similarityThreshold;
        return results
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

      async writeFile(params) {
        const { promises: fs } = await import("node:fs");
        const path = await import("node:path");

        const abs = path.resolve(params.relPath);

        // Resolve symlinks for the target directory (file may not exist yet).
        // Use the parent directory for symlink resolution so new files are
        // accepted without requiring the target to pre-exist.
        const parentDir = path.dirname(abs);
        let realParent: string;
        try {
          realParent = await fs.realpath(parentDir);
        } catch {
          const err = new WriteRejected(params.relPath);
          return { ok: false, error: err.message };
        }
        const realTarget = path.join(realParent, path.basename(abs));

        // Allowlist check — same prefix-confusion guard as readFile.
        const allowed = resolvedAllowedWriteRoots.some(
          (root) => realTarget === root || realTarget.startsWith(root + path.sep),
        );

        if (!allowed) {
          const err = new WriteRejected(params.relPath);
          return { ok: false, error: err.message };
        }

        try {
          await fs.writeFile(realTarget, params.content, "utf8");
          return { ok: true };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
          return { ok: false, error: `cannot write file: ${code}` };
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
          // Availability is gated on MCP lifecycle readiness (not a repository
          // capability — canReadDiary/canWriteDiary reflect tool presence, not
          // whether the search index is ready for queries).
          vector: { enabled: true, available: mcp.isReady() },
        };
      },

      async probeEmbeddingAvailability() {
        // Uses MCP lifecycle readiness. Repository search capability (canReadDiary)
        // reflects diary tool presence; vector search availability is a function of
        // whether the subprocess is alive and initialized.
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
              this.statusManagerPromise = null;
              if (!this.defaultManagerRequested) {
                await (mcp as ManagedMcpLifecycle).stop?.();
              }
            }
          : undefined,
    };
  }
}
