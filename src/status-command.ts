import type { CacheStats } from "./cache.js";
import type { DiaryHealthState, ReplayResult } from "./diary-replay.js";
import type { DiaryPersistenceState } from "./ports/mempalace-repository.js";

export interface DiaryStatus {
  state: DiaryHealthState;
  persistenceState?: DiaryPersistenceState;
  pending: number;
  lastReplay?: ReplayResult | null;
  lastReplayError?: string | null;
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
  canWriteDiary: boolean;
  canReadDiary: boolean;
  canInvalidateKg: boolean;
  searchCache: CacheStats;
  kgCache: CacheStats;
  metrics?: Record<string, number>;
  diary?: DiaryStatus;
  lastRecall?: LastRecallStatus | null;
}

function formatCacheLine(label: string, s: CacheStats): string {
  return `${label}: ${s.hits} hits, ${s.misses} misses, ${s.size} entries`;
}

function formatLatencySummary(metrics: Record<string, number> | undefined): string[] {
  if (!metrics) return [];
  const stages = ["init", "fetch", "format", "total"] as const;
  const lines: string[] = [];
  for (const stage of stages) {
    const total = metrics[`latency.before_prompt_build.${stage}.ms_total`];
    const count = metrics[`latency.before_prompt_build.${stage}.count`];
    if (!total || !count) continue;
    const avgMs = total / count;
    const maxMs =
      stage === "total" ? metrics["latency.before_prompt_build.total.max_ms"] : undefined;
    lines.push(
      stage === "total" && Number.isFinite(maxMs)
        ? `  ${stage}: avg=${avgMs.toFixed(1)}ms max=${(maxMs ?? 0).toFixed(1)}ms n=${count}`
        : `  ${stage}: avg=${avgMs.toFixed(1)}ms n=${count}`,
    );
  }
  return lines;
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
  lines.push(`  diary_write: ${input.canWriteDiary ? "ok" : "missing (falling back to local JSONL)"}`);
  lines.push(`  diary_read:  ${input.canReadDiary ? "ok" : "missing"}`);
  lines.push(`  kg_invalidate: ${input.canInvalidateKg ? "ok" : "missing (conflict invalidation disabled)"}`);

  lines.push("");
  lines.push("Caches:");
  lines.push(`  ${formatCacheLine("search cache", input.searchCache)}`);
  lines.push(`  ${formatCacheLine("kg cache", input.kgCache)}`);

  if (input.diary) {
    lines.push("");
    lines.push("Diary:");
    lines.push(`  state: ${input.diary.state}`);
    lines.push(
      `  persistence: ${input.diary.persistenceState === "persistent" ? "verified" : "unverified"}`,
    );
    lines.push(`  pending: ${input.diary.pending}`);
    const lr = input.diary.lastReplay;
    if (lr) {
      const when = new Date(lr.at).toISOString();
      lines.push(
        `  last replay: ${lr.attempted} attempted, ${lr.succeeded} succeeded, ${lr.failed} failed (${when})`,
      );
    }
    if (input.diary.lastReplayError) {
      lines.push(`  last replay error: ${input.diary.lastReplayError}`);
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
    const latencyLines = formatLatencySummary(input.metrics);
    if (latencyLines.length > 0) {
      lines.push("");
      lines.push("Latency:");
      lines.push(...latencyLines);
    }

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
