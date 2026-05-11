import { countTokens } from "./token-counter.js";
import type { Metrics } from "./metrics.js";
import type { MemPalaceRepository } from "./ports/mempalace-repository.js";
import { DiaryService } from "./services/diary-service.js";

interface SessionMessage {
  role?: string;
  content?: unknown;
}

interface DiaryEntry {
  turns: number;
  goals: string[];
  decisions: string[];
  facts_to_remember: string[];
  open_threads: string[];
  early_context: string;
  late_context: string;
}

function extractContent(msg: SessionMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part && typeof part.text === "string"
            ? part.text
            : "",
      )
      .join(" ");
  }
  return "";
}

function extractGoals(userTurns: string[]): string[] {
  return userTurns.slice(0, 3).map((t) => t.slice(0, 150)).filter(Boolean);
}

function extractDecisions(assistantTurns: string[]): string[] {
  return assistantTurns.slice(-3).map((t) => t.slice(0, 150)).filter(Boolean);
}

const FACT_PATTERNS = /\b(I use |my project is |I am |I have |I prefer |I work |I'm )/i;

function extractFacts(userTurns: string[]): string[] {
  const facts: string[] = [];
  for (const turn of userTurns) {
    for (const sentence of turn.split(/[.!?\n]+/)) {
      const s = sentence.trim();
      if (FACT_PATTERNS.test(s)) facts.push(s.slice(0, 120));
    }
  }
  return facts;
}

function extractOpenThreads(lastUserTurns: string[]): string[] {
  const threads: string[] = [];
  for (const turn of lastUserTurns.slice(-2)) {
    for (const sentence of turn.split(/[.!?\n]+/)) {
      const s = sentence.trim();
      if (/\?|TODO|TBD|unresolved|not sure|unclear|open/i.test(s)) {
        threads.push(s.slice(0, 120));
      }
    }
  }
  return threads;
}

function fitToTokenBudget(entry: DiaryEntry, maxTokens: number): DiaryEntry {
  const fits = (e: DiaryEntry) => countTokens(JSON.stringify(e)) <= maxTokens;
  if (fits(entry)) return entry;

  const e = { ...entry, open_threads: [] as string[] };
  if (fits(e)) return e;

  const e2 = { ...e, facts_to_remember: [] as string[] };
  if (fits(e2)) return e2;

  const e3 = { ...e2 };
  while (e3.decisions.length > 1 && !fits(e3)) {
    e3.decisions = e3.decisions.slice(1);
  }
  if (fits(e3)) return e3;

  const e4 = { ...e3 };
  while (e4.goals.length > 1 && !fits(e4)) {
    e4.goals = e4.goals.slice(1);
  }
  return e4;
}

export function summarizeSession(
  messages: SessionMessage[],
  opts: { maxTokens: number },
): string {
  if (messages.length === 0) return "";

  const userTurns = messages.filter((m) => m.role !== "assistant").map(extractContent);
  const assistantTurns = messages.filter((m) => m.role === "assistant").map(extractContent);

  const entry: DiaryEntry = {
    turns: messages.length,
    goals: extractGoals(userTurns),
    decisions: extractDecisions(assistantTurns),
    facts_to_remember: extractFacts(userTurns),
    open_threads: extractOpenThreads(userTurns),
    early_context: (userTurns[0] ?? "").slice(0, 200),
    late_context: (userTurns[userTurns.length - 1] ?? "").slice(0, 200),
  };

  return JSON.stringify(fitToTokenBudget(entry, opts.maxTokens));
}

export interface WriteDiaryOptions {
  localDir?: string;
}

export function writeDiaryAsync(
  repository: Pick<MemPalaceRepository, "canPersistDiary" | "writeDiary">,
  summary: string,
  metrics?: Metrics,
  options?: WriteDiaryOptions,
): void {
  new DiaryService({ repository, metrics, localDir: options?.localDir }).writeSessionSummaryAsync(summary);
}
