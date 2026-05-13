/**
 * LatencyMetricsService — per-stage ring-buffer latency tracking.
 *
 * No external dependencies. Uses a fixed-size ring buffer per stage (~128
 * samples). p50/p95 are computed from a sorted copy on snapshot() — cheap for
 * ring sizes of 128.
 */

const RING_SIZE = 128;

interface StageBucket {
  samples: number[];
  head: number;
  count: number;
  lastMs: number;
}

export interface StageLatencySnapshot {
  count: number;
  p50: number;
  p95: number;
  lastMs: number;
}

function createBucket(): StageBucket {
  return { samples: new Array<number>(RING_SIZE).fill(0), head: 0, count: 0, lastMs: 0 };
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = pct * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export class LatencyMetricsService {
  private readonly buckets = new Map<string, StageBucket>();

  /**
   * Record a latency sample (ms) for the given stage key.
   * Hot path — must stay O(1).
   */
  recordLatency(stage: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let bucket = this.buckets.get(stage);
    if (!bucket) {
      bucket = createBucket();
      this.buckets.set(stage, bucket);
    }
    bucket.samples[bucket.head] = ms;
    bucket.head = (bucket.head + 1) % RING_SIZE;
    if (bucket.count < RING_SIZE) bucket.count++;
    bucket.lastMs = ms;
  }

  /**
   * Return a snapshot of all stages with count, p50, p95, and the most-recent
   * sample. Computation is O(N log N) in ring size — cheap for N=128.
   */
  snapshot(): Record<string, StageLatencySnapshot> {
    const result: Record<string, StageLatencySnapshot> = {};
    for (const [stage, bucket] of this.buckets) {
      const n = bucket.count;
      const live =
        n < RING_SIZE
          ? bucket.samples.slice(0, n)
          : bucket.samples.slice();
      const sorted = live.slice().sort((a, b) => a - b);
      result[stage] = {
        count: n,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        lastMs: bucket.lastMs,
      };
    }
    return result;
  }

  /** Clear all stage data (useful in tests). */
  reset(): void {
    this.buckets.clear();
  }
}
