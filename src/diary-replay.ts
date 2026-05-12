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
    Partial<Pick<MemPalaceRepository, "verifyDiaryPersistence">>;
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

    if (repository.verifyDiaryPersistence) {
      const probe = await repository.verifyDiaryPersistence({ timeoutMs: DIARY_IO_TIMEOUT_MS });
      if (!probe.verified || !repository.canPersistDiary) {
        this.lastReplayError = probe.error ?? `diary persistence probe did not verify (${probe.state})`;
        const result: ReplayResult = { attempted: 0, succeeded: 0, failed: 0, skipped: true, at };
        this.lastReplayResult = result;
        return result;
      }
    }

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
    const successByDate = new Map<string, number[]>();
    const seenIds = new Set<string>();
    let lastError: string | null = null;

    for (const p of pending) {
      if (p.entry.id) {
        if (seenIds.has(p.entry.id)) {
          // Duplicate id within this batch — mark as done without re-sending
          const list = successByDate.get(p.date) ?? [];
          list.push(p.lineNo);
          successByDate.set(p.date, list);
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
        const list = successByDate.get(p.date) ?? [];
        list.push(p.lineNo);
        successByDate.set(p.date, list);
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
        this.opts.metrics?.inc("diary.replay.failed");
      }
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
