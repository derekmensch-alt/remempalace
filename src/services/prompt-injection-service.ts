import type { TimelineResult } from "../timeline.js";
import { countTokens } from "../token-counter.js";

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

const IDENTITY_CONTEXT_HEADER_TOKENS = countTokens("## Identity (remempalace)\n\n\n");
const MEMORY_CONTEXT_HEADER_TOKENS = countTokens("## Memory Context (remempalace)\n\n\n");

export class PromptInjectionService {
  private readonly runtimeDisclosureLines: string[];
  private readonly runtimeDisclosureOverheadTokens: number;

  constructor(
    private readonly opts: PromptInjectionServiceOptions = {
      runtimeDisclosure: buildDefaultRuntimeDisclosure,
    },
  ) {
    this.runtimeDisclosureLines = this.opts.runtimeDisclosure();
    this.runtimeDisclosureOverheadTokens = countTokens(this.runtimeDisclosureLines.join("\n"));
  }

  buildRuntimeDisclosure(): string[] {
    return [...this.runtimeDisclosureLines];
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

  /**
   * Returns the token cost of the static wrapper lines that surround memory content:
   * runtime disclosure + optional identity header + memory context header.
   * Pass this as fixedOverheadTokens to buildTieredInjection so the packer
   * only uses the tokens actually available for memory lines.
   */
  computeOverheadTokens(opts: { identityIncluded: boolean }): number {
    let tokens = this.runtimeDisclosureOverheadTokens;
    if (opts.identityIncluded) {
      tokens += IDENTITY_CONTEXT_HEADER_TOKENS;
    }
    tokens += MEMORY_CONTEXT_HEADER_TOKENS;
    return tokens;
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
