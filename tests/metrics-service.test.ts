import { describe, it, expect, beforeEach } from "vitest";
import { LatencyMetricsService } from "../src/services/metrics-service.js";

describe("LatencyMetricsService", () => {
  let svc: LatencyMetricsService;

  beforeEach(() => {
    svc = new LatencyMetricsService();
  });

  it("starts empty", () => {
    expect(svc.snapshot()).toEqual({});
  });

  it("records a single sample and returns it as p50/p95/last", () => {
    svc.recordLatency("mempalace_search", 42);
    const snap = svc.snapshot();
    expect(snap["mempalace_search"]).toEqual({ count: 1, p50: 42, p95: 42, lastMs: 42 });
  });

  it("tracks multiple stages independently", () => {
    svc.recordLatency("mempalace_search", 10);
    svc.recordLatency("mempalace_kg_query", 20);
    const snap = svc.snapshot();
    expect(snap["mempalace_search"].count).toBe(1);
    expect(snap["mempalace_kg_query"].count).toBe(1);
    expect(snap["mempalace_search"].lastMs).toBe(10);
    expect(snap["mempalace_kg_query"].lastMs).toBe(20);
  });

  it("computes correct p50 and p95 on a known 10-sample sequence", () => {
    // Insert 1..10 in shuffled order
    const samples = [7, 3, 9, 1, 5, 2, 8, 4, 6, 10];
    for (const s of samples) svc.recordLatency("test", s);
    const snap = svc.snapshot()["test"];
    expect(snap.count).toBe(10);
    // sorted: [1,2,3,4,5,6,7,8,9,10]
    // p50 at index 4.5 → interpolate 5 and 6 → 5.5
    expect(snap.p50).toBeCloseTo(5.5, 5);
    // p95 at index 8.55 → interpolate 9 and 10 → 9.55
    expect(snap.p95).toBeCloseTo(9.55, 5);
  });

  it("updates lastMs on each record", () => {
    svc.recordLatency("diary_write", 100);
    svc.recordLatency("diary_write", 200);
    expect(svc.snapshot()["diary_write"].lastMs).toBe(200);
  });

  it("ring buffer evicts oldest samples after 128 writes", () => {
    // Fill the ring and then add one more
    for (let i = 0; i < 128; i++) svc.recordLatency("stage", i);
    // count should cap at 128
    expect(svc.snapshot()["stage"].count).toBe(128);
    // Add 128 more — should still stay at 128
    for (let i = 200; i < 328; i++) svc.recordLatency("stage", i);
    expect(svc.snapshot()["stage"].count).toBe(128);
    // lastMs should be the most recent value
    expect(svc.snapshot()["stage"].lastMs).toBe(327);
  });

  it("ignores non-finite and negative samples", () => {
    svc.recordLatency("x", 10);
    svc.recordLatency("x", Number.NaN);
    svc.recordLatency("x", -5);
    svc.recordLatency("x", Number.POSITIVE_INFINITY);
    const snap = svc.snapshot()["x"];
    expect(snap.count).toBe(1);
    expect(snap.lastMs).toBe(10);
  });

  it("reset clears all data", () => {
    svc.recordLatency("a", 100);
    svc.reset();
    expect(svc.snapshot()).toEqual({});
  });

  it("snapshot is a copy, not a live reference", () => {
    svc.recordLatency("s", 50);
    const snap1 = svc.snapshot();
    svc.recordLatency("s", 99);
    expect(snap1["s"].count).toBe(1);
  });

  it("p50 and p95 equal single value when only one sample recorded", () => {
    svc.recordLatency("solo", 77);
    const snap = svc.snapshot()["solo"];
    expect(snap.p50).toBe(77);
    expect(snap.p95).toBe(77);
  });
});
