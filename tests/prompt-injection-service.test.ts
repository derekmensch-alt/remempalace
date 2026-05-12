import { describe, expect, it, vi } from "vitest";
import {
  buildDefaultRuntimeDisclosure,
  PromptInjectionService,
} from "../src/services/prompt-injection-service.js";
import { countTokens } from "../src/token-counter.js";

describe("PromptInjectionService", () => {
  it("builds the default runtime disclosure", () => {
    const service = new PromptInjectionService();

    expect(service.buildRuntimeDisclosure()).toEqual(buildDefaultRuntimeDisclosure());
    const text = service.buildRuntimeDisclosure().join("\n");
    expect(text).toContain("Active Memory Plugin (remempalace)");
    expect(text).toContain("OpenClaw memory plugin = remempalace");
    expect(text).toMatch(/separate from workspace files/i);
    expect(text).toMatch(/\/remempalace status/);
  });

  it("builds recall context with runtime disclosure, identity, and memory blocks", () => {
    const service = new PromptInjectionService({
      runtimeDisclosure: () => ["## Active Memory Plugin (remempalace)", "", "memory plugin active", ""],
    });

    expect(
      service.buildRecallContext({
        identity: "Derek prefers precise status reports.",
        memoryLines: ["- KG: Derek uses OpenClaw"],
      }),
    ).toEqual([
      "## Active Memory Plugin (remempalace)",
      "",
      "memory plugin active",
      "",
      "## Identity (remempalace)",
      "",
      "Derek prefers precise status reports.",
      "",
      "## Memory Context (remempalace)",
      "",
      "- KG: Derek uses OpenClaw",
      "",
    ]);
  });

  it("snapshots an audited recall context with source-labelled memory lines", () => {
    const service = new PromptInjectionService({
      runtimeDisclosure: () => ["## Active Memory Plugin (remempalace)", "", "memory plugin active", ""],
    });

    const text = service
      .buildRecallContext({
        identity: "Derek prefers precise status reports.",
        memoryLines: [
          "KG FACTS (source=remempalace KG, authoritative, newest first):",
          "- Derek:uses=OpenClaw [source=openclaw:user]",
          "- prior session note [source=remempalace search, confidence=0.82]",
        ],
      })
      .join("\n");

    expect(text).toMatchInlineSnapshot(`
      "## Active Memory Plugin (remempalace)

      memory plugin active

      ## Identity (remempalace)

      Derek prefers precise status reports.

      ## Memory Context (remempalace)

      KG FACTS (source=remempalace KG, authoritative, newest first):
      - Derek:uses=OpenClaw [source=openclaw:user]
      - prior session note [source=remempalace search, confidence=0.82]
      "
    `);
  });

  it("keeps recall context to runtime disclosure when optional blocks are empty", () => {
    const service = new PromptInjectionService({
      runtimeDisclosure: () => ["## Active Memory Plugin (remempalace)", ""],
    });

    expect(service.buildRecallContext({ identity: "", memoryLines: [] })).toEqual([
      "## Active Memory Plugin (remempalace)",
      "",
    ]);
  });

  it("builds identity context when compacted identity is present", () => {
    const service = new PromptInjectionService({ runtimeDisclosure: () => [] });

    expect(service.buildIdentityContext("Derek prefers precise status reports.")).toEqual([
      "## Identity (remempalace)",
      "",
      "Derek prefers precise status reports.",
      "",
    ]);
  });

  it("omits identity context when compacted identity is empty", () => {
    const service = new PromptInjectionService({ runtimeDisclosure: () => [] });

    expect(service.buildIdentityContext("")).toEqual([]);
  });

  it("builds memory context when injected lines are present", () => {
    const service = new PromptInjectionService({ runtimeDisclosure: () => [] });

    expect(service.buildMemoryContext(["- KG: Derek uses OpenClaw"])).toEqual([
      "## Memory Context (remempalace)",
      "",
      "- KG: Derek uses OpenClaw",
      "",
    ]);
  });

  it("omits memory context when there are no injected lines", () => {
    const service = new PromptInjectionService({ runtimeDisclosure: () => [] });

    expect(service.buildMemoryContext([])).toEqual([]);
  });

  it("builds timeline context with runtime disclosure, diary entries, and KG events", () => {
    const service = new PromptInjectionService({
      runtimeDisclosure: () => ["## Active Memory Plugin (remempalace)", "", "memory plugin active", ""],
    });

    const lines = service.buildTimelineContext({
      diary: [{ date: "2026-05-10", content: "worked on the diary health refactor" }],
      events: [{ date: "2026-05-10", fact: "remempalace Phase 2 completed" }],
    });

    expect(lines).toEqual([
      "## Active Memory Plugin (remempalace)",
      "",
      "memory plugin active",
      "",
      "## Timeline Context (remempalace)",
      "",
      "- 2026-05-10: worked on the diary health refactor",
      "- 2026-05-10: remempalace Phase 2 completed",
      "",
    ]);
  });

  it("computes overhead tokens covering runtime disclosure and memory context header", () => {
    const service = new PromptInjectionService();
    const overhead = service.computeOverheadTokens({ identityIncluded: false });
    const expected =
      countTokens(service.buildRuntimeDisclosure().join("\n")) +
      countTokens("## Memory Context (remempalace)\n\n\n");
    expect(overhead).toBe(expected);
  });

  it("adds identity header overhead when identityIncluded is true", () => {
    const service = new PromptInjectionService();
    const withoutIdentity = service.computeOverheadTokens({ identityIncluded: false });
    const withIdentity = service.computeOverheadTokens({ identityIncluded: true });
    expect(withIdentity).toBeGreaterThan(withoutIdentity);
  });

  it("caches static overhead token costs per service instance", () => {
    const runtimeDisclosure = vi.fn(() => [
      "## Active Memory Plugin (remempalace)",
      "",
      "memory plugin active",
      "",
    ]);
    const service = new PromptInjectionService({ runtimeDisclosure });

    const withoutIdentity = service.computeOverheadTokens({ identityIncluded: false });
    const withIdentity = service.computeOverheadTokens({ identityIncluded: true });
    const withoutIdentityAgain = service.computeOverheadTokens({ identityIncluded: false });

    expect(withIdentity).toBeGreaterThan(withoutIdentity);
    expect(withoutIdentityAgain).toBe(withoutIdentity);
    expect(runtimeDisclosure).toHaveBeenCalledTimes(1);
  });

  it("static overhead conservatively bounds rendered recall context without identity", () => {
    const service = new PromptInjectionService();
    const memoryLines = ["KG FACTS (source=remempalace KG, authoritative, newest first):", "- A:p=1"];
    const staticPlusContent =
      service.computeOverheadTokens({ identityIncluded: false }) +
      countTokens(memoryLines.join("\n"));
    const rendered = service.buildRecallContext({ identity: "", memoryLines }).join("\n");

    expect(staticPlusContent).toBeGreaterThanOrEqual(countTokens(rendered));
  });

  it("static overhead conservatively bounds rendered recall context with identity", () => {
    const service = new PromptInjectionService();
    const identity = "Derek prefers concise handoff notes.";
    const memoryLines = ["KG FACTS (source=remempalace KG, authoritative, newest first):", "- A:p=1"];
    const staticPlusContent =
      service.computeOverheadTokens({ identityIncluded: true }) +
      countTokens(identity) +
      countTokens(memoryLines.join("\n"));
    const rendered = service.buildRecallContext({ identity, memoryLines }).join("\n");

    expect(staticPlusContent).toBeGreaterThanOrEqual(countTokens(rendered));
  });

  it("truncates long diary content before injection", () => {
    const service = new PromptInjectionService({ runtimeDisclosure: () => [] });
    const content = "x".repeat(250);

    const lines = service.buildTimelineContext({
      diary: [{ date: "2026-05-10", content }],
      events: [],
    });

    expect(lines).toContain(`- 2026-05-10: ${"x".repeat(200)}`);
    expect(lines.join("\n")).not.toContain("x".repeat(201));
  });
});
