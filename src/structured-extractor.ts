import { dedupeWithKey } from "./dedup.js";
import type { ExtractedFact, FactCategory } from "./types.js";

interface RulePack {
  category: FactCategory;
  pattern: RegExp;
  base: number;
  build: (m: RegExpMatchArray) => {
    subject: string;
    predicate: string;
    object: string;
  } | null;
}

const HEDGE_WORDS = [
  "might",
  "maybe",
  "perhaps",
  "probably",
  "sometimes",
  "occasionally",
  "could",
  "possibly",
  "i think",
  "i guess",
  "seems",
  "kinda",
  "sort of",
];

const NEGATION_PATTERNS = [
  /\b(?:does not|doesn't|do not|don't|did not|didn't|never|no longer|isn't|is not|aren't|are not|wasn't|was not|won't|will not)\b/i,
];

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function detectHedgeAndNegation(span: string): { hedge: number; negated: boolean } {
  const lower = span.toLowerCase();
  let hedge = 0;
  for (const w of HEDGE_WORDS) {
    if (lower.includes(w)) hedge += 1;
  }
  const negated = NEGATION_PATTERNS.some((re) => re.test(lower));
  return { hedge, negated };
}

const RULES: RulePack[] = [
  // ---- preference ----
  {
    category: "preference",
    base: 0.92,
    pattern:
      /\b([A-Z][\w]{1,32})'s\s+(favorite|preferred|chosen|default)\s+(\w+)\s+is\s+([A-Za-z][\w\s.\-/+]{1,60}?)(?=[.\n]|$)/g,
    build: (m) => ({
      subject: m[1].trim(),
      predicate: `${m[2]}_${m[3]}`.toLowerCase(),
      object: m[4].trim(),
    }),
  },
  {
    category: "preference",
    base: 0.78,
    pattern: /\b([A-Z][\w]{1,32})\s+(prefers|likes|loves)\s+([A-Za-z][\w.\-/+]{0,59})\b/g,
    build: (m) => ({
      subject: m[1].trim(),
      predicate: m[2].toLowerCase(),
      object: m[3].trim(),
    }),
  },

  // ---- identity ----
  {
    category: "identity",
    base: 0.85,
    pattern:
      /\b([A-Z][\w]{1,32})\s+is\s+a(?:n)?\s+([A-Za-z][\w\s.\-/+]{1,60}?)(?=[.\n]|$)/g,
    build: (m) => ({
      subject: m[1].trim(),
      predicate: "is_a",
      object: m[2].trim(),
    }),
  },
  {
    category: "identity",
    base: 0.88,
    pattern:
      /\b([A-Z][\w]{1,32})\s+works\s+(?:at|for)\s+([A-Z][\w.\-/+]{0,59})\b/g,
    build: (m) => ({
      subject: m[1].trim(),
      predicate: "works_at",
      object: m[2].trim(),
    }),
  },

  // ---- decision ----
  {
    category: "decision",
    base: 0.82,
    pattern:
      /\b(we|i|they)\s+decided\s+to\s+([a-z][\w\s.\-/+]{1,80}?)(?=[.\n]|$)/gi,
    build: (m) => ({
      subject: m[1].toLowerCase() === "i" ? "I" : m[1].toLowerCase(),
      predicate: "decided_to",
      object: m[2].trim(),
    }),
  },
  {
    category: "decision",
    base: 0.8,
    pattern:
      /\b(we|i|they)\s+chose\s+([A-Za-z][\w.\-/+]{0,59})\s+over\s+([A-Za-z][\w.\-/+]{0,59})\b/gi,
    build: (m) => ({
      subject: m[1].toLowerCase() === "i" ? "I" : m[1].toLowerCase(),
      predicate: "chose_over",
      object: `${m[2].trim()}/${m[3].trim()}`,
    }),
  },

  // ---- project_state ----
  {
    category: "project_state",
    base: 0.78,
    pattern:
      /\b([A-Za-z][\w\-]{1,32})\s+is\s+using\s+([A-Za-z][\w.\-/+]{0,59})(?:\s+for\s+([A-Za-z][\w\s.\-/+]{0,59}?))?(?=[.\n]|$)/g,
    build: (m) => {
      const subj = m[1];
      // Skip pronouns/common words to avoid over-matching
      if (/^(it|he|she|they|we|i|the|a|an)$/i.test(subj)) return null;
      const purpose = m[3]?.trim();
      return {
        subject: subj.trim(),
        predicate: purpose ? `uses_for_${purpose.replace(/\s+/g, "_")}` : "uses",
        object: m[2].trim(),
      };
    },
  },
  {
    category: "project_state",
    base: 0.7,
    pattern:
      /\b(?:we|i)\s+(?:shipped|deployed|merged|released)\s+(?:the\s+)?([A-Za-z][\w\s.\-/+]{1,60}?)(?=[.\n]|$)/gi,
    build: (m) => ({
      subject: "we",
      predicate: "shipped",
      object: m[1].trim(),
    }),
  },

  // ---- environment ----
  {
    category: "environment",
    base: 0.82,
    pattern:
      /\b([A-Za-z][\w\-]{1,40})\s+runs\s+on\s+([A-Za-z][\w.\-/+: ]{1,60}?)(?=[.\n]|$)/g,
    build: (m) => ({
      subject: m[1].trim(),
      predicate: "runs_on",
      object: m[2].trim(),
    }),
  },
  {
    category: "environment",
    base: 0.85,
    pattern:
      /\b([A-Za-z][\w\s\-]{0,40}?)\s+lives\s+at\s+(~?[\/\w.\-]+)/g,
    build: (m) => ({
      subject: m[1].trim(),
      predicate: "lives_at",
      object: m[2].trim(),
    }),
  },

  // ---- generic uses (fallback, lower confidence) ----
  {
    category: "project_state",
    base: 0.6,
    pattern:
      /\b([A-Z][\w]{1,32})\s+(uses|runs|owns)\s+([A-Za-z][\w.\-/+]{0,59})(?=\s+(?:as|for|in|at|by|on|daily|the|a|an)\b|[.\n]|$)/g,
    build: (m) => ({
      subject: m[1].trim(),
      predicate: m[2].toLowerCase(),
      object: m[3].trim(),
    }),
  },
];

export interface ExtractStructuredFactsOptions {
  minConfidence?: number;
}

export function extractStructuredFacts(
  text: string,
  opts: ExtractStructuredFactsOptions = {},
): ExtractedFact[] {
  if (!text) return [];
  const out: ExtractedFact[] = [];

  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const m of text.matchAll(re)) {
      const built = rule.build(m);
      if (!built) continue;
      const span = m[0];
      const { hedge, negated } = detectHedgeAndNegation(span);
      let confidence = rule.base;
      if (hedge > 0) confidence -= 0.2 * Math.min(hedge, 2);
      if (negated) confidence = Math.min(confidence, 0.15);
      confidence = clamp01(confidence);

      out.push({
        subject: built.subject,
        predicate: built.predicate,
        object: built.object,
        category: rule.category,
        confidence,
        source_span: span,
      });
    }
  }

  const deduped = dedupeWithKey(
    out,
    (f) => `${f.subject}|${f.predicate}|${f.object}|${f.category}`,
  );

  const min = opts.minConfidence;
  if (typeof min === "number") {
    return deduped.filter((f) => f.confidence >= min);
  }
  return deduped;
}
