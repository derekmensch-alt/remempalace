import type { MemPalaceRepository } from "./ports/mempalace-repository.js";
import type { PalaceStatus } from "./types.js";

export interface PrefetchResult {
  status: PalaceStatus | null;
  diaryEntries: unknown[];
}

export interface PrefetchOptions {
  diaryCount: number;
  diaryReadTimeoutMs?: number;
}

const DEFAULT_DIARY_READ_TIMEOUT_MS = 500;

export async function prefetchWakeUp(
  repository: Pick<MemPalaceRepository, "getPalaceStatus" | "readDiary" | "searchMemory">,
  opts: PrefetchOptions,
): Promise<PrefetchResult> {
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const [statusResult, diaryResult, _warmupResult] = await Promise.all([
    safe(repository.getPalaceStatus(), null),
    safe(
      repository.readDiary<unknown>({
        agentName: "remempalace",
        lastN: opts.diaryCount,
        timeoutMs: opts.diaryReadTimeoutMs ?? DEFAULT_DIARY_READ_TIMEOUT_MS,
      }),
      [],
    ),
    safe(repository.searchMemory({ query: "__warmup__", limit: 1 }), null),
  ]);
  const status = statusResult;
  return { status, diaryEntries: normalizeDiaryEntries(diaryResult) };
}

function normalizeDiaryEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const entries = (raw as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries : [];
}
