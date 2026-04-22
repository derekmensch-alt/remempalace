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
