import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRemempalaceAgentTools } from "../src/agent-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "..", "openclaw.plugin.json");

describe("openclaw.plugin.json contracts", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    contracts?: { tools?: string[] };
  };

  it("declares a contracts.tools array", () => {
    expect(manifest.contracts).toBeDefined();
    expect(Array.isArray(manifest.contracts?.tools)).toBe(true);
  });

  it("declares every registered agent tool", () => {
    const stub = {
      ensureReady: async () => undefined,
      recallService: {
        extractCandidates: () => [],
        readBundle: async () => ({ kgResults: [], searchResults: [] }),
      } as never,
      rememberFact: async () => ({ subject: "I", predicate: "user_note", object: "" }),
      statusText: async () => "",
      readRecentDiary: async () => [],
    };
    const registered = createRemempalaceAgentTools(stub).map((t) => t.name);
    const declared = new Set(manifest.contracts?.tools ?? []);

    const missing = registered.filter((name) => !declared.has(name));
    expect(missing, `tools registered but not declared in contracts.tools: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not declare tools that aren't registered", () => {
    const stub = {
      ensureReady: async () => undefined,
      recallService: {
        extractCandidates: () => [],
        readBundle: async () => ({ kgResults: [], searchResults: [] }),
      } as never,
      rememberFact: async () => ({ subject: "I", predicate: "user_note", object: "" }),
      statusText: async () => "",
      readRecentDiary: async () => [],
    };
    const registered = new Set(createRemempalaceAgentTools(stub).map((t) => t.name));
    const declared = manifest.contracts?.tools ?? [];

    const orphans = declared.filter((name) => !registered.has(name));
    expect(orphans, `tools declared in contracts.tools but not registered: ${orphans.join(", ")}`).toEqual([]);
  });
});
