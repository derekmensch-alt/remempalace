import { dedupeWithKey } from "./dedup.js";
import type { ExtractedFact, FactCategory } from "./types.js";

interface RulePack {
  category: FactCategory;
  pattern: RegExp;
  base: number;
  build: (m: RegExpMatchArray) => BuiltFact | BuiltFact[] | null;
}

interface BuiltFact {
  subject: string;
  predicate: string;
  object: string;
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
  /\b(?:not|doesn't|don't|didn't|never|no longer|isn't|aren't|wasn't|won't)\b/i,
  /\b(?:does|do|did|is|are|was|will)\s+not\b/i,
];

const STABLE_PREDICATES = new Set([
  "chose_over",
  "decided_to",
  "is_a",
  "likes",
  "lives_at",
  "loves",
  "owns",
  "prefers",
  "runs",
  "runs_on",
  "shipped",
  "used_for",
  "uses",
  "works_at",
]);

const STABLE_PREFIXES = ["chosen_", "default_", "favorite_", "preferred_", "primary_"];

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

function splitConjunctionList(value: string): string[] {
  return value
    .split(/\s+(?:and|&)\s+/i)
    .map((part) => part.trim().replace(/[.,;:]+$/g, ""))
    .filter(Boolean);
}

function normalizePredicate(predicate: string): string | null {
  const normalized = predicate
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (STABLE_PREDICATES.has(normalized)) return normalized;
  if (STABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return normalized;
  return null;
}

function normalizeBuiltFacts(built: BuiltFact | BuiltFact[] | null): BuiltFact[] {
  if (!built) return [];
  const facts = Array.isArray(built) ? built : [built];
  return facts.flatMap((fact) => {
    const predicate = normalizePredicate(fact.predicate);
    if (!predicate) return [];
    const subject = fact.subject.trim();
    const object = fact.object.trim();
    if (!subject || !object) return [];
    return [{ ...fact, subject, predicate, object }];
  });
}

function buildConjoinedFacts(
  subject: string,
  predicate: string,
  objectText: string,
): BuiltFact[] {
  return splitConjunctionList(objectText).map((object) => ({
    subject,
    predicate,
    object,
  }));
}

function buildUsingFacts(subject: string, objectText: string): BuiltFact[] {
  const facts: BuiltFact[] = [];
  for (const rawPart of splitConjunctionList(objectText)) {
    const purposeMatch = rawPart.match(/^(.+?)\s+for\s+(.+)$/i);
    if (!purposeMatch) {
      facts.push({ subject, predicate: "uses", object: rawPart });
      continue;
    }
    const tool = purposeMatch[1].trim();
    const purpose = purposeMatch[2].trim();
    facts.push({ subject, predicate: "uses", object: tool });
    facts.push({ subject, predicate: "used_for", object: `${tool} for ${purpose}` });
  }
  return facts;
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
    pattern:
      /\b([A-Z][\w]{1,32})\s+(prefers|likes|loves)\s+([A-Za-z][\w\s.\-/+]{0,59}?)(?=[.\n]|$)/g,
    build: (m) => buildConjoinedFacts(m[1].trim(), m[2].toLowerCase(), m[3]),
  },

  // ---- identity ----
  {
    category: "identity",
    base: 0.85,
    pattern:
      /\b([A-Z][\w]{1,32})\s+is\s+a(?:n)?\s+([A-Za-z][\w\s.\-/+]{1,60}?)(?=[.\n]|$)/g,
    build: (m) => buildConjoinedFacts(m[1].trim(), "is_a", m[2]),
  },
  {
    category: "identity",
    base: 0.88,
    pattern:
      /\b([A-Z][\w]{1,32})\s+works\s+(?:at|for)\s+([A-Z][\w\s.\-/+]{0,80}?)(?=[.\n]|$)/g,
    build: (m) => buildConjoinedFacts(m[1].trim(), "works_at", m[2]),
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
      /\b([A-Za-z][\w\-]{1,32})\s+is\s+using\s+([A-Za-z][\w\s.\-/+]{0,120}?)(?=[.\n]|$)/g,
    build: (m) => {
      const subj = m[1];
      // Skip pronouns/common words to avoid over-matching
      if (/^(it|he|she|they|we|i|the|a|an)$/i.test(subj)) return null;
      return buildUsingFacts(subj.trim(), m[2]);
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
      const builtFacts = normalizeBuiltFacts(built);
      if (builtFacts.length === 0) continue;
      const span = m[0];
      const { hedge, negated } = detectHedgeAndNegation(span);
      if (negated) continue;
      let confidence = rule.base;
      if (hedge > 0) confidence -= 0.2 * Math.min(hedge, 2);
      confidence = clamp01(confidence);

      for (const fact of builtFacts) {
        out.push({
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          category: rule.category,
          confidence,
          source_span: span,
        });
      }
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
