import type { CacheStats } from "../cache.js";
import type { LoadedHealthCache } from "../services/health-cache-store.js";
import type { CircuitBreakerSnapshot } from "../services/circuit-breaker.js";
import type { StageLatencySnapshot } from "../services/metrics-service.js";
import {
  buildStatusReport,
  type DiaryStatus,
  type LastRecallStatus,
} from "../status-command.js";

export interface StatusControllerOptions {
  isMcpReady: () => boolean;
  canWriteDiary: () => boolean;
  canReadDiary: () => boolean;
  canInvalidateKg: () => boolean;
  canPersistDiary: () => boolean;
  searchCacheStats: () => CacheStats;
  kgCacheStats: () => CacheStats;
  metricsSnapshot: () => Record<string, number>;
  latencySnapshot: () => Record<string, StageLatencySnapshot>;
  breakersSnapshot: () => {
    search: CircuitBreakerSnapshot;
    kg: CircuitBreakerSnapshot;
    diary: CircuitBreakerSnapshot;
  };
  diaryStatus: () => Promise<DiaryStatus>;
  lastProbeAt: () => number | null;
  lastProbeReason: () => string | null;
  coldStartHealth: () => LoadedHealthCache | null;
}

export interface StatusCommandApi {
  registerCommand?: (command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: () => { text: string } | Promise<{ text: string }>;
  }) => void;
}

export class StatusController {
  private lastRecall: LastRecallStatus | null = null;

  constructor(private readonly opts: StatusControllerOptions) {}

  recordRecall(status: LastRecallStatus): void {
    this.lastRecall = status;
  }

  registerCommand(api: StatusCommandApi): void {
    if (typeof api.registerCommand !== "function") return;
    api.registerCommand({
      name: "remempalace",
      description: "Show remempalace memory plugin status (health, latency, breakers, diary)",
      acceptsArgs: false,
      handler: async () => ({ text: await this.buildText() }),
    });
  }

  async buildText(): Promise<string> {
    const liveReport = buildStatusReport({
      mcpReady: this.opts.isMcpReady(),
      canWriteDiary: this.opts.canWriteDiary(),
      canReadDiary: this.opts.canReadDiary(),
      canInvalidateKg: this.opts.canInvalidateKg(),
      canPersistDiary: this.opts.canPersistDiary(),
      searchCache: this.opts.searchCacheStats(),
      kgCache: this.opts.kgCacheStats(),
      metrics: this.opts.metricsSnapshot(),
      latency: this.opts.latencySnapshot(),
      breakers: this.opts.breakersSnapshot(),
      diary: await this.opts.diaryStatus(),
      lastProbeAt: this.opts.lastProbeAt(),
      lastProbeReason: this.opts.lastProbeReason(),
      lastRecall: this.lastRecall,
    });

    const coldStartHint = this.buildColdStartHint();
    return coldStartHint ? `${liveReport}\n${coldStartHint}` : liveReport;
  }

  private buildColdStartHint(): string | null {
    if (this.opts.isMcpReady()) return null;
    const coldStartHealth = this.opts.coldStartHealth();
    if (!coldStartHealth) return null;

    const h = coldStartHealth.snapshot;
    const age = Math.round((Date.now() - h.savedAt) / 1000);
    const staleMark = coldStartHealth.stale ? " [stale]" : "";
    const hintLines = [
      "",
      `cold_start_hint (${age}s ago${staleMark}):`,
      `  mcp_ready: ${h.mcpReady}`,
      `  diary_persistence: ${h.diaryPersistenceState}`,
      `  capabilities: write=${h.capabilities.canWriteDiary} read=${h.capabilities.canReadDiary} kg_invalidate=${h.capabilities.canInvalidateKg} persist=${h.capabilities.canPersistDiary}`,
    ];
    if (h.lastProbeAt !== null) {
      const probeAge = Math.round((Date.now() - h.lastProbeAt) / 1000);
      hintLines.push(`  last_probe: ${probeAge}s ago — ${h.lastProbeReason ?? "unknown"}`);
    }
    if (h.lastReplay) {
      hintLines.push(
        `  last_replay: ${h.lastReplay.succeeded}/${h.lastReplay.attempted} succeeded`,
      );
    }
    return hintLines.join("\n");
  }
}
