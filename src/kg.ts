import type { McpClient } from "./mcp-client.js";
import { dedupeWithKey } from "./dedup.js";
import type { KgFact } from "./types.js";

// Matches: "Derek uses OpenClaw" / "Derek prefers Rust" etc.
// Stops object capture at short prepositions (as, for, in, at, by, on) or end
const USES_PATTERN =
  /\b([A-Z][\w]{1,32})\s+(uses|prefers|runs|owns|works on|has|is)\s+([A-Za-z][\w.\-/+]{0,59})(?=\s+(?:as|for|in|at|by|on|daily|the|a|an)\b|\.|$|\n)/g;

// Matches: "Derek's favorite model is Kimi K2.5"
const APOSTROPHE_IS_PATTERN =
  /\b([A-Z][\w]{1,32})'s?\s+(favorite|preferred|chosen|default)\s+(\w+)\s+is\s+([A-Za-z][\w\s.\-/+]{1,60})(?:\.|$|\n)/g;

export function extractFacts(text: string): KgFact[] {
  const out: KgFact[] = [];

  for (const m of text.matchAll(USES_PATTERN)) {
    const [, subj, pred, obj] = m;
    out.push({
      subject: subj.trim(),
      predicate: pred.replace(/\s+/g, "_").trim(),
      object: obj.trim(),
    });
  }

  for (const m of text.matchAll(APOSTROPHE_IS_PATTERN)) {
    const [, subj, modifier, category, obj] = m;
    out.push({
      subject: subj.trim(),
      predicate: `${modifier}_${category}`.toLowerCase(),
      object: obj.trim(),
    });
  }

  return dedupeWithKey(out, (f) => `${f.subject}|${f.predicate}|${f.object}`);
}

export interface KgBatcherOptions {
  batchSize: number;
  flushIntervalMs: number;
}

export class KgBatcher {
  private buffer: KgFact[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly mcp: McpClient,
    private readonly opts: KgBatcherOptions,
  ) {
    this.startTimer();
  }

  add(fact: KgFact): void {
    if (this.stopped) return;
    this.buffer.push(fact);
    if (this.buffer.length >= this.opts.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = dedupeWithKey(
      this.buffer.splice(0),
      (f) => `${f.subject}|${f.predicate}|${f.object}`,
    );
    await Promise.all(
      batch.map((f) =>
        this.mcp
          .callTool("mempalace_kg_add", {
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            valid_from: f.valid_from,
          })
          .catch(() => {
            // silent — best effort
          }),
      ),
    );
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.opts.flushIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
