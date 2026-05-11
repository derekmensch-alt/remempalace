import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../src/services/recall-service.js";

describe("RecallService", () => {
  function makeService(candidates: string[] = []): RecallService {
    return new RecallService({
      extractCandidates: vi.fn(() => candidates),
      readBundle: vi.fn(async () => ({ searchResults: [], kgResults: [] })),
    });
  }

  it("extracts candidates and passes them into bundle reads", async () => {
    const router = {
      extractCandidates: vi.fn(() => ["Derek", "OpenClaw"]),
      readBundle: vi.fn(async () => ({
        searchResults: [{ text: "hit", wing: "w", room: "r", similarity: 0.8 }],
        kgResults: { facts: [] },
      })),
    };
    const service = new RecallService(router);

    const result = await service.recall("what does Derek use?", 5);

    expect(router.extractCandidates).toHaveBeenCalledWith("what does Derek use?");
    expect(router.readBundle).toHaveBeenCalledWith("what does Derek use?", 5, {
      entityCandidates: ["Derek", "OpenClaw"],
    });
    expect(result.candidates).toEqual(["Derek", "OpenClaw"]);
    expect(result.bundle.searchResults).toHaveLength(1);
  });

  it("can read a bundle using already-extracted candidates", async () => {
    const router = {
      extractCandidates: vi.fn(() => ["unused"]),
      readBundle: vi.fn(async () => ({ searchResults: [], kgResults: [] })),
    };
    const service = new RecallService(router);

    await service.readBundle("what does Derek use?", 5, ["Derek"]);

    expect(router.extractCandidates).not.toHaveBeenCalled();
    expect(router.readBundle).toHaveBeenCalledWith("what does Derek use?", 5, {
      entityCandidates: ["Derek"],
    });
  });

  it("passes an empty candidate list explicitly for full recall prompts", async () => {
    const router = {
      extractCandidates: vi.fn(() => []),
      readBundle: vi.fn(async () => ({ searchResults: [], kgResults: [] })),
    };
    const service = new RecallService(router);

    await service.recall("what should I remember?", 5);

    expect(router.readBundle).toHaveBeenCalledWith("what should I remember?", 5, {
      entityCandidates: [],
    });
  });

  it.each(["ok", "thanks", "thank you", "got it", "continue", "sounds good"])(
    "skips tiny acknowledgement prompts: %s",
    (prompt) => {
      expect(makeService().shouldSkipRecall(prompt)).toBe(true);
    },
  );

  it.each(["done", "ran it", "tests passed", "tool finished", "looks good"])(
    "skips low-semantic tool follow-up chatter: %s",
    (prompt) => {
      expect(makeService().shouldSkipRecall(prompt)).toBe(true);
    },
  );

  it.each([
    "what does Derek use?",
    "continue the remempalace refactor",
    "what happened last week?",
    "remind me what OpenClaw status is",
  ])("does not skip question or project prompts: %s", (prompt) => {
    expect(makeService().shouldSkipRecall(prompt)).toBe(false);
  });

  it("does not skip short prompts when entity candidates are present", () => {
    expect(makeService(["OpenClaw"]).shouldSkipRecall("OpenClaw")).toBe(false);
  });

  it("skips very short prompts without candidates or question intent", () => {
    expect(makeService().shouldSkipRecall("yep")).toBe(true);
    expect(makeService().shouldSkipRecall("next")).toBe(true);
  });

  it.each([
    "what does Derek use?",
    "remember the deployment decision",
    "what did we decide last session",
  ])("selects full recall for questions and prior-context prompts: %s", (prompt) => {
    expect(makeService().selectRecallMode(prompt)).toBe("full");
  });

  it("selects full recall when entity candidates are present", () => {
    expect(makeService(["remempalace"]).selectRecallMode("continue the refactor")).toBe("full");
  });

  it("selects cheap recall for ordinary non-specific prompts", () => {
    expect(makeService().selectRecallMode("please proceed with the next edit")).toBe("cheap");
  });

  it("cheap recall returns an empty bundle without touching the router", async () => {
    const router = {
      extractCandidates: vi.fn(() => []),
      readBundle: vi.fn(async () => ({ searchResults: [{ text: "hit" }], kgResults: { facts: [] } })),
    };
    const service = new RecallService(router as any);

    const bundle = await service.readBundle("please proceed with the next edit", 5, [], {
      mode: "cheap",
    });

    expect(bundle).toEqual({ searchResults: [], kgResults: { facts: [] } });
    expect(router.readBundle).not.toHaveBeenCalled();
  });

  it("builds cheap memory lines from lexically matching prefetched diary entries", () => {
    const lines = makeService().buildCheapMemoryLines({
      prompt: "continue diary health refactor",
      diaryEntries: [
        { content: "worked on the diary health persistence refactor" },
        { content: "unrelated grocery note" },
        "refactor status: replay waits for verified persistence",
      ],
    });

    expect(lines).toEqual([
      "RECENT DIARY (source=remempalace diary prefetch, cheap tier):",
      "- worked on the diary health persistence refactor",
      "- refactor status: replay waits for verified persistence",
    ]);
  });

  it("omits cheap memory lines when prefetched diary has no lexical match", () => {
    expect(
      makeService().buildCheapMemoryLines({
        prompt: "continue diary health refactor",
        diaryEntries: [{ content: "unrelated grocery note" }],
      }),
    ).toEqual([]);
  });
});
