import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ReadBundle } from "./router.js";

export interface HotCacheSnapshotEntry {
  intentKey: string;
  bundle: ReadBundle;
  expiresAt: number; // epoch ms
  entities: string[];
}

export interface HotCacheSnapshot {
  version: 1;
  savedAt: number; // epoch ms
  entries: HotCacheSnapshotEntry[];
}

/**
 * Load a hot cache snapshot from disk.
 * Returns null if the file is missing, malformed, wrong version, or unreadable.
 * Never throws.
 */
export async function loadHotCache(path: string): Promise<HotCacheSnapshot | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== 1) return null;
    if (!Array.isArray(parsed.entries)) return null;
    if (typeof parsed.savedAt !== "number") return null;
    // Basic structural validation of entries
    const entries: HotCacheSnapshotEntry[] = [];
    for (const e of parsed.entries) {
      if (
        typeof e.intentKey !== "string" ||
        typeof e.expiresAt !== "number" ||
        !Array.isArray(e.entities) ||
        !e.bundle ||
        typeof e.bundle !== "object"
      ) {
        continue; // skip malformed entries
      }
      entries.push({
        intentKey: e.intentKey,
        bundle: e.bundle as ReadBundle,
        expiresAt: e.expiresAt,
        entities: e.entities as string[],
      });
    }
    return { version: 1, savedAt: parsed.savedAt as number, entries };
  } catch {
    return null;
  }
}

/**
 * Save a hot cache snapshot to disk atomically (write to tmp, rename).
 * Creates the directory if needed.
 * Never throws — callers handle errors via return/metric.
 */
export async function saveHotCache(path: string, snapshot: HotCacheSnapshot): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });

  // Filter entries that can't be serialized (e.g. circular refs)
  const safeEntries: HotCacheSnapshotEntry[] = [];
  for (const entry of snapshot.entries) {
    try {
      JSON.stringify(entry);
      safeEntries.push(entry);
    } catch {
      // Entry is not serializable; skip it (caller should increment metric)
    }
  }

  const safeSnapshot: HotCacheSnapshot = { ...snapshot, entries: safeEntries };
  const tmp = `${dir}/.hot-cache-${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(safeSnapshot), "utf8");
  await fs.rename(tmp, path);
}

/**
 * Filter snapshot entries to only those that are not yet expired.
 * Modifies nothing; returns a new array.
 */
export function filterLiveEntries(
  entries: HotCacheSnapshotEntry[],
  now: number,
): HotCacheSnapshotEntry[] {
  return entries.filter((e) => e.expiresAt > now);
}

// Export tmpdir for test stubs (allows tests to override tmp path logic if needed)
export { tmpdir };
