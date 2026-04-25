import { describe, it, expect } from "vitest";
import { mergeConfig } from "../src/config.js";
import { homedir } from "node:os";

describe("mergeConfig with identity section", () => {
  it("returns default identity.soulPath using os.homedir()", () => {
    const cfg = mergeConfig(undefined);
    expect(cfg.identity.soulPath).toBe(`${homedir()}/SOUL.md`);
  });

  it("returns default identity.identityPath using os.homedir()", () => {
    const cfg = mergeConfig(undefined);
    expect(cfg.identity.identityPath).toBe(`${homedir()}/IDENTITY.md`);
  });

  it("returns default identity.maxChars of 2000", () => {
    const cfg = mergeConfig(undefined);
    expect(cfg.identity.maxChars).toBe(2000);
  });

  it("preserves user soulPath and merges default identityPath", () => {
    const cfg = mergeConfig({
      identity: { soulPath: "/custom/soul.md" },
    });
    expect(cfg.identity.soulPath).toBe("/custom/soul.md");
    expect(cfg.identity.identityPath).toBe(`${homedir()}/IDENTITY.md`);
    expect(cfg.identity.maxChars).toBe(2000);
  });

  it("preserves user identityPath and merges default soulPath", () => {
    const cfg = mergeConfig({
      identity: { identityPath: "/custom/identity.md" },
    });
    expect(cfg.identity.soulPath).toBe(`${homedir()}/SOUL.md`);
    expect(cfg.identity.identityPath).toBe("/custom/identity.md");
    expect(cfg.identity.maxChars).toBe(2000);
  });

  it("preserves user maxChars and merges default paths", () => {
    const cfg = mergeConfig({
      identity: { maxChars: 5000 },
    });
    expect(cfg.identity.soulPath).toBe(`${homedir()}/SOUL.md`);
    expect(cfg.identity.identityPath).toBe(`${homedir()}/IDENTITY.md`);
    expect(cfg.identity.maxChars).toBe(5000);
  });

  it("expands ~ in soulPath to os.homedir()", () => {
    const cfg = mergeConfig({
      identity: { soulPath: "~/MySoul.md" },
    });
    expect(cfg.identity.soulPath).toBe(`${homedir()}/MySoul.md`);
  });

  it("expands ~ in identityPath to os.homedir()", () => {
    const cfg = mergeConfig({
      identity: { identityPath: "~/MyIdentity.md" },
    });
    expect(cfg.identity.identityPath).toBe(`${homedir()}/MyIdentity.md`);
  });

  it("does not expand ~ in absolute paths", () => {
    const cfg = mergeConfig({
      identity: { soulPath: "/home/derek/SOUL.md" },
    });
    expect(cfg.identity.soulPath).toBe("/home/derek/SOUL.md");
  });

  it("preserves all custom identity values together", () => {
    const cfg = mergeConfig({
      identity: {
        soulPath: "~/custom/soul.md",
        identityPath: "/absolute/identity.md",
        maxChars: 3000,
      },
    });
    expect(cfg.identity.soulPath).toBe(`${homedir()}/custom/soul.md`);
    expect(cfg.identity.identityPath).toBe("/absolute/identity.md");
    expect(cfg.identity.maxChars).toBe(3000);
  });
});
