import { readdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metrics } from "./metrics.js";

export interface DiaryEntry {
  wing: string;
  room: string;
  content: string;
  ts: string;
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

interface McpLike {
  hasDiaryWrite: boolean;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface DiaryReconcilerOptions {
  diaryDir: string;
  mcp?: McpLike;
  metrics?: Metrics;
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
    const mcp = this.opts.mcp;
    if (!mcp || !mcp.hasDiaryWrite) {
      const result: ReplayResult = { attempted: 0, succeeded: 0, failed: 0, skipped: true, at };
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

    for (const p of pending) {
      this.opts.metrics?.inc("diary.replay.attempted");
      try {
        await mcp.callTool("mempalace_diary_write", {
          agent_name: p.entry.wing ?? "remempalace",
          entry: p.entry.content,
          topic: p.entry.room ?? "session",
        });
        succeeded++;
        this.opts.metrics?.inc("diary.replay.succeeded");
        const list = successByDate.get(p.date) ?? [];
        list.push(p.lineNo);
        successByDate.set(p.date, list);
      } catch {
        failed++;
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

export type DiaryHealthState = "mcp-healthy" | "jsonl-only" | "split-brain" | "degraded";

export interface DiaryHealthInput {
  hasDiaryWrite: boolean;
  pending: number;
  lastReplay?: ReplayResult | null;
}

export function computeDiaryHealth(input: DiaryHealthInput): DiaryHealthState {
  if (!input.hasDiaryWrite) return "jsonl-only";
  if (input.lastReplay && input.lastReplay.failed > 0) return "degraded";
  if (input.pending > 0) return "split-brain";
  return "mcp-healthy";
}
