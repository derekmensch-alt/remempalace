import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  LearningService,
  KgDedup,
  kgConfidenceThresholdForSource,
  kgSourceClosetForRole,
  type LearningConfig,
} from "../src/services/learning-service.js";
import type { KgBatcher } from "../src/kg.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<LearningConfig> = {}): LearningConfig {
  return {
    fromUser: true,
    fromAssistant: false,
    fromSystem: false,
    ...overrides,
  };
}

function makeBatcher() {
  return {
    add: vi.fn(),
    flush: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as KgBatcher;
}

// A text that reliably extracts a structured fact:
// "Derek prefers Rust" → matches the USES_PATTERN category=preference
const TEXT_WITH_FACT = "Derek prefers Rust.";

// A text that won't extract any structured facts
const TEXT_WITHOUT_FACT = "hello world";

// ---------------------------------------------------------------------------
// KgDedup tests
// ---------------------------------------------------------------------------

describe("KgDedup", () => {
  it("returns true for a new key", () => {
    const dedup = new KgDedup();
    expect(dedup.add("a|b|c")).toBe(true);
  });

  it("returns false for a duplicate key", () => {
    const dedup = new KgDedup();
    dedup.add("a|b|c");
    expect(dedup.add("a|b|c")).toBe(false);
  });

  it("reports size correctly", () => {
    const dedup = new KgDedup();
    dedup.add("x");
    dedup.add("y");
    expect(dedup.size).toBe(2);
  });

  it("evicts oldest key when maxSize is exceeded", () => {
    const dedup = new KgDedup(3);
    dedup.add("a");
    dedup.add("b");
    dedup.add("c");
    // Adding "d" should evict "a"
    dedup.add("d");
    expect(dedup.size).toBe(3);
    expect(dedup.has("a")).toBe(false);
    expect(dedup.has("b")).toBe(true);
    expect(dedup.has("d")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// confidence threshold helpers
// ---------------------------------------------------------------------------

describe("kgConfidenceThresholdForSource", () => {
  it("returns base threshold for user role", () => {
    expect(kgConfidenceThresholdForSource(0.6, "user")).toBe(0.6);
  });

  it("raises threshold to 0.8 floor for assistant", () => {
    expect(kgConfidenceThresholdForSource(0.6, "assistant")).toBe(0.8);
    expect(kgConfidenceThresholdForSource(0.85, "assistant")).toBe(0.85);
  });

  it("raises threshold to 0.7 floor for system", () => {
    expect(kgConfidenceThresholdForSource(0.5, "system")).toBe(0.7);
    expect(kgConfidenceThresholdForSource(0.75, "system")).toBe(0.75);
  });
});

describe("kgSourceClosetForRole", () => {
  it("returns openclaw:<role>", () => {
    expect(kgSourceClosetForRole("user")).toBe("openclaw:user");
    expect(kgSourceClosetForRole("assistant")).toBe("openclaw:assistant");
    expect(kgSourceClosetForRole("system")).toBe("openclaw:system");
  });
});

// ---------------------------------------------------------------------------
// LearningService — role policy
// ---------------------------------------------------------------------------

describe("LearningService — role policy", () => {
  it("extracts facts from user turns when fromUser=true (default)", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig(),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "user");
    expect(batcher.add).toHaveBeenCalled();
  });

  it("does NOT extract facts from user turns when fromUser=false", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig({ fromUser: false }),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "user");
    expect(batcher.add).not.toHaveBeenCalled();
  });

  it("does NOT extract facts from assistant turns when fromAssistant=false (default)", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig(),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "assistant");
    expect(batcher.add).not.toHaveBeenCalled();
  });

  it("extracts facts from assistant turns when fromAssistant=true", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig({ fromAssistant: true }),
    });
    // Use a high-confidence fact (base ~0.92) that clears the assistant floor of 0.8
    svc.ingestTurn("Derek's preferred editor is Neovim.", "assistant");
    expect(batcher.add).toHaveBeenCalled();
  });

  it("does NOT extract facts from system turns when fromSystem=false (default)", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig(),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "system");
    expect(batcher.add).not.toHaveBeenCalled();
  });

  it("extracts facts from system turns when fromSystem=true", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig({ fromSystem: true }),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "system");
    expect(batcher.add).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LearningService — extraction thresholds
// ---------------------------------------------------------------------------

describe("LearningService — extraction thresholds", () => {
  it("drops facts below minConfidence threshold", () => {
    const batcher = makeBatcher();
    // Set a very high threshold so all facts get dropped
    const svc = new LearningService({
      batcher,
      minConfidence: 0.99,
      config: makeConfig(),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "user");
    expect(batcher.add).not.toHaveBeenCalled();
  });

  it("enqueues facts at or above minConfidence threshold", () => {
    const batcher = makeBatcher();
    // Default threshold of 0.6 should pass "Derek prefers Rust" (confidence ~0.78)
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig(),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "user");
    expect(batcher.add).toHaveBeenCalled();
  });

  it("applies higher threshold for assistant turns", () => {
    const batcher = makeBatcher();
    // Confidence floor for assistant is 0.8; "Derek prefers Rust" is ~0.78 — should drop
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig({ fromAssistant: true }),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "assistant");
    // "Derek prefers Rust" has confidence ~0.78 which is below assistant floor of 0.8
    expect(batcher.add).not.toHaveBeenCalled();
  });

  it("enqueues assistant facts above the 0.8 floor", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig({ fromAssistant: true }),
    });
    // "Derek's preferred editor is Neovim" → confidence ~0.92 (APOSTROPHE_IS_PATTERN)
    svc.ingestTurn("Derek's preferred editor is Neovim.", "assistant");
    expect(batcher.add).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LearningService — dedup
