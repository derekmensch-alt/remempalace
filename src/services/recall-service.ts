import type { ReadBundle } from "../router.js";

export interface RecallRouter {
  extractCandidates(prompt: string): string[];
  readBundle(
    query: string,
    limit: number,
    opts?: { entityCandidates?: string[] },
  ): Promise<ReadBundle>;
}

export interface RecallResult {
  candidates: string[];
  bundle: ReadBundle;
}

export type RecallMode = "cheap" | "full";

export interface CheapRecallInput {
  prompt: string;
  diaryEntries?: unknown[];
  maxDiaryEntries?: number;
}

export class RecallService {
  constructor(private readonly router: RecallRouter) {}

  shouldSkipRecall(prompt: string): boolean {
    const trimmed = prompt.trim();
    if (!trimmed) return true;

    const normalized = trimmed
      .toLowerCase()
      .replace(/[.!?,;:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (isLowSemanticAcknowledgement(normalized)) return true;
    if (isToolFollowUpChatter(normalized)) return true;
    if (/[?]/.test(trimmed)) return false;
    if (this.extractCandidates(trimmed).length > 0) return false;

    const words = normalized.split(" ").filter(Boolean);
    return words.length <= 2;
  }

  extractCandidates(prompt: string): string[] {
    return this.router.extractCandidates(prompt);
  }

  selectRecallMode(prompt: string, candidates = this.extractCandidates(prompt)): RecallMode {
    const trimmed = prompt.trim();
    if (!trimmed) return "cheap";
    if (/[?]/.test(trimmed)) return "full";
    if (candidates.length > 0) return "full";
    if (isPriorContextPrompt(normalizePrompt(trimmed))) return "full";
    return "cheap";
  }

  readBundle(
    prompt: string,
    limit: number,
    candidates: string[],
    opts: { mode?: RecallMode } = {},
  ): Promise<ReadBundle> {
    if ((opts.mode ?? "full") === "cheap") {
      return Promise.resolve({ searchResults: [], kgResults: { facts: [] } });
    }
    return this.router.readBundle(prompt, limit, { entityCandidates: candidates });
  }

  async recall(prompt: string, limit: number): Promise<RecallResult> {
    const candidates = this.extractCandidates(prompt);
    const bundle = await this.readBundle(prompt, limit, candidates, {
      mode: this.selectRecallMode(prompt, candidates),
    });
    return { candidates, bundle };
  }

  buildCheapMemoryLines(input: CheapRecallInput): string[] {
    const entries = selectRelevantDiaryEntries(input.prompt, input.diaryEntries ?? [], {
      maxEntries: input.maxDiaryEntries ?? 2,
    });
    if (entries.length === 0) return [];
    return [
      "RECENT DIARY (source=remempalace diary prefetch, cheap tier):",
      ...entries.map((entry) => `- ${entry}`),
    ];
  }
}

function normalizePrompt(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLowSemanticAcknowledgement(text: string): boolean {
  return /^(ok|okay|k|thanks|thank you|thx|got it|sounds good|makes sense|cool|great|continue|go on|yep|yeah|yes|no|next)$/.test(
    text,
  );
}

function isToolFollowUpChatter(text: string): boolean {
  return /^(done|ran it|tests? passed|tests? failed|tool finished|command finished|looks good|that worked|fixed)$/.test(
    text,
  );
}

function isPriorContextPrompt(text: string): boolean {
  return /\b(remember|recall|remind me|what did|what was|last time|last session|previous|earlier|before|history|timeline)\b/.test(
    text,
  );
}

const STOP_WORDS = new Set([
  "about",
  "again",
  "after",
  "before",
  "continue",
  "could",
  "please",
  "proceed",
  "should",
  "that",
  "their",
  "there",
  "these",
  "this",
  "with",
  "would",
]);

function selectRelevantDiaryEntries(
  prompt: string,
  entries: unknown[],
  opts: { maxEntries: number },
): string[] {
  const promptTerms = lexicalTerms(prompt);
  if (promptTerms.size === 0) return [];
  return entries
    .map((entry) => diaryEntryContent(entry))
    .filter((content): content is string => typeof content === "string" && content.length > 0)
    .map((content) => ({ content, score: lexicalOverlapScore(promptTerms, content) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxEntries)
    .map((entry) => truncateLine(entry.content, 180));
}

function diaryEntryContent(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim();
  if (!entry || typeof entry !== "object") return null;
  const record = entry as { content?: unknown; entry?: unknown };
  const content = record.content ?? record.entry;
  return typeof content === "string" ? content.trim() : null;
}

function lexicalOverlapScore(promptTerms: Set<string>, content: string): number {
  const contentTerms = lexicalTerms(content);
  let score = 0;
  for (const term of promptTerms) {
    if (contentTerms.has(term)) score += 1;
  }
  return score;
}

function lexicalTerms(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return new Set();
  return new Set(
    normalized
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)),
  );
}

function truncateLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  const capped = collapsed.slice(0, maxChars);
  const lastSpace = capped.lastIndexOf(" ");
  return `${lastSpace > 0 ? capped.slice(0, lastSpace) : capped}...`;
}
