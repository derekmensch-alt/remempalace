import { describe, it, expect } from "vitest";
import { resolvePluginUserConfig } from "../src/index.js";

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