// ---------------------------------------------------------------------------

describe("LearningService — dedup", () => {
  it("enqueues a fact only once when the same text is ingested twice", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig(),
    });
    svc.ingestTurn(TEXT_WITH_FACT, "user");
    svc.ingestTurn(TEXT_WITH_FACT, "user");
    // Should only add once despite two ingest calls
    expect(batcher.add).toHaveBeenCalledTimes(1);
  });

  it("allows a fact again when a fresh dedup store is provided", () => {
    const batcher = makeBatcher();
    // Each service instance gets an independent dedup store
    const svc1 = new LearningService({ batcher, minConfidence: 0.6, config: makeConfig() });
    const svc2 = new LearningService({ batcher, minConfidence: 0.6, config: makeConfig() });
    svc1.ingestTurn(TEXT_WITH_FACT, "user");
    svc2.ingestTurn(TEXT_WITH_FACT, "user");
    expect(batcher.add).toHaveBeenCalledTimes(2);
  });

  it("enqueues facts from different source roles separately (distinct dedup keys)", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig({ fromAssistant: true }),
    });
    // Use a high-confidence fact to pass assistant threshold
    const highConfidenceText = "Derek's preferred editor is Neovim.";
    svc.ingestTurn(highConfidenceText, "user");
    svc.ingestTurn(highConfidenceText, "assistant");
    // Different role keys → should be added twice
    expect(batcher.add).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// LearningService — remember/forget commands
// ---------------------------------------------------------------------------

describe("LearningService — memory commands", () => {
  let batcher: ReturnType<typeof makeBatcher>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  let svc: LearningService;

  beforeEach(() => {
    batcher = makeBatcher();
    logger = { info: vi.fn(), warn: vi.fn() };
    svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig(),
      logger,
    });
  });

  it("enqueues a remember command payload as a user_note fact", () => {
    svc.ingestTurn("Please remember that I prefer dark mode.", "user");
    expect(batcher.add).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "I",
        predicate: "user_note",
        object: expect.stringContaining("prefer dark mode"),
        source_closet: "openclaw:user",
      }),
    );
  });

  it("logs remember commands via the logger", () => {
    svc.ingestTurn("Remember that my deadline is Friday.", "user");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("remember"));
  });

  it("deduplicates remember commands — same payload ingested twice only enqueues once", () => {
    svc.ingestTurn("Remember that I prefer dark mode.", "user");
    svc.ingestTurn("Remember that I prefer dark mode.", "user");
    // Only one add call for the user_note (may be additional for extracted facts, but
    // the remember dedup key prevents double enqueue of the same command)
    const userNoteCalls = (batcher.add as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args) => args[0]?.predicate === "user_note",
    );
    expect(userNoteCalls).toHaveLength(1);
  });

  it("logs forget commands (does not throw, no batcher mutation for forget)", () => {
    svc.ingestTurn("Forget that I use Windows.", "user");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("forget"));
    // No KG mutation is performed — this is logged-only per the deferral note.
    // We verify batcher.add was NOT called with a forget payload.
    const calls = (batcher.add as ReturnType<typeof vi.fn>).mock.calls;
    const forgetsAdded = calls.filter(
      (args) => String(args[0]?.object ?? "").includes("Windows"),
    );
    expect(forgetsAdded).toHaveLength(0);
  });

  it("does not process memory commands from non-user turns", () => {
    svc.ingestTurn("Remember that you prefer Rust.", "assistant");
    // assistant is disabled by default — nothing should fire
    expect(batcher.add).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("skips turns shorter than 5 characters", () => {
    svc.ingestTurn("hi", "user");
    expect(batcher.add).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LearningService — sets correct source_closet on enqueued facts
// ---------------------------------------------------------------------------

describe("LearningService — source_closet label", () => {
  it("labels user facts with openclaw:user", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({ batcher, minConfidence: 0.6, config: makeConfig() });
    svc.ingestTurn(TEXT_WITH_FACT, "user");
    expect(batcher.add).toHaveBeenCalledWith(
      expect.objectContaining({ source_closet: "openclaw:user" }),
    );
  });

  it("labels assistant facts with openclaw:assistant", () => {
    const batcher = makeBatcher();
    const svc = new LearningService({
      batcher,
      minConfidence: 0.6,
      config: makeConfig({ fromAssistant: true }),
    });
    svc.ingestTurn("Derek's preferred editor is Neovim.", "assistant");
    expect(batcher.add).toHaveBeenCalledWith(
      expect.objectContaining({ source_closet: "openclaw:assistant" }),
    );
  });
});
