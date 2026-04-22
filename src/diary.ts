import { countTokens } from "./token-counter.js";
import { appendLocalDiary } from "./diary-local.js";

interface SessionMessage {
  role?: string;
  content?: unknown;
}

function extractContent(msg: SessionMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part && typeof part.text === "string"
            ? part.text
            : "",
      )
      .join(" ");
  }
  return "";
}

export function summarizeSession(
  messages: SessionMessage[],
  opts: { maxTokens: number },
): string {
  if (messages.length === 0) return "";
  const turns = messages.length;
  const parts: string[] = [`TURNS:${turns}`];
  let tokensUsed = countTokens(parts.join(" | "));
  for (const m of messages) {
    const role = m.role === "assistant" ? "A" : "U";
    const text = extractContent(m).slice(0, 200);
    const line = `${role}: ${text}`;
    const cost = countTokens(line);
    if (tokensUsed + cost > opts.maxTokens) break;
    parts.push(line);
    tokensUsed += cost;
  }
  return parts.join(" | ");
}

export function writeDiaryAsync(
  mcp: { hasDiaryWrite: boolean; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> },
  summary: string,
): void {
  if (mcp.hasDiaryWrite) {
    void mcp.callTool("mempalace_diary_write", {
      wing: "remempalace",
      room: "session",
      content: summary,
      added_by: "remempalace",
    }).catch(() => {});
  } else {
    void appendLocalDiary({
      wing: "remempalace",
      room: "session",
      content: summary,
      ts: new Date().toISOString(),
    }).catch(() => {});
  }
}
