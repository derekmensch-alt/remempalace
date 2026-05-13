import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { DiaryPersistenceState } from "../ports/mempalace-repository.js";
import type { ReplayResult } from "../diary-replay.js";

/** How long a snapshot is considered fresh. Snapshots older than this are
 *  still returned but flagged as stale so callers can decide how to surface
 *  them. 10 minutes matches a typical session gap. */
export const HEALTH_CACHE_STALE_MS = 10 * 60 * 1000;

export interface HealthCacheCapabilities {
  canWriteDiary: boolean;
  canReadDiary: boolean;
  canInvalidateKg: boolean;
  canPersistDiary: boolean;
}

export interface HealthCacheReplayOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  at: number;
}

export interface HealthCacheSnapshot {
  /** Schema version — bump when fields are removed or types change. */
  version: 1;
  /** Wall-clock epoch ms when this snapshot was written. */
  savedAt: number;
  /** Whether the MCP client reported ready at save time. */
  mcpReady: boolean;
  /** Capability flags from the repository at save time. */
  capabilities: HealthCacheCapabilities;
  /** Diary persistence state at save time. */
  diaryPersistenceState: DiaryPersistenceState;
  /** Timestamp (epoch ms) of the most-recent persistence probe, if any. */
  lastProbeAt: number | null;
  /** Probe reason / outcome text recorded at save time, if any. */
  lastProbeReason: string | null;
  /** Outcome of the most-recent diary replay, if any. */
  lastReplay: HealthCacheReplayOutcome | null;
}

export interface LoadedHealthCache {
  snapshot: HealthCacheSnapshot;
  /** True when savedAt is older than HEALTH_CACHE_STALE_MS. */
  stale: boolean;
}

/**
 * Load a health-cache snapshot from disk.
 * Returns null if the file is missing, unreadable, malformed, or wrong version.
 * Never throws.
 */
export async function loadHealthCache(path: string): Promise<LoadedHealthCache | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.savedAt !== "number") return null;
    if (typeof parsed.mcpReady !== "boolean") return null;
    if (!parsed.capabilities || typeof parsed.capabilities !== "object") return null;
    if (typeof parsed.diaryPersistenceState !== "string") return null;

    const capabilities: HealthCacheCapabilities = {
      canWriteDiary: Boolean(parsed.capabilities.canWriteDiary),
      canReadDiary: Boolean(parsed.capabilities.canReadDiary),
      canInvalidateKg: Boolean(parsed.capabilities.canInvalidateKg),
      canPersistDiary: Boolean(parsed.capabilities.canPersistDiary),
    };

    // Replay outcome — optional; malformed sub-object is dropped to null.
    let lastReplay: HealthCacheReplayOutcome | null = null;
    const lr = parsed.lastReplay;
    if (
      lr &&
      typeof lr === "object" &&
      typeof lr.attempted === "number" &&
      typeof lr.succeeded === "number" &&
      typeof lr.failed === "number" &&
      typeof lr.at === "number"
    ) {
      lastReplay = {
        attempted: lr.attempted,
        succeeded: lr.succeeded,
        failed: lr.failed,
        at: lr.at,
      };
    }

    const snapshot: HealthCacheSnapshot = {
      version: 1,
      savedAt: parsed.savedAt as number,
      mcpReady: parsed.mcpReady as boolean,
      capabilities,
      diaryPersistenceState: parsed.diaryPersistenceState as DiaryPersistenceState,
      lastProbeAt: typeof parsed.lastProbeAt === "number" ? parsed.lastProbeAt : null,
      lastProbeReason: typeof parsed.lastProbeReason === "string" ? parsed.lastProbeReason : null,
      lastReplay,
    };

    const stale = Date.now() - snapshot.savedAt > HEALTH_CACHE_STALE_MS;
    return { snapshot, stale };
  } catch {
    return null;
  }
}

/**
 * Save a health-cache snapshot to disk atomically (write-to-tmp then rename).
 * Creates the parent directory if needed.
 * Never throws — callers treat this as best-effort.
 */
export async function saveHealthCache(
  path: string,
  snapshot: HealthCacheSnapshot,
): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${dir}/.health-cache-${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot), "utf8");
  await fs.rename(tmp, path);
}

/**
 * Build a health-cache snapshot from live plugin state.
 * The `lastReplay` argument accepts the full `ReplayResult` from DiaryReconciler
 * (which has the same shape as HealthCacheReplayOutcome).
 */
export function buildHealthSnapshot(input: {
  mcpReady: boolean;
  capabilities: HealthCacheCapabilities;
  diaryPersistenceState: DiaryPersistenceState;
  lastProbeAt?: number | null;
  lastProbeReason?: string | null;
  lastReplay?: ReplayResult | null;
}): HealthCacheSnapshot {
  const lr = input.lastReplay;
  return {
    version: 1,
    savedAt: Date.now(),
    mcpReady: input.mcpReady,
    capabilities: input.capabilities,
    diaryPersistenceState: input.diaryPersistenceState,
    lastProbeAt: input.lastProbeAt ?? null,
    lastProbeReason: input.lastProbeReason ?? null,
    lastReplay: lr
      ? {
          attempted: lr.attempted,
          succeeded: lr.succeeded,
          failed: lr.failed,
          at: lr.at,
        }
      : null,
  };
}
