import { describe, expect, it } from "vitest";
import {
  buildDefaultRuntimeDisclosure,
  PromptInjectionService,
} from "../src/services/prompt-injection-service.js";

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
