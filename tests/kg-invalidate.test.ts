import { describe, it, expect, vi, beforeEach } from "vitest";
import { KgBatcher } from "../src/kg.js";
import type { McpClient } from "../src/mcp-client.js";

function makeMcp(overrides: Partial<McpClient> = {}): McpClient {
  return {
    hasDiaryWrite: false,
    hasDiaryRead: false,
    hasKgInvalidate: false,
    callTool: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as McpClient;
}

describe("KgBatcher invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flag off: never calls kg_invalidate or kg_query", async () => {
    const mcp = makeMcp();
    const batcher = new KgBatcher(mcp, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: false,
      getMcpCaps: () => ({ hasKgInvalidate: true }),
    });
    batcher.add({ subject: "Derek", predicate: "favorite_model", object: "Kimi K3.0" });
    await batcher.flush();

    const calls = (mcp.callTool as ReturnType<typeof vi.fn>).mock.calls;
    const names = calls.map((c: unknown[]) => c[0]);
    expect(names).not.toContain("mempalace_kg_query");
    expect(names).not.toContain("mempalace_kg_invalidate");
    expect(names).toContain("mempalace_kg_add");
    await batcher.stop();
  });

  it("flag on but upstream broken: no invalidation calls", async () => {
    const mcp = makeMcp();
    const batcher = new KgBatcher(mcp, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: true,
      getMcpCaps: () => ({ hasKgInvalidate: false }),
    });
    batcher.add({ subject: "Derek", predicate: "favorite_model", object: "Kimi K3.0" });
    await batcher.flush();

    const calls = (mcp.callTool as ReturnType<typeof vi.fn>).mock.calls;
    const names = calls.map((c: unknown[]) => c[0]);
    expect(names).not.toContain("mempalace_kg_invalidate");
    expect(names).not.toContain("mempalace_kg_query");
    await batcher.stop();
  });

  it("flag on + upstream healthy: invalidates stale facts before adding", async () => {
    const mcp = makeMcp({
      callTool: vi.fn().mockImplementation(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "mempalace_kg_query") {
          return {
            facts: [
              { subject: "Derek", predicate: "favorite_model", object: "Kimi K2.5", current: true },
            ],
          };
        }
        return {};
      }) as unknown as McpClient["callTool"],
    });

    const batcher = new KgBatcher(mcp, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: true,
      getMcpCaps: () => ({ hasKgInvalidate: true }),
    });
    batcher.add({ subject: "Derek", predicate: "favorite_model", object: "Kimi K3.0" });
    await batcher.flush();

    const calls = (mcp.callTool as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];
    const invalidateCall = calls.find(([t]) => t === "mempalace_kg_invalidate");
    expect(invalidateCall).toBeDefined();
    expect(invalidateCall![1]).toMatchObject({
      subject: "Derek",
      predicate: "favorite_model",
      object: "Kimi K2.5",
    });
    const addCall = calls.find(([t]) => t === "mempalace_kg_add");
    expect(addCall).toBeDefined();
    expect(addCall![1]).toMatchObject({ object: "Kimi K3.0" });
    await batcher.stop();
  });

  it("list-cardinality predicate (uses): never invalidates even with different object", async () => {
    const mcp = makeMcp({
      callTool: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === "mempalace_kg_query") {
          return {
            facts: [
              { subject: "Derek", predicate: "uses", object: "OpenClaw", current: true },
            ],
          };
        }
        return {};
      }) as unknown as McpClient["callTool"],
    });

    const batcher = new KgBatcher(mcp, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: true,
      getMcpCaps: () => ({ hasKgInvalidate: true }),
    });
    batcher.add({ subject: "Derek", predicate: "uses", object: "Vitest" });
    await batcher.flush();

    const calls = (mcp.callTool as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    const names = calls.map(([t]) => t);
    expect(names).not.toContain("mempalace_kg_invalidate");
    expect(names).not.toContain("mempalace_kg_query");
    await batcher.stop();
  });

  it("same object: does NOT call kg_invalidate", async () => {
    const mcp = makeMcp({
      callTool: vi.fn().mockImplementation(async (tool: string) => {
        if (tool === "mempalace_kg_query") {
          return {
            facts: [
              { subject: "Derek", predicate: "favorite_model", object: "Kimi K2.5", current: true },
            ],
          };
        }
        return {};
      }) as unknown as McpClient["callTool"],
    });

    const batcher = new KgBatcher(mcp, {
      batchSize: 10,
      flushIntervalMs: 60000,
      invalidateOnConflict: true,
      getMcpCaps: () => ({ hasKgInvalidate: true }),
    });
    batcher.add({ subject: "Derek", predicate: "favorite_model", object: "Kimi K2.5" });
    await batcher.flush();

    const calls = (mcp.callTool as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    const names = calls.map(([t]) => t);
    expect(names).not.toContain("mempalace_kg_invalidate");
    await batcher.stop();
  });
});
