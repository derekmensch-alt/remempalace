import type { KgFact, SearchResult } from "./types.js";

export function formatKgFact(fact: KgFact): string {
  const base = `${fact.subject}:${fact.predicate}=${fact.object}`;
  if (fact.valid_from) return `${base} [${fact.valid_from}]`;
  return base;
}

export function formatKgFactsAaak(facts: KgFact[]): string {
  return facts.map(formatKgFact).join(" | ");
}

export function formatSearchResult(r: SearchResult): string {
  const sim = r.similarity.toFixed(2);
  return `[${r.wing}/${r.room} ★${sim}] ${r.text}`;
}

export function formatSearchResultsAaak(results: SearchResult[]): string {
  return results.map(formatSearchResult).join("\n");
}
