import { describe, it, expect, vi } from "vitest";
import {
  buildRuntimeDisclosure,
  createPromptMemoryDeadline,
  kgConfidenceThresholdForSource,
  kgSourceClosetForRole,
  PROMPT_RECALL_DEADLINE_MS,
  PROMPT_STAGE_BUDGETS_MS,
  resolvePluginUserConfig,
  stageBudgetMs,
  withPromptMemoryDeadline,
} from "../src/index.js";

describe("resolvePluginUserConfig", () => {
  it("returns api.config.plugins.entries[id].config when present", () => {
    const api = {
      config: {
        plugins: {
          entries: {
            remempalace: { config: { mcpPythonBin: "/venv/bin/python" } },
          },
        },
      },
    };
    expect(resolvePluginUserConfig(api, undefined, "remempalace")).toEqual({
      mcpPythonBin: "/venv/bin/python",
    });
  });

  it("falls back to positional userConfig when api.config has nothing", () => {
    const fallback = { mcpPythonBin: "/fallback/python" };
    expect(resolvePluginUserConfig({}, fallback, "remempalace")).toEqual(fallback);
  });

  it("falls back when entry exists but config is empty", () => {
    const api = { config: { plugins: { entries: { remempalace: { config: {} } } } } };
    const fallback = { mcpPythonBin: "/fallback/python" };
    expect(resolvePluginUserConfig(api, fallback, "remempalace")).toEqual(fallback);
  });

  it("returns undefined when neither source has config", () => {
    expect(resolvePluginUserConfig({}, undefined, "remempalace")).toBeUndefined();
    expect(resolvePluginUserConfig(undefined, undefined, "remempalace")).toBeUndefined();
  });

  it("scoped by plugin id", () => {
    const api = {
      config: {
        plugins: { entries: { other: { config: { mcpPythonBin: "/wrong" } } } },
      },
    };
    expect(resolvePluginUserConfig(api, undefined, "remempalace")).toBeUndefined();
  });
});

describe("KG provenance helpers", () => {
  it("keeps user-originated facts at the configured confidence threshold", () => {
    expect(kgConfidenceThresholdForSource(0.6, "user")).toBe(0.6);
  });

  it("requires stricter confidence for assistant-originated facts", () => {
    expect(kgConfidenceThresholdForSource(0.6, "assistant")).toBe(0.8);
    expect(kgConfidenceThresholdForSource(0.85, "assistant")).toBe(0.85);
  });

  it("maps source roles to MemPalace source_closet values", () => {
    expect(kgSourceClosetForRole("user")).toBe("openclaw:user");
    expect(kgSourceClosetForRole("assistant")).toBe("openclaw:assistant");
  });
});

describe("buildRuntimeDisclosure", () => {
  it("makes the active memory plugin impossible to miss", () => {
    const text = buildRuntimeDisclosure().join("\n");
    expect(text).toContain("Active Memory Plugin (remempalace)");
    expect(text).toContain("OpenClaw memory plugin = remempalace");
  });

  it("distinguishes remempalace recall from workspace files", () => {
    const text = buildRuntimeDisclosure().join("\n");
    expect(text).toMatch(/separate from workspace files/i);
    expect(text).toMatch(/\/remempalace status/);
  });
});

describe("prompt memory deadline helpers", () => {
  it("tracks remaining time against a shared prompt memory deadline", () => {
    let now = 1000;
    const deadline = createPromptMemoryDeadline(1500, () => now);

    expect(deadline.elapsedMs()).toBe(0);
    expect(deadline.remainingMs()).toBe(1500);

    now += 400;

    expect(deadline.elapsedMs()).toBe(400);
    expect(deadline.remainingMs()).toBe(1100);
  });

  it("returns the resolved value when recall finishes before the deadline", async () => {
    await expect(
      withPromptMemoryDeadline(Promise.resolve("ready"), "fallback", 10),
    ).resolves.toEqual({ value: "ready", timedOut: false });
  });

  it("returns fallback when recall exceeds the prompt-path deadline", async () => {
    vi.useFakeTimers();
    try {
      const deadline = createPromptMemoryDeadline();
      const result = withPromptMemoryDeadline(new Promise<string>(() => {}), "fallback", deadline);

      await vi.advanceTimersByTimeAsync(PROMPT_RECALL_DEADLINE_MS);

      await expect(result).resolves.toEqual({ value: "fallback", timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns fallback immediately when a shared deadline is already exhausted", async () => {
    let now = 1000;
    const deadline = createPromptMemoryDeadline(1500, () => now);
    now += 1501;

    await expect(
      withPromptMemoryDeadline(Promise.resolve("late"), "fallback", deadline),
    ).resolves.toEqual({ value: "fallback", timedOut: true });
  });

  it("caps stage budget by configured per-stage ceiling", () => {
    let now = 1000;
    const deadline = createPromptMemoryDeadline(1500, () => now);
    now += 100;
    expect(stageBudgetMs(deadline, PROMPT_STAGE_BUDGETS_MS.fetch)).toBe(900);
  });

  it("caps stage budget by remaining deadline when remaining is smaller", () => {
    let now = 1000;
    const deadline = createPromptMemoryDeadline(1500, () => now);
    now += 1300;
    expect(stageBudgetMs(deadline, PROMPT_STAGE_BUDGETS_MS.fetch)).toBe(200);
  });
});
