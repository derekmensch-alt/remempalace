import type { TimelineResult } from "../timeline.js";

export interface PromptInjectionServiceOptions {
  runtimeDisclosure: () => string[];
}

export function buildDefaultRuntimeDisclosure(): string[] {
  return [
    "## Active Memory Plugin (remempalace)",
    "",
    "runtime slot: OpenClaw memory plugin = remempalace",
    "scope: remempalace recall is separate from workspace files or local markdown notes",
    "audit: use /remempalace status to see the most recent recall candidates and counts",
    "",
  ];
}

export class PromptInjectionService {
  constructor(private readonly opts: PromptInjectionServiceOptions = {
    runtimeDisclosure: buildDefaultRuntimeDisclosure,
  }) {}

  buildRuntimeDisclosure(): string[] {
    return this.opts.runtimeDisclosure();
  }

  buildRecallContext(input: { identity: string; memoryLines: string[] }): string[] {
    return [
      ...this.buildRuntimeDisclosure(),
      ...this.buildIdentityContext(input.identity),
      ...this.buildMemoryContext(input.memoryLines),
    ];
  }

  buildIdentityContext(identity: string): string[] {
    if (!identity) return [];
    return ["## Identity (remempalace)", "", identity, ""];
  }

  buildMemoryContext(lines: string[]): string[] {
    if (lines.length === 0) return [];
    return ["## Memory Context (remempalace)", "", ...lines, ""];
  }

  buildTimelineContext(timeline: TimelineResult): string[] {
    return [
      ...this.buildRuntimeDisclosure(),
      "## Timeline Context (remempalace)",
      "",
      ...timeline.diary.map((d) => `- ${d.date}: ${d.content.slice(0, 200)}`),
      ...timeline.events.map((e) => `- ${e.date}: ${e.fact}`),
      "",
    ];
  }
}
