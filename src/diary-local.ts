import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

export interface LocalDiaryEntry {
  wing: string;
  room: string;
  content: string;
  ts: string;
  id?: string;
}

function entryId(content: string, ts: string): string {
  return createHash("sha1").update(`${content}\x00${ts}`).digest("hex").slice(0, 16);
}

export async function appendLocalDiary(
  entry: {
    wing: string;
    room: string;
    content: string;
    ts: string;
  },
  baseDir?: string,
  diaryDir?: string,
): Promise<void> {
  const dir = diaryDir ?? join(baseDir ?? homedir(), ".mempalace", "palace", "diary");
  await mkdir(dir, { recursive: true });
  const date = entry.ts.slice(0, 10); // YYYY-MM-DD
  const file = join(dir, `${date}.jsonl`);
  const withId: LocalDiaryEntry = { ...entry, id: entryId(entry.content, entry.ts) };
  await appendFile(file, JSON.stringify(withId) + "\n");
}
