import { describe, it, expect, vi, beforeEach } from "vitest";
import { MempalaceMemoryRuntime } from "../src/memory-runtime.js";

interface MockMcp {
  callTool: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
}

function makeMcp(overrides: Partial<MockMcp> = {}): MockMcp {
  return {
    callTool: vi.fn().mockResolvedValue({ results: [] }),
    isReady: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

describe("MempalaceMemoryRuntime", () => {
  let mcp: MockMcp;
  let runtime: MempalaceMemoryRuntime;
  const cfg = {} as never;

  beforeEach(() => {
    mcp = makeMcp();
    runtime = new MempalaceMemoryRuntime({ mcp: mcp as never, similarityThreshold: 0.25 });
  });

  describe("resolveMemoryBackendConfig", () => {
    it("always reports builtin backend", () => {
      const result = runtime.resolveMemoryBackendConfig({ cfg, agentId: "default" });
      expect(result).toEqual({ backend: "builtin" });
    });
  });

  describe("getMemorySearchManager", () => {
    it("returns a manager when MCP is ready", async () => {
      const result = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      expect(result.manager).not.toBeNull();
      expect(result.error).toBeUndefined();
    });

    it("returns error when MCP is not ready", async () => {
      mcp.isReady.mockReturnValue(false);
      const result = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      expect(result.manager).toBeNull();
      expect(result.error).toMatch(/mcp/i);
    });
  });

  describe("search manager", () => {
    it("proxies search() to mempalace_search and maps results", async () => {
      mcp.callTool.mockResolvedValueOnce({
        results: [
          {
            text: "Derek uses OpenClaw",
            wing: "tools",
            room: "openclaw",
            similarity: 0.82,
            source_file: "/home/derek/.mempalace/palace/tools/openclaw.md",
          },
        ],
      });
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const results = await manager!.search("openclaw", { maxResults: 3 });

      expect(mcp.callTool).toHaveBeenCalledWith(
        "mempalace_search",
        { query: "openclaw", limit: 3 },
        expect.any(Number),
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        path: "/home/derek/.mempalace/palace/tools/openclaw.md",
        score: 0.82,
        snippet: "Derek uses OpenClaw",
        source: "memory",
      });
      expect(results[0].startLine).toBe(1);
      expect(results[0].endLine).toBeGreaterThanOrEqual(1);
    });

    it("filters below similarity threshold", async () => {
      mcp.callTool.mockResolvedValueOnce({
        results: [
          { text: "high", wing: "w", room: "r", similarity: 0.5 },
          { text: "low", wing: "w", room: "r", similarity: 0.1 },
        ],
      });
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const results = await manager!.search("q");
      expect(results).toHaveLength(1);
      expect(results[0].snippet).toBe("high");
    });

    it("falls back to wing/room path when source_file is missing", async () => {
      mcp.callTool.mockResolvedValueOnce({
        results: [{ text: "hit", wing: "personal", room: "prefs", similarity: 0.6 }],
      });
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const results = await manager!.search("x");
      expect(results[0].path).toBe("personal/prefs");
    });

    it("status() returns builtin backend shape", async () => {
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const status = manager!.status();
      expect(status.backend).toBe("builtin");
      expect(status.provider).toBe("mempalace");
    });

    it("probeEmbeddingAvailability reflects MCP readiness", async () => {
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const okProbe = await manager!.probeEmbeddingAvailability();
      expect(okProbe.ok).toBe(true);

      mcp.isReady.mockReturnValue(false);
      const failProbe = await manager!.probeEmbeddingAvailability();
      expect(failProbe.ok).toBe(false);
      expect(failProbe.error).toBeTruthy();
    });

    it("probeVectorAvailability returns true (MemPalace uses FAISS)", async () => {
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      expect(await manager!.probeVectorAvailability()).toBe(true);
    });
  });

  describe("closeAllMemorySearchManagers", () => {
    it("is a no-op that resolves cleanly", async () => {
      await expect(runtime.closeAllMemorySearchManagers()).resolves.toBeUndefined();
    });
  });
});
