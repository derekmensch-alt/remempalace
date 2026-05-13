import type { MemPalaceRepository } from "./ports/mempalace-repository.js";

const TIMELINE_PATTERNS = [
  /what happened/i,
  /what did (i|we) do/i,
  /recap of/i,
  /last (week|month|day|year)/i,
  /yesterday/i,
  /since (yesterday|last)/i,
];

export function isTimelineQuery(text: string): boolean {
  return TIMELINE_PATTERNS.some((re) => re.test(text));
}

export interface TimelineResult {
  diary: Array<{ date: string; content: string }>;
  events: Array<{ date: string; fact: string }>;
}

export interface QueryTimelineOptions {
  daysBack: number;
  diaryReadTimeoutMs?: number;
}

const DEFAULT_DIARY_READ_TIMEOUT_MS = 500;

export async function queryTimeline(
  repository: Pick<MemPalaceRepository, "readDiary" | "readKgTimeline">,
  opts: QueryTimelineOptions,
): Promise<TimelineResult> {
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const [diary, events] = await Promise.all([
    safe(
      repository.readDiary<unknown>({
        agentName: "remempalace",
        lastN: 50,
        timeoutMs: opts.diaryReadTimeoutMs ?? DEFAULT_DIARY_READ_TIMEOUT_MS,
      }),
      [],
    ),
    safe(repository.readKgTimeline({ daysBack: opts.daysBack }), []),
  ]);
  return {
    diary: normalizeDiaryEntries(diary),
    events: Array.isArray(events) ? events : [],
  };
}

function normalizeDiaryEntries(raw: unknown): Array<{ date: string; content: string }> {
  const entries = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)
      ? (raw as { entries: unknown[] }).entries
      : [];
  return entries.filter(
    (entry): entry is { date: string; content: string } =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as { date?: unknown }).date === "string" &&
      typeof (entry as { content?: unknown }).content === "string",
  );
}
