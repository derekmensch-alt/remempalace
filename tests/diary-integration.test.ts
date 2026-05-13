import { describe, it, expect } from "vitest";
import { McpClient } from "../src/mcp-client.js";

const pythonBin = process.env.REMEMPALACE_TEST_PY;
const describeIntegration = pythonBin ? describe : describe.skip;

interface DiaryWriteResult {
  success?: boolean;
  entry_id?: string;
  agent?: string;
  topic?: string;
  timestamp?: string;
  error?: string;
}

interface DiaryReadResult {
  agent?: string;
  entries?: Array<{ content?: string; topic?: string; timestamp?: string }>;
  message?: string;
  error?: string;
}

describeIntegration("MemPalace diary MCP integration", () => {
  it("lists the current diary tools", async () => {
    const client = new McpClient({ pythonBin: pythonBin! });
    try {
      await client.start();
      const resp = await client.call("tools/list", {}, 10_000);
      const names = ((resp.result as { tools?: Array<{ name?: string }> })?.tools ?? []).map((t) => t.name);

      expect(names).toContain("mempalace_diary_write");
      expect(names).toContain("mempalace_diary_read");
    } finally {
      await client.stop().catch(() => {});
    }
  });

  it("accepts the current diary_write schema", async () => {
    const client = new McpClient({ pythonBin: pythonBin! });
    const stamp = `remempalace integration write schema probe ${Date.now()}`;

    try {
      await client.start();
      const write = await client.callTool<DiaryWriteResult>(
        "mempalace_diary_write",
        {
          agent_name: "remempalace-integration",
          entry: stamp,
          topic: "integration-test",
        },
        10_000,
      );

      expect(write.success).toBe(true);
      expect(write.entry_id).toEqual(expect.stringContaining("diary_"));
      expect(write.agent).toBe("remempalace-integration");
      expect(write.topic).toBe("integration-test");
    } finally {
      await client.stop().catch(() => {});
    }
  });

  it("persists diary writes so a later diary_read can see them", async () => {
    const client = new McpClient({ pythonBin: pythonBin! });
    const agentName = "remempalace-integration";
    const stamp = `remempalace integration persistence probe ${Date.now()}`;

    try {
      await client.start();
      const write = await client.callTool<DiaryWriteResult>(
        "mempalace_diary_write",
        {
          agent_name: agentName,
          entry: stamp,
          topic: "integration-test",
        },
        10_000,
      );
      expect(write.success).toBe(true);

      const read = await client.callTool<DiaryReadResult>(
        "mempalace_diary_read",
        {
          agent_name: agentName,
          last_n: 10,
        },
        10_000,
      );

      expect(read.error).toBeUndefined();
      expect(read.entries ?? []).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: stamp, topic: "integration-test" })]),
      );
    } finally {
      await client.stop().catch(() => {});
    }
  });

  it("documents that the legacy diary_write schema is rejected", async () => {
    const client = new McpClient({ pythonBin: pythonBin! });

    try {
      await client.start();
      await expect(
        client.callTool(
          "mempalace_diary_write",
          {
            wing: "remempalace",
            room: "session",
            content: "legacy schema probe",
            added_by: "remempalace",
          },
          10_000,
        ),
      ).rejects.toThrow(/Internal tool error|agent_name|entry/i);
    } finally {
      await client.stop().catch(() => {});
    }
  });
});
