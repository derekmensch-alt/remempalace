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
