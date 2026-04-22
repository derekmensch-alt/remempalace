import { describe, it, expect, vi } from "vitest";
import { prefetchWakeUp } from "../src/prefetch.js";

describe("prefetchWakeUp", () => {
  it("fires status, diary, and identity queries in parallel", async () => {
    const calls: string[] = [];
    const mockMcp = {
      callTool: vi.fn(async (name: string) => {
        calls.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 5));
        calls.push(`end:${name}`);
        return {};
      }),
    };
    await prefetchWakeUp(mockMcp as any, { diaryCount: 2 });
    const starts = calls.filter((c) => c.startsWith("start:"));
    const ends = calls.filter((c) => c.startsWith("end:"));
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.every((s) => calls.indexOf(s) < calls.indexOf(ends[0]))).toBe(true);
  });

  it("tolerates partial failures", async () => {
    const mockMcp = {
      callTool: vi.fn(async (name: string) => {
        if (name === "mempalace_status") throw new Error("fail");
        return {};
      }),
    };
    const result = await prefetchWakeUp(mockMcp as any, { diaryCount: 2 });
    expect(result.status).toBeNull();
    expect(result.diaryEntries).toBeDefined();
  });
});
