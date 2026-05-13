/**
 * CircuitBreaker — simple per-backend state machine.
 *
 * States:
 *   closed     → normal; failures increment a counter
 *   open       → fast-fail; enters after N consecutive failures within windowMs
 *   half-open  → one trial call allowed after cooldownMs from open
 *
 * When open, calls throw BackendUnavailable immediately.
 * No external dependencies; uses Date.now() for time.
 */

import { BackendUnavailable } from "../ports/mempalace-repository.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures within windowMs that trips the breaker. */
  failureThreshold?: number;
  /** Window (ms) over which consecutive failures are counted. */
  windowMs?: number;
  /** How long (ms) the breaker stays open before allowing a trial call. */
  cooldownMs?: number;
  /** Injected clock for testing. Defaults to Date.now. */
  now?: () => number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  openedAt: number | null;
  lastFailureReason: string | null;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 15_000;

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private windowStart = 0;
  private openedAt: number | null = null;
  private lastFailureReason: string | null = null;

  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Wrap a backend call with circuit-breaker logic.
   * Throws BackendUnavailable immediately when the breaker is open.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const t = this.now();
    if (this.state === "open") {
      if (this.openedAt !== null && t - this.openedAt >= this.cooldownMs) {
        this.state = "half-open";
      } else {
        throw new BackendUnavailable(
          new Error(`circuit open: ${this.lastFailureReason ?? "repeated failures"}`),
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.windowStart = 0;
    this.openedAt = null;
  }

  private onFailure(err: unknown): void {
    const t = this.now();
    const reason = err instanceof Error ? err.message : String(err);
    this.lastFailureReason = reason;

    // If we were half-open, a failure trips directly back to open.
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = t;
      this.consecutiveFailures = this.failureThreshold;
      return;
    }

    // In closed state, track consecutive failures within the window.
    if (this.consecutiveFailures === 0 || t - this.windowStart > this.windowMs) {
      // Start a new window.
      this.windowStart = t;
      this.consecutiveFailures = 1;
    } else {
      this.consecutiveFailures++;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = t;
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      openedAt: this.openedAt,
      lastFailureReason: this.lastFailureReason,
    };
  }
}

// ---------------------------------------------------------------------------
// BackendCircuitBreakers — named breakers for search, kg, diary
// ---------------------------------------------------------------------------

export interface BackendCircuitBreakerOptions {
  search?: CircuitBreakerOptions;
  kg?: CircuitBreakerOptions;
  diary?: CircuitBreakerOptions;
}

export interface BackendBreakersSnapshot {
  search: CircuitBreakerSnapshot;
  kg: CircuitBreakerSnapshot;
  diary: CircuitBreakerSnapshot;
}

export class BackendCircuitBreakers {
  readonly search: CircuitBreaker;
  readonly kg: CircuitBreaker;
  readonly diary: CircuitBreaker;

  constructor(opts: BackendCircuitBreakerOptions = {}) {
    this.search = new CircuitBreaker(opts.search ?? {});
    this.kg = new CircuitBreaker(opts.kg ?? {});
    this.diary = new CircuitBreaker(opts.diary ?? {});
  }

  snapshot(): BackendBreakersSnapshot {
    return {
      search: this.search.snapshot(),
      kg: this.kg.snapshot(),
      diary: this.diary.snapshot(),
    };
  }
}
