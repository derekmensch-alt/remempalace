import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("stop is idempotent while the process is already stopping", async () => {
    await pm.start();
    await Promise.all([pm.stop(), pm.stop()]);
    expect(pm.isAlive()).toBe(false);
  });

  it("restarts dead process", async () => {
    await pm.start();
    await pm.stop();
    await pm.start();
    expect(pm.isAlive()).toBe(true);
  });

  it("captures stderr through registered handler", async () => {
    const errPm = new ProcessManager({
      command: "node",
      args: ["-e", "process.stderr.write('boom\\n'); setTimeout(() => {}, 1000);"],
    });
    try {
      const captured = await new Promise<string>((resolve) => {
        errPm.onStderr((data) => resolve(data));
        errPm.start();
      });
      expect(captured).toContain("boom");
    } finally {
      await errPm.stop();
    }
  });

  it("does not crash the process when writing to a dead child (EPIPE)", async () => {
    const dyingPm = new ProcessManager({
      command: "node",
      args: ["-e", "process.exit(0);"],
    });
    await dyingPm.start();
    await new Promise<void>((resolve) => dyingPm.onExit(() => resolve()));

    const uncaught: Error[] = [];
    const handler = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", handler);

    try {
      expect(() => dyingPm.writeStdin("after-death\n")).toThrow(/not alive|EPIPE|dead|not started/i);
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toHaveLength(0);
    } finally {
      process.off("uncaughtException", handler);
      await dyingPm.stop();
    }
  });

  it("attaches an error listener to stdin so async EPIPE never reaches uncaughtException", async () => {
    await pm.start();
    const proc = (pm as unknown as { proc: { stdin: NodeJS.WritableStream } }).proc;
    expect(proc.stdin.listenerCount("error")).toBeGreaterThan(0);
  });

  it("emits async stdin errors through the registered stderr/error handler instead of crashing", async () => {
    const stderrPm = new ProcessManager({
      command: "node",
      args: ["-e", "process.stdin.on('data', () => { process.exit(0); });"],
    });
    const errors: string[] = [];
    stderrPm.onStderr((d) => errors.push(d));
    await stderrPm.start();

    const uncaught: Error[] = [];
    const handler = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", handler);

    try {
      const proc = (stderrPm as unknown as { proc: { stdin: NodeJS.WritableStream } }).proc;
      proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught.filter((e) => /EPIPE/.test(e.message))).toHaveLength(0);
    } finally {
      process.off("uncaughtException", handler);
      await stderrPm.stop();
    }
  });

  it(
    "uses SIGKILL fallback when a child ignores SIGTERM",
    async () => {
      const stubbornPm = new ProcessManager({
        command: "node",
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
      });
      await stubbornPm.start();

      await stubbornPm.stop();

      expect(stubbornPm.isAlive()).toBe(false);
    },
    5000,
  );
});
