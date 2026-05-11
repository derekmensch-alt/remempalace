import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiaryReconciler, computeDiaryHealth } from "../src/diary-replay.js";
import { Metrics } from "../src/metrics.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "remempalace-diary-replay-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeJsonl(file: string, entries: Array<{ content: string; ts: string }>) {
  const lines = entries.map(
    (e) =>
      JSON.stringify({
        wing: "remempalace",
        room: "session",
        content: e.content,
        ts: e.ts,
      }) + "\n",
  );
  await writeFile(file, lines.join(""));
}

describe("DiaryReconciler.loadPending", () => {
  it("returns empty when diary directory does not exist", async () => {
    const r = new DiaryReconciler({ diaryDir: join(dir, "missing") });
    const pending = await r.loadPending();
    expect(pending).toEqual([]);
  });

  it("returns empty when there are no .jsonl files", async () => {
    await mkdir(dir, { recursive: true });
    const r = new DiaryReconciler({ diaryDir: dir });
    const pending = await r.loadPending();
    expect(pending).toEqual([]);
  });

  it("returns all entries when no .replayed sidecar exists", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [
      { content: "first", ts: "2026-04-22T01:00:00Z" },
      { content: "second", ts: "2026-04-22T02:00:00Z" },
    ]);
    const r = new DiaryReconciler({ diaryDir: dir });
    const pending = await r.loadPending();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ date: "2026-04-22", lineNo: 0 });
    expect(pending[0].entry.content).toBe("first");
    expect(pending[1]).toMatchObject({ date: "2026-04-22", lineNo: 1 });
  });

  it("filters out lines listed in the .replayed sidecar", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [
      { content: "first", ts: "2026-04-22T01:00:00Z" },
      { content: "second", ts: "2026-04-22T02:00:00Z" },
      { content: "third", ts: "2026-04-22T03:00:00Z" },
    ]);
    await writeFile(join(dir, "2026-04-22.replayed"), "0\n2\n");
    const r = new DiaryReconciler({ diaryDir: dir });
    const pending = await r.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].lineNo).toBe(1);
    expect(pending[0].entry.content).toBe("second");
  });

  it("walks multiple daily files in lexical order", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [{ content: "a", ts: "2026-04-22T01:00:00Z" }]);
    await writeJsonl(join(dir, "2026-04-23.jsonl"), [{ content: "b", ts: "2026-04-23T01:00:00Z" }]);
    const r = new DiaryReconciler({ diaryDir: dir });
    const pending = await r.loadPending();
    expect(pending).toHaveLength(2);
    expect(pending[0].date).toBe("2026-04-22");
    expect(pending[1].date).toBe("2026-04-23");
  });

  it("ignores blank lines and unparseable lines", async () => {
    await writeFile(
      join(dir, "2026-04-22.jsonl"),
      [
        JSON.stringify({ wing: "remempalace", room: "session", content: "ok", ts: "2026-04-22T01:00:00Z" }),
        "",
        "{not json",
        JSON.stringify({ wing: "remempalace", room: "session", content: "ok2", ts: "2026-04-22T02:00:00Z" }),
        "",
      ].join("\n"),
    );
    const r = new DiaryReconciler({ diaryDir: dir });
    const pending = await r.loadPending();
    expect(pending.map((p) => p.entry.content)).toEqual(["ok", "ok2"]);
    expect(pending[1].lineNo).toBe(3);
  });
});

