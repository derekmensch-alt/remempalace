import { appendLocalDiary } from "../diary-local.js";
import { computeDiaryHealth, type DiaryReconciler, type ReplayResult } from "../diary-replay.js";
import type { Metrics } from "../metrics.js";
import type {
  DiaryPersistenceProbeResult,
  DiaryPersistenceState,
  MemPalaceRepository,
} from "../ports/mempalace-repository.js";

const DIARY_IO_TIMEOUT_MS = 500;

export interface DiaryStatus {
  state: ReturnType<typeof computeDiaryHealth>;
  persistenceState?: DiaryPersistenceState;
  pending: number;
  lastReplay?: ReplayResult | null;
  lastReplayError?: string | null;
}

export interface DiaryServiceOptions {
  repository: Pick<MemPalaceRepository, "canPersistDiary" | "writeDiary"> &
    Partial<Pick<MemPalaceRepository, "verifyDiaryPersistence">>;
  metrics?: Metrics;
  localDir?: string;
  now?: () => Date;
}

export interface DiaryStartupOptions {
  replayOnStart: boolean;
  reconciler: Pick<DiaryReconciler, "replay">;
  onProbeResult?: (result: DiaryPersistenceProbeResult) => void;
  onProbeError?: (err: Error) => void;
  onReplayResult?: (result: ReplayResult) => void;
  onReplayError?: (err: Error) => void;
}

export interface DiaryStatusOptions {
  reconciler: Pick<DiaryReconciler, "loadPending" | "lastReplayResult" | "lastReplayError">;
}

export class DiaryService {
  private readonly now: () => Date;

  constructor(private readonly opts: DiaryServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  async verifyPersistenceAndReplay(options: DiaryStartupOptions): Promise<DiaryPersistenceProbeResult | null> {
    if (!this.opts.repository.verifyDiaryPersistence) return null;

    let probe: DiaryPersistenceProbeResult;
    try {
      probe = await this.opts.repository.verifyDiaryPersistence({ timeoutMs: DIARY_IO_TIMEOUT_MS });
    } catch (err) {
      options.onProbeError?.(err instanceof Error ? err : new Error(String(err)));
      return null;
    }
    options.onProbeResult?.(probe);

    if (!options.replayOnStart || !this.opts.repository.canPersistDiary) return probe;

    options.reconciler
      .replay()
      .then((result) => options.onReplayResult?.(result))
      .catch((err: Error) => options.onReplayError?.(err));

    return probe;
  }

  async getStatus(options: DiaryStatusOptions): Promise<DiaryStatus> {
    const pending = await options.reconciler.loadPending().catch(() => []);
    const persistenceState = this.resolvePersistenceState();
    return {
      state: computeDiaryHealth({
        persistenceState,
        pending: pending.length,
        lastReplay: options.reconciler.lastReplayResult,
      }),
      persistenceState,
      pending: pending.length,
      lastReplay: options.reconciler.lastReplayResult,
      lastReplayError: options.reconciler.lastReplayError,
    };
  }

  writeSessionSummaryAsync(summary: string): void {
    this.opts.metrics?.inc("diary.write.attempted");

    if (this.opts.repository.canPersistDiary) {
      void this.opts.repository
        .writeDiary({
          agentName: "remempalace",
          entry: summary,
          topic: "session",
          timeoutMs: DIARY_IO_TIMEOUT_MS,
        })
        .then(() => this.opts.metrics?.inc("diary.write.mcp_succeeded"))
        .catch(() => {
          this.opts.metrics?.inc("diary.write.mcp_failed");
          return this.writeLocal(summary);
        });
      return;
    }

    this.opts.metrics?.inc("diary.write.persistence_unverified");
    void this.writeLocal(summary);
  }

  private writeLocal(summary: string): Promise<void> {
    this.opts.metrics?.inc("diary.write.fallback");
    return appendLocalDiary(
      {
        wing: "remempalace",
        room: "session",
        content: summary,
        ts: this.now().toISOString(),
      },
      undefined,
      this.opts.localDir,
    ).catch(() => {});
  }

  private resolvePersistenceState(): DiaryPersistenceState {
    const repository = this.opts.repository as Partial<Pick<MemPalaceRepository, "diaryPersistenceState">>;
    return repository.diaryPersistenceState ?? (this.opts.repository.canPersistDiary ? "persistent" : "unavailable");
  }
}
