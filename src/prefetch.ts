import type { McpClient } from "./mcp-client.js";
import type { PalaceStatus } from "./types.js";

export interface PrefetchResult {
  status: PalaceStatus | null;
  diaryEntries: unknown[];
}

export interface PrefetchOptions {
  diaryCount: number;
}

export async function prefetchWakeUp(
  mcp: McpClient,
  opts: PrefetchOptions,
): Promise<PrefetchResult> {
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const [status, diaryEntries] = await Promise.all([
    safe(mcp.callTool<PalaceStatus>("mempalace_status", {}), null),
    safe(
      mcp.callTool<unknown[]>("mempalace_diary_read", { limit: opts.diaryCount }),
      [],
    ),
  ]);
  return { status, diaryEntries: Array.isArray(diaryEntries) ? diaryEntries : [] };
}
