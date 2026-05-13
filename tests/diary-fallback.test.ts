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
import { DiaryService } from "../src/services/diary-service.js";

describe("writeDiaryAsync fallback routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls appendLocalDiary when canPersistDiary is false", async () => {
    const repository = {
      canPersistDiary: false,
      writeDiary: vi.fn(),
    };

    await writeDiaryAsync(repository, "local fallback summary");

    expect(appendLocalDiary).toHaveBeenCalledOnce();
    const call = (appendLocalDiary as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.wing).toBe("remempalace");
    expect(call.room).toBe("session");
    expect(call.content).toBe("local fallback summary");
    expect(typeof call.ts).toBe("string");
    expect(repository.writeDiary).not.toHaveBeenCalled();
  });

  it("calls repository.writeDiary when canPersistDiary is true", async () => {
    const repository = {
      canPersistDiary: true,
      writeDiary: vi.fn().mockResolvedValue(undefined),
    };

    await writeDiaryAsync(repository, "remote summary");

    expect(repository.writeDiary).toHaveBeenCalledOnce();
    expect(repository.writeDiary).toHaveBeenCalledWith({
      agentName: "remempalace",
      entry: "remote summary",
      topic: "session",
      timeoutMs: 500,
    });
    expect(appendLocalDiary).not.toHaveBeenCalled();
  });

  it("passes localDir from options as diaryDir to appendLocalDiary", async () => {
    const repository = {
      canPersistDiary: false,
      writeDiary: vi.fn(),
    };

    await writeDiaryAsync(repository, "summary", undefined, { localDir: "/custom/diary/path" });

    expect(appendLocalDiary).toHaveBeenCalledOnce();
    const call = (appendLocalDiary as ReturnType<typeof vi.fn>).mock.calls[0];
    // Third argument is diaryDir
    expect(call[2]).toBe("/custom/diary/path");
  });
});

describe("DiaryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses local JSONL when persistence is not verified", async () => {
    const repository = {
      canPersistDiary: false,
      writeDiary: vi.fn(),
    };
    const service = new DiaryService({
      repository,
      now: () => new Date("2026-05-11T00:00:00.000Z"),
    });

    await service.writeSessionSummaryAsync("summary");

    expect(repository.writeDiary).not.toHaveBeenCalled();
    expect(appendLocalDiary).toHaveBeenCalledWith(
      {
        wing: "remempalace",
        room: "session",
        content: "summary",
        ts: "2026-05-11T00:00:00.000Z",
      },
      undefined,
      undefined,
    );
  });

  it("uses repository writes when persistence is verified", async () => {
    const repository = {
      canPersistDiary: true,
      writeDiary: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DiaryService({ repository });

    await service.writeSessionSummaryAsync("summary");

    expect(repository.writeDiary).toHaveBeenCalledWith({
      agentName: "remempalace",
      entry: "summary",
      topic: "session",
      timeoutMs: 500,
    });
    expect(appendLocalDiary).not.toHaveBeenCalled();
  });

  it("verifies persistence and replays fallback entries only when persistence is verified", async () => {
    let persistent = false;
    const repository = {
      get canPersistDiary() {
        return persistent;
      },
      writeDiary: vi.fn(),
      verifyDiaryPersistence: vi.fn().mockImplementation(async () => {
        persistent = true;
        return { state: "persistent", verified: true };
      }),
    };
    const replay = vi.fn().mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0, at: 0 });
    const onReplayResult = vi.fn();
    const onProbeResult = vi.fn();
    const service = new DiaryService({ repository });

    const probe = await service.verifyPersistenceAndReplay({
      replayOnStart: true,
      reconciler: { replay },
      onReplayResult,
      onProbeResult,
    });
    await new Promise((r) => setImmediate(r));

    expect(probe).toEqual({ state: "persistent", verified: true });
    expect(repository.verifyDiaryPersistence).toHaveBeenCalledWith({ timeoutMs: 500 });
    expect(onProbeResult).toHaveBeenCalledWith({ state: "persistent", verified: true });
    expect(replay).toHaveBeenCalledOnce();
    expect(onReplayResult).toHaveBeenCalledWith({ attempted: 1, succeeded: 1, failed: 0, at: 0 });
  });

  it("does not replay fallback entries when persistence remains unverified", async () => {
    const repository = {
      canPersistDiary: false,
      writeDiary: vi.fn(),
      verifyDiaryPersistence: vi.fn().mockResolvedValue({
        state: "write-ok-unverified",
        verified: false,
      }),
    };
    const replay = vi.fn();
    const service = new DiaryService({ repository });

    const probe = await service.verifyPersistenceAndReplay({
      replayOnStart: true,
      reconciler: { replay },
    });

    expect(probe).toEqual({ state: "write-ok-unverified", verified: false });
    expect(replay).not.toHaveBeenCalled();
  });

  it("builds diary status from persistence state and pending fallback entries", async () => {
    const repository = {
      canPersistDiary: false,
      diaryPersistenceState: "write-ok-unverified" as const,
      writeDiary: vi.fn(),
    };
    const service = new DiaryService({ repository });

    const status = await service.getStatus({
      reconciler: {
        loadPending: vi.fn().mockResolvedValue([{ lineNo: 0 }]),
        lastReplayResult: null,
        lastReplayError: null,
      },
    });

    expect(status).toEqual({
      state: "fallback-active",
      persistenceState: "write-ok-unverified",
      pending: 1,
      lastReplay: null,
      lastReplayError: null,
    });
  });

  it("reports unverified probe results without replaying", async () => {
    const repository = {
      canPersistDiary: false,
      writeDiary: vi.fn(),
      verifyDiaryPersistence: vi.fn().mockResolvedValue({
        state: "write-ok-unverified",
        verified: false,
        error: "read miss",
      }),
    };
    const replay = vi.fn();
    const onProbeResult = vi.fn();
    const service = new DiaryService({ repository });

    await service.verifyPersistenceAndReplay({
      replayOnStart: true,
      reconciler: { replay },
      onProbeResult,
    });

    expect(onProbeResult).toHaveBeenCalledWith({
      state: "write-ok-unverified",
      verified: false,
      error: "read miss",
    });
    expect(replay).not.toHaveBeenCalled();
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
