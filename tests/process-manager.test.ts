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
