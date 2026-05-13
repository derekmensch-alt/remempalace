import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitBreaker, BackendCircuitBreakers } from "../src/services/circuit-breaker.js";
import { BackendUnavailable } from "../src/ports/mempalace-repository.js";

function makeBreaker(opts: {
  failureThreshold?: number;
  windowMs?: number;
  cooldownMs?: number;
  now?: () => number;
} = {}): CircuitBreaker {
  return new CircuitBreaker({
    failureThreshold: opts.failureThreshold ?? 3,
    windowMs: opts.windowMs ?? 10_000,
    cooldownMs: opts.cooldownMs ?? 15_000,
    now: opts.now,
  });
}

describe("CircuitBreaker", () => {
  it("starts closed and allows calls", async () => {
    const cb = makeBreaker();
    const result = await cb.call(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(cb.snapshot().state).toBe("closed");
  });

  it("stays closed on one failure below threshold", async () => {
    const cb = makeBreaker({ failureThreshold: 3 });
    await cb.call(() => Promise.reject(new Error("boom"))).catch(() => {});
    expect(cb.snapshot().state).toBe("closed");
  });

  it("opens after N consecutive failures within window", async () => {
    const cb = makeBreaker({ failureThreshold: 3, windowMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      await cb.call(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    expect(cb.snapshot().state).toBe("open");
  });

  it("records last failure reason", async () => {
    const cb = makeBreaker({ failureThreshold: 2 });
    await cb.call(() => Promise.reject(new Error("network error"))).catch(() => {});
    await cb.call(() => Promise.reject(new Error("timeout"))).catch(() => {});
    expect(cb.snapshot().lastFailureReason).toBe("timeout");
  });

  it("throws BackendUnavailable immediately when open", async () => {
    const cb = makeBreaker({ failureThreshold: 2 });
    await cb.call(() => Promise.reject(new Error("fail"))).catch(() => {});
    await cb.call(() => Promise.reject(new Error("fail"))).catch(() => {});
    // Now open
    await expect(cb.call(() => Promise.resolve("ok"))).rejects.toBeInstanceOf(BackendUnavailable);
  });

  it("transitions to half-open after cooldown", async () => {
    let t = 0;
    const now = () => t;
    const cb = makeBreaker({ failureThreshold: 2, cooldownMs: 1000, now });
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    expect(cb.snapshot().state).toBe("open");

    t = 2000; // advance past cooldown
    // Next call should be allowed (half-open trial)
    const result = await cb.call(() => Promise.resolve("trial"));
    expect(result).toBe("trial");
    expect(cb.snapshot().state).toBe("closed");
  });

  it("half-open success closes the breaker", async () => {
    let t = 0;
    const now = () => t;
    const cb = makeBreaker({ failureThreshold: 2, cooldownMs: 500, now });
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    t = 1000;
    await cb.call(() => Promise.resolve("ok"));
    expect(cb.snapshot().state).toBe("closed");
    expect(cb.snapshot().openedAt).toBeNull();
  });

  it("half-open failure reopens the breaker", async () => {
    let t = 0;
    const now = () => t;
    const cb = makeBreaker({ failureThreshold: 2, cooldownMs: 500, now });
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    t = 1000;
    await cb.call(() => Promise.reject(new Error("still broken"))).catch(() => {});
    expect(cb.snapshot().state).toBe("open");
    expect(cb.snapshot().openedAt).toBe(1000);
  });

  it("resets consecutive failure counter after a window expiry", async () => {
    let t = 0;
    const now = () => t;
    const cb = makeBreaker({ failureThreshold: 3, windowMs: 5000, now });
    // Two failures in window
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    expect(cb.snapshot().state).toBe("closed");

    // Window expires — next failure starts a fresh window
    t = 10_000;
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    // Only 1 failure in new window — still closed
    expect(cb.snapshot().state).toBe("closed");
  });

  it("snapshot reflects openedAt timestamp", async () => {
    let t = 500;
    const now = () => t;
    const cb = makeBreaker({ failureThreshold: 2, now });
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => {});
    expect(cb.snapshot().openedAt).toBe(500);
  });
});

describe("BackendCircuitBreakers", () => {
  it("exposes three independent breakers: search, kg, diary", () => {
    const b = new BackendCircuitBreakers();
    expect(b.search).toBeInstanceOf(CircuitBreaker);
    expect(b.kg).toBeInstanceOf(CircuitBreaker);
    expect(b.diary).toBeInstanceOf(CircuitBreaker);
  });

  it("snapshot returns state for all three backends", () => {
    const b = new BackendCircuitBreakers();
    const snap = b.snapshot();
    expect(snap.search.state).toBe("closed");
    expect(snap.kg.state).toBe("closed");
    expect(snap.diary.state).toBe("closed");
  });

  it("each breaker trips independently", async () => {
    const b = new BackendCircuitBreakers({
      search: { failureThreshold: 2, windowMs: 10_000, cooldownMs: 5_000 },
    });
    await b.search.call(() => Promise.reject(new Error("x"))).catch(() => {});
    await b.search.call(() => Promise.reject(new Error("x"))).catch(() => {});
    expect(b.snapshot().search.state).toBe("open");
    expect(b.snapshot().kg.state).toBe("closed");
    expect(b.snapshot().diary.state).toBe("closed");
  });
});
