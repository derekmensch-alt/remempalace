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
    const mockMcp = {
      callTool: vi.fn(async (name: string) => {
        if (name === "mempalace_diary_read") return [{ date: "2026-04-15", content: "worked on X" }];
        if (name === "mempalace_kg_timeline") return [{ date: "2026-04-15", fact: "completed X" }];
        return {};
      }),
    };
    const result = await queryTimeline(mockMcp as any, {
      daysBack: 7,
    });
    expect(result.diary).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });
});
