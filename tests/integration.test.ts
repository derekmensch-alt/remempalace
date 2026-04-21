import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpClient } from "../src/mcp-client.js";
import { MemoryRouter } from "../src/router.js";
import { MemoryCache } from "../src/cache.js";
import type { SearchResult } from "../src/types.js";
import { existsSync } from "node:fs";

const PY = "/home/derek/.local/share/pipx/venvs/mempalace/bin/python";
const hasMempalace = existsSync(PY);
const maybe = hasMempalace ? describe : describe.skip;

maybe("integration: real MemPalace MCP", () => {
  let mcp: McpClient;

  beforeAll(async () => {
    mcp = new McpClient({ pythonBin: PY });
    await mcp.start();
  }, 30000);

  afterAll(async () => {
    await mcp.stop();
  });

  it("completes a search round-trip", async () => {
    const router = new MemoryRouter({
      mcp,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 1000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 1000 }),
      similarityThreshold: 0,
    });
    const results = await router.search("derek", 3);
    expect(Array.isArray(results)).toBe(true);
  }, 15000);

  it("second identical search is cache hit (sub-5ms)", async () => {
    const router = new MemoryRouter({
      mcp,
      searchCache: new MemoryCache<SearchResult[]>({ capacity: 10, ttlMs: 10000 }),
      kgCache: new MemoryCache<unknown>({ capacity: 10, ttlMs: 10000 }),
      similarityThreshold: 0,
    });
    await router.search("derek", 3);
    const t0 = performance.now();
    await router.search("derek", 3);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(5);
  }, 15000);
});
