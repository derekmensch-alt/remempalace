import type { McpClient } from "./mcp-client.js";

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
}

export async function queryTimeline(
  mcp: McpClient,
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
      mcp.callTool<Array<{ date: string; content: string }>>(
        "mempalace_diary_read",
        { agent_name: "remempalace", last_n: 50 },
      ),
      [],
    ),
    safe(
      mcp.callTool<Array<{ date: string; fact: string }>>(
        "mempalace_kg_timeline",
        { days_back: opts.daysBack },
      ),
      [],
    ),
  ]);
  return {
    diary: Array.isArray(diary) ? diary : [],
    events: Array.isArray(events) ? events : [],
  };
}
