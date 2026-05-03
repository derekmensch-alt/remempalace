import { describe, it, expect, vi } from "vitest";
import { loadIdentityContext } from "../src/identity.js";
import { promises as fs } from "node:fs";

describe("loadIdentityContext", () => {
  it("returns empty object when no identity files exist", async () => {
    const out = await loadIdentityContext({
      soulPath: "/nonexistent/SOUL.md",
      identityPath: "/nonexistent/IDENTITY.md",
    });
    expect(out.soul).toBe("");
    expect(out.identity).toBe("");
  });

  it("reads SOUL.md and IDENTITY.md when present", async () => {
    const tmpSoul = `/tmp/test-soul-${Date.now()}.md`;
    const tmpId = `/tmp/test-id-${Date.now()}.md`;
    await fs.writeFile(tmpSoul, "soul content");
    await fs.writeFile(tmpId, "identity content");
    try {
      const out = await loadIdentityContext({
        soulPath: tmpSoul,
        identityPath: tmpId,
      });
      expect(out.soul).toBe("soul content");
      expect(out.identity).toBe("identity content");
    } finally {
      await fs.unlink(tmpSoul).catch(() => {});
      await fs.unlink(tmpId).catch(() => {});
    }
  });

  it("truncates to max length", async () => {
    const tmp = `/tmp/test-soul-big-${Date.now()}.md`;
    await fs.writeFile(tmp, "x".repeat(10000));
    try {
      const out = await loadIdentityContext({
        soulPath: tmp,
        identityPath: "/nonexistent",
        maxChars: 100,
      });
      expect(out.soul.length).toBeLessThanOrEqual(100);
    } finally {
      await fs.unlink(tmp);
    }
  });
});
