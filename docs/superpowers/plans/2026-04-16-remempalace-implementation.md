# remempalace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model selection (per-task):** Dispatch each subagent with the model listed below. Default Opus is overkill and expensive for most of this plan — Haiku 4.5 is ~3x cheaper at ~90% of Sonnet's coding capability for spec'd boilerplate, and Sonnet 4.6 is the strongest coder for the core logic. Reserve Opus 4.7 only for unplanned debugging or replanning.
>
> | Model ID | When to use | Tasks (this plan) |
> |---|---|---|
> | `claude-haiku-4-5-20251001` | Boilerplate scaffolding, mechanical wiring of pre-written code, small typed files, docs, install/measurement scripts | 0.1, 0.2, 0.3, 1.6, 2.1, 2.4, 2.6, 3.2, 4.2, 5.4, 5.5, 5.6, M.1 |
> | `claude-sonnet-4-6` | TDD-driven core logic with edge cases, integration tests, anything that needs to make architectural micro-decisions while implementing | 1.1, 1.2, 1.3, 1.4, 1.5, 2.2, 2.3, 2.5, 3.1, 4.1, 5.1, 5.2, 5.3 |
> | `claude-opus-4-7` | Reserve for: a task fails twice on Sonnet, plan needs replanning mid-execution, or a cross-cutting design conflict surfaces | — (none by default) |
>
> Each task heading also carries an inline `[Model: …]` tag. When dispatching the subagent (e.g. via `Agent` tool), pass `model: "haiku"` / `"sonnet"` / `"opus"` accordingly.

**Goal:** Build a full-lifecycle memory plugin for OpenClaw that replaces `mempalace-auto-recall`, communicates with MemPalace via a persistent MCP subprocess (no CLI spawns per turn), injects tiered memory context to minimize token cost, and closes the read-write-recall loop via diary writes and KG updates.

**Architecture:** Node.js/TypeScript OpenClaw plugin. Spawns `python -m mempalace.mcp_server` **once** at plugin init and keeps it warm; all queries go over stdio JSON-RPC (~5-20ms). LRU cache with TTL for repeat queries. Tiered injection (L0 KG facts → L1 top hits → L2 deep context) gated by a Budget Manager that watches remaining context window. Session lifecycle hooks (`session_start`, `llm_output`, `session_end`) handle pre-fetch warming, fact extraction, and diary write-back respectively.

**Tech Stack:** TypeScript 5.x, Node.js 20+, `@modelcontextprotocol/sdk` (MCP client), `lru-cache` (LRU+TTL), `vitest` (tests), OpenClaw plugin SDK (`registerMemoryCapability`, `registerHook`).

---

## File Structure

```
remempalace/
├── src/
│   ├── index.ts              # Plugin entry point, hook registration
│   ├── mcp-client.ts         # Persistent MCP subprocess + JSON-RPC client
│   ├── process-manager.ts    # Spawn/health-check/restart the MCP child process
│   ├── cache.ts              # LRU cache with TTL
│   ├── budget.ts             # Token budget manager
│   ├── router.ts             # Memory router (read/write coordinator)
│   ├── tiers.ts              # Tiered injection (L0/L1/L2)
│   ├── aaak.ts               # AAAK formatting/compression
│   ├── dedup.ts              # Deduplication of search + KG results
│   ├── diary.ts              # Session-end diary write-back
│   ├── kg.ts                 # KG lifecycle (extract/batch/invalidate)
│   ├── prefetch.ts           # Wake-up pre-fetch and cache warming
│   ├── identity.ts           # SOUL.md / IDENTITY.md loader
│   ├── heartbeat.ts          # Heartbeat-driven cache warmer
│   ├── timeline.ts           # Timeline queries ("what happened last week?")
│   ├── config.ts             # Config parsing & defaults
│   ├── types.ts              # Shared TypeScript types
│   ├── types-messages.ts     # AgentMessage shape for session summarization
│   ├── token-counter.ts      # Token/line counting helpers
│   └── logger.ts             # Plugin logger wrapper
├── tests/
│   ├── cache.test.ts
│   ├── mcp-client.test.ts
│   ├── process-manager.test.ts
│   ├── budget.test.ts
│   ├── tiers.test.ts
│   ├── aaak.test.ts
│   ├── dedup.test.ts
│   ├── router.test.ts
│   ├── diary.test.ts
│   ├── kg.test.ts
│   ├── prefetch.test.ts
│   ├── identity.test.ts
│   ├── heartbeat.test.ts
│   ├── timeline.test.ts
│   ├── token-counter.test.ts
│   └── integration.test.ts
├── openclaw.plugin.json      # Plugin manifest
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── LICENSE                   # MIT
├── README.md
└── docs/
    ├── architecture.md
    └── superpowers/
        ├── specs/
        │   └── 2026-04-16-remempalace-design.md
        └── plans/
            └── 2026-04-16-remempalace-implementation.md
```

---

# Phase 0: Project Setup

### Task 0.1: Initialize Git repo, package.json, TypeScript  [Model: haiku]

**Files:**
- Create: `/media/derek/Projects/remempalace/package.json`
- Create: `/media/derek/Projects/remempalace/tsconfig.json`
- Create: `/media/derek/Projects/remempalace/.gitignore`
- Create: `/media/derek/Projects/remempalace/vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "remempalace",
  "version": "0.1.0",
  "description": "Full-lifecycle memory plugin for OpenClaw, powered by MemPalace.",
  "type": "module",
  "main": "dist/index.js",
  "files": ["dist", "openclaw.plugin.json"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "openclaw": {
    "plugin": "./openclaw.plugin.json",
    "extensions": ["./dist/index.js"]
  },
  "peerDependencies": {
    "openclaw": "*"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "lru-cache": "^11.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/derekmensch-alt/remempalace.git"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
.DS_Store
coverage/
```

