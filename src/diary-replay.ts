import { readdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metrics } from "./metrics.js";
import type { DiaryPersistenceState, MemPalaceRepository } from "./ports/mempalace-repository.js";

const DIARY_IO_TIMEOUT_MS = 500;

export interface DiaryEntry {
  wing: string;
  room: string;
  content: string;
  ts: string;
  id?: string;
  added_by?: string;
}

export interface PendingDiaryEntry {
  date: string;
  lineNo: number;
  entry: DiaryEntry;
}

export interface ReplayResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped?: boolean;
  at: number;
}

export interface DiaryReconcilerOptions {
  diaryDir: string;
  repository?: Pick<MemPalaceRepository, "canPersistDiary" | "writeDiary"> &
    Partial<Pick<MemPalaceRepository, "verifyDiaryPersistence" | "canReadDiary" | "readDiary">>;
  metrics?: Metrics;
  /** Minimum ms between replay attempts. Defaults to 0 (no throttle). */
  minIntervalMs?: number;
}

const DAILY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function parseEntry(line: string): DiaryEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as DiaryEntry;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.content !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readReplayedSet(path: string): Promise<Set<number>> {
  try {
    const text = await readFile(path, "utf8");
    const out = new Set<number>();
    for (const line of text.split("\n")) {
      const n = Number(line.trim());
      if (Number.isInteger(n) && n >= 0) out.add(n);
    }
    return out;
  } catch {
    return new Set<number>();
  }
}

export class DiaryReconciler {
  lastReplayResult: ReplayResult | null = null;
  lastReplayError: string | null = null;

  constructor(private readonly opts: DiaryReconcilerOptions) {}

