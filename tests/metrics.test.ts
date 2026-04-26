import { describe, it, expect } from "vitest";
import { Metrics } from "../src/metrics.js";

describe("Metrics", () => {
  it("starts empty", () => {
    const m = new Metrics();
    expect(m.snapshot()).toEqual({});
  });

  it("increments counters by 1 by default", () => {
    const m = new Metrics();
    m.inc("recall.invoked");
    m.inc("recall.invoked");
    expect(m.snapshot()).toEqual({ "recall.invoked": 2 });
  });

  it("increments by an explicit amount", () => {
    const m = new Metrics();
    m.inc("injection.tokens_l1", 250);
    m.inc("injection.tokens_l1", 175);
    expect(m.snapshot()["injection.tokens_l1"]).toBe(425);
  });

  it("tracks unrelated counters independently", () => {
    const m = new Metrics();
    m.inc("a");
    m.inc("b", 5);
    expect(m.snapshot()).toEqual({ a: 1, b: 5 });
  });

  it("ignores non-finite increments rather than poisoning the counter", () => {
    const m = new Metrics();
    m.inc("x", 3);
    m.inc("x", Number.NaN);
    m.inc("x", Number.POSITIVE_INFINITY);
    expect(m.snapshot().x).toBe(3);
  });

  it("snapshot is a copy, not a live reference", () => {
    const m = new Metrics();
    m.inc("foo", 1);
    const snap = m.snapshot();
    m.inc("foo", 1);
    expect(snap.foo).toBe(1);
  });

  it("reset clears all counters", () => {
    const m = new Metrics();
    m.inc("a", 5);
    m.inc("b", 10);
    m.reset();
    expect(m.snapshot()).toEqual({});
  });
});
