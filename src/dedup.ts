import { createHash } from "node:crypto";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function contentHash(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex");
}

export function dedupeByContent(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const h = contentHash(item);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(item);
  }
  return out;
}

export function dedupeWithKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const h = contentHash(keyFn(item));
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(item);
  }
  return out;
}
