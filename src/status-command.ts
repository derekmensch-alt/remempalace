import type { CacheStats } from "./cache.js";
import type { DiaryHealthState, ReplayResult } from "./diary-replay.js";
import type { DiaryPersistenceState } from "./ports/mempalace-repository.js";
import type { CircuitBreakerSnapshot } from "./services/circuit-breaker.js";
import type { StageLatencySnapshot } from "./services/metrics-service.js";

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

export interface BreakersStatus {
  search: CircuitBreakerSnapshot;
  kg: CircuitBreakerSnapshot;
  diary: CircuitBreakerSnapshot;
}

export interface StatusReportInput {
  mcpReady: boolean;
  canWriteDiary: boolean;
  canReadDiary: boolean;
  canInvalidateKg: boolean;
  canPersistDiary: boolean;
  searchCache: CacheStats;
  kgCache: CacheStats;
  /** Flat counter metrics from Metrics.snapshot() — used for overrun detection. */
  metrics?: Record<string, number>;
  /** Per-stage latency snapshots from LatencyMetricsService.snapshot(). */
  latency?: Record<string, StageLatencySnapshot>;
  /** Circuit breaker state per backend. */
  breakers?: BreakersStatus;
  diary?: DiaryStatus;
  lastProbeAt?: number | null;
  lastProbeReason?: string | null;
  lastRecall?: LastRecallStatus | null;
}

// ---------------------------------------------------------------------------
// Health label derivation
// ---------------------------------------------------------------------------

/**
 * Derive the overall health label from the inputs.
 *
 * Rules (evaluated in order):
 *   offline   — MCP not ready
 *   degraded  — any circuit breaker is open OR
 *               diary persistence is fallback-active/write-ok-unverified
 *   healthy   — otherwise
 */
export type HealthLabel = "healthy" | "degraded" | "offline";

