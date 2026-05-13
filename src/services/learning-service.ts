import { extractStructuredFacts, extractMemoryCommands } from "../structured-extractor.js";
import type { KgBatcher } from "../kg.js";
import type { Metrics } from "../metrics.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Source-role policy
// ---------------------------------------------------------------------------

/**
 * Roles from which KG facts may be extracted.
 *
 * - user: enabled by default — the primary source of ground-truth facts.
 * - assistant: disabled by default — avoids self-poisoning the KG with
 *   model-generated conjecture.
 * - system: disabled by default — system prompts are typically framework-
 *   provided scaffolding, not user-asserted facts.
 */
export type KgFactSourceRole = "user" | "assistant" | "system";

/**
 * Returns the minimum confidence threshold for a given source role.
 * Assistant and system sources apply a stricter floor to reduce noise.
 */
export function kgConfidenceThresholdForSource(
  baseThreshold: number,
  sourceRole: KgFactSourceRole,
): number {
  if (sourceRole === "assistant") return Math.max(baseThreshold, 0.8);
  if (sourceRole === "system") return Math.max(baseThreshold, 0.7);
  return baseThreshold;
}

/**
 * Returns the source_closet label for a fact written from a given role.
 */
export function kgSourceClosetForRole(sourceRole: KgFactSourceRole): string {
  return `openclaw:${sourceRole}`;
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/**
 * An in-process dedup set for KG facts ingested within a single plugin
 * lifetime. Bounded to `maxSize` entries; oldest entry evicted on overflow.
 */
export class KgDedup {
  private readonly seen = new Set<string>();

  constructor(private readonly maxSize = 2000) {}

  /**
   * Returns true if this key has NOT been seen before (i.e. the fact is new).
   * Also records the key so subsequent calls with the same key return false.
   */
  add(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.maxSize) {
      const oldest = this.seen.values().next().value;
      if (typeof oldest === "string") this.seen.delete(oldest);
    }
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  get size(): number {
    return this.seen.size;
  }
}

// ---------------------------------------------------------------------------
// LearningServiceOptions
// ---------------------------------------------------------------------------

export interface LearningConfig {
  /** Extract KG facts from user turns. Default: true. */
  fromUser: boolean;
  /** Extract KG facts from assistant turns. Default: false. */
  fromAssistant: boolean;
  /** Extract KG facts from system turns. Default: false. */
  fromSystem: boolean;
}

export interface LearningServiceOptions {
  batcher: KgBatcher;
  minConfidence: number;
  config: LearningConfig;
  metrics?: Metrics;
  logger?: Pick<Logger, "info" | "warn">;
  /** Optionally provide an external dedup store (e.g. for testing). */
  dedup?: KgDedup;
}

// ---------------------------------------------------------------------------
// LearningService
// ---------------------------------------------------------------------------

/**
 * LearningService encapsulates KG fact extraction, dedup, and batching.
 *
 * It accepts a text turn and source role, applies the role-policy gate,
 * extracts structured facts, deduplicates against an in-process seen-set,
 * and enqueues new facts into the KgBatcher.
 *
 * Explicit memory commands (`remember <X>` / `forget <X>`) detected in user
 * turns are logged. `remember` payloads are also enqueued as high-confidence
 * user facts. `forget` payloads are currently logged-only because KG
 * invalidation requires a subject/predicate/object triple, and a plain text
 * payload cannot be reliably mapped to an existing triple without a KG read;
 * this is a deliberate deferral — implement full invalidation in a follow-up
 * slice once the KG search API is plumbed through the recall path.
 */
export class LearningService {
  private readonly dedup: KgDedup;
  private readonly batcher: KgBatcher;
  private readonly minConfidence: number;
  private readonly config: LearningConfig;
  private readonly metrics?: Metrics;
  private readonly logger?: Pick<Logger, "info" | "warn">;

  constructor(opts: LearningServiceOptions) {
    this.batcher = opts.batcher;
    this.minConfidence = opts.minConfidence;
    this.config = opts.config;
    this.metrics = opts.metrics;
    this.logger = opts.logger;
    this.dedup = opts.dedup ?? new KgDedup();
  }

  /**
   * Ingest a text turn for KG learning.
   *
   * @param text     - The cleaned text content of the turn.
   * @param role     - Source role determining policy and confidence floor.
   */
  ingestTurn(text: string, role: KgFactSourceRole): void {
    if (!this.isRoleEnabled(role)) return;
    if (text.length < 5) return;

    this.extractAndEnqueue(text, role);

    // Explicit memory command handling (user turns only).
    if (role === "user") {
      this.handleMemoryCommands(text);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isRoleEnabled(role: KgFactSourceRole): boolean {
    if (role === "user") return this.config.fromUser;
    if (role === "assistant") return this.config.fromAssistant;
    if (role === "system") return this.config.fromSystem;
    return false;
  }

  private extractAndEnqueue(text: string, role: KgFactSourceRole): void {
    const all = extractStructuredFacts(text);
    const minConfidence = kgConfidenceThresholdForSource(this.minConfidence, role);
    const sourceCloset = kgSourceClosetForRole(role);
    let dropped = 0;

    for (const f of all) {
      this.metrics?.inc(`kg.facts.extracted.${f.category}`);
      this.metrics?.inc(`kg.facts.source.${role}`);
      if (f.confidence < minConfidence) {
        dropped += 1;
        continue;
      }
      const dedupKey = `${role}|${f.subject}|${f.predicate}|${f.object}|${f.source_span ?? ""}`;
      if (!this.dedup.add(dedupKey)) continue;
      this.metrics?.inc("kg.facts.extracted");
      this.batcher.add({
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        valid_from: f.valid_from,
        source_closet: sourceCloset,
      });
    }

    if (dropped > 0) this.metrics?.inc("kg.facts.dropped_low_confidence", dropped);
  }

  private handleMemoryCommands(text: string): void {
    const cmds = extractMemoryCommands(text);

    if (cmds.remember.length > 0) {
      this.logger?.info(`memory commands — remember: ${cmds.remember.join(" | ")}`);
      // Enqueue each remember payload as a high-confidence user fact
      // (predicate: "user_note", subject: "I", confidence implicit via direct
      // enqueue rather than threshold filtering).
      for (const payload of cmds.remember) {
        const dedupKey = `user_command|remember|${payload}`;
        if (!this.dedup.add(dedupKey)) continue;
        this.metrics?.inc("kg.facts.remember_command");
        this.batcher.add({
          subject: "I",
          predicate: "user_note",
          object: payload,
          source_closet: kgSourceClosetForRole("user"),
        });
      }
    }

    if (cmds.forget.length > 0) {
      // DEFERRED: Full invalidation requires resolving a plain-text payload
      // to a KG triple (subject/predicate/object), which needs a KG search
      // call on the recall path. For now, forget commands are logged so the
      // user's intent is visible in debug/info logs, but no KG mutation is
      // performed.  Implement triple-resolution in a follow-up slice.
      this.logger?.info(`memory commands — forget (logged only): ${cmds.forget.join(" | ")}`);
      this.metrics?.inc("kg.facts.forget_command_logged", cmds.forget.length);
    }
  }
}
