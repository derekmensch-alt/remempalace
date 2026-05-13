import { describe, it, expect, vi, afterEach } from "vitest";
import { McpClient } from "../src/mcp-client.js";
import type { McpResponse } from "../src/mcp-client.js";

describe("McpClient", () => {
  afterEach(async () => {
    await McpClient.resetSharedForTests();
    vi.restoreAllMocks();
  });

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

  it("reuses one shared client for the same python binary", () => {
    const first = McpClient.shared({ pythonBin: "/usr/bin/python3" });
    const second = McpClient.shared({ pythonBin: "/usr/bin/python3" });
    const other = McpClient.shared({ pythonBin: "/opt/mempalace/python" });

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("coalesces concurrent start calls", async () => {
    const client = new McpClient({ pythonBin: "/usr/bin/python3" });
    const rawClient = client as unknown as {
      pm: { start: ReturnType<typeof vi.fn>; isAlive: ReturnType<typeof vi.fn> };
      initialize: ReturnType<typeof vi.fn>;
    };
    rawClient.pm = {
      start: vi.fn().mockResolvedValue(undefined),
      isAlive: vi.fn().mockReturnValue(false),
    };
    rawClient.initialize = vi.fn().mockImplementation(async () => {
      rawClient.pm.isAlive.mockReturnValue(true);
    });

    await Promise.all([client.start(), client.start(), client.start()]);

    expect(rawClient.pm.start).toHaveBeenCalledTimes(1);
    expect(rawClient.initialize).toHaveBeenCalledTimes(1);
  });

  it("rejects pending calls immediately when stopped", async () => {
    const client = new McpClient({ pythonBin: "/usr/bin/python3" });
    const rawClient = client as unknown as {
      pm: { stop: ReturnType<typeof vi.fn> };
      pending: Map<number, unknown>;
    };
    rawClient.pm = { stop: vi.fn().mockResolvedValue(undefined) };

    const pending = client.expect(99, 10000);
    await client.stop();

    await expect(pending).rejects.toThrow("MCP process died");
    expect(rawClient.pending.size).toBe(0);
  });

  it("clears pending calls when writeStdin throws before the request is sent", async () => {
    const client = new McpClient({ pythonBin: "/usr/bin/python3" });
    const rawClient = client as unknown as {
      pm: { writeStdin: ReturnType<typeof vi.fn> };
      pending: Map<number, unknown>;
    };
    rawClient.pm = {
      writeStdin: vi.fn().mockImplementation(() => {
        throw new Error("stdin closed");
      }),
    };

    await expect(client.call("tools/list", {}, 10000)).rejects.toThrow("stdin closed");
    expect(rawClient.pending.size).toBe(0);
  });
});

describe("probeCapabilities", () => {
  function makeClient(): McpClient {
    return new McpClient({ pythonBin: "/usr/bin/python3" });
  }

  function mockToolsListResponse(tools: Array<{ name?: unknown }>): McpResponse {
    return { jsonrpc: "2.0", id: 1, result: { tools } };
  }

  afterEach(async () => {
    await McpClient.resetSharedForTests();
    vi.restoreAllMocks();
  });

  it("calls tools/list and NEVER invokes mempalace_diary_write", async () => {
    // Regression test for the old destructive probe that wrote "probe" entries
    // to the real diary on every plugin startup.
    const client = makeClient();
    const spy = vi
      .spyOn(client, "call")
      .mockResolvedValue(mockToolsListResponse([{ name: "mempalace_diary_read" }]));

    await client.probeCapabilities();

    expect(spy).toHaveBeenCalledWith("tools/list", {});
    // Must not have attempted a tools/call for any mempalace_diary_write
    const destructiveCalls = spy.mock.calls.filter(([method, params]) => {
      if (method !== "tools/call") return false;
      const name = (params as { name?: string } | undefined)?.name;
      return name === "mempalace_diary_write" || name === "mempalace_kg_invalidate";
    });
    expect(destructiveCalls).toHaveLength(0);
  });

  it("sets hasDiaryWrite and hasDiaryRead true when both listed; hasKgInvalidate false when absent", async () => {
    const client = makeClient();
    vi.spyOn(client, "call").mockResolvedValue(
      mockToolsListResponse([
        { name: "mempalace_diary_write" },
        { name: "mempalace_diary_read" },
        { name: "mempalace_search" },
      ]),
    );

    await client.probeCapabilities();

    expect(client.hasDiaryWrite).toBe(true);
    expect(client.hasDiaryRead).toBe(true);
    expect(client.hasKgInvalidate).toBe(false);
  });

  it("sets all flags false when the tool list is empty", async () => {
    const client = makeClient();
    vi.spyOn(client, "call").mockResolvedValue(mockToolsListResponse([]));

    await client.probeCapabilities();

    expect(client.hasDiaryWrite).toBe(false);
    expect(client.hasDiaryRead).toBe(false);
    expect(client.hasKgInvalidate).toBe(false);
  });

  it("sets hasKgInvalidate true when mempalace_kg_invalidate is listed", async () => {
    const client = makeClient();
    vi.spyOn(client, "call").mockResolvedValue(
      mockToolsListResponse([{ name: "mempalace_kg_invalidate" }]),
    );

    await client.probeCapabilities();

    expect(client.hasKgInvalidate).toBe(true);
    expect(client.hasDiaryWrite).toBe(false);
    expect(client.hasDiaryRead).toBe(false);
  });

  it("handles missing tools field gracefully (result: {})", async () => {
    const client = makeClient();
    vi.spyOn(client, "call").mockResolvedValue({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(client.probeCapabilities()).resolves.toBeUndefined();
    expect(client.hasDiaryWrite).toBe(false);
    expect(client.hasDiaryRead).toBe(false);
    expect(client.hasKgInvalidate).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/tools\/list returned unexpected shape/i));
  });

  it("does not throw and defaults flags to false when tools/list call rejects", async () => {
    const client = makeClient();
    vi.spyOn(client, "call").mockRejectedValue(new Error("mcp down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Prime flags to true so we can observe them being reset on failure
    client.hasDiaryWrite = true;
    client.hasDiaryRead = true;
    client.hasKgInvalidate = true;

    await expect(client.probeCapabilities()).resolves.toBeUndefined();

    expect(client.hasDiaryWrite).toBe(false);
    expect(client.hasDiaryRead).toBe(false);
    expect(client.hasKgInvalidate).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("ignores entries with non-string names", async () => {
    const client = makeClient();
    vi.spyOn(client, "call").mockResolvedValue(
      mockToolsListResponse([
        { name: 123 },
        { name: null },
        { name: undefined },
        { name: "mempalace_diary_read" },
      ]),
    );

    await client.probeCapabilities();

    expect(client.hasDiaryRead).toBe(true);
    expect(client.hasDiaryWrite).toBe(false);
    expect(client.hasKgInvalidate).toBe(false);
  });
});
