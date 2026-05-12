import { describe, expect, it, vi } from "vitest";
import { McpMemPalaceRepository } from "../src/adapters/mcp-mempalace-repository.js";
import {
  BackendUnavailable,
  CapabilityMissing,
  ToolFailed,
} from "../src/ports/mempalace-repository.js";

function makeMcp(overrides: {
  hasDiaryWrite?: boolean;
  hasDiaryRead?: boolean;
  hasKgInvalidate?: boolean;
  callTool?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    hasDiaryWrite: true,
    hasDiaryRead: true,
    hasKgInvalidate: true,
    callTool: vi.fn(),
    ...overrides,
  };
}

describe("McpMemPalaceRepository", () => {
  it("maps palace status to the current MemPalace MCP schema", async () => {
    const callTool = vi.fn().mockResolvedValue({
      total_drawers: 1,
      wings: {},
      rooms: {},
      palace_path: "/tmp/palace",
    });
    const repository = new McpMemPalaceRepository(makeMcp({ callTool }));

    const status = await repository.getPalaceStatus();

    expect(callTool).toHaveBeenCalledWith("mempalace_status", {});
    expect(status.palace_path).toBe("/tmp/palace");
  });

  it("maps memory search to the current MemPalace MCP schema", async () => {
    const callTool = vi.fn().mockResolvedValue({
      results: [{ text: "hit", wing: "w", room: "r", similarity: 0.8 }],
    });
    const repository = new McpMemPalaceRepository(makeMcp({ callTool }));

    const results = await repository.searchMemory({ query: "openclaw", limit: 3 });

    expect(callTool).toHaveBeenCalledWith("mempalace_search", {
      query: "openclaw",
      limit: 3,
    });
    expect(results).toEqual([{ text: "hit", wing: "w", room: "r", similarity: 0.8 }]);
  });

  it("passes memory search timeout through the adapter without exposing raw MCP schemas", async () => {
    const callTool = vi.fn().mockResolvedValue({ results: [] });
    const repository = new McpMemPalaceRepository(makeMcp({ callTool }));

    await repository.searchMemory({ query: "openclaw", limit: 3, timeoutMs: 500 });

    expect(callTool).toHaveBeenCalledWith(
      "mempalace_search",
      {
        query: "openclaw",
        limit: 3,
      },
      500,
    );
  });

  it("maps KG timeline reads to the current MemPalace MCP schema", async () => {
    const callTool = vi.fn().mockResolvedValue([{ date: "2026-04-15", fact: "completed X" }]);
    const repository = new McpMemPalaceRepository(makeMcp({ callTool }));

    const events = await repository.readKgTimeline({ daysBack: 7 });

    expect(callTool).toHaveBeenCalledWith("mempalace_kg_timeline", {
      days_back: 7,
    });
    expect(events).toEqual([{ date: "2026-04-15", fact: "completed X" }]);
  });

  it("maps KG entity queries to the current MemPalace MCP schema", async () => {
    const callTool = vi.fn().mockResolvedValue({
      facts: [{ subject: "Derek", predicate: "uses", object: "OpenClaw" }],
    });
    const repository = new McpMemPalaceRepository(makeMcp({ callTool }));

    const result = await repository.queryKgEntity({ entity: "Derek" });

    expect(callTool).toHaveBeenCalledWith("mempalace_kg_query", {
      entity: "Derek",
    });
    expect(result).toEqual({
      facts: [{ subject: "Derek", predicate: "uses", object: "OpenClaw" }],
    });
  });

  it("passes KG entity query timeout through the adapter without exposing raw MCP schemas", async () => {
    const callTool = vi.fn().mockResolvedValue({ facts: [] });
    const repository = new McpMemPalaceRepository(makeMcp({ callTool }));

    await repository.queryKgEntity({ entity: "Derek", timeoutMs: 500 });

    expect(callTool).toHaveBeenCalledWith(
      "mempalace_kg_query",
      {
        entity: "Derek",
      },
      500,
    );
  });

  it("maps KG fact adds to the current MemPalace MCP schema", async () => {
    const callTool = vi.fn().mockResolvedValue({ success: true });
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool,
    });

    await repository.addKgFact({
      subject: "Derek",
      predicate: "uses",
      object: "OpenClaw",
      valid_from: "2026-05-11",
      source_closet: "openclaw:user",
    });

    expect(callTool).toHaveBeenCalledWith("mempalace_kg_add", {
      subject: "Derek",
      predicate: "uses",
      object: "OpenClaw",
      valid_from: "2026-05-11",
      source_closet: "openclaw:user",
    });
  });

  it("maps KG invalidation to the current MemPalace MCP schema", async () => {
    const callTool = vi.fn().mockResolvedValue({ success: true });
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool,
    });

    await repository.invalidateKgFact({
      subject: "Derek",
      predicate: "favorite_model",
      object: "Kimi K2.5",
    });

    expect(callTool).toHaveBeenCalledWith("mempalace_kg_invalidate", {
      subject: "Derek",
      predicate: "favorite_model",
      object: "Kimi K2.5",
    });
  });

  it("maps diary writes to the current MemPalace MCP schema", async () => {
    const callTool = vi.fn().mockResolvedValue({ success: true });
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool,
    });

    await repository.writeDiary({
      agentName: "remempalace",
      entry: "session summary",
      topic: "session",
      wing: "openclaw",
    });

    expect(callTool).toHaveBeenCalledWith("mempalace_diary_write", {
      agent_name: "remempalace",
      entry: "session summary",
      topic: "session",
      wing: "openclaw",
    });
  });

  it("passes diary write timeout through the adapter without exposing raw MCP schemas", async () => {
    const callTool = vi.fn().mockResolvedValue({ success: true });
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool,
    });

    await repository.writeDiary({
      agentName: "remempalace",
      entry: "session summary",
      topic: "session",
      timeoutMs: 500,
    });

    expect(callTool).toHaveBeenCalledWith(
      "mempalace_diary_write",
      {
        agent_name: "remempalace",
        entry: "session summary",
        topic: "session",
      },
      500,
    );
  });

  it("maps diary reads to the current MemPalace MCP schema", async () => {
    const callTool = vi.fn().mockResolvedValue({ entries: [] });
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool,
    });

    await repository.readDiary({
      agentName: "remempalace",
      lastN: 5,
      topic: "session",
    });

    expect(callTool).toHaveBeenCalledWith("mempalace_diary_read", {
      agent_name: "remempalace",
      last_n: 5,
      topic: "session",
    });
  });

  it("passes diary read timeout through the adapter without exposing raw MCP schemas", async () => {
    const callTool = vi.fn().mockResolvedValue({ entries: [] });
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool,
    });

    await repository.readDiary({
      agentName: "remempalace",
      lastN: 5,
      timeoutMs: 500,
    });

    expect(callTool).toHaveBeenCalledWith(
      "mempalace_diary_read",
      {
        agent_name: "remempalace",
        last_n: 5,
      },
      500,
    );
  });

  it("exposes diary capabilities from the wrapped MCP client", () => {
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: false,
      hasDiaryRead: true,
      callTool: vi.fn(),
    });

    expect(repository.canWriteDiary).toBe(false);
    expect(repository.canReadDiary).toBe(true);
    expect(repository.canPersistDiary).toBe(false);
    expect(repository.diaryPersistenceState).toBe("unavailable");
  });

  it("throws CapabilityMissing when diary write tool is absent", async () => {
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: false,
      hasDiaryRead: true,
      callTool: vi.fn(),
    });

    await expect(
      repository.writeDiary({
        agentName: "remempalace",
        entry: "summary",
        topic: "session",
      }),
    ).rejects.toBeInstanceOf(CapabilityMissing);
  });

  it("maps MCP tool errors to ToolFailed", async () => {
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool: vi.fn().mockRejectedValue(new Error("Internal tool error")),
    });

    await expect(
      repository.writeDiary({
        agentName: "remempalace",
        entry: "summary",
        topic: "session",
      }),
    ).rejects.toBeInstanceOf(ToolFailed);
  });

  it("maps memory search MCP failures to ToolFailed", async () => {
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool: vi.fn().mockRejectedValue(new Error("Internal tool error")),
    });

    await expect(repository.searchMemory({ query: "x", limit: 1 })).rejects.toBeInstanceOf(
      ToolFailed,
    );
  });

  it("maps backend availability errors to BackendUnavailable", async () => {
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool: vi.fn().mockRejectedValue(new Error("MCP process died")),
    });

    await expect(
      repository.readDiary({
        agentName: "remempalace",
        lastN: 5,
      }),
    ).rejects.toBeInstanceOf(BackendUnavailable);
  });

  it("verifies diary persistence by writing and reading back a probe entry", async () => {
    let probeEntry = "";
    const callTool = vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "mempalace_diary_write") {
        probeEntry = String(args.entry);
        return Promise.resolve({ success: true });
      }
      if (name === "mempalace_diary_read") {
        return Promise.resolve({ entries: [{ content: probeEntry, topic: "health-probe" }] });
      }
      return Promise.resolve({});
    });
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool,
    });

    const result = await repository.verifyDiaryPersistence();

    expect(result).toEqual({ state: "persistent", verified: true });
    expect(callTool).toHaveBeenCalledWith(
      "mempalace_diary_write",
      expect.objectContaining({ agent_name: "remempalace-health", topic: "health-probe" }),
      500,
    );
    expect(callTool).toHaveBeenCalledWith(
      "mempalace_diary_read",
      expect.objectContaining({ agent_name: "remempalace-health", topic: "health-probe", last_n: 20 }),
      500,
    );
    expect(repository.canPersistDiary).toBe(true);
    expect(repository.diaryPersistenceState).toBe("persistent");
  });

  it("distinguishes write success from verified persistence when read misses the probe", async () => {
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool: vi.fn().mockImplementation((name: string) => {
        if (name === "mempalace_diary_write") return Promise.resolve({ success: true });
        if (name === "mempalace_diary_read") return Promise.resolve({ entries: [] });
        return Promise.resolve({});
      }),
    });

    const result = await repository.verifyDiaryPersistence();

    expect(result).toEqual({
      state: "write-ok-unverified",
      verified: false,
      error: "MemPalace diary write could not be verified as persistent",
    });
    expect(repository.canPersistDiary).toBe(false);
    expect(repository.diaryPersistenceState).toBe("write-ok-unverified");
  });

  it("uses caller-provided timeout for persistence probe write/read", async () => {
    let probeEntry = "";
    const callTool = vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "mempalace_diary_write") {
        probeEntry = String(args.entry);
        return Promise.resolve({ success: true });
      }
      if (name === "mempalace_diary_read") {
        return Promise.resolve({ entries: [{ content: probeEntry, topic: "health-probe" }] });
      }
      return Promise.resolve({});
    });
    const repository = new McpMemPalaceRepository({
      hasDiaryWrite: true,
      hasDiaryRead: true,
      callTool,
    });

    await repository.verifyDiaryPersistence({ timeoutMs: 250 });

    expect(callTool).toHaveBeenCalledWith(
      "mempalace_diary_write",
      expect.objectContaining({ agent_name: "remempalace-health", topic: "health-probe" }),
      250,
    );
    expect(callTool).toHaveBeenCalledWith(
      "mempalace_diary_read",
      expect.objectContaining({ agent_name: "remempalace-health", topic: "health-probe", last_n: 20 }),
      250,
    );
  });
});
