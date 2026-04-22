import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export async function appendLocalDiary(
  entry: {
    wing: string;
    room: string;
    content: string;
    ts: string;
  },
  baseDir?: string,
): Promise<void> {
  const dir = join(baseDir ?? homedir(), ".mempalace", "palace", "diary");
  await mkdir(dir, { recursive: true });
  const date = entry.ts.slice(0, 10); // YYYY-MM-DD
  const file = join(dir, `${date}.jsonl`);
  await appendFile(file, JSON.stringify(entry) + "\n");
}
