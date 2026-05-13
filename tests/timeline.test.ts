import { describe, it, expect, vi } from "vitest";
import { queryTimeline, isTimelineQuery } from "../src/timeline.js";

describe("isTimelineQuery", () => {
  it("detects 'what happened' queries", () => {
    expect(isTimelineQuery("what happened last week")).toBe(true);
    expect(isTimelineQuery("What did I do yesterday?")).toBe(true);
    expect(isTimelineQuery("recap of last month")).toBe(true);
  });

  it("ignores non-timeline queries", () => {
    expect(isTimelineQuery("what is the weather")).toBe(false);
    expect(isTimelineQuery("install node")).toBe(false);
  });
});

describe("queryTimeline", () => {
  it("reads diary entries and kg timeline together", async () => {
    const repository = {
      readDiary: vi.fn(async () => [{ date: "2026-04-15", content: "worked on X" }]),
      readKgTimeline: vi.fn(async () => [{ date: "2026-04-15", fact: "completed X" }]),
    };
    const result = await queryTimeline(repository as any, {
      daysBack: 7,
    });
    expect(repository.readDiary).toHaveBeenCalledWith({
      agentName: "remempalace",
      lastN: 50,
      timeoutMs: 500,
    });
    expect(repository.readKgTimeline).toHaveBeenCalledWith({ daysBack: 7 });
    expect(result.diary).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });

  it("normalizes object-shaped diary read results", async () => {
    const repository = {
      readDiary: vi.fn(async () => ({
        entries: [{ date: "2026-04-15", content: "worked on X" }],
      })),
      readKgTimeline: vi.fn(async () => []),
    };

    const result = await queryTimeline(repository as any, { daysBack: 7 });

    expect(result.diary).toEqual([{ date: "2026-04-15", content: "worked on X" }]);
  });

  it("allows callers to override the diary read timeout", async () => {
    const repository = {
      readDiary: vi.fn(async () => []),
      readKgTimeline: vi.fn(async () => []),
    };

    await queryTimeline(repository as any, { daysBack: 7, diaryReadTimeoutMs: 250 });

    expect(repository.readDiary).toHaveBeenCalledWith({
      agentName: "remempalace",
      lastN: 50,
      timeoutMs: 250,
    });
  });
});
