import type { InjectionBudget, KgFact, SearchResult } from "./types.js";
import { formatKgFactsAaak, formatSearchResult } from "./aaak.js";
import { countTokens } from "./token-counter.js";
import { dedupeByContent } from "./dedup.js";

export interface TieredInjectionParams {
  kgFacts: KgFact[];
  searchResults: SearchResult[];
  budget: InjectionBudget;
  tiers: { l1Threshold: number; l2Threshold: number; l2BudgetFloor: number };
  useAaak: boolean;
}

export function buildTieredInjection(params: TieredInjectionParams): string[] {
  const { kgFacts, searchResults, budget, tiers } = params;
  if (budget.allowedTiers.length === 0 || budget.maxTokens === 0) return [];

  const lines: string[] = [];
  let tokensUsed = 0;
  const canAdd = (next: string): boolean => {
    const nextTokens = countTokens(next);
    return tokensUsed + nextTokens <= budget.maxTokens;
  };
  const add = (line: string) => {
    lines.push(line);
    tokensUsed += countTokens(line);
  };

  // L0: KG facts
  if (budget.allowedTiers.includes("L0") && kgFacts.length > 0) {
    const factsLine = `FACTS: ${formatKgFactsAaak(kgFacts)}`;
    if (canAdd(factsLine)) add(factsLine);
  }

  // L1: top hits above l1Threshold
  if (budget.allowedTiers.includes("L1")) {
    const l1Hits = searchResults
      .filter((r) => r.similarity >= tiers.l1Threshold)
      .slice(0, 2);
    for (const hit of l1Hits) {
      const line = formatSearchResult(hit);
      if (canAdd(line)) add(line);
      else break;
    }
  }

  // L2: deeper context above l2Threshold but below l1Threshold
  if (budget.allowedTiers.includes("L2")) {
    const l2Hits = searchResults.filter(
      (r) => r.similarity >= tiers.l2Threshold && r.similarity < tiers.l1Threshold,
    );
    for (const hit of l2Hits) {
      const line = formatSearchResult(hit);
      if (canAdd(line)) add(line);
      else break;
    }
  }

  return dedupeByContent(lines);
}
