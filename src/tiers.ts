import type { InjectionBudget, KgFact, SearchResult } from "./types.js";
import { formatKgFact, formatSearchResult } from "./aaak.js";
import { countTokens } from "./token-counter.js";
import { dedupeByContent } from "./dedup.js";
import type { Metrics } from "./metrics.js";

export interface TieredInjectionParams {
  kgFacts: KgFact[];
  searchResults: SearchResult[];
  budget: InjectionBudget;
  tiers: { l1Threshold: number; l2Threshold: number; l2BudgetFloor: number };
  useAaak: boolean;
  metrics?: Metrics;
  /** Tokens to reserve for wrapper headers (runtime disclosure, section headers). Subtracted from budget.maxTokens before packing. */
  fixedOverheadTokens?: number;
}

const KG_FACTS_HEADER = "KG FACTS (source=remempalace KG, authoritative, newest first):";
const KG_FACTS_HEADER_TOKENS = countTokens(KG_FACTS_HEADER);

function maxCandidateScan(remainingTokens: number, available: number): number {
  // Every emitted candidate costs at least one token, so scanning more
  // candidates than remaining tokens cannot improve a greedy pack.
  return Math.max(0, Math.min(available, remainingTokens));
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
  const { kgFacts, searchResults, budget, tiers, metrics } = params;
  const effectiveMaxTokens = Math.max(0, budget.maxTokens - (params.fixedOverheadTokens ?? 0));
  if (budget.allowedTiers.length === 0 || effectiveMaxTokens === 0) return [];

  const lines: string[] = [];
  let tokensUsed = 0;
  const remaining = (): number => Math.max(0, effectiveMaxTokens - tokensUsed);
  // Count tokens once and use the result for both the budget check and the increment.
  const tryAdd = (line: string, tier: "l0" | "l1" | "l2"): boolean => {
    const tokens = countTokens(line);
    if (tokensUsed + tokens > effectiveMaxTokens) return false;
    lines.push(line);
    tokensUsed += tokens;
    metrics?.inc(`injection.tokens.${tier}`, tokens);
    return true;
  };

  // L0: KG facts — filter to current, sort newest-first, greedy pack per-fact so a tight
  // budget still yields the most recent authoritative facts instead of dropping the whole tier.
  // Only emit the header if at least one fact will actually fit beneath it; otherwise a
  // very tight budget would leave a semantically empty labelled block.
  if (budget.allowedTiers.includes("L0") && kgFacts.length > 0) {
    const ranked = rankKgFacts(kgFacts);
    if (ranked.length > 0) {
      const firstSource = ranked[0].source_closet ? `source=${ranked[0].source_closet}` : "source=unknown";
      const firstLine = `- ${formatKgFact(ranked[0])} [${firstSource}]`;
      if (KG_FACTS_HEADER_TOKENS + countTokens(firstLine) <= effectiveMaxTokens) {
        tryAdd(KG_FACTS_HEADER, "l0");
        for (let i = 0; i < ranked.length; i += 1) {
          if (maxCandidateScan(remaining(), ranked.length - i) === 0) break;
          const fact = ranked[i];
          if (tokensUsed >= effectiveMaxTokens) break;
          const source = fact.source_closet ? `source=${fact.source_closet}` : "source=unknown";
          const line = `- ${formatKgFact(fact)} [${source}]`;
          if (!tryAdd(line, "l0")) break;
        }
      }
    }
  }

  // L1: top hits above l1Threshold
  if (budget.allowedTiers.includes("L1")) {
    const l1Candidates = searchResults.filter((hit) => hit.similarity >= tiers.l1Threshold);
    const maxL1Candidates = maxCandidateScan(remaining(), Math.min(2, l1Candidates.length));
    let l1Added = 0;
    for (let i = 0; i < maxL1Candidates; i += 1) {
      if (l1Added >= maxL1Candidates) break;
      const hit = l1Candidates[i];
      if (tokensUsed >= effectiveMaxTokens) break;
      const line = `${formatSearchResult(hit)} [source=remempalace search, confidence=${hit.similarity.toFixed(2)}]`;
      if (!tryAdd(line, "l1")) break;
      l1Added += 1;
    }
  }

  // L2: deeper context above l2Threshold but below l1Threshold
  if (budget.allowedTiers.includes("L2")) {
    const l2Candidates = searchResults.filter(
      (hit) => hit.similarity >= tiers.l2Threshold && hit.similarity < tiers.l1Threshold,
    );
    const maxL2Candidates = maxCandidateScan(remaining(), l2Candidates.length);
    for (let i = 0; i < maxL2Candidates; i += 1) {
      const hit = l2Candidates[i];
      if (tokensUsed >= effectiveMaxTokens) break;
      const line = `${formatSearchResult(hit)} [source=remempalace search, confidence=${hit.similarity.toFixed(2)}]`;
      if (!tryAdd(line, "l2")) break;
    }
  }

  return dedupeByContent(lines);
}
