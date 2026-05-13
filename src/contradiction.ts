import type { ExtractedFact, KgFact } from "./types.js";

export type Cardinality = "single" | "list";

export interface Contradiction {
  prior: KgFact;
  next: ExtractedFact;
  type: Cardinality;
}

const SINGLE_CARDINALITY_EXACT = new Set([
  "works_at",
  "lives_at",
  "runs_on",
  "primary_email",
  "default_browser",
  "default_editor",
  "favorite_color",
  "chose_over",
]);

const SINGLE_CARDINALITY_PREFIXES = [
  "favorite_",
  "preferred_",
  "default_",
  "primary_",
  "chosen_",
];

export function classifyPredicate(predicate: string): Cardinality {
  if (SINGLE_CARDINALITY_EXACT.has(predicate)) return "single";
  if (SINGLE_CARDINALITY_PREFIXES.some((p) => predicate.startsWith(p))) return "single";
  return "list";
}

export function detectContradictions(
  prior: KgFact[],
  next: ExtractedFact[],
): Contradiction[] {
  const out: Contradiction[] = [];

  const priorByKey = new Map<string, KgFact[]>();
  for (const p of prior) {
    if (p.current === false) continue;
    const key = `${p.subject}|${p.predicate}`;
    let list = priorByKey.get(key);
    if (!list) {
      list = [];
      priorByKey.set(key, list);
    }
    list.push(p);
  }

  for (const n of next) {
    const card = classifyPredicate(n.predicate);
    if (card !== "single") continue;
    const matches = priorByKey.get(`${n.subject}|${n.predicate}`);
    if (!matches) continue;
    for (const p of matches) {
      if (p.object === n.object) continue;
      out.push({ prior: p, next: n, type: card });
    }
  }

  return out;
}
