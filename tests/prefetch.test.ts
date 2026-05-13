import { describe, it, expect, vi } from "vitest";
import { prefetchWakeUp } from "../src/prefetch.js";

describe("prefetchWakeUp", () => {
  it("fires status, diary, and warmup search queries in parallel", async () => {
    const calls: string[] = [];
    const call = vi.fn(async (name: string) => {
      calls.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 5));
      calls.push(`end:${name}`);
      return {};
    });
    const repository = {
      getPalaceStatus: () => call("status"),
      readDiary: () => call("diary"),
      searchMemory: () => call("search"),
    };

    await prefetchWakeUp(repository as any, { diaryCount: 2 });

    const starts = calls.filter((c) => c.startsWith("start:"));
    const ends = calls.filter((c) => c.startsWith("end:"));
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.every((s) => calls.indexOf(s) < calls.indexOf(ends[0]))).toBe(true);
  });

  it("tolerates partial failures", async () => {
    const repository = {
      getPalaceStatus: vi.fn(async () => {
        throw new Error("fail");
      }),
      readDiary: vi.fn(async () => ({})),
      searchMemory: vi.fn(async () => []),
    };

    const result = await prefetchWakeUp(repository as any, { diaryCount: 2 });

    expect(result.status).toBeNull();
    expect(result.diaryEntries).toBeDefined();
  });

  it("fires warmup search through the repository", async () => {
    const repository = {
      getPalaceStatus: vi.fn(async () => ({})),
      readDiary: vi.fn(async () => []),
      searchMemory: vi.fn(async () => []),
    };

    await prefetchWakeUp(repository as any, { diaryCount: 2 });

    expect(repository.searchMemory).toHaveBeenCalledWith({ query: "__warmup__", limit: 1 });
  });

  it("reads recent remempalace diary entries through the repository", async () => {
    const repository = {
      getPalaceStatus: vi.fn(async () => ({})),
      readDiary: vi.fn(async () => ({ entries: ["entry"] })),
      searchMemory: vi.fn(async () => []),
    };

    const result = await prefetchWakeUp(repository as any, { diaryCount: 2 });

    expect(repository.readDiary).toHaveBeenCalledWith({
      agentName: "remempalace",
      lastN: 2,
      timeoutMs: 500,
    });
    expect(result.diaryEntries).toEqual(["entry"]);
  });

  it("allows callers to override the diary read timeout", async () => {
    const repository = {
      getPalaceStatus: vi.fn(async () => ({})),
      readDiary: vi.fn(async () => ({ entries: [] })),
      searchMemory: vi.fn(async () => []),
    };

    await prefetchWakeUp(repository as any, { diaryCount: 2, diaryReadTimeoutMs: 250 });

    expect(repository.readDiary).toHaveBeenCalledWith({
      agentName: "remempalace",
      lastN: 2,
      timeoutMs: 250,
    });
  });

  it("does not include warmup result in returned PrefetchResult", async () => {
    const repository = {
      getPalaceStatus: vi.fn(async () => ({})),
      readDiary: vi.fn(async () => []),
      searchMemory: vi.fn(async () => [{ text: "warmup" }]),
    };

    const result = await prefetchWakeUp(repository as any, { diaryCount: 2 });

    expect(Object.keys(result)).toEqual(["status", "diaryEntries"]);
  });
});
