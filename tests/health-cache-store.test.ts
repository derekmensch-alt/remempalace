import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  loadHealthCache,
  saveHealthCache,
  buildHealthSnapshot,
  HEALTH_CACHE_STALE_MS,
  type HealthCacheSnapshot,
} from "../src/services/health-cache-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpPath(): string {
  return join(tmpdir(), `remempalace-health-test-${randomBytes(6).toString("hex")}.json`);
}

function makeSnapshot(overrides: Partial<HealthCacheSnapshot> = {}): HealthCacheSnapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    mcpReady: true,
    capabilities: {
      canWriteDiary: true,
      canReadDiary: true,
      canInvalidateKg: true,
      canPersistDiary: true,
    },
    diaryPersistenceState: "persistent",
    lastProbeAt: Date.now() - 1000,
    lastProbeReason: "verified: persistent",
    lastReplay: { attempted: 3, succeeded: 3, failed: 0, at: Date.now() - 2000 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Write → read round-trip
// ---------------------------------------------------------------------------

describe("saveHealthCache / loadHealthCache round-trip", () => {
  it("persists and restores all snapshot fields", async () => {
    const path = tmpPath();
    const snapshot = makeSnapshot();
    await saveHealthCache(path, snapshot);
    const loaded = await loadHealthCache(path);
    expect(loaded).not.toBeNull();
    const s = loaded!.snapshot;
    expect(s.version).toBe(1);
    expect(s.mcpReady).toBe(true);
    expect(s.diaryPersistenceState).toBe("persistent");
    expect(s.capabilities.canWriteDiary).toBe(true);
    expect(s.capabilities.canReadDiary).toBe(true);
    expect(s.capabilities.canInvalidateKg).toBe(true);
    expect(s.capabilities.canPersistDiary).toBe(true);
    expect(s.lastProbeReason).toBe("verified: persistent");
    expect(s.lastReplay).not.toBeNull();
    expect(s.lastReplay!.attempted).toBe(3);
    expect(s.lastReplay!.succeeded).toBe(3);
    expect(s.lastReplay!.failed).toBe(0);
    await fs.unlink(path).catch(() => {});
  });

  it("round-trips a snapshot with null replay and null probe fields", async () => {
    const path = tmpPath();
    const snapshot = makeSnapshot({ lastReplay: null, lastProbeAt: null, lastProbeReason: null });
    await saveHealthCache(path, snapshot);
    const loaded = await loadHealthCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.snapshot.lastReplay).toBeNull();
    expect(loaded!.snapshot.lastProbeAt).toBeNull();
    expect(loaded!.snapshot.lastProbeReason).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("creates parent directory if it does not exist", async () => {
    const dir = join(tmpdir(), `remempalace-health-dir-${randomBytes(4).toString("hex")}`);
    const path = join(dir, "nested", "health-cache.json");
    await saveHealthCache(path, makeSnapshot());
    const stat = await fs.stat(path);
    expect(stat.isFile()).toBe(true);
    await fs.rm(dir, { recursive: true }).catch(() => {});
  });

  it("writes atomically — existing file survives if rename fails", async () => {
    const path = tmpPath();
    const original = makeSnapshot({ diaryPersistenceState: "persistent" });
    await saveHealthCache(path, original);

    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("ENOSPC: no space left"));
    await expect(
      saveHealthCache(path, makeSnapshot({ diaryPersistenceState: "unavailable" })),
    ).rejects.toThrow("ENOSPC");

    const loaded = await loadHealthCache(path);
    expect(loaded!.snapshot.diaryPersistenceState).toBe("persistent");
    vi.restoreAllMocks();
    await fs.unlink(path).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// 2. Malformed / wrong version / missing fields → null
// ---------------------------------------------------------------------------

describe("loadHealthCache — invalid input", () => {
  it("returns null for missing file", async () => {
    const path = join(tmpdir(), `no-such-health-${randomBytes(4).toString("hex")}.json`);
    expect(await loadHealthCache(path)).toBeNull();
  });

  it("returns null for truncated JSON", async () => {
    const path = tmpPath();
    await fs.writeFile(path, '{"version":1,"savedAt":12345,"mcpReady":true,broken');
    expect(await loadHealthCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("returns null for wrong version number", async () => {
    const path = tmpPath();
    await fs.writeFile(
      path,
      JSON.stringify({ version: 2, savedAt: Date.now(), mcpReady: true }),
    );
    expect(await loadHealthCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("returns null for a JSON array (not an object)", async () => {
    const path = tmpPath();
    await fs.writeFile(path, JSON.stringify([1, 2, 3]));
    expect(await loadHealthCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("returns null when mcpReady field is missing", async () => {
    const path = tmpPath();
    const raw = {
      version: 1,
      savedAt: Date.now(),
      // mcpReady intentionally omitted
      capabilities: { canWriteDiary: true, canReadDiary: true, canInvalidateKg: false, canPersistDiary: false },
      diaryPersistenceState: "unavailable",
      lastProbeAt: null,
      lastProbeReason: null,
      lastReplay: null,
    };
    await fs.writeFile(path, JSON.stringify(raw));
    expect(await loadHealthCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("returns null when capabilities field is missing", async () => {
    const path = tmpPath();
    const raw = {
      version: 1,
      savedAt: Date.now(),
      mcpReady: false,
      // capabilities intentionally omitted
      diaryPersistenceState: "unavailable",
      lastProbeAt: null,
      lastProbeReason: null,
      lastReplay: null,
    };
    await fs.writeFile(path, JSON.stringify(raw));
    expect(await loadHealthCache(path)).toBeNull();
    await fs.unlink(path).catch(() => {});
  });

  it("silently drops a malformed lastReplay sub-object and returns null for it", async () => {
    const path = tmpPath();
    const raw = {
      ...makeSnapshot(),
      lastReplay: { attempted: "not-a-number", succeeded: 1, failed: 0, at: Date.now() },
    };
    await fs.writeFile(path, JSON.stringify(raw));
    const loaded = await loadHealthCache(path);
    // Snapshot still loads; malformed lastReplay is coerced to null
    expect(loaded).not.toBeNull();
    expect(loaded!.snapshot.lastReplay).toBeNull();
    await fs.unlink(path).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// 3. Stale TTL flagging
// ---------------------------------------------------------------------------

describe("loadHealthCache — stale flag", () => {
  it("marks snapshot as stale when savedAt is older than HEALTH_CACHE_STALE_MS", async () => {
    const path = tmpPath();
    const snapshot = makeSnapshot({ savedAt: Date.now() - HEALTH_CACHE_STALE_MS - 1000 });
    await saveHealthCache(path, snapshot);
    const loaded = await loadHealthCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.stale).toBe(true);
    await fs.unlink(path).catch(() => {});
  });

  it("marks snapshot as fresh when savedAt is within HEALTH_CACHE_STALE_MS", async () => {
    const path = tmpPath();
    const snapshot = makeSnapshot({ savedAt: Date.now() - 1000 });
    await saveHealthCache(path, snapshot);
    const loaded = await loadHealthCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.stale).toBe(false);
    await fs.unlink(path).catch(() => {});
  });

  it("HEALTH_CACHE_STALE_MS is 10 minutes", () => {
    expect(HEALTH_CACHE_STALE_MS).toBe(10 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 4. buildHealthSnapshot helper
// ---------------------------------------------------------------------------

describe("buildHealthSnapshot", () => {
  it("builds a version-1 snapshot with current savedAt", () => {
    const before = Date.now();
    const snap = buildHealthSnapshot({
      mcpReady: true,
      capabilities: {
        canWriteDiary: true,
        canReadDiary: false,
        canInvalidateKg: false,
        canPersistDiary: true,
      },
      diaryPersistenceState: "write-ok-unverified",
    });
    const after = Date.now();
    expect(snap.version).toBe(1);
    expect(snap.savedAt).toBeGreaterThanOrEqual(before);
    expect(snap.savedAt).toBeLessThanOrEqual(after);
    expect(snap.mcpReady).toBe(true);
    expect(snap.capabilities.canReadDiary).toBe(false);
    expect(snap.diaryPersistenceState).toBe("write-ok-unverified");
    expect(snap.lastReplay).toBeNull();
    expect(snap.lastProbeAt).toBeNull();
    expect(snap.lastProbeReason).toBeNull();
  });

  it("maps a ReplayResult to HealthCacheReplayOutcome", () => {
    const replayResult = { attempted: 5, succeeded: 4, failed: 1, at: 12345, skipped: false };
    const snap = buildHealthSnapshot({
      mcpReady: false,
      capabilities: {
        canWriteDiary: false,
        canReadDiary: false,
        canInvalidateKg: false,
        canPersistDiary: false,
      },
      diaryPersistenceState: "unavailable",
      lastReplay: replayResult,
    });
    expect(snap.lastReplay).toEqual({
      attempted: 5,
      succeeded: 4,
      failed: 1,
      at: 12345,
    });
  });

  it("includes probe fields when provided", () => {
    const snap = buildHealthSnapshot({
      mcpReady: true,
      capabilities: {
        canWriteDiary: true,
        canReadDiary: true,
        canInvalidateKg: true,
        canPersistDiary: true,
      },
      diaryPersistenceState: "persistent",
      lastProbeAt: 99999,
      lastProbeReason: "verified: persistent",
    });
    expect(snap.lastProbeAt).toBe(99999);
    expect(snap.lastProbeReason).toBe("verified: persistent");
  });
});
