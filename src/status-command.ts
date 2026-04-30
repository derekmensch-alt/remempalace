import type { CacheStats } from "./cache.js";
import type { DiaryHealthState, ReplayResult } from "./diary-replay.js";

export interface DiaryStatus {
  state: DiaryHealthState;
  pending: number;
  lastReplay?: ReplayResult | null;
}

export interface LastRecallStatus {
  sessionKey: string;
  promptPreview: string;
  candidates: string[];
  kgFactCount: number;
  searchResultCount: number;
  injectedLineCount: number;
  identityIncluded: boolean;
  at: number;
}

export interface StatusReportInput {
  mcpReady: boolean;
  hasDiaryWrite: boolean;
  hasDiaryRead: boolean;
  hasKgInvalidate: boolean;
  searchCache: CacheStats;
  kgCache: CacheStats;
  metrics?: Record<string, number>;
  diary?: DiaryStatus;
  lastRecall?: LastRecallStatus | null;
}

function formatCacheLine(label: string, s: CacheStats): string {
  return `${label}: ${s.hits} hits, ${s.misses} misses, ${s.size} entries`;
}

export function buildStatusReport(input: StatusReportInput): string {
  const lines: string[] = ["remempalace status", ""];

  if (input.mcpReady) {
    lines.push("MCP: ready");
  } else {
    lines.push("MCP: down / not ready (memory recall unavailable)");
  }

  lines.push("");
  lines.push("Capabilities:");
  lines.push(`  diary_write: ${input.hasDiaryWrite ? "ok" : "missing (falling back to local JSONL)"}`);
  lines.push(`  diary_read:  ${input.hasDiaryRead ? "ok" : "missing"}`);
  lines.push(`  kg_invalidate: ${input.hasKgInvalidate ? "ok" : "missing (conflict invalidation disabled)"}`);

  lines.push("");
  lines.push("Caches:");
  lines.push(`  ${formatCacheLine("search cache", input.searchCache)}`);
  lines.push(`  ${formatCacheLine("kg cache", input.kgCache)}`);

  if (input.diary) {
    lines.push("");
    lines.push("Diary:");
    lines.push(`  state: ${input.diary.state}`);
    lines.push(`  pending: ${input.diary.pending}`);
    const lr = input.diary.lastReplay;
    if (lr) {
      const when = new Date(lr.at).toISOString();
      lines.push(
        `  last replay: ${lr.attempted} attempted, ${lr.succeeded} succeeded, ${lr.failed} failed (${when})`,
      );
    }
  }

  if (input.lastRecall) {
    const r = input.lastRecall;
    lines.push("");
    lines.push("Last recall:");
    lines.push(`  session: ${r.sessionKey}`);
    lines.push(`  at: ${new Date(r.at).toISOString()}`);
    lines.push(`  prompt: ${r.promptPreview}`);
    lines.push(`  candidates: ${r.candidates.length > 0 ? r.candidates.join(", ") : "(none)"}`);
    lines.push(`  KG facts: ${r.kgFactCount}`);
    lines.push(`  search results: ${r.searchResultCount}`);
    lines.push(`  injected lines: ${r.injectedLineCount}`);
    lines.push(`  identity included: ${r.identityIncluded ? "yes" : "no"}`);
  }

  if (input.metrics) {
    lines.push("");
    lines.push("Metrics:");
    const keys = Object.keys(input.metrics).sort();
    if (keys.length === 0) {
      lines.push("  (no counters yet)");
    } else {
      for (const k of keys) {
        lines.push(`  ${k}: ${input.metrics[k]}`);
      }
    }
  }

  return lines.join("\n");
}
