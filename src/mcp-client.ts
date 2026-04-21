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
