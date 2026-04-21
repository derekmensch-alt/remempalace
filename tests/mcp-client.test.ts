import { describe, it, expect, vi } from "vitest";
import { McpClient } from "../src/mcp-client.js";

describe("McpClient", () => {
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
});