- [ ] **Step 4: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
```

- [ ] **Step 5: Initialize git, install deps**

Run:
```bash
cd /media/derek/Projects/remempalace
git init
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore vitest.config.ts
git commit -m "chore: initialize remempalace project with TypeScript + vitest"
```

---

### Task 0.2: Create OpenClaw plugin manifest  [Model: haiku]

**Files:**
- Create: `/media/derek/Projects/remempalace/openclaw.plugin.json`

- [ ] **Step 1: Create manifest**

```json
{
  "id": "remempalace",
  "kind": "memory",
  "name": "remempalace",
  "description": "Full-lifecycle memory plugin for OpenClaw, powered by MemPalace. Fast (persistent MCP), token-aware (tiered injection), complete (diary + KG lifecycle).",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "mcpPythonBin": {
        "type": "string",
        "description": "Path to Python binary in the mempalace virtualenv",
        "default": "/home/derek/.local/share/pipx/venvs/mempalace/bin/python"
      },
      "cache": {
        "type": "object",
        "properties": {
          "capacity": { "type": "number", "default": 200 },
          "ttlMs": { "type": "number", "default": 300000 },
          "kgTtlMs": { "type": "number", "default": 600000 }
        }
      },
      "injection": {
        "type": "object",
        "properties": {
          "maxTokens": { "type": "number", "default": 800 },
          "budgetPercent": { "type": "number", "default": 0.15 },
          "similarityThreshold": { "type": "number", "default": 0.25 },
          "useAaak": { "type": "boolean", "default": true }
        }
      },
      "tiers": {
        "type": "object",
        "properties": {
          "l1Threshold": { "type": "number", "default": 0.3 },
          "l2Threshold": { "type": "number", "default": 0.25 },
          "l2BudgetFloor": { "type": "number", "default": 0.5 }
        }
      },
      "diary": {
        "type": "object",
        "properties": {
          "enabled": { "type": "boolean", "default": true },
          "maxEntryTokens": { "type": "number", "default": 500 }
        }
      },
      "kg": {
        "type": "object",
        "properties": {
          "autoLearn": { "type": "boolean", "default": true },
          "batchSize": { "type": "number", "default": 5 },
          "flushIntervalMs": { "type": "number", "default": 30000 }
        }
      },
      "prefetch": {
        "type": "object",
        "properties": {
          "diaryCount": { "type": "number", "default": 3 },
          "identityEntities": { "type": "boolean", "default": true }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add openclaw.plugin.json
git commit -m "feat: add OpenClaw plugin manifest"
```

---

### Task 0.3: Shared types  [Model: haiku]

**Files:**
- Create: `/media/derek/Projects/remempalace/src/types.ts`

- [ ] **Step 1: Create shared types**

```typescript
export interface SearchResult {
  text: string;
  wing: string;
  room: string;
  similarity: number;
  source_file?: string;
}

export interface KgFact {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string;
  valid_to?: string;
}

export interface DiaryEntry {
  date: string;
  content: string;
}

export interface PalaceStatus {
  total_drawers: number;
  wings: Record<string, number>;
  rooms: Record<string, number>;
  palace_path: string;
}

export interface RemempalaceConfig {
  mcpPythonBin: string;
  cache: {
    capacity: number;
    ttlMs: number;
    kgTtlMs: number;
  };
  injection: {
    maxTokens: number;
    budgetPercent: number;
    similarityThreshold: number;
    useAaak: boolean;
  };
  tiers: {
    l1Threshold: number;
    l2Threshold: number;
    l2BudgetFloor: number;
  };
  diary: {
    enabled: boolean;
    maxEntryTokens: number;
  };
  kg: {
    autoLearn: boolean;
    batchSize: number;
    flushIntervalMs: number;
  };
  prefetch: {
    diaryCount: number;
    identityEntities: boolean;
  };
}

export type Tier = "L0" | "L1" | "L2";

export interface InjectionBudget {
  maxTokens: number;
  allowedTiers: Tier[];
  contextFillRatio: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared type definitions"
```

---

# Phase 1: MCP Transport + Cache

### Task 1.1: LRU cache (TDD)  [Model: sonnet]

**Files:**
- Create: `src/cache.ts`
- Test: `tests/cache.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/cache.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryCache } from "../src/cache.js";

describe("MemoryCache", () => {
  let cache: MemoryCache<string>;

  beforeEach(() => {
    cache = new MemoryCache<string>({ capacity: 3, ttlMs: 1000 });
  });

  it("returns undefined for missing keys", () => {
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves values", () => {
    cache.set("a", "value-a");
    expect(cache.get("a")).toBe("value-a");
  });

  it("evicts LRU entries when at capacity", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe("4");
  });

  it("expires entries after ttlMs", async () => {
    vi.useFakeTimers();
    cache.set("a", "value-a");
    vi.advanceTimersByTime(1500);
    expect(cache.get("a")).toBeUndefined();
    vi.useRealTimers();
  });

  it("reports hits and misses", () => {
    cache.set("a", "1");
    cache.get("a");
    cache.get("b");
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/cache.test.ts`
Expected: FAIL — "Cannot find module '../src/cache.js'"

- [ ] **Step 3: Implement `src/cache.ts`**

```typescript
import { LRUCache } from "lru-cache";

export interface CacheOptions {
  capacity: number;
  ttlMs: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export class MemoryCache<V> {
  private lru: LRUCache<string, V>;
  private hitCount = 0;
  private missCount = 0;

  constructor(opts: CacheOptions) {
    this.lru = new LRUCache<string, V>({
      max: opts.capacity,
      ttl: opts.ttlMs,
    });
  }

  get(key: string): V | undefined {
    const value = this.lru.get(key);
    if (value === undefined) {
      this.missCount++;
    } else {
      this.hitCount++;
    }
    return value;
  }

  set(key: string, value: V): void {
    this.lru.set(key, value);
  }

  delete(key: string): void {
    this.lru.delete(key);
  }

  clear(): void {
    this.lru.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  stats(): CacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      size: this.lru.size,
    };
  }
}

export function hashKey(toolName: string, params: Record<string, unknown>): string {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  return `${toolName}:${sorted}`;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- tests/cache.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts tests/cache.test.ts
git commit -m "feat: add LRU cache with TTL and stats"
```

---

### Task 1.2: Persistent MCP subprocess client  [Model: sonnet]

**Files:**
- Create: `src/process-manager.ts`
- Create: `src/mcp-client.ts`
- Test: `tests/process-manager.test.ts`
- Test: `tests/mcp-client.test.ts`

- [ ] **Step 1: Write failing test for process manager**

```typescript
// tests/process-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProcessManager } from "../src/process-manager.js";

describe("ProcessManager", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager({
      command: "node",
      args: ["-e", "process.stdin.on('data', d => process.stdout.write(d));"],
    });
  });

  afterEach(async () => {
    await pm.stop();
  });

  it("starts a child process", async () => {
    await pm.start();
    expect(pm.isAlive()).toBe(true);
  });

  it("echoes stdin to stdout", async () => {
    await pm.start();
    const output = await new Promise<string>((resolve) => {
      pm.onStdout((data) => resolve(data));
      pm.writeStdin("hello\n");
    });
    expect(output).toContain("hello");
  });

  it("reports not alive after stop", async () => {
    await pm.start();
    await pm.stop();
    expect(pm.isAlive()).toBe(false);
  });

  it("restarts dead process", async () => {
    await pm.start();
    await pm.stop();
    await pm.start();
    expect(pm.isAlive()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/process-manager.test.ts`
Expected: FAIL — "Cannot find module '../src/process-manager.js'"

- [ ] **Step 3: Implement `src/process-manager.ts`**

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ProcessManagerOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class ProcessManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutHandlers: Array<(data: string) => void> = [];
  private stderrHandlers: Array<(data: string) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];

  constructor(private readonly opts: ProcessManagerOptions) {}

  async start(): Promise<void> {
    if (this.proc && !this.proc.killed) return;
    this.proc = spawn(this.opts.command, this.opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.opts.env },
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      for (const h of this.stdoutHandlers) h(chunk);
    });
    this.proc.stderr.on("data", (chunk: string) => {
      for (const h of this.stderrHandlers) h(chunk);
    });
    this.proc.on("exit", (code) => {
      for (const h of this.exitHandlers) h(code);
      this.proc = null;
    });
  }

  async stop(): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      this.proc.once("exit", () => resolve());
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
      }, 2000);
    });
  }

  isAlive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  writeStdin(data: string): void {
    if (!this.proc) throw new Error("Process not started");
    this.proc.stdin.write(data);
  }

  onStdout(handler: (data: string) => void): void {
    this.stdoutHandlers.push(handler);
  }

  onStderr(handler: (data: string) => void): void {
    this.stderrHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- tests/process-manager.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/process-manager.ts tests/process-manager.test.ts
git commit -m "feat: add persistent child process manager with stdio"
```

- [ ] **Step 6: Write failing test for MCP client**

```typescript
// tests/mcp-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { McpClient } from "../src/mcp-client.js";

describe("McpClient", () => {
  it("formats JSON-RPC request correctly", () => {
    const req = McpClient.formatRequest(1, "tools/call", {
      name: "mempalace_search",
      arguments: { query: "hello" },
    });
    const parsed = JSON.parse(req);
    expect(parsed).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "mempalace_search",
        arguments: { query: "hello" },
      },
    });
  });

  it("parses JSON-RPC response", () => {
    const raw = '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}';
    const parsed = McpClient.parseResponse(raw);
    expect(parsed.id).toBe(1);
    expect(parsed.result).toBeDefined();
  });

  it("handles responses split across multiple chunks", () => {
    const client = new McpClient({ pythonBin: "/usr/bin/python3" });
    const pending = client.expect(1);
    client.onChunk('{"jsonrpc":"2.0","id":1,');
    client.onChunk('"result":{"ok":true}}\n');
    return expect(pending).resolves.toMatchObject({
      id: 1,
      result: { ok: true },
    });
  });

  it("rejects on error response", async () => {
    const client = new McpClient({ pythonBin: "/usr/bin/python3" });
    const pending = client.expect(2);
    client.onChunk('{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"boom"}}\n');
    await expect(pending).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 7: Run test, verify failure**

Run: `npm test -- tests/mcp-client.test.ts`
Expected: FAIL — "Cannot find module '../src/mcp-client.js'"

- [ ] **Step 8: Implement `src/mcp-client.ts`**

```typescript
import { ProcessManager } from "./process-manager.js";

export interface McpRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpClientOptions {
  pythonBin: string;
}

interface PendingCall {
  resolve: (resp: McpResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private pm: ProcessManager;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private buffer = "";
  private initialized = false;

  constructor(opts: McpClientOptions) {
    this.pm = new ProcessManager({
      command: opts.pythonBin,
      args: ["-m", "mempalace.mcp_server"],
    });
    this.pm.onStdout((chunk) => this.onChunk(chunk));
    this.pm.onExit(() => this.failAllPending());
  }

  async start(): Promise<void> {
    await this.pm.start();
    await this.initialize();
  }

  async stop(): Promise<void> {
    this.failAllPending();
    await this.pm.stop();
  }

  isReady(): boolean {
    return this.pm.isAlive() && this.initialized;
  }

  private async initialize(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "remempalace", version: "0.1.0" },
    });
    this.pm.writeStdin(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    this.initialized = true;
  }

  async call(method: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<McpResponse> {
    const id = this.nextId++;
    const req = McpClient.formatRequest(id, method, params);
    const pending = this.expect(id, timeoutMs);
    this.pm.writeStdin(req + "\n");
    return pending;
  }

  async callTool<T = unknown>(toolName: string, args: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
    const resp = await this.call("tools/call", { name: toolName, arguments: args }, timeoutMs);
    if (resp.error) throw new Error(resp.error.message);
    const result = resp.result as { content?: Array<{ type: string; text?: string }> };
    if (result?.content && result.content.length > 0 && result.content[0].type === "text") {
      const text = result.content[0].text ?? "";
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }
    return resp.result as T;
  }

  expect(id: number, timeoutMs = 10000): Promise<McpResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  onChunk(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = McpClient.parseResponse(line);
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg);
        }
      } catch {
        // non-JSON or unknown line — skip
      }
    }
  }

  private failAllPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP process died"));
    }
    this.pending.clear();
  }

  static formatRequest(id: number, method: string, params: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
  }

  static parseResponse(raw: string): McpResponse {
    return JSON.parse(raw) as McpResponse;
  }
}
```

- [ ] **Step 9: Run tests, verify pass**

Run: `npm test -- tests/mcp-client.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 10: Commit**

```bash
git add src/mcp-client.ts tests/mcp-client.test.ts
git commit -m "feat: add persistent MCP JSON-RPC client"
```

---

### Task 1.3: Memory Router (read path, cache-first)  [Model: sonnet]

**Files:**
- Create: `src/router.ts`
- Test: `tests/router.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/router.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "../src/router.js";
import { MemoryCache } from "../src/cache.js";
import type { SearchResult } from "../src/types.js";

describe("MemoryRouter", () => {
  let mockMcp: { callTool: ReturnType<typeof vi.fn> };
  let router: MemoryRouter;

  beforeEach(() => {
    mockMcp = { callTool: vi.fn() };
    router = new MemoryRouter({
      mcp: mockMcp as any,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0.25,
    });
  });

  it("calls MCP search on cache miss", async () => {
    mockMcp.callTool.mockResolvedValue({
      results: [{ text: "hit", wing: "w", room: "r", similarity: 0.5 }],
    });
    const result = await router.search("hello", 5);
    expect(mockMcp.callTool).toHaveBeenCalledWith(
      "mempalace_search",
      { query: "hello", limit: 5 },
      expect.any(Number),
    );
    expect(result).toHaveLength(1);
  });

  it("returns cached results on second call with same query", async () => {
    mockMcp.callTool.mockResolvedValue({
      results: [{ text: "hit", wing: "w", room: "r", similarity: 0.5 }],
    });
    await router.search("hello", 5);
    await router.search("hello", 5);
    expect(mockMcp.callTool).toHaveBeenCalledTimes(1);
  });

  it("filters out results below similarity threshold", async () => {
    mockMcp.callTool.mockResolvedValue({
      results: [
        { text: "high", wing: "w", room: "r", similarity: 0.5 },
        { text: "low", wing: "w", room: "r", similarity: 0.1 },
      ],
    });
    const result = await router.search("hello", 5);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("high");
  });

  it("fires search and KG query in parallel", async () => {
    const callOrder: string[] = [];
    mockMcp.callTool.mockImplementation(async (name: string) => {
      callOrder.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`end:${name}`);
      return name.includes("search") ? { results: [] } : {};
    });
    await router.readBundle("hello", 5);
    // Both should start before either ends
    expect(callOrder[0].startsWith("start:")).toBe(true);
    expect(callOrder[1].startsWith("start:")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/router.test.ts`
Expected: FAIL — "Cannot find module '../src/router.js'"

- [ ] **Step 3: Implement `src/router.ts`**

```typescript
import { MemoryCache, hashKey } from "./cache.js";
import type { McpClient } from "./mcp-client.js";
import type { SearchResult } from "./types.js";

export interface MemoryRouterOptions {
  mcp: McpClient;
  searchCache: MemoryCache<SearchResult[]>;
  kgCache: MemoryCache<unknown>;
  similarityThreshold: number;
  callTimeoutMs?: number;
}

export interface ReadBundle {
  searchResults: SearchResult[];
  kgResults: unknown;
}

export class MemoryRouter {
  private readonly timeoutMs: number;

  constructor(private readonly opts: MemoryRouterOptions) {
    this.timeoutMs = opts.callTimeoutMs ?? 8000;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const key = hashKey("mempalace_search", { query, limit });
    const cached = this.opts.searchCache.get(key);
    if (cached) return cached;
    const raw = await this.opts.mcp.callTool<{ results: SearchResult[] }>(
      "mempalace_search",
      { query, limit },
      this.timeoutMs,
    );
    const filtered = (raw.results ?? []).filter(
      (r) => r.similarity >= this.opts.similarityThreshold,
    );
    this.opts.searchCache.set(key, filtered);
    return filtered;
  }

  async kgQuery(entity: string): Promise<unknown> {
    const key = hashKey("mempalace_kg_query", { entity });
    const cached = this.opts.kgCache.get(key);
    if (cached !== undefined) return cached;
    const raw = await this.opts.mcp.callTool<unknown>(
      "mempalace_kg_query",
      { entity },
      this.timeoutMs,
    );
    this.opts.kgCache.set(key, raw);
    return raw;
  }

  async readBundle(query: string, limit: number): Promise<ReadBundle> {
    const [searchResults, kgResults] = await Promise.all([
      this.search(query, limit),
      this.kgQuery(query),
    ]);
    return { searchResults, kgResults };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/router.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat: add memory router with cache-first reads and parallel fetches"
```

---

### Task 1.4: Plugin entry point (Phase 1 integration)  [Model: sonnet]

**Files:**
- Create: `src/config.ts`
- Create: `src/logger.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Create `src/config.ts`**

```typescript
import type { RemempalaceConfig } from "./types.js";

export const DEFAULT_CONFIG: RemempalaceConfig = {
  mcpPythonBin: "/home/derek/.local/share/pipx/venvs/mempalace/bin/python",
  cache: { capacity: 200, ttlMs: 300000, kgTtlMs: 600000 },
  injection: {
    maxTokens: 800,
    budgetPercent: 0.15,
    similarityThreshold: 0.25,
    useAaak: true,
  },
  tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
  diary: { enabled: true, maxEntryTokens: 500 },
  kg: { autoLearn: true, batchSize: 5, flushIntervalMs: 30000 },
  prefetch: { diaryCount: 3, identityEntities: true },
};

export function mergeConfig(
  user: Partial<RemempalaceConfig> | undefined,
): RemempalaceConfig {
  if (!user) return DEFAULT_CONFIG;
  return {
    mcpPythonBin: user.mcpPythonBin ?? DEFAULT_CONFIG.mcpPythonBin,
    cache: { ...DEFAULT_CONFIG.cache, ...user.cache },
    injection: { ...DEFAULT_CONFIG.injection, ...user.injection },
    tiers: { ...DEFAULT_CONFIG.tiers, ...user.tiers },
    diary: { ...DEFAULT_CONFIG.diary, ...user.diary },
    kg: { ...DEFAULT_CONFIG.kg, ...user.kg },
    prefetch: { ...DEFAULT_CONFIG.prefetch, ...user.prefetch },
  };
}
```

- [ ] **Step 2: Create `src/logger.ts`**

```typescript
export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export function createLogger(prefix: string, base?: Partial<Logger>): Logger {
  const fmt = (msg: string) => `[${prefix}] ${msg}`;
  return {
    debug: (msg) => base?.debug?.(fmt(msg)),
    info: (msg) => (base?.info ?? console.log)(fmt(msg)),
    warn: (msg) => (base?.warn ?? console.warn)(fmt(msg)),
    error: (msg) => (base?.error ?? console.error)(fmt(msg)),
  };
}
```

- [ ] **Step 3: Create `src/index.ts`** (Phase 1 version, minimal)

```typescript
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
```

- [ ] **Step 4: Build the project**

Run: `npm run build`
Expected: `dist/` directory created, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/logger.ts src/index.ts
git commit -m "feat: add Phase 1 plugin entry with MCP recall pipeline"
```

---

### Task 1.5: Phase 1 integration test  [Model: sonnet]

**Files:**
- Test: `tests/integration.test.ts`

- [ ] **Step 1: Write integration test (real MCP, skipped by default)**

```typescript
// tests/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpClient } from "../src/mcp-client.js";
import { MemoryRouter } from "../src/router.js";
import { MemoryCache } from "../src/cache.js";
import type { SearchResult } from "../src/types.js";
import { existsSync } from "node:fs";

const PY = "/home/derek/.local/share/pipx/venvs/mempalace/bin/python";
const hasMempalace = existsSync(PY);
const maybe = hasMempalace ? describe : describe.skip;

maybe("integration: real MemPalace MCP", () => {
  let mcp: McpClient;

  beforeAll(async () => {
    mcp = new McpClient({ pythonBin: PY });
    await mcp.start();
  }, 30000);

  afterAll(async () => {
    await mcp.stop();
  });

  it("completes a search round-trip", async () => {
    const router = new MemoryRouter({
      mcp,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0,
    });
    const results = await router.search("derek", 3);
    expect(Array.isArray(results)).toBe(true);
  }, 15000);

  it("second identical search is cache hit (sub-5ms)", async () => {
    const router = new MemoryRouter({
      mcp,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 10000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 10000 }),
      similarityThreshold: 0,
    });
    await router.search("derek", 3);
    const t0 = performance.now();
    await router.search("derek", 3);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(5);
  }, 15000);
});
```

- [ ] **Step 2: Run integration test**

Run: `npm test -- tests/integration.test.ts`
Expected: PASS (both tests) if mempalace is installed, SKIP otherwise.

- [ ] **Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add Phase 1 integration tests against real MemPalace MCP"
```

---

### Task 1.6: Install alongside existing plugin & measure latency  [Model: haiku]

**Files:**
- Modify: `/home/derek/.openclaw/openclaw.json`

- [ ] **Step 1: Build and link**

```bash
cd /media/derek/Projects/remempalace
npm run build
npm link
cd /home/derek/.openclaw
npm link remempalace
```

- [ ] **Step 2: Add to plugins.allow (keep auto-recall for A/B)**

Modify `/home/derek/.openclaw/openclaw.json`:
```json
"plugins": {
  "allow": [
    "openclaw-web-search",
    "telegram-approval-buttons",
    "telegram",
    "discord",
    "ollama",
    "mempalace-auto-recall",
    "remempalace"
  ],
  "entries": {
    "remempalace": { "enabled": false }
  }
}
```

Start disabled so we can toggle and measure.

- [ ] **Step 3: Verify plugin loads**

Run: `openclaw plugins list`
Expected: `remempalace` appears in the output.

- [ ] **Step 4: Toggle remempalace, disable auto-recall, test**

Edit `openclaw.json`:
- `plugins.entries.mempalace-auto-recall.enabled`: `false`
- `plugins.entries.remempalace.enabled`: `true`
- `plugins.slots.memory`: `"remempalace"`

- [ ] **Step 5: Trigger a message in OpenClaw, observe logs for recall latency**

Run: `openclaw tail` (or check Telegram interaction).
Expected: No errors, memory context appears in prompts.

- [ ] **Step 6: Commit OpenClaw config change**

```bash
cd /home/derek/.openclaw
git add openclaw.json
git commit -m "chore: switch memory slot to remempalace Phase 1"
```

---

# Phase 2: Tiered Injection + Budget Manager

### Task 2.1: Token counter  [Model: haiku]

**Files:**
- Create: `src/token-counter.ts`
- Test: `tests/token-counter.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/token-counter.test.ts
import { describe, it, expect } from "vitest";
import { countTokens, countLines } from "../src/token-counter.js";

describe("token-counter", () => {
  it("approximates tokens as chars/4 rounded up", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("test")).toBe(1);
    expect(countTokens("hello world")).toBe(3);
  });

  it("counts array of lines", () => {
    expect(countLines(["a", "bb", "cccc"])).toBe(countTokens("a\nbb\ncccc"));
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/token-counter.test.ts`
Expected: FAIL — "Cannot find module '../src/token-counter.js'"

- [ ] **Step 3: Implement `src/token-counter.ts`**

```typescript
export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function countLines(lines: string[]): number {
  return countTokens(lines.join("\n"));
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- tests/token-counter.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/token-counter.ts tests/token-counter.test.ts
git commit -m "feat: add token counter (char/4 approximation)"
```

---

### Task 2.2: Budget Manager  [Model: sonnet]

**Files:**
- Create: `src/budget.ts`
- Test: `tests/budget.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/budget.test.ts
import { describe, it, expect } from "vitest";
import { BudgetManager } from "../src/budget.js";

describe("BudgetManager", () => {
  const base = {
    contextWindow: 100000,
    maxMemoryTokens: 800,
    budgetPercent: 0.15,
    l2BudgetFloor: 0.5,
  };

  it("allows L0/L1/L2 when conversation is tiny", () => {
    const bm = new BudgetManager(base);
    const b = bm.compute({ conversationTokens: 1000 });
    expect(b.allowedTiers).toEqual(["L0", "L1", "L2"]);
  });

  it("allows L0/L1 only when conversation is medium", () => {
    const bm = new BudgetManager(base);
    const b = bm.compute({ conversationTokens: 65000 });
    expect(b.allowedTiers).toEqual(["L0", "L1"]);
  });

  it("allows L0 only when conversation is large", () => {
    const bm = new BudgetManager(base);
    const b = bm.compute({ conversationTokens: 72000 });
    expect(b.allowedTiers).toEqual(["L0"]);
  });

  it("blocks all injection near context limit", () => {
    const bm = new BudgetManager(base);
    const b = bm.compute({ conversationTokens: 85000 });
    expect(b.allowedTiers).toEqual([]);
  });

  it("caps maxTokens at configured limit", () => {
    const bm = new BudgetManager(base);
    const b = bm.compute({ conversationTokens: 1000 });
    expect(b.maxTokens).toBeLessThanOrEqual(800);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/budget.test.ts`
Expected: FAIL — "Cannot find module '../src/budget.js'"

- [ ] **Step 3: Implement `src/budget.ts`**

```typescript
import type { InjectionBudget, Tier } from "./types.js";

export interface BudgetManagerOptions {
  contextWindow: number;
  maxMemoryTokens: number;
  budgetPercent: number;
  l2BudgetFloor: number;
}

export class BudgetManager {
  constructor(private readonly opts: BudgetManagerOptions) {}

  compute(params: { conversationTokens: number }): InjectionBudget {
    const { contextWindow, maxMemoryTokens, budgetPercent, l2BudgetFloor } = this.opts;
    const safetyMargin = 0.1;
    const available = Math.max(
      0,
      contextWindow - params.conversationTokens - contextWindow * safetyMargin,
    );
    const contextFillRatio = params.conversationTokens / contextWindow;

    let allowedTiers: Tier[];
    if (contextFillRatio >= 0.8) {
      allowedTiers = [];
    } else if (contextFillRatio >= 0.6) {
      allowedTiers = ["L0"];
    } else if (contextFillRatio > 1 - l2BudgetFloor) {
      allowedTiers = ["L0", "L1"];
    } else {
      allowedTiers = ["L0", "L1", "L2"];
    }

    const budgetTokens = Math.min(
      Math.floor(available * budgetPercent),
      maxMemoryTokens,
    );

    return {
      maxTokens: Math.max(0, budgetTokens),
      allowedTiers,
      contextFillRatio,
    };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/budget.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/budget.ts tests/budget.test.ts
git commit -m "feat: add budget manager with tiered allowance + context-aware back-off"
```

---

### Task 2.3: AAAK formatter  [Model: sonnet]

**Files:**
- Create: `src/aaak.ts`
- Test: `tests/aaak.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/aaak.test.ts
import { describe, it, expect } from "vitest";
import { formatKgFact, formatSearchResult, formatSearchResultsAaak } from "../src/aaak.js";

describe("aaak formatter", () => {
  it("formats KG fact as SUBJ:PRED=OBJ", () => {
    const out = formatKgFact({
      subject: "Derek",
      predicate: "prefers_model",
      object: "Kimi K2.5",
    });
    expect(out).toBe("Derek:prefers_model=Kimi K2.5");
  });

  it("adds valid_from annotation when present", () => {
    const out = formatKgFact({
      subject: "Derek",
      predicate: "owns",
      object: "Legion 5",
      valid_from: "2025-01-01",
    });
    expect(out).toBe("Derek:owns=Legion 5 [2025-01-01]");
  });

  it("formats search result with wing/room prefix and similarity", () => {
    const out = formatSearchResult({
      text: "test content",
      wing: "technical",
      room: "notes",
      similarity: 0.73,
    });
    expect(out).toBe("[technical/notes ★0.73] test content");
  });

  it("joins search results with pipe separators", () => {
    const out = formatSearchResultsAaak([
      { text: "a", wing: "w1", room: "r1", similarity: 0.5 },
      { text: "b", wing: "w2", room: "r2", similarity: 0.4 },
    ]);
    expect(out).toContain("[w1/r1 ★0.50] a");
    expect(out).toContain("[w2/r2 ★0.40] b");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/aaak.test.ts`
Expected: FAIL — "Cannot find module '../src/aaak.js'"

- [ ] **Step 3: Implement `src/aaak.ts`**

```typescript
import type { KgFact, SearchResult } from "./types.js";

export function formatKgFact(fact: KgFact): string {
  const base = `${fact.subject}:${fact.predicate}=${fact.object}`;
  if (fact.valid_from) return `${base} [${fact.valid_from}]`;
  return base;
}

export function formatKgFactsAaak(facts: KgFact[]): string {
  return facts.map(formatKgFact).join(" | ");
}

export function formatSearchResult(r: SearchResult): string {
  const sim = r.similarity.toFixed(2);
  return `[${r.wing}/${r.room} ★${sim}] ${r.text}`;
}

export function formatSearchResultsAaak(results: SearchResult[]): string {
  return results.map(formatSearchResult).join("\n");
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/aaak.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/aaak.ts tests/aaak.test.ts
git commit -m "feat: add AAAK formatter for KG facts and search results"
```

---

### Task 2.4: Deduplication  [Model: haiku]

**Files:**
- Create: `src/dedup.ts`
- Test: `tests/dedup.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/dedup.test.ts
import { describe, it, expect } from "vitest";
import { dedupeByContent } from "../src/dedup.js";

describe("dedupeByContent", () => {
  it("removes exact duplicate strings", () => {
    expect(dedupeByContent(["a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("treats whitespace-normalized strings as duplicates", () => {
    const out = dedupeByContent(["hello world", "hello   world", "hello\nworld"]);
    expect(out).toHaveLength(1);
  });

  it("preserves insertion order", () => {
    expect(dedupeByContent(["c", "a", "b", "c", "a"])).toEqual(["c", "a", "b"]);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/dedup.test.ts`
Expected: FAIL — "Cannot find module '../src/dedup.js'"

- [ ] **Step 3: Implement `src/dedup.ts`**

```typescript
import { createHash } from "node:crypto";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function contentHash(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex");
}

export function dedupeByContent(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const h = contentHash(item);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(item);
  }
  return out;
}

export function dedupeWithKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const h = contentHash(keyFn(item));
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(item);
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/dedup.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dedup.ts tests/dedup.test.ts
git commit -m "feat: add content-hash deduplication"
```

---

### Task 2.5: Tiered injection  [Model: sonnet]

**Files:**
- Create: `src/tiers.ts`
- Test: `tests/tiers.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/tiers.test.ts
import { describe, it, expect } from "vitest";
import { buildTieredInjection } from "../src/tiers.js";
import type { SearchResult, KgFact, InjectionBudget } from "../src/types.js";

describe("buildTieredInjection", () => {
  const sampleResults: SearchResult[] = [
    { text: "top hit content about project X", wing: "w", room: "r", similarity: 0.5 },
    { text: "second hit content about project X", wing: "w", room: "r", similarity: 0.35 },
    { text: "deep context hit", wing: "w", room: "r", similarity: 0.27 },
  ];
  const sampleFacts: KgFact[] = [
    { subject: "Derek", predicate: "works_on", object: "remempalace" },
  ];

  it("returns empty when no tiers allowed", () => {
    const budget: InjectionBudget = { maxTokens: 0, allowedTiers: [], contextFillRatio: 0.9 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    expect(out).toEqual([]);
  });

  it("includes L0 facts only when L0 is the only allowed tier", () => {
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L0"], contextFillRatio: 0.7 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined).toContain("Derek:works_on=remempalace");
    expect(joined).not.toContain("top hit content");
  });

  it("includes L0 + L1 when budget allows", () => {
    const budget: InjectionBudget = { maxTokens: 500, allowedTiers: ["L0", "L1"], contextFillRatio: 0.4 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined).toContain("Derek:works_on=remempalace");
    expect(joined).toContain("top hit content");
    expect(joined).not.toContain("deep context hit");
  });

  it("includes L0 + L1 + L2 when budget is generous", () => {
    const budget: InjectionBudget = { maxTokens: 2000, allowedTiers: ["L0", "L1", "L2"], contextFillRatio: 0.1 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined).toContain("deep context hit");
  });

  it("respects token budget cap", () => {
    const budget: InjectionBudget = { maxTokens: 10, allowedTiers: ["L0", "L1", "L2"], contextFillRatio: 0.1 };
    const out = buildTieredInjection({
      kgFacts: sampleFacts,
      searchResults: sampleResults,
      budget,
      tiers: { l1Threshold: 0.3, l2Threshold: 0.25, l2BudgetFloor: 0.5 },
      useAaak: true,
    });
    const joined = out.join("\n");
    expect(joined.length).toBeLessThanOrEqual(10 * 4 + 50);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/tiers.test.ts`
Expected: FAIL — "Cannot find module '../src/tiers.js'"

- [ ] **Step 3: Implement `src/tiers.ts`**

```typescript
import type { InjectionBudget, KgFact, SearchResult } from "./types.js";
import { formatKgFactsAaak, formatSearchResult } from "./aaak.js";
import { countTokens } from "./token-counter.js";
import { dedupeByContent } from "./dedup.js";

export interface TieredInjectionParams {
  kgFacts: KgFact[];
  searchResults: SearchResult[];
  budget: InjectionBudget;
  tiers: { l1Threshold: number; l2Threshold: number; l2BudgetFloor: number };
  useAaak: boolean;
}

export function buildTieredInjection(params: TieredInjectionParams): string[] {
  const { kgFacts, searchResults, budget, tiers } = params;
  if (budget.allowedTiers.length === 0 || budget.maxTokens === 0) return [];

  const lines: string[] = [];
  let tokensUsed = 0;
  const canAdd = (next: string): boolean => {
    const next_tokens = countTokens(next);
    return tokensUsed + next_tokens <= budget.maxTokens;
  };
  const add = (line: string) => {
    lines.push(line);
    tokensUsed += countTokens(line);
  };

  // L0: KG facts
  if (budget.allowedTiers.includes("L0") && kgFacts.length > 0) {
    const factsLine = `FACTS: ${formatKgFactsAaak(kgFacts)}`;
    if (canAdd(factsLine)) add(factsLine);
  }

  // L1: top hits above l1Threshold
  if (budget.allowedTiers.includes("L1")) {
    const l1Hits = searchResults
      .filter((r) => r.similarity >= tiers.l1Threshold)
      .slice(0, 2);
    for (const hit of l1Hits) {
      const line = formatSearchResult(hit);
      if (canAdd(line)) add(line);
      else break;
    }
  }

  // L2: deeper context above l2Threshold but below l1Threshold
  if (budget.allowedTiers.includes("L2")) {
    const l2Hits = searchResults.filter(
      (r) => r.similarity >= tiers.l2Threshold && r.similarity < tiers.l1Threshold,
    );
    for (const hit of l2Hits) {
      const line = formatSearchResult(hit);
      if (canAdd(line)) add(line);
      else break;
    }
  }

  return dedupeByContent(lines);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/tiers.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tiers.ts tests/tiers.test.ts
git commit -m "feat: add tiered injection (L0/L1/L2) with budget-aware gating"
```

---

### Task 2.6: Wire tiered injection into plugin  [Model: haiku]

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update `src/index.ts` to use tiers + budget**

Replace the `api.on("before_prompt_build", ...)` block in `src/index.ts` with:

```typescript
if (typeof api.on === "function") {
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
```

Add the required imports at the top of `src/index.ts`:

```typescript
import { BudgetManager } from "./budget.js";
import { buildTieredInjection } from "./tiers.js";
import { countTokens } from "./token-counter.js";
import type { KgFact } from "./types.js";
```

Add this helper function inside the module:

```typescript
function normalizeKgResult(raw: unknown): KgFact[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw as KgFact[];
  if ("facts" in raw && Array.isArray((raw as { facts: unknown[] }).facts)) {
    return (raw as { facts: KgFact[] }).facts;
  }
  return [];
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: No type errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire tiered injection + budget manager into plugin entry"
```

---

# Phase 3: Diary Write-back

### Task 3.1: Session summarizer  [Model: sonnet]

**Files:**
- Create: `src/diary.ts`
- Test: `tests/diary.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/diary.test.ts
import { describe, it, expect, vi } from "vitest";
import { summarizeSession, writeDiaryAsync } from "../src/diary.js";
import type { AgentMessage } from "../src/types-messages.js";

describe("summarizeSession", () => {
  it("extracts user and assistant turns into AAAK format", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "update TODO" },
      { role: "assistant", content: "done" },
    ];
    const out = summarizeSession(messages, { maxTokens: 200 });
    expect(out).toContain("TURNS:4");
    expect(out).toContain("hello");
    expect(out).toContain("hi");
  });

  it("truncates to token budget", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} with some content to make it longer`,
    }));
    const out = summarizeSession(messages, { maxTokens: 50 });
    expect(out.length).toBeLessThanOrEqual(50 * 4 + 50);
  });

  it("returns empty string for empty session", () => {
    expect(summarizeSession([], { maxTokens: 200 })).toBe("");
  });
});

describe("writeDiaryAsync", () => {
  it("is fire-and-forget (does not await)", () => {
    const mockMcp = {
      callTool: vi.fn().mockImplementation(
        () => new Promise((r) => setTimeout(r, 1000)),
      ),
    };
    const t0 = Date.now();
    writeDiaryAsync(mockMcp as any, "summary content");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });

  it("swallows errors silently", async () => {
    const mockMcp = {
      callTool: vi.fn().mockRejectedValue(new Error("boom")),
    };
    expect(() => writeDiaryAsync(mockMcp as any, "summary")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
```

- [ ] **Step 2: Create placeholder `src/types-messages.ts`**

```typescript
export interface AgentMessage {
  role: string;
  content: unknown;
}
```

- [ ] **Step 3: Run test, verify failure**

Run: `npm test -- tests/diary.test.ts`
Expected: FAIL — "Cannot find module '../src/diary.js'"

- [ ] **Step 4: Implement `src/diary.ts`**

```typescript
import type { McpClient } from "./mcp-client.js";
import { countTokens } from "./token-counter.js";

interface SessionMessage {
  role?: string;
  content?: unknown;
}

function extractContent(msg: SessionMessage): string {
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

export function summarizeSession(
  messages: SessionMessage[],
  opts: { maxTokens: number },
): string {
  if (messages.length === 0) return "";
  const turns = messages.length;
  const parts: string[] = [`TURNS:${turns}`];
  let tokensUsed = countTokens(parts.join(" | "));
  for (const m of messages) {
    const role = m.role === "assistant" ? "A" : "U";
    const text = extractContent(m).slice(0, 200);
    const line = `${role}: ${text}`;
    const cost = countTokens(line);
    if (tokensUsed + cost > opts.maxTokens) break;
    parts.push(line);
    tokensUsed += cost;
  }
  return parts.join(" | ");
}

export function writeDiaryAsync(
  mcp: McpClient,
  content: string,
  wing = "claude_code",
  room = "general",
): void {
  void (async () => {
    try {
      await mcp.callTool("mempalace_diary_write", {
        wing,
        room,
        content,
        added_by: "remempalace",
      });
    } catch {
      // fire-and-forget: silently swallow
    }
  })();
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -- tests/diary.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/diary.ts src/types-messages.ts tests/diary.test.ts
git commit -m "feat: add session summarizer + fire-and-forget diary write"
```

---

### Task 3.2: Hook session_end into plugin  [Model: haiku]

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add session_end handler**

Add to `src/index.ts` after the `before_prompt_build` handler:

```typescript
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
}
```

Add imports at the top of `src/index.ts`:

```typescript
import { summarizeSession, writeDiaryAsync } from "./diary.js";

interface SessionMessage {
  role?: string;
  content?: unknown;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire session_end diary write-back into plugin"
```

---

# Phase 4: KG Lifecycle

### Task 4.1: Fact extractor  [Model: sonnet]

**Files:**
- Create: `src/kg.ts`
- Test: `tests/kg.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/kg.test.ts
import { describe, it, expect, vi } from "vitest";
import { extractFacts, KgBatcher } from "../src/kg.js";

describe("extractFacts", () => {
  it("extracts SUBJ is PRED OBJ patterns", () => {
    const text = "Derek's favorite model is Kimi K2.5.";
    const facts = extractFacts(text);
    expect(facts.length).toBeGreaterThan(0);
  });

  it("extracts SUBJ uses OBJ patterns", () => {
    const text = "Derek uses OpenClaw as his daily driver.";
    const facts = extractFacts(text);
    expect(facts).toContainEqual(
      expect.objectContaining({
        subject: "Derek",
        predicate: "uses",
        object: "OpenClaw",
      }),
    );
  });

  it("returns empty array for text with no recognizable patterns", () => {
    const facts = extractFacts("hello there how are you");
    expect(facts).toEqual([]);
  });

  it("deduplicates facts across a single extraction run", () => {
    const text = "Derek uses OpenClaw. Derek uses OpenClaw daily.";
    const facts = extractFacts(text);
    const openclawFacts = facts.filter(
      (f) => f.subject === "Derek" && f.object === "OpenClaw",
    );
    expect(openclawFacts).toHaveLength(1);
  });
});

describe("KgBatcher", () => {
  it("flushes when batch size is reached", async () => {
    const mockMcp = { callTool: vi.fn().mockResolvedValue({}) };
    const batcher = new KgBatcher(mockMcp as any, { batchSize: 2, flushIntervalMs: 10000 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    expect(mockMcp.callTool).not.toHaveBeenCalled();
    batcher.add({ subject: "B", predicate: "p", object: "2" });
    await new Promise((r) => setTimeout(r, 5));
    expect(mockMcp.callTool).toHaveBeenCalledTimes(2);
    await batcher.stop();
  });

  it("flushes on timer if batch not full", async () => {
    const mockMcp = { callTool: vi.fn().mockResolvedValue({}) };
    const batcher = new KgBatcher(mockMcp as any, { batchSize: 10, flushIntervalMs: 20 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    await new Promise((r) => setTimeout(r, 40));
    expect(mockMcp.callTool).toHaveBeenCalled();
    await batcher.stop();
  });

  it("coalesces duplicates in the same batch", async () => {
    const mockMcp = { callTool: vi.fn().mockResolvedValue({}) };
    const batcher = new KgBatcher(mockMcp as any, { batchSize: 3, flushIntervalMs: 10000 });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    batcher.add({ subject: "A", predicate: "p", object: "1" });
    await new Promise((r) => setTimeout(r, 5));
    expect(mockMcp.callTool).toHaveBeenCalledTimes(1);
    await batcher.stop();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/kg.test.ts`
Expected: FAIL — "Cannot find module '../src/kg.js'"

- [ ] **Step 3: Implement `src/kg.ts`**

```typescript
import type { McpClient } from "./mcp-client.js";
import { dedupeWithKey } from "./dedup.js";
import type { KgFact } from "./types.js";

const USES_PATTERN = /\b([A-Z][\w]{1,32})\s+(uses|prefers|runs|owns|works on|has|is)\s+([A-Za-z][\w\s.\-/+]{1,60})(?:\.|$|\n)/g;
const APOSTROPHE_IS_PATTERN = /\b([A-Z][\w]{1,32})'s?\s+(favorite|preferred|chosen|default)\s+(\w+)\s+is\s+([A-Za-z][\w\s.\-/+]{1,60})(?:\.|$|\n)/g;

export function extractFacts(text: string): KgFact[] {
  const out: KgFact[] = [];
  for (const m of text.matchAll(USES_PATTERN)) {
    const [, subj, pred, obj] = m;
    out.push({
      subject: subj.trim(),
      predicate: pred.replace(/\s+/g, "_").trim(),
      object: obj.trim(),
    });
  }
  for (const m of text.matchAll(APOSTROPHE_IS_PATTERN)) {
    const [, subj, modifier, category, obj] = m;
    out.push({
      subject: subj.trim(),
      predicate: `${modifier}_${category}`.toLowerCase(),
      object: obj.trim(),
    });
  }
  return dedupeWithKey(out, (f) => `${f.subject}|${f.predicate}|${f.object}`);
}

export interface KgBatcherOptions {
  batchSize: number;
  flushIntervalMs: number;
}

export class KgBatcher {
  private buffer: KgFact[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly mcp: McpClient,
    private readonly opts: KgBatcherOptions,
  ) {
    this.startTimer();
  }

  add(fact: KgFact): void {
    if (this.stopped) return;
    this.buffer.push(fact);
    if (this.buffer.length >= this.opts.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = dedupeWithKey(
      this.buffer.splice(0),
      (f) => `${f.subject}|${f.predicate}|${f.object}`,
    );
    await Promise.all(
      batch.map((f) =>
        this.mcp
          .callTool("mempalace_kg_add", {
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            valid_from: f.valid_from,
          })
          .catch(() => {
            // silent — best effort
          }),
      ),
    );
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.opts.flushIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/kg.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/kg.ts tests/kg.test.ts
git commit -m "feat: add fact extractor + KG batcher with coalescing"
```

---

### Task 4.2: Wire KG lifecycle into plugin  [Model: haiku]

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add llm_output handler and batcher**

Add to `src/index.ts`:

```typescript
const kgBatcher = cfg.kg.autoLearn
  ? new KgBatcher(mcp, {
      batchSize: cfg.kg.batchSize,
      flushIntervalMs: cfg.kg.flushIntervalMs,
    })
  : null;

if (typeof api.on === "function" && kgBatcher) {
  api.on("llm_output", (event: unknown) => {
    const ev = event as { assistantTexts?: string[] };
    if (!ev.assistantTexts) return;
    for (const text of ev.assistantTexts) {
      const facts = extractFacts(text);
      for (const fact of facts) kgBatcher.add(fact);
    }
  });
}
```

Add imports:

```typescript
import { KgBatcher, extractFacts } from "./kg.js";
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire KG lifecycle into llm_output hook"
```

---

# Phase 5: Proactive Memory

### Task 5.1: Identity chain loader  [Model: sonnet]

**Files:**
- Create: `src/identity.ts`
- Test: `tests/identity.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/identity.test.ts
import { describe, it, expect, vi } from "vitest";
import { loadIdentityContext } from "../src/identity.js";
import { promises as fs } from "node:fs";

describe("loadIdentityContext", () => {
  it("returns empty object when no identity files exist", async () => {
    const out = await loadIdentityContext({
      soulPath: "/nonexistent/SOUL.md",
      identityPath: "/nonexistent/IDENTITY.md",
    });
    expect(out.soul).toBe("");
    expect(out.identity).toBe("");
  });

  it("reads SOUL.md and IDENTITY.md when present", async () => {
    const tmpSoul = `/tmp/test-soul-${Date.now()}.md`;
    const tmpId = `/tmp/test-id-${Date.now()}.md`;
    await fs.writeFile(tmpSoul, "soul content");
    await fs.writeFile(tmpId, "identity content");
    try {
      const out = await loadIdentityContext({
        soulPath: tmpSoul,
        identityPath: tmpId,
      });
      expect(out.soul).toBe("soul content");
      expect(out.identity).toBe("identity content");
    } finally {
      await fs.unlink(tmpSoul).catch(() => {});
      await fs.unlink(tmpId).catch(() => {});
    }
  });

  it("truncates to max length", async () => {
    const tmp = `/tmp/test-soul-big-${Date.now()}.md`;
    await fs.writeFile(tmp, "x".repeat(10000));
    try {
      const out = await loadIdentityContext({
        soulPath: tmp,
        identityPath: "/nonexistent",
        maxChars: 100,
      });
      expect(out.soul.length).toBeLessThanOrEqual(100);
    } finally {
      await fs.unlink(tmp);
    }
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/identity.test.ts`
Expected: FAIL — "Cannot find module '../src/identity.js'"

- [ ] **Step 3: Implement `src/identity.ts`**

```typescript
import { promises as fs } from "node:fs";

export interface IdentityContext {
  soul: string;
  identity: string;
}

export interface LoadIdentityOptions {
  soulPath: string;
  identityPath: string;
  maxChars?: number;
}

export async function loadIdentityContext(
  opts: LoadIdentityOptions,
): Promise<IdentityContext> {
  const maxChars = opts.maxChars ?? 4000;
  const readSafe = async (path: string): Promise<string> => {
    try {
      const content = await fs.readFile(path, "utf8");
      return content.slice(0, maxChars);
    } catch {
      return "";
    }
  };
  const [soul, identity] = await Promise.all([
    readSafe(opts.soulPath),
    readSafe(opts.identityPath),
  ]);
  return { soul, identity };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/identity.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/identity.ts tests/identity.test.ts
git commit -m "feat: add identity chain loader (SOUL.md + IDENTITY.md)"
```

---

### Task 5.2: Prefetch + heartbeat cache warmer  [Model: sonnet]

**Files:**
- Create: `src/prefetch.ts`
- Create: `src/heartbeat.ts`
- Test: `tests/prefetch.test.ts`
- Test: `tests/heartbeat.test.ts`

- [ ] **Step 1: Write failing test for prefetch**

```typescript
// tests/prefetch.test.ts
import { describe, it, expect, vi } from "vitest";
import { prefetchWakeUp } from "../src/prefetch.js";

describe("prefetchWakeUp", () => {
  it("fires status, diary, and identity queries in parallel", async () => {
    const calls: string[] = [];
    const mockMcp = {
      callTool: vi.fn(async (name: string) => {
        calls.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 5));
        calls.push(`end:${name}`);
        return {};
      }),
    };
    await prefetchWakeUp(mockMcp as any, { diaryCount: 2 });
    const starts = calls.filter((c) => c.startsWith("start:"));
    const ends = calls.filter((c) => c.startsWith("end:"));
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.every((s) => calls.indexOf(s) < calls.indexOf(ends[0]))).toBe(true);
  });

  it("tolerates partial failures", async () => {
    const mockMcp = {
      callTool: vi.fn(async (name: string) => {
        if (name === "mempalace_status") throw new Error("fail");
        return {};
      }),
    };
    const result = await prefetchWakeUp(mockMcp as any, { diaryCount: 2 });
    expect(result.status).toBeNull();
    expect(result.diaryEntries).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/prefetch.test.ts`
Expected: FAIL — "Cannot find module '../src/prefetch.js'"

- [ ] **Step 3: Implement `src/prefetch.ts`**

```typescript
import type { McpClient } from "./mcp-client.js";
import type { PalaceStatus } from "./types.js";

export interface PrefetchResult {
  status: PalaceStatus | null;
  diaryEntries: unknown[];
}

export interface PrefetchOptions {
  diaryCount: number;
}

export async function prefetchWakeUp(
  mcp: McpClient,
  opts: PrefetchOptions,
): Promise<PrefetchResult> {
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const [status, diaryEntries] = await Promise.all([
    safe(mcp.callTool<PalaceStatus>("mempalace_status", {}), null),
    safe(
      mcp.callTool<unknown[]>("mempalace_diary_read", { limit: opts.diaryCount }),
      [],
    ),
  ]);
  return { status, diaryEntries: Array.isArray(diaryEntries) ? diaryEntries : [] };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- tests/prefetch.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/prefetch.ts tests/prefetch.test.ts
git commit -m "feat: add wake-up prefetch with parallel queries + partial failure tolerance"
```

- [ ] **Step 6: Write failing test for heartbeat**

```typescript
// tests/heartbeat.test.ts
import { describe, it, expect, vi } from "vitest";
import { HeartbeatWarmer } from "../src/heartbeat.js";

describe("HeartbeatWarmer", () => {
  it("fires warm function on interval", async () => {
    const warm = vi.fn().mockResolvedValue(undefined);
    const hb = new HeartbeatWarmer({ intervalMs: 20, warm });
    hb.start();
    await new Promise((r) => setTimeout(r, 50));
    hb.stop();
    expect(warm.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fire after stop()", async () => {
    const warm = vi.fn().mockResolvedValue(undefined);
    const hb = new HeartbeatWarmer({ intervalMs: 20, warm });
    hb.start();
    await new Promise((r) => setTimeout(r, 25));
    hb.stop();
    const countBefore = warm.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(warm.mock.calls.length).toBe(countBefore);
  });

  it("tolerates warm() failures", async () => {
    const warm = vi.fn().mockRejectedValue(new Error("boom"));
    const hb = new HeartbeatWarmer({ intervalMs: 10, warm });
    hb.start();
    await new Promise((r) => setTimeout(r, 30));
    hb.stop();
    expect(warm.mock.calls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run test, verify failure**

Run: `npm test -- tests/heartbeat.test.ts`
Expected: FAIL — "Cannot find module '../src/heartbeat.js'"

- [ ] **Step 8: Implement `src/heartbeat.ts`**

```typescript
export interface HeartbeatWarmerOptions {
  intervalMs: number;
  warm: () => Promise<void>;
}

export class HeartbeatWarmer {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HeartbeatWarmerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.opts.warm().catch(() => {
        // tolerate failures — best effort
      });
    }, this.opts.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 9: Run tests, verify pass**

Run: `npm test -- tests/heartbeat.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 10: Commit**

```bash
git add src/heartbeat.ts tests/heartbeat.test.ts
git commit -m "feat: add heartbeat-driven cache warmer"
```

---

### Task 5.3: Timeline queries  [Model: sonnet]

**Files:**
- Create: `src/timeline.ts`
- Test: `tests/timeline.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/timeline.test.ts
import { describe, it, expect, vi } from "vitest";
import { queryTimeline, isTimelineQuery } from "../src/timeline.js";

describe("isTimelineQuery", () => {
  it("detects 'what happened' queries", () => {
    expect(isTimelineQuery("what happened last week")).toBe(true);
    expect(isTimelineQuery("What did I do yesterday?")).toBe(true);
    expect(isTimelineQuery("recap of last month")).toBe(true);
  });

  it("ignores non-timeline queries", () => {
    expect(isTimelineQuery("what is the weather")).toBe(false);
    expect(isTimelineQuery("install node")).toBe(false);
  });
});

describe("queryTimeline", () => {
  it("reads diary entries and kg timeline together", async () => {
    const mockMcp = {
      callTool: vi.fn(async (name: string) => {
        if (name === "mempalace_diary_read") return [{ date: "2026-04-15", content: "worked on X" }];
        if (name === "mempalace_kg_timeline") return [{ date: "2026-04-15", fact: "completed X" }];
        return {};
      }),
    };
    const result = await queryTimeline(mockMcp as any, {
      daysBack: 7,
    });
    expect(result.diary).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/timeline.test.ts`
Expected: FAIL — "Cannot find module '../src/timeline.js'"

- [ ] **Step 3: Implement `src/timeline.ts`**

```typescript
import type { McpClient } from "./mcp-client.js";

const TIMELINE_PATTERNS = [
  /what happened/i,
  /what did (i|we) do/i,
  /recap of/i,
  /last (week|month|day|year)/i,
  /yesterday/i,
  /since (yesterday|last)/i,
];

export function isTimelineQuery(text: string): boolean {
  return TIMELINE_PATTERNS.some((re) => re.test(text));
}

export interface TimelineResult {
  diary: Array<{ date: string; content: string }>;
  events: Array<{ date: string; fact: string }>;
}

export interface QueryTimelineOptions {
  daysBack: number;
}

export async function queryTimeline(
  mcp: McpClient,
  opts: QueryTimelineOptions,
): Promise<TimelineResult> {
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const [diary, events] = await Promise.all([
    safe(
      mcp.callTool<Array<{ date: string; content: string }>>(
        "mempalace_diary_read",
        { days_back: opts.daysBack },
      ),
      [],
    ),
    safe(
      mcp.callTool<Array<{ date: string; fact: string }>>(
        "mempalace_kg_timeline",
        { days_back: opts.daysBack },
      ),
      [],
    ),
  ]);
  return {
    diary: Array.isArray(diary) ? diary : [],
    events: Array.isArray(events) ? events : [],
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/timeline.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/timeline.ts tests/timeline.test.ts
git commit -m "feat: add timeline query detection and diary/KG aggregation"
```

---

### Task 5.4: Wire Phase 5 into plugin  [Model: haiku]

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add session_start prefetch + heartbeat warmer + identity injection**

Add to `src/index.ts` after MCP start:

```typescript
// Session-start prefetch cache
const sessionStartCache = new Map<
  string,
  { status: unknown; diaryEntries: unknown[]; identity: { soul: string; identity: string } }
>();

if (typeof api.on === "function") {
  api.on("session_start", async (_event: unknown, ctx: unknown) => {
    const hctx = ctx as HookContext;
    const key = hctx?.sessionKey ?? "default";
    try {
      const [prefetch, identity] = await Promise.all([
        prefetchWakeUp(mcp, { diaryCount: cfg.prefetch.diaryCount }),
        cfg.prefetch.identityEntities
          ? loadIdentityContext({
              soulPath: "/home/derek/SOUL.md",
              identityPath: "/home/derek/IDENTITY.md",
              maxChars: 2000,
            })
          : Promise.resolve({ soul: "", identity: "" }),
      ]);
      sessionStartCache.set(key, { ...prefetch, identity });
    } catch (err) {
      logger.warn(`session_start prefetch failed: ${(err as Error).message}`);
    }
  });
}

// Heartbeat-driven cache warmer
const heartbeat = new HeartbeatWarmer({
  intervalMs: 30 * 60 * 1000,
  warm: async () => {
    await prefetchWakeUp(mcp, { diaryCount: cfg.prefetch.diaryCount });
  },
});
heartbeat.start();
```

Add imports:

```typescript
import { prefetchWakeUp } from "./prefetch.js";
import { HeartbeatWarmer } from "./heartbeat.js";
import { loadIdentityContext } from "./identity.js";
import { isTimelineQuery, queryTimeline } from "./timeline.js";
```

- [ ] **Step 2: Add timeline-detection branch in `before_prompt_build`**

Inside the `before_prompt_build` handler, before the existing `router.readBundle` call, add:

```typescript
if (isTimelineQuery(prompt)) {
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
    return;
  } catch (err) {
    logger.warn(`timeline query failed: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 3: Add identity context injection**

Update `promptBuilder` to include identity if present:

```typescript
const builder = (params: unknown) => {
  const p = params as { sessionKey?: string };
  const key = p?.sessionKey ?? "default";
  const recallLines = cachedBySession.get(key) ?? [];
  cachedBySession.delete(key);
  const start = sessionStartCache.get(key);
  const identityLines: string[] = [];
  if (start?.identity && (start.identity.soul || start.identity.identity)) {
    identityLines.push("## Identity (remempalace)", "");
    if (start.identity.soul) identityLines.push(start.identity.soul, "");
    if (start.identity.identity) identityLines.push(start.identity.identity, "");
  }
  return [...identityLines, ...recallLines];
};
```

- [ ] **Step 4: Clean shutdown on gateway_stop**

```typescript
if (typeof api.on === "function") {
  api.on("gateway_stop", async () => {
    heartbeat.stop();
    if (kgBatcher) await kgBatcher.stop();
    await mcp.stop();
  });
}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: No type errors.

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire Phase 5 — identity, prefetch, heartbeat, timeline"
```

---

### Task 5.5: README + docs  [Model: haiku]

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `docs/architecture.md`

- [ ] **Step 1: Create `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Derek Mensch

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Create `README.md`**

```markdown
# remempalace

Full-lifecycle memory plugin for OpenClaw, powered by [MemPalace](https://github.com/milla-jovovich/mempalace).

- **Fast**: persistent MCP subprocess, LRU cache, parallel queries (~5-20ms on cache miss, ~0ms on hit)
- **Token-aware**: tiered injection (L0 KG facts → L1 top hits → L2 deep context) gated by a budget manager
- **Complete**: recall on prompt, learn during conversation, persist diary on session end

## Install

```bash
npm install -g remempalace
```

Then in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["remempalace"],
    "entries": { "remempalace": { "enabled": true } },
    "slots": { "memory": "remempalace" }
  }
}
```

## Configuration

See `openclaw.plugin.json` for the full config schema. Defaults are tuned for daily-driver usage.

## How it works

1. **Session start**: prefetches palace status, recent diary, identity context
2. **Before each prompt**: queries search + KG in parallel (cache-first), injects tiered context respecting token budget
3. **After each LLM response**: extracts facts, batches them for KG write
4. **Session end**: fire-and-forget diary write summarizing the session in AAAK format
5. **Heartbeat** (30 min): warms cache proactively

## License

MIT
```

- [ ] **Step 3: Create `docs/architecture.md`**

```markdown
# remempalace architecture

See `docs/superpowers/specs/2026-04-16-remempalace-design.md` for the full design spec.

## Layout

- `src/mcp-client.ts` — persistent stdio MCP client (spawns `python -m mempalace.mcp_server` once)
- `src/cache.ts` — LRU with TTL
- `src/budget.ts` — tier gating based on remaining context window
- `src/tiers.ts` — L0/L1/L2 injection builder
- `src/router.ts` — cache-first read coordinator
- `src/diary.ts` — session-end summarizer + fire-and-forget write
- `src/kg.ts` — fact extractor + batching writer
- `src/prefetch.ts` — wake-up warm-up (status + diary)
- `src/heartbeat.ts` — periodic cache warmer
- `src/timeline.ts` — "what happened last week" queries
- `src/identity.ts` — SOUL.md / IDENTITY.md loader
- `src/index.ts` — plugin entry; wires everything into OpenClaw hooks
```

- [ ] **Step 4: Commit**

```bash
git add README.md LICENSE docs/architecture.md
git commit -m "docs: add README, LICENSE, and architecture notes"
```

---

### Task 5.6: Publish to GitHub  [Model: haiku]

**Files:**
- (external GitHub repo)

- [ ] **Step 1: Create GitHub repo**

Run:
```bash
gh repo create derekmensch-alt/remempalace --public --source=/media/derek/Projects/remempalace --remote=origin --description "Full-lifecycle memory plugin for OpenClaw, powered by MemPalace." --push=false
```

Expected: New empty repo at `https://github.com/derekmensch-alt/remempalace`.

- [ ] **Step 2: Push all commits**

```bash
cd /media/derek/Projects/remempalace
git branch -M main
git push -u origin main
```

Expected: All commits pushed.

- [ ] **Step 3: Verify on GitHub**

Run: `gh repo view derekmensch-alt/remempalace --web`
Expected: README renders, all files present.

---

## Phase 7: Revisions

> Added 2026-04-21 by the critique agent (see
> `docs/superpowers/plans/2026-04-16-remempalace-critique.md`). These tasks
> close the HIGH/MEDIUM gaps found when the plugin was measured against the
> live MemPalace MCP server. Verdict: REVISE. Two HIGH-impact correctness
> items (KG entity-query bug, broken diary tool) plus one HIGH token-cost
> item (raw identity injection) must land before this project can be called
> complete. Run these in order — 7.1 / 7.2 / 7.3 first (they are the
> correctness fixes), then 7.4 / 7.5 / 7.6 for polish.

### Task 7.1: Extract entity candidates before kg_query  [Model: sonnet]

**Why sonnet:** Small but load-bearing change touching router+index, needs a
real test suite to avoid regressing the existing parallel-fetch behavior.

**Files:**
- Create: `src/entity-extractor.ts`
- Create: `tests/entity-extractor.test.ts`
- Modify: `src/router.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts` (optional — for `EntityExtractionConfig` if added)

**Root cause (from critique #1):** `router.readBundle(prompt, 5)` passes the
full user prompt as the `entity` arg to `mempalace_kg_query`, which expects an
entity name. Live testing confirmed `kg_query({entity:"what should I do about
remempalace today?"})` returns `{facts:[], count:0}`, while the same prompt
trimmed to `"remempalace"` returns 6 facts. L0 is effectively dead.

- [ ] **Step 1: Write tests first**

Test cases for `extractEntityCandidates(prompt, opts)`:
- Returns `["Derek"]` for "what is Derek working on today?"
- Returns `["OpenClaw", "remempalace"]` for "is remempalace running under OpenClaw?"
- Returns at most `maxCandidates` (default 4)
- Merges capitalized-word matches with a config whitelist (`knownEntities`)
- Returns `[]` for prompts with no caps and no whitelist hits
- Lowercases for matching but returns original-case where it appeared

- [ ] **Step 2: Implement extractor**

```ts
export interface EntityExtractionOptions {
  knownEntities: string[]; // whitelist from config, case-insensitive match
  maxCandidates: number;   // default 4
  minLength: number;       // default 3 — skip "I", "it"
}

export function extractEntityCandidates(
  prompt: string,
  opts: EntityExtractionOptions,
): string[];
```

Implementation: (a) find `/\b[A-Z][\w]{2,}\b/g` capitalized tokens; (b) lowercase
the prompt and check each known entity as substring; (c) merge, dedup
case-insensitively preserving first-seen casing, cap at `maxCandidates`.

- [ ] **Step 3: Update MemoryRouter**

Add `kgQueryMulti(entities: string[])` that fans out via `Promise.all`, flattens
results, dedups by `subject|predicate|object` using `dedupeWithKey`. Keep the
existing `kgQuery(entity)` for direct/single-entity callers and the integration
test.

Update `readBundle(prompt, limit)` to call `extractEntityCandidates` (injected
via options) and use `kgQueryMulti` when candidates exist; fall back to
`kgQuery(prompt)` only if candidates is empty (so the existing behavior is a
strict subset when extraction misses).

- [ ] **Step 4: Wire into plugin + config**

Add `knownEntities: string[]` to `RemempalaceConfig.injection` with a default
of `["Derek", "OpenClaw", "MemPalace", "remempalace", "Anthropic", "Claude"]`.
Pass into `MemoryRouter` constructor. Bump the router ctor to accept an
`extractEntities` function so tests can swap it.

- [ ] **Step 5: Verify**

Run `npm test` — all green. Manually call the plugin's recall path against the
live MCP (`node -e 'await mcp.start(); await router.readBundle("is remempalace
running?", 5); ...'`) and confirm `kgResults` now has `facts.length > 0`.

**Acceptance criteria:** For prompts containing known entities or capitalized
names, at least one of them yields non-empty KG facts in >80% of cases when the
palace has matching data. For prompts with no candidates, behavior is identical
to before (no regressions).

---

### Task 7.2: Diary health check + local-fallback + upstream report  [Model: sonnet]

**Why sonnet:** Touches MCP client lifecycle, needs careful fallback design
that survives both upstream fix and continued breakage.

**Files:**
- Modify: `src/mcp-client.ts`
- Modify: `src/diary.ts`
- Modify: `src/index.ts`
- Create: `tests/diary-fallback.test.ts`
- Create: `docs/upstream-issue-diary.md` (issue text to file against mempalace)

**Root cause (from critique #2):** `mempalace_diary_write` returns
`"Internal tool error"` for every arg combo tested (bench 22:05 2026-04-21);
`mempalace_diary_read` same. `writeDiaryAsync` silently swallows, so the
failure is invisible and the Phase 3 success criterion is unmet.

- [ ] **Step 1: Probe at MCP startup**

In `McpClient.start` (or a new `probeCapabilities` method called from
`index.ts` after start), call `diary_write` with a harmless probe
(`{wing:"remempalace",room:"selftest",content:"probe",added_by:"remempalace"}`)
and also `diary_read({})`. Store booleans `hasDiaryWrite` / `hasDiaryRead` on
the client. Log at `warn` level when either fails, including the raw error
message for triage. Probe runs once per session, not per turn.

- [ ] **Step 2: Fallback to local JSONL when remote diary is broken**

Add `src/diary-local.ts`:
```ts
export async function appendLocalDiary(
  entry: { wing: string; room: string; content: string; ts: string },
  opts: { dir: string },
): Promise<void>;
```
Writes `JSONL` to `~/.mempalace/palace/diary/<YYYY-MM-DD>.jsonl` (create dir
if missing). `diary.writeDiaryAsync` should use `mcp.callTool` when
`hasDiaryWrite` is true, otherwise fall through to `appendLocalDiary`.

- [ ] **Step 3: Surface diary status in `mempalace_status` builder output**

When `hasDiaryWrite === false`, include a one-line warning in the identity
section at session start (or a dedicated `## System Notes` block) so the user
sees it once per session: `"remempalace: diary falling back to local JSONL
(mempalace_diary_write returned Internal tool error)"`. Do not repeat per turn.

- [ ] **Step 4: File upstream issue**

Write `docs/upstream-issue-diary.md` with reproduction: Python version, MCP
arg combos tried, exact error text, expected behavior. This file is committed
so we have the full trail even if the upstream issue is closed later.

- [ ] **Step 5: Tests**

Unit: `writeDiaryAsync` calls local fallback when `mcp.hasDiaryWrite === false`.
Unit: local fallback creates dir, appends JSONL, survives concurrent calls.

**Acceptance criteria:** `ls ~/.mempalace/palace/diary/*.jsonl` shows a fresh
entry after any real session ends when upstream diary is broken. When upstream
is fixed, flipping `hasDiaryWrite=true` routes back to MCP automatically with
no code change. No silent failures.

---

### Task 7.3: AAAK-compressed identity through BudgetManager  [Model: sonnet]

**Why sonnet:** Requires writing an identity-compaction step and re-wiring
the builder; easy to under-compact or over-compact.

**Files:**
- Modify: `src/identity.ts`
- Create: `src/identity-compact.ts`
- Create: `tests/identity-compact.test.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts` (add `injection.identityMaxTokens`, `injection.rawIdentity`)

**Root cause (from critique #3):** `index.ts:262-268` unconditionally prepends
raw SOUL.md + IDENTITY.md (up to ~1000 tokens) to the builder output,
bypassing `BudgetManager`, AAAK compression, and the
"skip-when-context-full" rule. Baseline injection exceeds the 150-300 token
target before L0/L1/L2 content is even considered.

- [ ] **Step 1: Design the compaction**

Convert SOUL.md / IDENTITY.md into an AAAK fact block at session start:
```
IDENT: Derek | role=principal | stack=typescript,python,rust | ...
VALUES: direct | low-bs | build-to-learn | ...
CURRENT: project=remempalace | goal=ship-phase-7
```
Target ≤150 tokens total. Extraction can be regex + headings (no LLM — that
violates the speed/cost constraint per design §9).

- [ ] **Step 2: Implement `compactIdentity`**

```ts
export function compactIdentity(
  raw: { soul: string; identity: string },
  opts: { maxTokens: number },
): string;
```
- Parse `#`/`##` headings for section labels
- Collect bullet lines, join with `|`
- Truncate to `maxTokens` via `countTokens`
- Return single string ready to inject as one L0 line

- [ ] **Step 3: Route through BudgetManager**

In `index.ts` `before_prompt_build`:
- Read compacted identity from `sessionStartCache`
- If `budget.allowedTiers.includes("L0")` and the compacted identity fits in
  the L0 token budget, prepend it to the injected lines
- Otherwise skip (respect the 80%-full rule)

Remove the direct identity-dumping block from the `builder` function. The
builder should only return what was staged by the hook.

- [ ] **Step 4: Config knobs**

Add to `RemempalaceConfig.injection`:
- `identityMaxTokens: number` (default 150)
- `rawIdentity: boolean` (default false — keep the old dump-the-markdown
  behavior available only when explicitly enabled, for debugging)

- [ ] **Step 5: Tests**

Unit: `compactIdentity` stays within `maxTokens`, preserves key sections.
Integration: per-turn injection with identity + empty KG + empty search
should be ≤200 tokens (vs. ~1000 today).

**Acceptance criteria:** Measured per-turn injection size (excluding the turn
header) drops to 150-300 tokens in the typical case. Identity is elided when
context is >80% full.

---

### Task 7.4: Prefetch ChromaDB warm-up  [Model: haiku]

**Why haiku:** One-line parallel-call addition, no design work.

**Files:**
- Modify: `src/prefetch.ts`
- Modify: `tests/prefetch.test.ts`

**Root cause (from critique #4):** Measured prefetch (status + diary_read in
parallel) was 230.7ms, exceeding the design's 100ms target. The first real
`mempalace_search` after that was 208ms while subsequent warm searches ran at
12-13ms — ChromaDB cold-start dominates.

- [ ] **Step 1: Add warmup search to `prefetchWakeUp`**

```ts
const [status, diary, _warmup] = await Promise.all([
  safe(mcp.callTool("mempalace_status", {}), null),
  safe(mcp.callTool("mempalace_diary_read", { limit: diaryCount }), []),
  safe(mcp.callTool("mempalace_search", { query: "__warmup__", limit: 1 }), null),
]);
```
Do not surface the warmup result. Its only job is to trigger ChromaDB load.

- [ ] **Step 2: Update tests**

Mock 3 parallel calls; assert all three fire concurrently and that the
returned `PrefetchResult` shape is unchanged (no `warmup` field leaks).

**Acceptance criteria:** First real search after prefetch measures <50ms p95
against the live server. Prefetch itself is allowed to be ~250ms (it runs
in parallel with the session-start hook, not on the critical turn path).

---

### Task 7.5: KG invalidation pathway (feature-flagged)  [Model: sonnet]

**Why sonnet:** Needs contradiction-detection logic and careful gating so
the broken upstream tool doesn't spam errors.

**Files:**
- Modify: `src/kg.ts`
- Create: `tests/kg-invalidate.test.ts`
- Modify: `src/types.ts` (add `kg.invalidateOnConflict: boolean`)

**Root cause (from critique #5):** Phase 4 lists invalidation as a
deliverable. Zero references to `kg_invalidate` exist in `src/`. Live
`kg_invalidate` tool also returns `"Internal tool error"` right now so this
must ship feature-flagged OFF until upstream is fixed (dependency on 7.2's
upstream work).

- [ ] **Step 1: Add contradiction detection to `KgBatcher.flush`**

Before each `kg_add`, query `kg_query({entity: fact.subject})`. For each
existing fact with the same `subject+predicate` but different `object` and
`current:true`, call `kg_invalidate({subject, predicate, object: oldObject})`
first. Only fire if `config.kg.invalidateOnConflict` is true AND the MCP
client reports `hasKgInvalidate=true` (add capability probe alongside the
diary one from 7.2).

- [ ] **Step 2: Tests**

Unit: Given a cached KG with `Derek | favorite_model | Kimi K2.5`, adding
`Derek | favorite_model | Kimi K3.0` should fire `kg_invalidate` for K2.5
then `kg_add` for K3.0. Adding `Derek | favorite_model | Kimi K2.5` again
(same object) should NOT fire invalidate.

- [ ] **Step 3: Default the flag OFF**

`config.kg.invalidateOnConflict: false` until 7.2 reports upstream is healthy.
Document in README.

**Acceptance criteria:** Flag-on integration test (against a fixed, healthy
upstream or a mock) shows stale facts invalidated and new facts added in a
single atomic batch. Flag-off path is a no-op (bit-for-bit identical to
current behavior).

---

### Task 7.6: Hoist BudgetManager out of the hot path  [Model: haiku]

**Why haiku:** Three-line move.

**Files:**
- Modify: `src/index.ts`

**Root cause (from critique #6):** `index.ts:217-222` constructs a new
`BudgetManager` on every `before_prompt_build`. Its constructor args are
constant for the lifetime of the plugin.

- [ ] **Step 1:** Hoist `const budgetManager = new BudgetManager({...})`
above the hook registration. Per-turn: just `budgetManager.compute({
conversationTokens })`.

- [ ] **Step 2:** Verify `npm test` still passes.

**Acceptance criteria:** No behavior change. One less allocation per turn.

---

## Migration & Cutover

### Task M.1: Remove mempalace-auto-recall  [Model: haiku]

**Files:**
- Modify: `/home/derek/.openclaw/openclaw.json`

- [ ] **Step 1: Remove mempalace-auto-recall entries**

In `/home/derek/.openclaw/openclaw.json`:
- Remove `"mempalace-auto-recall"` from `plugins.allow`
- Remove `mempalace-auto-recall` key from `plugins.entries`
- Remove `/home/derek/.openclaw/extensions/mempalace-auto-recall` from `plugins.load.paths`
- Confirm `plugins.slots.memory` is `"remempalace"`

- [ ] **Step 2: Remove old plugin directory**

```bash
rm -rf /home/derek/.openclaw/extensions/mempalace-auto-recall
```

- [ ] **Step 3: Restart OpenClaw, verify behavior**

Run: `openclaw status`
Expected: `remempalace` loaded, `mempalace-auto-recall` absent.

Send a Telegram message, check logs.
Expected: Memory context present, no errors.

- [ ] **Step 4: Commit OpenClaw config change**

```bash
cd /home/derek/.openclaw
git add openclaw.json
git commit -m "chore: remove mempalace-auto-recall, remempalace is now the memory slot"
```

---

# Phase 6: Critique & Iterate

> This phase runs **after** all prior phases are complete and the plugin is live in production. Its job is to close the loop: prove the goals were met, find what's still slow / wasteful / wrong, and feed revisions back into this plan for a second pass.

### Task 6.1: Dispatch the critique agent  [Model: opus]

**Why Opus:** This task synthesizes the design doc, the full source tree, real measured behavior, and the original goals into a revision plan. It's deep cross-cutting reasoning — the one place in this plan where Opus 4.7 earns its cost.

**Files:**
- Read: `/media/derek/Projects/remempalace/2026-04-16-remempalace-design.md`
- Read: `/media/derek/Projects/remempalace/docs/superpowers/plans/2026-04-16-remempalace-implementation.md` (this file)
- Read: `/media/derek/Projects/remempalace/src/**/*.ts`
- Read: `/media/derek/Projects/remempalace/tests/**/*.ts`
- Read: live OpenClaw logs at `/home/derek/.openclaw/logs/` (most recent session)
- Modify (if revisions needed): this file
- Create: `/media/derek/Projects/remempalace/docs/superpowers/plans/2026-04-16-remempalace-critique.md`

- [ ] **Step 1: Dispatch the critique subagent**

Use the `Agent` tool with `subagent_type: "general-purpose"` and `model: "opus"`. Pass the prompt below verbatim. The agent runs cold and produces a single self-contained report — do not feed it conversation context.

**Critique agent prompt:**

```
You are the critique agent for the remempalace plugin. The plugin is now built,
tested, and live as the memory slot in OpenClaw. Your job is to decide whether
we hit the goals — and if not, write the revisions back into the implementation
plan so a second pass can fix them.

## Inputs to read (in this order)

1. Design doc: /media/derek/Projects/remempalace/2026-04-16-remempalace-design.md
   — focus on §1 Design Goals (Speed, Token cost, Completeness) and §5 Phase
   success criteria.
2. Implementation plan: /media/derek/Projects/remempalace/docs/superpowers/plans/2026-04-16-remempalace-implementation.md
   — what we said we'd build.
3. Source: /media/derek/Projects/remempalace/src/**/*.ts — what we actually built.
4. Tests: /media/derek/Projects/remempalace/tests/**/*.ts — what we actually verified.
5. Live behavior: tail the most recent OpenClaw session log at
   /home/derek/.openclaw/logs/ (look for `remempalace` entries).
   Capture: per-turn injection token count, cache hit/miss ratio,
   MCP call latency p50/p95, any errors.

## Evaluation rubric

For each design goal, render a verdict — MET / PARTIAL / MISSED — with evidence:

### Goal 1: Speed
- [ ] Cache hit < 20ms?  (measure from logs / add a one-shot benchmark if absent)
- [ ] MCP round-trip < 50ms p95?
- [ ] Pre-fetch on session start completes < 100ms?
- [ ] No CLI spawns per turn? (grep src for `spawn`, `exec` — should only spawn
      the MCP server once at init)

### Goal 2: Token cost
- [ ] Average injection size 150-300 tokens (down from old plugin's ~1000)?
- [ ] L2 tier correctly skipped when context > 60% full?
- [ ] AAAK compression actually applied (sample injected text)?
- [ ] Search + KG dedup working (no duplicate facts injected)?

### Goal 3: Completeness
- [ ] Diary entry written on session_end? (check ~/.mempalace/palace/diary/)
- [ ] KG facts added during conversation? (call mempalace_kg_stats before/after
      a session, expect delta)
- [ ] Stale facts get invalidated when contradicted?
- [ ] Identity context at L0?

### Code quality (secondary)
- [ ] All `npm test` passing?
- [ ] `npm run lint` clean?
- [ ] No TODO / FIXME / XXX in src/?
- [ ] Dead code? (grep for unreferenced exports)
- [ ] Hot path allocations? (any per-turn `new` of large objects, JSON.parse on
      cache hit, etc.)

## Output

Write your full report to:
/media/derek/Projects/remempalace/docs/superpowers/plans/2026-04-16-remempalace-critique.md

Structure:

  # remempalace Critique Report
  **Date:** <today>
  **Verdict:** SHIP / REVISE / BLOCK

  ## Goal scorecard
  | Goal | Verdict | Evidence |
  |---|---|---|
  | Speed       | MET/PARTIAL/MISSED | <metric + source> |
  | Token cost  | MET/PARTIAL/MISSED | <metric + source> |
  | Completeness| MET/PARTIAL/MISSED | <metric + source> |

  ## What works well
  - <bullets, be specific, cite file:line>

  ## What's broken or wasteful
  Sorted by impact (highest first). Each item must have:
  - **Problem:** <one line>
  - **Evidence:** <file:line, log excerpt, or measurement>
  - **Impact:** <latency ms / tokens / correctness>
  - **Proposed fix:** <concrete code change or design tweak>

  ## Recommended plan revisions
  For each "broken or wasteful" item that needs more than a one-line fix,
  describe the new task to add to the implementation plan:
    - Task ID (next sequential, e.g. 6.2, 6.3)
    - Phase to insert under (or new Phase 7)
    - Model assignment (haiku/sonnet/opus per the existing rubric)
    - File scope
    - Acceptance criteria

## Decision gate

- **SHIP** — all 3 goals MET, no broken items above LOW impact. Stop here.
- **REVISE** — at least one goal PARTIAL, or MEDIUM-impact items exist. Edit
  the implementation plan in place: append the new tasks under a new
  "## Phase 7: Revisions" section near the bottom, just before the
  "Migration & Cutover" section. Use the same task format as the rest of the
  plan (checkboxes, [Model: ...] tag, files list, steps). Mention each new
  task in the report.
- **BLOCK** — any goal MISSED, or HIGH-impact correctness bug. Edit the plan
  to add an emergency hotfix phase at the very top of the still-pending work,
  and flag in the report header that the plugin should be rolled back to
  mempalace-auto-recall until fixed.

## Constraints

- Do NOT rewrite or "improve" working code in this task. Your output is
  analysis + plan edits only. Code changes happen in the follow-up tasks
  you create.
- Do NOT delete prior tasks from the plan, even if obsolete. Mark them
  "(superseded by 7.x)" inline.
- Be specific. "Cache could be faster" is useless; "router.ts:47 awaits the
  KG call sequentially after search instead of using Promise.all, costing
  ~30ms per cache miss" is actionable.
- Word budget: report under 1500 words. Plan edits as long as needed.
```

- [ ] **Step 2: Read the report and act on the verdict**

Open `/media/derek/Projects/remempalace/docs/superpowers/plans/2026-04-16-remempalace-critique.md`.

- If **SHIP**: commit the report, close out the project, you're done.
- If **REVISE**: the plan now has a Phase 7. Re-enter `superpowers:executing-plans` (or `subagent-driven-development`) starting at the first new task. Each new task carries its own `[Model: ...]` tag.
- If **BLOCK**: roll back per the report's instructions, then execute the hotfix phase.

- [ ] **Step 3: Commit the critique artifacts**

```bash
cd /media/derek/Projects/remempalace
git add docs/superpowers/plans/2026-04-16-remempalace-critique.md docs/superpowers/plans/2026-04-16-remempalace-implementation.md
git commit -m "docs: critique pass — verdict <SHIP|REVISE|BLOCK>"
```

---