describe("DiaryReconciler.replay", () => {
  it("calls mempalace_diary_write for every pending entry", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [
      { content: "a", ts: "2026-04-22T01:00:00Z" },
      { content: "b", ts: "2026-04-22T02:00:00Z" },
    ]);
    const writeDiary = vi.fn().mockResolvedValue({});
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
    });
    const result = await r.replay();
    expect(writeDiary).toHaveBeenCalledTimes(2);
    expect(writeDiary).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "remempalace", entry: "a", topic: "session" }),
    );
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("appends successful line numbers to the .replayed sidecar", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [
      { content: "a", ts: "2026-04-22T01:00:00Z" },
      { content: "b", ts: "2026-04-22T02:00:00Z" },
    ]);
    const writeDiary = vi.fn().mockResolvedValue({});
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
    });
    await r.replay();
    const sidecar = await readFile(join(dir, "2026-04-22.replayed"), "utf8");
    expect(sidecar.trim().split("\n").sort()).toEqual(["0", "1"]);
  });

  it("does not mark failed entries as replayed", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [
      { content: "a", ts: "2026-04-22T01:00:00Z" },
      { content: "b", ts: "2026-04-22T02:00:00Z" },
    ]);
    const writeDiary = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("boom"));
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
    });
    const result = await r.replay();
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    const sidecar = await readFile(join(dir, "2026-04-22.replayed"), "utf8");
    expect(sidecar.trim()).toBe("0");
  });

  it("freshly verifies persistence before replaying when a probe is available", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [{ content: "a", ts: "2026-04-22T01:00:00Z" }]);
    const writeDiary = vi.fn();
    const verifyDiaryPersistence = vi.fn().mockResolvedValue({
      state: "write-ok-unverified",
      verified: false,
      error: "probe read miss",
    });
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary, verifyDiaryPersistence },
    });

    const result = await r.replay();

    expect(verifyDiaryPersistence).toHaveBeenCalledOnce();
    expect(writeDiary).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: 0, succeeded: 0, failed: 0, skipped: true });
    expect(r.lastReplayError).toBe("probe read miss");
  });

  it("noop when repository canPersistDiary is false", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [{ content: "a", ts: "2026-04-22T01:00:00Z" }]);
    const writeDiary = vi.fn();
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: false, writeDiary },
    });
    const result = await r.replay();
    expect(writeDiary).not.toHaveBeenCalled();
    expect(result.attempted).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it("noop when mcp is undefined", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [{ content: "a", ts: "2026-04-22T01:00:00Z" }]);
    const r = new DiaryReconciler({ diaryDir: dir });
    const result = await r.replay();
    expect(result.skipped).toBe(true);
    expect(result.attempted).toBe(0);
  });

  it("records diary.replay.{attempted,succeeded,failed} metrics", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [
      { content: "a", ts: "2026-04-22T01:00:00Z" },
      { content: "b", ts: "2026-04-22T02:00:00Z" },
    ]);
    const writeDiary = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("x"));
    const metrics = new Metrics();
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
      metrics,
    });
    await r.replay();
    const snap = metrics.snapshot();
    expect(snap["diary.replay.attempted"]).toBe(2);
    expect(snap["diary.replay.succeeded"]).toBe(1);
    expect(snap["diary.replay.failed"]).toBe(1);
  });

  it("is idempotent — replaying twice does not double-write", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [
      { content: "a", ts: "2026-04-22T01:00:00Z" },
      { content: "b", ts: "2026-04-22T02:00:00Z" },
    ]);
    const writeDiary = vi.fn().mockResolvedValue({});
    const r1 = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
    });
    await r1.replay();
    expect(writeDiary).toHaveBeenCalledTimes(2);

    const r2 = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
    });
    const result2 = await r2.replay();
    expect(writeDiary).toHaveBeenCalledTimes(2);
    expect(result2.attempted).toBe(0);
  });

  it("captures lastReplayResult after run", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [{ content: "a", ts: "2026-04-22T01:00:00Z" }]);
    const writeDiary = vi.fn().mockResolvedValue({});
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
    });
    expect(r.lastReplayResult).toBeNull();
    await r.replay();
    expect(r.lastReplayResult).not.toBeNull();
    expect(r.lastReplayResult?.succeeded).toBe(1);
    expect(typeof r.lastReplayResult?.at).toBe("number");
  });

  it("captures lastReplayError when a write fails", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [{ content: "a", ts: "2026-04-22T01:00:00Z" }]);
    const writeDiary = vi.fn().mockRejectedValue(new Error("network timeout"));
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
    });
    expect(r.lastReplayError).toBeNull();
    await r.replay();
    expect(r.lastReplayError).toBe("network timeout");
  });

  it("throttles replay when called within minIntervalMs", async () => {
    await writeJsonl(join(dir, "2026-04-22.jsonl"), [{ content: "a", ts: "2026-04-22T01:00:00Z" }]);
    const writeDiary = vi.fn().mockResolvedValue({});
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
      minIntervalMs: 60_000,
    });
    const r1 = await r.replay();
    expect(writeDiary).toHaveBeenCalledTimes(1);
    expect(r1.attempted).toBe(1);

    // Second call within throttle window — should be skipped
    const r2 = await r.replay();
    expect(writeDiary).toHaveBeenCalledTimes(1);
    expect(r2.skipped).toBe(true);
    expect(r2.attempted).toBe(0);
  });

  it("deduplicates entries with the same id within a single replay pass", async () => {
    // Write two entries that share the same id (simulates duplicate writes)
    const entry = JSON.stringify({
      wing: "remempalace",
      room: "session",
      content: "dup content",
      ts: "2026-04-22T01:00:00Z",
      id: "deadbeef12345678",
    });
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(join(dir, "2026-04-22.jsonl"), entry + "\n" + entry + "\n"),
    );
    const writeDiary = vi.fn().mockResolvedValue({});
    const r = new DiaryReconciler({
      diaryDir: dir,
      repository: { canPersistDiary: true, writeDiary },
    });
    await r.replay();
    // Only one of the two duplicate entries should be sent
    expect(writeDiary).toHaveBeenCalledTimes(1);
  });
});

describe("computeDiaryHealth", () => {
  it("returns 'persistent' when diary persistence is verified and no pending fallback entries exist", () => {
    expect(computeDiaryHealth({ persistenceState: "persistent", pending: 0 })).toBe("persistent");
  });

  it("returns the capability state when persistence is not verified and no pending fallback entries exist", () => {
    expect(computeDiaryHealth({ persistenceState: "unavailable", pending: 0 })).toBe("unavailable");
    expect(computeDiaryHealth({ persistenceState: "tool-present", pending: 0 })).toBe("tool-present");
    expect(computeDiaryHealth({ persistenceState: "write-ok-unverified", pending: 0 })).toBe(
      "write-ok-unverified",
    );
  });

  it("returns 'fallback-active' when JSONL has unreplayed entries", () => {
    expect(computeDiaryHealth({ persistenceState: "persistent", pending: 5 })).toBe("fallback-active");
    expect(computeDiaryHealth({ persistenceState: "write-ok-unverified", pending: 5 })).toBe(
      "fallback-active",
    );
  });

  it("returns 'degraded' when last replay attempt had failures", () => {
    expect(
      computeDiaryHealth({
        persistenceState: "persistent",
        pending: 5,
        lastReplay: { attempted: 5, succeeded: 0, failed: 5, at: Date.now() },
      }),
    ).toBe("degraded");
  });
});
