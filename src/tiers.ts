import type { InjectionBudget, KgFact, SearchResult } from "./types.js";
import { formatKgFact, formatSearchResult } from "./aaak.js";
import { countTokens } from "./token-counter.js";
import { dedupeByContent } from "./dedup.js";

export interface TieredInjectionParams {
  kgFacts: KgFact[];
  searchResults: SearchResult[];
  budget: InjectionBudget;
  tiers: { l1Threshold: number; l2Threshold: number; l2BudgetFloor: number };
  useAaak: boolean;
}

function rankKgFacts(facts: KgFact[]): KgFact[] {
  return facts
    .filter((f) => f.current !== false)
    .slice()
    .sort((a, b) => {
      const av = a.valid_from ?? "";
      const bv = b.valid_from ?? "";
      if (av && !bv) return -1;
      if (!av && bv) return 1;
      if (av === bv) return 0;
      return av < bv ? 1 : -1;
    });
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

  // L0: KG facts — filter to current, sort newest-first, greedy pack per-fact so a tight
  // budget still yields the most recent authoritative facts instead of dropping the whole tier.
  // Only emit the header if at least one fact will actually fit beneath it; otherwise a
  // very tight budget would leave a semantically empty labelled block.
  if (budget.allowedTiers.includes("L0") && kgFacts.length > 0) {
    const ranked = rankKgFacts(kgFacts);
    if (ranked.length > 0) {
      const header = "KG FACTS (authoritative, newest first):";
      const firstLine = `- ${formatKgFact(ranked[0])}`;
      if (countTokens(header) + countTokens(firstLine) <= budget.maxTokens) {
        add(header);
        for (const fact of ranked) {
          const line = `- ${formatKgFact(fact)}`;
          if (canAdd(line)) add(line);
          else break;
        }
      }
    }
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