  async loadPending(): Promise<PendingDiaryEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.opts.diaryDir);
    } catch {
      return [];
    }
    const dailyFiles = names
      .map((n) => DAILY_FILE.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ name: m[0], date: m[1] }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const pending: PendingDiaryEntry[] = [];
    for (const { name, date } of dailyFiles) {
      const filePath = join(this.opts.diaryDir, name);
      let text: string;
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const replayed = await readReplayedSet(join(this.opts.diaryDir, `${date}.replayed`));
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (replayed.has(i)) continue;
        const entry = parseEntry(lines[i]);
        if (!entry) continue;
        pending.push({ date, lineNo: i, entry });
      }
    }
    return pending;
  }

  async replay(): Promise<ReplayResult> {
    const at = Date.now();
    const repository = this.opts.repository;
    if (!repository || !repository.canPersistDiary) {
      const result: ReplayResult = { attempted: 0, succeeded: 0, failed: 0, skipped: true, at };
      this.lastReplayResult = result;
      return result;
    }

    // Durable-aware marking gate: determine which verification path is available.
    //
    // We require one of the following before marking any entry replayed:
    //   (A) A fresh persistence probe in this cycle returned verified=true.
    //   (B) No probe available but canReadDiary is true — we will do a
    //       post-write batch read to confirm entries persisted.
    //
    // If neither is available, entries are written to the backend but NOT
    // marked replayed (they will be retried next cycle).
    let probePassed = false;
    if (repository.verifyDiaryPersistence) {
      const probe = await repository.verifyDiaryPersistence({ timeoutMs: DIARY_IO_TIMEOUT_MS });
      if (!probe.verified || !repository.canPersistDiary) {
        this.lastReplayError = probe.error ?? `diary persistence probe did not verify (${probe.state})`;
        const result: ReplayResult = { attempted: 0, succeeded: 0, failed: 0, skipped: true, at };
        this.lastReplayResult = result;
        return result;
      }
      // (A) Same-cycle probe succeeded — entries may be marked after write-ack.
      probePassed = true;
    }
    // (B) canReadDiary without verifyDiaryPersistence: post-write batch read
    //     verification will run at the end. probePassed stays false here.

    const minInterval = this.opts.minIntervalMs ?? 0;
    if (minInterval > 0 && this.lastReplayResult && at - this.lastReplayResult.at < minInterval) {
      const result: ReplayResult = {
        attempted: 0, succeeded: 0, failed: 0, skipped: true, at,
      };
      this.lastReplayResult = result;
      return result;
    }

    const pending = await this.loadPending();
    if (pending.length === 0) {
      const result: ReplayResult = { attempted: 0, succeeded: 0, failed: 0, at };
      this.lastReplayResult = result;
      return result;
    }

    let succeeded = 0;
    let failed = 0;
    // writtenEntries collects entries that received a write-ack — used for
    // post-write read verification when probePassed is false.
    const writtenEntries: Array<{ date: string; lineNo: number; content: string }> = [];
    const successByDate = new Map<string, number[]>();
    const seenIds = new Set<string>();
    let lastError: string | null = null;

    for (const p of pending) {
      if (p.entry.id) {
        if (seenIds.has(p.entry.id)) {
          // Duplicate id within this batch — mark as done without re-sending.
          // Only mark if we can verify (probe passed or will do read verify).
          if (probePassed || repository.canReadDiary) {
            const list = successByDate.get(p.date) ?? [];
            list.push(p.lineNo);
            successByDate.set(p.date, list);
          }
          continue;
        }
        seenIds.add(p.entry.id);
      }
      this.opts.metrics?.inc("diary.replay.attempted");
      try {
        await repository.writeDiary({
          agentName: p.entry.wing ?? "remempalace",
          entry: p.entry.content,
          topic: p.entry.room ?? "session",
          timeoutMs: DIARY_IO_TIMEOUT_MS,
        });
        succeeded++;
        this.opts.metrics?.inc("diary.replay.succeeded");
        if (probePassed) {
          // (A) Same-cycle probe passed: mark replayed immediately on write-ack.
          const list = successByDate.get(p.date) ?? [];
          list.push(p.lineNo);
          successByDate.set(p.date, list);
        } else {
          // (B) No probe — collect for post-write read verification.
          writtenEntries.push({ date: p.date, lineNo: p.lineNo, content: p.entry.content });
        }
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
        this.opts.metrics?.inc("diary.replay.failed");
      }
    }

    // (B) Post-write read verification: check that written entries appear in the
    //     backend diary before marking them as replayed.
    if (!probePassed && writtenEntries.length > 0 && repository.canReadDiary && repository.readDiary) {
      let verifiedContents: Set<string> | null = null;
      try {
        const readResult = await repository.readDiary<{ entries?: Array<{ content?: string }> }>({
          agentName: "remempalace",
          lastN: Math.max(20, writtenEntries.length * 2),
          timeoutMs: DIARY_IO_TIMEOUT_MS,
        });
        const entries =
          Array.isArray(readResult)
            ? (readResult as Array<{ content?: string }>)
            : (readResult?.entries ?? []);
        verifiedContents = new Set(
          entries
            .filter((e): e is { content: string } => typeof e?.content === "string")
            .map((e) => e.content),
        );
      } catch {
        // Read failed — leave all written entries unmarked for next cycle.
        verifiedContents = null;
      }

      if (verifiedContents !== null) {
        for (const w of writtenEntries) {
          if (verifiedContents.has(w.content)) {
            const list = successByDate.get(w.date) ?? [];
            list.push(w.lineNo);
            successByDate.set(w.date, list);
          }
          // If not found in read result, leave unmarked (next cycle will retry).
        }
      }
      // verifiedContents === null: read failed; all written entries stay unmarked.
    }

    for (const [date, lineNos] of successByDate) {
      const sidecarPath = join(this.opts.diaryDir, `${date}.replayed`);
      try {
        await appendFile(sidecarPath, lineNos.join("\n") + "\n");
      } catch {
        // best effort
      }
    }

    this.lastReplayError = lastError;
    const result: ReplayResult = {
      attempted: pending.length,
      succeeded,
      failed,
      at,
    };
    this.lastReplayResult = result;
    return result;
  }
}

export type DiaryHealthState = DiaryPersistenceState | "fallback-active" | "degraded";

export interface DiaryHealthInput {
  persistenceState: DiaryPersistenceState;
  pending: number;
  lastReplay?: ReplayResult | null;
}

export function computeDiaryHealth(input: DiaryHealthInput): DiaryHealthState {
  if (input.persistenceState !== "persistent") return input.pending > 0 ? "fallback-active" : input.persistenceState;
  if (input.lastReplay && input.lastReplay.failed > 0) return "degraded";
  if (input.pending > 0) return "fallback-active";
  return "persistent";
}
