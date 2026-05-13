/**
 * Tests for the shared RuntimeState container.
 *
 * Verifies the singleton-per-McpClient contract:
 *   - Repeated getRuntimeState(mcp, cfg) calls return identical instances.
 *   - resetRuntimeStateForTests() clears the cache.
 *   - Different McpClient instances get distinct RuntimeStates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp-client.js";
import { mergeConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import {
  getRuntimeState,
  resetRuntimeStateForTests,
} from "../src/runtime-state.js";

function makeFakeMcp(): McpClient {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    probeCapabilities: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({}),
    call: vi.fn().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: {} }),
    isReady: vi.fn().mockReturnValue(true),
    hasDiaryWrite: false,
    hasDiaryRead: false,
    hasKgInvalidate: false,
  } as unknown as McpClient;
}

const logger = createLogger("runtime-state-test", {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

beforeEach(async () => {
  await resetRuntimeStateForTests();
});

afterEach(async () => {
  await resetRuntimeStateForTests();
  vi.restoreAllMocks();
});

describe("getRuntimeState", () => {
  it("returns the same instance on repeated calls for the same mcp", () => {
    const mcp = makeFakeMcp();
    const cfg = mergeConfig({ hotCache: { enabled: false } });
    const a = getRuntimeState(mcp, cfg, { logger });
    const b = getRuntimeState(mcp, cfg, { logger });

    expect(a).toBe(b);
    expect(a.mempalaceRepository).toBe(b.mempalaceRepository);
    expect(a.diaryReconciler).toBe(b.diaryReconciler);
    expect(a.router).toBe(b.router);
    expect(a.searchCache).toBe(b.searchCache);
    expect(a.kgCache).toBe(b.kgCache);
    expect(a.memoryRuntime).toBe(b.memoryRuntime);
    expect(a.health).toBe(b.health);
    expect(a.hookFiredSessions).toBe(b.hookFiredSessions);
  });

  it("ignores config on later calls (first-call wins)", () => {
    const mcp = makeFakeMcp();
    const cfgA = mergeConfig({
      hotCache: { enabled: false },
      injection: { similarityThreshold: 0.5 },
    });
    const cfgB = mergeConfig({
      hotCache: { enabled: false },
      injection: { similarityThreshold: 0.9 },
    });
    const a = getRuntimeState(mcp, cfgA, { logger });
    const b = getRuntimeState(mcp, cfgB, { logger });

    expect(a).toBe(b);
    // The cached cfg is the one from the first call.
    expect(a.cfg.injection.similarityThreshold).toBe(0.5);
  });

  it("produces distinct RuntimeStates for distinct mcp instances", () => {
    const mcp1 = makeFakeMcp();
    const mcp2 = makeFakeMcp();
    const cfg = mergeConfig({ hotCache: { enabled: false } });
    const a = getRuntimeState(mcp1, cfg, { logger });
    const b = getRuntimeState(mcp2, cfg, { logger });

    expect(a).not.toBe(b);
    expect(a.mempalaceRepository).not.toBe(b.mempalaceRepository);
    expect(a.searchCache).not.toBe(b.searchCache);
  });

  it("resetRuntimeStateForTests clears the cache", async () => {
    const mcp = makeFakeMcp();
    const cfg = mergeConfig({ hotCache: { enabled: false } });
    const a = getRuntimeState(mcp, cfg, { logger });
    await resetRuntimeStateForTests();
    const b = getRuntimeState(mcp, cfg, { logger });

    expect(a).not.toBe(b);
  });
});

describe("RuntimeState health slot", () => {
  it("is observable from multiple consumers (shared mutation)", () => {
    const mcp = makeFakeMcp();
    const cfg = mergeConfig({ hotCache: { enabled: false } });
    const a = getRuntimeState(mcp, cfg, { logger });
    const b = getRuntimeState(mcp, cfg, { logger });

    expect(a.health.lastProbeAt).toBeNull();
    a.health.lastProbeAt = 12345;
    a.health.lastProbeReason = "verified: confirmed";
    expect(b.health.lastProbeAt).toBe(12345);
    expect(b.health.lastProbeReason).toBe("verified: confirmed");
  });
});

describe("RuntimeState ensureInit", () => {
  it("calls mcp.start() exactly once across repeated ensureInit invocations", async () => {
    const mcp = makeFakeMcp();
    const cfg = mergeConfig({
      hotCache: { enabled: false },
      diary: { replayOnStart: false },
    });
    const rt = getRuntimeState(mcp, cfg, { logger });

    await rt.ensureInit();
    await rt.ensureInit();
    await rt.ensureInit();

    expect((mcp.start as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
