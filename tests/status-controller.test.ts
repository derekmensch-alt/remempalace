import { describe, expect, it, vi, afterEach } from "vitest";
import { StatusController, type StatusControllerOptions } from "../src/controllers/status-controller.js";

function makeOptions(overrides: Partial<StatusControllerOptions> = {}): StatusControllerOptions {
  return {
    isMcpReady: () => true,
    canWriteDiary: () => true,
    canReadDiary: () => true,
    canInvalidateKg: () => true,
    canPersistDiary: () => true,
    searchCacheStats: () => ({ hits: 0, misses: 0, size: 0 }),
    kgCacheStats: () => ({ hits: 0, misses: 0, size: 0 }),
    metricsSnapshot: () => ({}),
    latencySnapshot: () => ({}),
    breakersSnapshot: () => ({
      search: { state: "closed", openedAt: null, lastFailureReason: null },
      kg: { state: "closed", openedAt: null, lastFailureReason: null },
      diary: { state: "closed", openedAt: null, lastFailureReason: null },
    }),
    diaryStatus: async () => ({ state: "persistent", persistenceState: "persistent", pending: 0 }),
    lastProbeAt: () => null,
    lastProbeReason: () => null,
    coldStartHealth: () => null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StatusController", () => {
  it("builds the live status report from injected state", async () => {
    const controller = new StatusController(makeOptions());

    const text = await controller.buildText();

    expect(text).toContain("remempalace status");
    expect(text).toContain("health: healthy");
    expect(text).toContain("mcp_ready: yes");
  });

  it("appends cold-start health hints while MCP is offline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T00:00:30.000Z"));
    const controller = new StatusController(makeOptions({
      isMcpReady: () => false,
      coldStartHealth: () => ({
        stale: true,
        snapshot: {
          version: 1,
          savedAt: new Date("2026-05-13T00:00:00.000Z").getTime(),
          mcpReady: true,
          capabilities: {
            canWriteDiary: true,
            canReadDiary: true,
            canInvalidateKg: false,
            canPersistDiary: true,
          },
          diaryPersistenceState: "persistent",
          lastProbeAt: new Date("2026-05-12T23:59:30.000Z").getTime(),
          lastProbeReason: "verified: persistent",
          lastReplay: { attempted: 2, succeeded: 2, failed: 0, at: Date.now() },
        },
      }),
    }));

    const text = await controller.buildText();

    expect(text).toContain("remempalace status");
    expect(text).toContain("cold_start_hint (30s ago [stale])");
    expect(text).toContain("capabilities: write=true read=true kg_invalidate=false persist=true");
    expect(text).toContain("last_probe: 60s ago");
    expect(text).toContain("last_replay: 2/2 succeeded");
  });

  it("records last recall for subsequent status reports", async () => {
    const controller = new StatusController(makeOptions());

    controller.recordRecall({
      sessionKey: "abc",
      promptPreview: "what did we decide?",
      candidates: ["project"],
      kgFactCount: 2,
      searchResultCount: 3,
      injectedLineCount: 4,
      identityIncluded: true,
      at: new Date("2026-05-13T00:00:00.000Z").getTime(),
    });

    const text = await controller.buildText();

    expect(text).toContain("last_recall:");
    expect(text).toContain("session: abc");
    expect(text).toContain("KG facts: 2");
  });

  it("registers the slash command without forcing MCP startup", async () => {
    const registerCommand = vi.fn();
    const controller = new StatusController(makeOptions());

    controller.registerCommand({ registerCommand });

    expect(registerCommand).toHaveBeenCalledWith(expect.objectContaining({
      name: "remempalace",
      acceptsArgs: false,
    }));
    const command = registerCommand.mock.calls[0][0];
    await expect(command.handler()).resolves.toEqual(expect.objectContaining({
      text: expect.stringContaining("remempalace status"),
    }));
  });
});
