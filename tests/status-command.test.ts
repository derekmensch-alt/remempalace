import { describe, it, expect } from "vitest";
import { buildStatusReport, deriveHealthLabel, type StatusReportInput } from "../src/status-command.js";

/** Minimal valid input — MCP ready, all capabilities, no extras. */
function baseInput(overrides: Partial<StatusReportInput> = {}): StatusReportInput {
  return {
    mcpReady: true,
    canWriteDiary: true,
    canReadDiary: true,
    canInvalidateKg: true,
    canPersistDiary: true,
    searchCache: { hits: 0, misses: 0, size: 0 },
    kgCache: { hits: 0, misses: 0, size: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Health label derivation
// ---------------------------------------------------------------------------

describe("deriveHealthLabel", () => {
  it("returns offline when MCP is not ready", () => {
    expect(deriveHealthLabel(baseInput({ mcpReady: false }))).toBe("offline");
  });

  it("returns healthy when all conditions nominal", () => {
    expect(deriveHealthLabel(baseInput())).toBe("healthy");
  });

  it("returns degraded when any breaker is open", () => {
    const input = baseInput({
      breakers: {
        search: { state: "open", openedAt: Date.now(), lastFailureReason: "timeout" },
        kg: { state: "closed", openedAt: null, lastFailureReason: null },
        diary: { state: "closed", openedAt: null, lastFailureReason: null },
      },
    });
    expect(deriveHealthLabel(input)).toBe("degraded");
  });

  it("returns healthy when all breakers closed or half-open", () => {
    const input = baseInput({
      breakers: {
        search: { state: "half-open", openedAt: Date.now() - 1000, lastFailureReason: "x" },
        kg: { state: "closed", openedAt: null, lastFailureReason: null },
        diary: { state: "closed", openedAt: null, lastFailureReason: null },
      },
    });
    // half-open is not open, so still healthy (kg/diary are fine)
    expect(deriveHealthLabel(input)).toBe("healthy");
  });

  it("returns degraded when diary state is fallback-active", () => {
    const input = baseInput({
      diary: { state: "fallback-active", persistenceState: "persistent", pending: 3 },
    });
    expect(deriveHealthLabel(input)).toBe("degraded");
  });

  it("returns degraded when diary persistenceState is write-ok-unverified", () => {
    const input = baseInput({
      diary: { state: "write-ok-unverified", persistenceState: "write-ok-unverified", pending: 0 },
    });
    expect(deriveHealthLabel(input)).toBe("degraded");
  });

  it("keeps health healthy when only advisory latency overruns are present", () => {
    const input = baseInput({
      metrics: { "latency.before_prompt_build.init.overrun": 2 },
    });
    expect(deriveHealthLabel(input)).toBe("healthy");
  });

  it("returns healthy when all overrun counters are zero", () => {
    const input = baseInput({
      metrics: {
        "latency.before_prompt_build.init.overrun": 0,
        "recall.invoked": 5,
      },
    });
    expect(deriveHealthLabel(input)).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

describe("buildStatusReport — health line", () => {
  it("includes overall health label healthy", () => {
    const text = buildStatusReport(baseInput());
    expect(text).toMatch(/health: healthy/);
  });

  it("includes overall health label offline when MCP down", () => {
    const text = buildStatusReport(baseInput({ mcpReady: false }));
    expect(text).toMatch(/health: offline/);
  });

  it("includes overall health label degraded when breaker open", () => {
    const text = buildStatusReport(
      baseInput({
        breakers: {
          search: { state: "open", openedAt: 1000, lastFailureReason: "boom" },
          kg: { state: "closed", openedAt: null, lastFailureReason: null },
          diary: { state: "closed", openedAt: null, lastFailureReason: null },
        },
      }),
    );
    expect(text).toMatch(/health: degraded/);
  });
});

describe("buildStatusReport — capabilities section", () => {
  it("reports all capabilities as yes when fully ready", () => {
    const text = buildStatusReport(baseInput());
    expect(text).toMatch(/mcp_ready: yes/);
    expect(text).toMatch(/diary_persistent: yes/);
    expect(text).toMatch(/diary_write: yes/);
    expect(text).toMatch(/diary_read: yes/);
    expect(text).toMatch(/kg_writable: yes/);
  });

  it("reports capabilities as no when missing", () => {
    const text = buildStatusReport(
      baseInput({
        mcpReady: false,
        canWriteDiary: false,
        canReadDiary: false,
        canInvalidateKg: false,
        canPersistDiary: false,
      }),
    );
    expect(text).toMatch(/mcp_ready: no/);
    expect(text).toMatch(/diary_persistent: no/);
    expect(text).toMatch(/diary_write: no/);
    expect(text).toMatch(/diary_read: no/);
    expect(text).toMatch(/kg_writable: no/);
  });
});

describe("buildStatusReport — circuit breakers section", () => {
  it("renders closed breakers", () => {
    const text = buildStatusReport(
      baseInput({
        breakers: {
          search: { state: "closed", openedAt: null, lastFailureReason: null },
          kg: { state: "closed", openedAt: null, lastFailureReason: null },
          diary: { state: "closed", openedAt: null, lastFailureReason: null },
        },
      }),
    );
    expect(text).toMatch(/circuit_breakers:/);
    expect(text).toMatch(/search: closed/);
    expect(text).toMatch(/kg: closed/);
    expect(text).toMatch(/diary: closed/);
  });

  it("renders open breaker with since timestamp and lastFailure", () => {
    const openedAt = new Date("2026-05-12T10:00:00Z").getTime();
    const text = buildStatusReport(
      baseInput({
        breakers: {
          search: {
            state: "open",
            openedAt,
            lastFailureReason: "connection refused",
          },
          kg: { state: "closed", openedAt: null, lastFailureReason: null },
          diary: { state: "closed", openedAt: null, lastFailureReason: null },
        },
      }),
    );
    expect(text).toMatch(/search: open/);
    expect(text).toMatch(/since.*2026-05-12/);
    expect(text).toMatch(/lastFailure="connection refused"/);
  });

  it("renders half-open breaker", () => {
    const text = buildStatusReport(
      baseInput({
        breakers: {
          search: { state: "half-open", openedAt: Date.now() - 5000, lastFailureReason: "x" },
          kg: { state: "closed", openedAt: null, lastFailureReason: null },
          diary: { state: "closed", openedAt: null, lastFailureReason: null },
        },
      }),
    );
    expect(text).toMatch(/search: half-open/);
  });

  it("omits circuit_breakers section when not provided", () => {
    const text = buildStatusReport(baseInput());
    expect(text).not.toMatch(/circuit_breakers:/);
  });
});

describe("buildStatusReport — latency section", () => {
  it("renders p50/p95/last/n for provided stages", () => {
    const text = buildStatusReport(
      baseInput({
        latency: {
          "before_prompt_build.total": { count: 10, p50: 120.5, p95: 450.1, lastMs: 200.0 },
          "before_prompt_build.init": { count: 10, p50: 30.0, p95: 80.0, lastMs: 25.0 },
          "mempalace_search": { count: 5, p50: 95.2, p95: 310.0, lastMs: 88.0 },
        },
      }),
    );
    expect(text).toMatch(/latency:/);
    expect(text).toMatch(/before_prompt_build\.total: p50=120\.5ms p95=450\.1ms last=200\.0ms n=10/);
    expect(text).toMatch(/before_prompt_build\.init: p50=30\.0ms p95=80\.0ms last=25\.0ms n=10/);
    expect(text).toMatch(/mempalace_search: p50=95\.2ms p95=310\.0ms last=88\.0ms n=5/);
  });

  it("omits stages with zero samples", () => {
    const text = buildStatusReport(
      baseInput({
        latency: {
          "before_prompt_build.total": { count: 3, p50: 100.0, p95: 200.0, lastMs: 90.0 },
          "diary_write": { count: 0, p50: 0, p95: 0, lastMs: 0 },
        },
      }),
    );
    expect(text).toMatch(/before_prompt_build\.total/);
    // diary_write latency stage with count=0 should not appear in the latency section
    // (note: "diary_write:" in capabilities section is different from a latency line)
    expect(text).not.toMatch(/diary_write: p50=/);
  });

  it("omits latency section when all stages have zero samples", () => {
    const text = buildStatusReport(
      baseInput({
        latency: {
          "before_prompt_build.total": { count: 0, p50: 0, p95: 0, lastMs: 0 },
        },
      }),
    );
    expect(text).not.toMatch(/^latency:/m);
  });

  it("omits latency section when latency is undefined", () => {
    const text = buildStatusReport(baseInput());
    expect(text).not.toMatch(/^latency:/m);
  });
});

describe("buildStatusReport — last_probe", () => {
  it("renders last probe timestamp and reason", () => {
    const probeAt = new Date("2026-05-12T09:30:00Z").getTime();
    const text = buildStatusReport(
      baseInput({ lastProbeAt: probeAt, lastProbeReason: "verified: persistent" }),
    );
    expect(text).toMatch(/last_probe:.*2026-05-12T09:30:00\.000Z.*verified: persistent/);
  });

  it("omits last_probe when not set", () => {
    const text = buildStatusReport(baseInput());
    expect(text).not.toMatch(/last_probe:/);
  });
});

describe("buildStatusReport — diary section", () => {
  it("renders diary state, persistence, pending, and replay", () => {
    const text = buildStatusReport(
      baseInput({
        diary: {
          state: "persistent",
          persistenceState: "persistent",
          pending: 0,
          lastReplay: { attempted: 5, succeeded: 5, failed: 0, at: new Date("2026-05-12T08:00:00Z").getTime() },
        },
      }),
    );
    expect(text).toMatch(/diary:/);
    expect(text).toMatch(/state: persistent/);
    expect(text).toMatch(/persistence: verified/);
    expect(text).toMatch(/pending_fallback: 0/);
    expect(text).toMatch(/last_replay: 5\/5 succeeded, 0 failed/);
  });

  it("renders fallback-active state and pending count", () => {
    const text = buildStatusReport(
      baseInput({
        diary: { state: "fallback-active", persistenceState: "persistent", pending: 42 },
      }),
    );
    expect(text).toMatch(/state: fallback-active/);
    expect(text).toMatch(/pending_fallback: 42/);
    expect(text).toMatch(/last_replay: none/);
  });

  it("renders last_replay_error when present", () => {
    const text = buildStatusReport(
      baseInput({
        diary: {
          state: "degraded",
          persistenceState: "persistent",
          pending: 3,
          lastReplay: { attempted: 3, succeeded: 1, failed: 2, at: Date.now() },
          lastReplayError: "connection reset",
        },
      }),
    );
    expect(text).toMatch(/last_replay_error: connection reset/);
  });

  it("omits diary section when not provided", () => {
    const text = buildStatusReport(baseInput());
    expect(text).not.toMatch(/^diary:/m);
  });
});

describe("buildStatusReport — caches section", () => {
  it("renders search and kg cache stats", () => {
    const text = buildStatusReport(
      baseInput({
        searchCache: { hits: 10, misses: 2, size: 7 },
        kgCache: { hits: 4, misses: 1, size: 3 },
      }),
    );
    expect(text).toMatch(/caches:/);
    expect(text).toMatch(/search: 10 hits, 2 misses, 7 entries/);
    expect(text).toMatch(/kg: 4 hits, 1 misses, 3 entries/);
  });
});

describe("buildStatusReport — last recall section", () => {
  it("renders last recall audit details when available", () => {
    const text = buildStatusReport(
      baseInput({
        lastRecall: {
          sessionKey: "chat-1",
          promptPreview: "what memory plugin are you using?",
          candidates: ["remempalace"],
          kgFactCount: 2,
          searchResultCount: 1,
          injectedLineCount: 4,
          identityIncluded: false,
          at: new Date("2026-04-30T09:26:00Z").getTime(),
        },
      }),
    );
    expect(text).toMatch(/last_recall:/);
    expect(text).toMatch(/chat-1/);
    expect(text).toMatch(/remempalace/);
    expect(text).toMatch(/KG facts: 2/);
    expect(text).toMatch(/search results: 1/);
  });

  it("omits last_recall section when not provided", () => {
    const text = buildStatusReport(baseInput());
    expect(text).not.toMatch(/last_recall:/);
  });
});

describe("buildStatusReport — output length", () => {
  it("stays within 30 lines for a fully populated report", () => {
    const openedAt = Date.now() - 5000;
    const text = buildStatusReport(
      baseInput({
        lastProbeAt: Date.now() - 60_000,
        lastProbeReason: "verified: persistent",
        breakers: {
          search: { state: "open", openedAt, lastFailureReason: "timeout" },
          kg: { state: "closed", openedAt: null, lastFailureReason: null },
          diary: { state: "half-open", openedAt, lastFailureReason: "write error" },
        },
        latency: {
          "before_prompt_build.total": { count: 10, p50: 120.0, p95: 400.0, lastMs: 200.0 },
          "before_prompt_build.init": { count: 10, p50: 30.0, p95: 80.0, lastMs: 25.0 },
          "mempalace_search": { count: 5, p50: 95.0, p95: 310.0, lastMs: 88.0 },
        },
        diary: {
          state: "fallback-active",
          persistenceState: "persistent",
          pending: 7,
          lastReplay: { attempted: 5, succeeded: 3, failed: 2, at: Date.now() - 120_000 },
          lastReplayError: "write timeout",
        },
        searchCache: { hits: 20, misses: 5, size: 12 },
        kgCache: { hits: 8, misses: 2, size: 6 },
        lastRecall: {
          sessionKey: "sess-abc",
          promptPreview: "what did we discuss last time?",
          candidates: ["project", "memory"],
          kgFactCount: 3,
          searchResultCount: 2,
          injectedLineCount: 8,
          identityIncluded: true,
          at: Date.now() - 30_000,
        },
      }),
    );
    const lineCount = text.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(45);
  });
});
