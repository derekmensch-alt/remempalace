import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock diary-local before importing diary so writeDiaryAsync picks up the mock
vi.mock("../src/diary-local.js", () => ({
  appendLocalDiary: vi.fn().mockResolvedValue(undefined),
}));

import { writeDiaryAsync } from "../src/diary.js";
import { appendLocalDiary } from "../src/diary-local.js";

describe("writeDiaryAsync fallback routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls appendLocalDiary when hasDiaryWrite is false", async () => {
    const mockMcp = {
      hasDiaryWrite: false,
      callTool: vi.fn(),
    };

    writeDiaryAsync(mockMcp, "local fallback summary");
    // Allow the microtask queue to drain
    await new Promise((r) => setTimeout(r, 20));

    expect(appendLocalDiary).toHaveBeenCalledOnce();
    const call = (appendLocalDiary as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.wing).toBe("remempalace");
    expect(call.room).toBe("session");
    expect(call.content).toBe("local fallback summary");
    expect(typeof call.ts).toBe("string");
    expect(mockMcp.callTool).not.toHaveBeenCalled();
  });

  it("calls mcp.callTool when hasDiaryWrite is true", async () => {
    const mockMcp = {
      hasDiaryWrite: true,
      callTool: vi.fn().mockResolvedValue(undefined),
    };

    writeDiaryAsync(mockMcp, "remote summary");
    await new Promise((r) => setTimeout(r, 20));

    expect(mockMcp.callTool).toHaveBeenCalledOnce();
    expect(mockMcp.callTool).toHaveBeenCalledWith("mempalace_diary_write", {
      wing: "remempalace",
      room: "session",
      content: "remote summary",
      added_by: "remempalace",
    });
    expect(appendLocalDiary).not.toHaveBeenCalled();
  });
});

describe("appendLocalDiary (real implementation)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diary-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSONL with correct fields to a date-named file", async () => {
    // Use importActual to bypass the vi.mock at the top of this file
    const { appendLocalDiary: realAppend } = await vi.importActual<typeof import("../src/diary-local.js")>(
      "../src/diary-local.js",
    );

    const ts = "2026-04-21T10:30:00.000Z";
    const entry = { wing: "remempalace", room: "session", content: "hello world", ts };

    // Pass tmpDir as baseDir to avoid writing to real ~/.mempalace
    await realAppend(entry, tmpDir);

    const filePath = join(tmpDir, ".mempalace", "palace", "diary", "2026-04-21.jsonl");
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.wing).toBe("remempalace");
    expect(parsed.room).toBe("session");
    expect(parsed.content).toBe("hello world");
    expect(parsed.ts).toBe(ts);
  });
});