export function deriveHealthLabel(input: StatusReportInput): HealthLabel {
  if (!input.mcpReady) return "offline";

  // Circuit breakers
  if (input.breakers) {
    for (const snap of Object.values(input.breakers)) {
      if (snap.state === "open") return "degraded";
    }
  }

  // Diary persistence — degraded when state shows unverified or fallback writes
  const diaryPersistenceState = input.diary?.persistenceState;
  if (diaryPersistenceState === "write-ok-unverified") {
    return "degraded";
  }
  const diaryState = input.diary?.state;
  if (
    diaryState === "fallback-active" ||
    diaryState === "degraded" ||
    diaryState === "write-ok-unverified"
  ) {
    return "degraded";
  }

  return "healthy";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const ORDERED_STAGES = [
  "before_prompt_build.total",
  "before_prompt_build.init",
  "before_prompt_build.fetch",
  "before_prompt_build.format",
  "mempalace_search",
  "mempalace_kg_query",
  "diary_read",
  "diary_write",
] as const;

function formatLatencyLine(stage: string, snap: StageLatencySnapshot): string {
  return `  ${stage}: p50=${snap.p50.toFixed(1)}ms p95=${snap.p95.toFixed(1)}ms last=${snap.lastMs.toFixed(1)}ms n=${snap.count}`;
}

function formatBreakerLine(name: string, snap: CircuitBreakerSnapshot): string {
  if (snap.state === "closed") return `  ${name}: closed`;
  const since = snap.openedAt !== null ? ` since ${new Date(snap.openedAt).toISOString()}` : "";
  const reason = snap.lastFailureReason ? ` lastFailure="${snap.lastFailureReason}"` : "";
  return `  ${name}: ${snap.state}${since}${reason}`;
}

// ---------------------------------------------------------------------------
// Main report builder
// ---------------------------------------------------------------------------

export function buildStatusReport(input: StatusReportInput): string {
  const health = deriveHealthLabel(input);
  const lines: string[] = [];

  lines.push(`remempalace status — ${health}`);
  lines.push("");

  // Overall health label
  lines.push(`health: ${health}`);

  // Last probe
  if (input.lastProbeAt !== null && input.lastProbeAt !== undefined) {
    const probeTs = new Date(input.lastProbeAt).toISOString();
    const reason = input.lastProbeReason ?? "unknown";
    lines.push(`last_probe: ${probeTs} — ${reason}`);
  }
  lines.push("");

  // Capabilities
  lines.push("capabilities:");
  lines.push(`  mcp_ready: ${input.mcpReady ? "yes" : "no"}`);
  lines.push(`  diary_persistent: ${input.canPersistDiary ? "yes" : "no"}`);
  lines.push(`  diary_write: ${input.canWriteDiary ? "yes" : "no"}`);
  lines.push(`  diary_read: ${input.canReadDiary ? "yes" : "no"}`);
  lines.push(`  kg_writable: ${input.canInvalidateKg ? "yes" : "no"}`);
  lines.push("");

  // Circuit breakers
  if (input.breakers) {
    lines.push("circuit_breakers:");
    lines.push(formatBreakerLine("search", input.breakers.search));
    lines.push(formatBreakerLine("kg", input.breakers.kg));
    lines.push(formatBreakerLine("diary", input.breakers.diary));
    lines.push("");
  }

  // Latency summary (p50/p95, omit zero-sample stages)
  if (input.latency) {
    const stagesToShow = ORDERED_STAGES.filter(
      (s) => input.latency![s] && input.latency![s].count > 0,
    );
    // Also include any extra stages recorded outside the known list
    const extraStages = Object.keys(input.latency).filter(
      (s) => !(ORDERED_STAGES as readonly string[]).includes(s) && input.latency![s].count > 0,
    );
    if (stagesToShow.length > 0 || extraStages.length > 0) {
      lines.push("latency:");
      for (const s of stagesToShow) {
        lines.push(formatLatencyLine(s, input.latency[s]));
      }
      for (const s of extraStages.sort()) {
        lines.push(formatLatencyLine(s, input.latency[s]));
      }
      lines.push("");
    }
  }

  // Diary section
  if (input.diary) {
    lines.push("diary:");
    lines.push(`  state: ${input.diary.state}`);
    lines.push(
      `  persistence: ${input.diary.persistenceState === "persistent" ? "verified" : (input.diary.persistenceState ?? "unknown")}`,
    );
    lines.push(`  pending_fallback: ${input.diary.pending}`);
    const lr = input.diary.lastReplay;
    if (lr) {
      const when = new Date(lr.at).toISOString();
      lines.push(
        `  last_replay: ${lr.succeeded}/${lr.attempted} succeeded, ${lr.failed} failed (${when})`,
      );
    } else {
      lines.push("  last_replay: none");
    }
    if (input.diary.lastReplayError) {
      lines.push(`  last_replay_error: ${input.diary.lastReplayError}`);
    }
    lines.push("");
  }

  // Caches
  lines.push("caches:");
  lines.push(
    `  search: ${input.searchCache.hits} hits, ${input.searchCache.misses} misses, ${input.searchCache.size} entries`,
  );
  lines.push(
    `  kg: ${input.kgCache.hits} hits, ${input.kgCache.misses} misses, ${input.kgCache.size} entries`,
  );
  lines.push("");

  // Last recall
  if (input.lastRecall) {
    const r = input.lastRecall;
    lines.push("last_recall:");
    lines.push(`  session: ${r.sessionKey}`);
    lines.push(`  at: ${new Date(r.at).toISOString()}`);
    lines.push(`  prompt: ${r.promptPreview}`);
    lines.push(`  candidates: ${r.candidates.length > 0 ? r.candidates.join(", ") : "(none)"}`);
    lines.push(`  KG facts: ${r.kgFactCount}`);
    lines.push(`  search results: ${r.searchResultCount}`);
    lines.push(`  injected lines: ${r.injectedLineCount}`);
    lines.push(`  identity included: ${r.identityIncluded ? "yes" : "no"}`);
  }

  // Trim trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}
