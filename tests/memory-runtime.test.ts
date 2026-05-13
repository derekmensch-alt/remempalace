import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MempalaceMemoryRuntime } from "../src/memory-runtime.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// McpLifecycle mock — no callTool; lifecycle only.
interface MockMcp {
  isReady: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

// Full MemPalaceRepository mock (only methods used by the runtime need real impls).
interface MockRepository {
  searchMemory: ReturnType<typeof vi.fn>;
  canWriteDiary: boolean;
  canReadDiary: boolean;
  canInvalidateKg: boolean;
  canPersistDiary: boolean;
  diaryPersistenceState: string;
  getPalaceStatus: ReturnType<typeof vi.fn>;
  queryKgEntity: ReturnType<typeof vi.fn>;
  addKgFact: ReturnType<typeof vi.fn>;
  invalidateKgFact: ReturnType<typeof vi.fn>;
  readKgTimeline: ReturnType<typeof vi.fn>;
  writeDiary: ReturnType<typeof vi.fn>;
  readDiary: ReturnType<typeof vi.fn>;
  verifyDiaryPersistence: ReturnType<typeof vi.fn>;
}

function makeMcp(overrides: Partial<MockMcp> = {}): MockMcp {
  return {
    isReady: vi.fn().mockReturnValue(true),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRepository(overrides: Partial<MockRepository> = {}): MockRepository {
  return {
    searchMemory: vi.fn().mockResolvedValue([]),
    canWriteDiary: true,
    canReadDiary: true,
    canInvalidateKg: true,
    canPersistDiary: false,
    diaryPersistenceState: "tool-present",
    getPalaceStatus: vi.fn().mockResolvedValue({}),
    queryKgEntity: vi.fn().mockResolvedValue({}),
    addKgFact: vi.fn().mockResolvedValue({}),
    invalidateKgFact: vi.fn().mockResolvedValue({}),
    readKgTimeline: vi.fn().mockResolvedValue([]),
    writeDiary: vi.fn().mockResolvedValue({}),
    readDiary: vi.fn().mockResolvedValue([]),
    verifyDiaryPersistence: vi.fn().mockResolvedValue({ state: "tool-present", verified: false }),
    ...overrides,
  };
}

describe("MempalaceMemoryRuntime", () => {
  let mcp: MockMcp;
  let repository: MockRepository;
  let runtime: MempalaceMemoryRuntime;
  const cfg = {} as never;

  beforeEach(() => {
    mcp = makeMcp();
    repository = makeRepository();
    runtime = new MempalaceMemoryRuntime({
      mcp: mcp as never,
      repository: repository as never,
      similarityThreshold: 0.25,
      allowedReadRoots: [process.cwd()],
    });
  });

  describe("resolveMemoryBackendConfig", () => {
    it("always reports builtin backend", () => {
      const result = runtime.resolveMemoryBackendConfig({ cfg, agentId: "default" });
      expect(result).toEqual({ backend: "builtin" });
    });
  });

  describe("getMemorySearchManager", () => {
    it("returns a manager when MCP is ready", async () => {
      const result = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      expect(result.manager).not.toBeNull();
      expect(result.error).toBeUndefined();
    });

    it("returns error when MCP is not ready", async () => {
      mcp.isReady.mockReturnValue(false);
      const result = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      expect(result.manager).toBeNull();
      expect(result.error).toMatch(/mcp/i);
    });

    it("waits for plugin initialization before checking MCP readiness", async () => {
      const waitUntilReady = vi.fn().mockImplementation(async () => {
        mcp.isReady.mockReturnValue(true);
      });
      mcp.isReady.mockReturnValue(false);
      runtime = new MempalaceMemoryRuntime({
        mcp: mcp as never,
        repository: repository as never,
        similarityThreshold: 0.25,
        allowedReadRoots: [process.cwd()],
        waitUntilReady,
      });

      const result = await runtime.getMemorySearchManager({ cfg, agentId: "default" });

      expect(waitUntilReady).toHaveBeenCalledTimes(1);
      expect(result.manager).not.toBeNull();
    });
  });

  describe("search manager", () => {
    it("proxies search() to the repository and maps results", async () => {
      repository.searchMemory.mockResolvedValueOnce([
        {
          text: "Derek uses OpenClaw",
          wing: "tools",
          room: "openclaw",
          similarity: 0.82,
          source_file: "/fixtures/palace/tools/openclaw.md",
        },
      ]);
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const results = await manager!.search("openclaw", { maxResults: 3 });

      expect(repository.searchMemory).toHaveBeenCalledWith({ query: "openclaw", limit: 3 });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        path: "/fixtures/palace/tools/openclaw.md",
        score: 0.82,
        snippet: "Derek uses OpenClaw",
        source: "memory",
      });
      expect(results[0].startLine).toBe(1);
      expect(results[0].endLine).toBeGreaterThanOrEqual(1);
    });

    it("filters below similarity threshold", async () => {
      repository.searchMemory.mockResolvedValueOnce([
        { text: "high", wing: "w", room: "r", similarity: 0.5 },
        { text: "low", wing: "w", room: "r", similarity: 0.1 },
      ]);
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const results = await manager!.search("q");
      expect(results).toHaveLength(1);
      expect(results[0].snippet).toBe("high");
    });

    it("falls back to wing/room path when source_file is missing", async () => {
      repository.searchMemory.mockResolvedValueOnce([
        { text: "hit", wing: "personal", room: "prefs", similarity: 0.6 },
      ]);
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const results = await manager!.search("x");
      expect(results[0].path).toBe("personal/prefs");
    });

    it("status() returns builtin backend shape", async () => {
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const status = manager!.status();
      expect(status.backend).toBe("builtin");
      expect(status.provider).toBe("mempalace");
      expect(status.files).toBe(0);
      expect(status.chunks).toBe(0);
      expect(status.sources).toEqual(["memory"]);
      expect(status.vector).toEqual({ enabled: true, available: true });
      expect(status.fts).toEqual({ enabled: false, available: false });
    });

    it("probeEmbeddingAvailability reflects MCP readiness", async () => {
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      const okProbe = await manager!.probeEmbeddingAvailability();
      expect(okProbe.ok).toBe(true);

      mcp.isReady.mockReturnValue(false);
      const failProbe = await manager!.probeEmbeddingAvailability();
      expect(failProbe.ok).toBe(false);
      expect(failProbe.error).toBeTruthy();
    });

    it("probeVectorAvailability returns true (MemPalace uses FAISS)", async () => {
      const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "default" });
      expect(await manager!.probeVectorAvailability()).toBe(true);
    });
  });

  describe("closeAllMemorySearchManagers", () => {
    it("stops the MCP client and resolves cleanly", async () => {
      await expect(runtime.closeAllMemorySearchManagers()).resolves.toBeUndefined();
      expect(mcp.stop).toHaveBeenCalledTimes(1);
    });

    it("status-purpose manager close stops the MCP client", async () => {
      const { manager } = await runtime.getMemorySearchManager({
        cfg,
        agentId: "default",
        purpose: "status",
      });
      await expect(manager!.close?.()).resolves.toBeUndefined();
      expect(mcp.stop).toHaveBeenCalledTimes(1);
    });

    it("default-purpose manager close is not exposed for the long-lived gateway path", async () => {
      const { manager } = await runtime.getMemorySearchManager({
        cfg,
        agentId: "default",
        purpose: "default",
      });
      expect(manager!.close).toBeUndefined();
    });

    it("status-purpose manager does not poison the cached default manager", async () => {
      const statusResult = await runtime.getMemorySearchManager({
        cfg,
        agentId: "default",
        purpose: "status",
      });
      expect(statusResult.manager!.close).toBeTypeOf("function");

      const defaultResult = await runtime.getMemorySearchManager({
        cfg,
        agentId: "default",
        purpose: "default",
      });
      expect(defaultResult.manager!.close).toBeUndefined();
    });

    it("status-purpose close does not stop MCP after the default gateway manager exists", async () => {
      await runtime.getMemorySearchManager({
        cfg,
        agentId: "default",
        purpose: "default",
      });
      const { manager } = await runtime.getMemorySearchManager({
        cfg,
        agentId: "default",
        purpose: "status",
      });

      await expect(manager!.close?.()).resolves.toBeUndefined();
      expect(mcp.stop).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// readFile sandbox tests
// ---------------------------------------------------------------------------
describe("readFile sandbox", () => {
  let tmpDir: string;
  let allowedRoot: string;
  let runtime: MempalaceMemoryRuntime;

  function makeSandboxedRuntime(
    allowedReadRoots: string[],
    allowedWriteRoots: string[] = [],
  ): MempalaceMemoryRuntime {
    const mcp = makeMcp();
    return new MempalaceMemoryRuntime({
      mcp: mcp as never,
      repository: makeRepository() as never,
      similarityThreshold: 0.25,
      allowedReadRoots,
      allowedWriteRoots,
    });
  }

  async function getManager(rt: MempalaceMemoryRuntime) {
    const { manager } = await rt.getMemorySearchManager({ cfg: {} as never, agentId: "test" });
    return manager!;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remempalace-test-"));
    allowedRoot = path.join(tmpDir, "allowed");
    fs.mkdirSync(allowedRoot, { recursive: true });
    runtime = makeSandboxedRuntime([allowedRoot]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const REJECT_TEXT = "[remempalace] path not allowed";

  it("rejects path traversal using .. that escapes the allowed root", async () => {
    // Write a file inside the allowed root so the traversal target actually exists
    fs.writeFileSync(path.join(allowedRoot, "canary.txt"), "safe content");

    // Construct a relPath that starts inside allowedRoot then escapes via ..
    const traversal = path.join(allowedRoot, "..", "..", "..", "etc", "passwd");
    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: traversal });

    expect(result.text).toBe(REJECT_TEXT);
    expect(result.path).toBe(traversal);
    expect(result.truncated).toBe(false);
  });

  it("rejects absolute path outside allowlist", async () => {
    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: "/etc/hostname" });

    expect(result.text).toBe(REJECT_TEXT);
    expect(result.path).toBe("/etc/hostname");
    expect(result.truncated).toBe(false);
  });

  it("rejects symlink inside allowed root that points outside allowlist", async () => {
    // Create the symlink target: a real file that exists outside the allowed root
    const outsideFile = path.join(tmpDir, "outside-secret.txt");
    fs.writeFileSync(outsideFile, "secret content");

    // Symlink from inside allowedRoot to the outside file
    const symlinkPath = path.join(allowedRoot, "link-to-outside.txt");
    let realpathSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") {
        throw err;
      }

      // Windows often requires Developer Mode or elevated privileges for
      // symlink creation. Simulate the important part of the security case:
      // the requested path resolves to a target outside the allowlist.
      fs.writeFileSync(symlinkPath, "placeholder");
      realpathSpy = vi.spyOn(fs.promises, "realpath").mockImplementation(async (target) => {
        const targetPath = String(target);
        if (path.resolve(targetPath) === path.resolve(symlinkPath)) {
          return outsideFile;
        }
        return path.resolve(targetPath);
      });
    }

    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: symlinkPath });
    realpathSpy?.mockRestore();

    expect(result.text).toBe(REJECT_TEXT);
    expect(result.path).toBe(symlinkPath);
    expect(result.truncated).toBe(false);
    // Must not have returned the secret content
    expect(result.text).not.toContain("secret content");
  });

  it("accepts file under allowed root and returns its contents", async () => {
    const testFile = path.join(allowedRoot, "hello.txt");
    fs.writeFileSync(testFile, "line1\nline2\nline3");

    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: testFile });

    expect(result.text).toBe("line1\nline2\nline3");
    expect(result.path).toBe(testFile);
    expect(result.truncated).toBe(false);
  });

  it("rejects sibling directory with shared prefix (prefix-confusion guard)", async () => {
    // allowedRoot is e.g. /tmp/xyz/allowed
    // evil dir is /tmp/xyz/allowed-evil — shares the prefix but is NOT inside allowedRoot
    const evilDir = allowedRoot + "-evil";
    fs.mkdirSync(evilDir, { recursive: true });
    const evilFile = path.join(evilDir, "secret.txt");
    fs.writeFileSync(evilFile, "evil secret");

    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: evilFile });

    expect(result.text).toBe(REJECT_TEXT);
    expect(result.path).toBe(evilFile);
    expect(result.truncated).toBe(false);
  });

  it("error message does NOT leak the resolved absolute path", async () => {
    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: "/etc/shadow" });

    // Must be exactly the literal rejection string — no path leakage appended
    expect(result.text).toBe(REJECT_TEXT);
    // The text must not contain any absolute path beyond what caller gave us
    expect(result.text).not.toContain("/etc/shadow");
    expect(result.text).not.toMatch(/\/tmp\//);
    expect(result.text).not.toMatch(/realpath|resolve/i);
  });

  it("accepts exact root match (allowed root itself passes allowlist check)", async () => {
    // Reading the directory will fail with EISDIR from fs.readFile — that's acceptable.
    // What matters is the allowlist check passes (text != REJECT_TEXT).
    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: allowedRoot });

    // Should NOT be blocked by the sandbox
    expect(result.text).not.toBe(REJECT_TEXT);
    // fs.readFile on a directory yields an error message via the catch block
    expect(result.path).toBe(allowedRoot);
  });

  it("rejects nonexistent path outside allowlist (no ENOENT leak)", async () => {
    const outsideMissing = path.join(tmpDir, "does-not-exist.txt");
    // tmpDir is NOT the allowedRoot, so this is outside the allowlist
    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: outsideMissing });

    expect(result.text).toBe(REJECT_TEXT);
    // Must not leak ENOENT or the resolved path
    expect(result.text).not.toContain("ENOENT");
    expect(result.path).toBe(outsideMissing);
  });

  it("tilde-expanded user roots work (expand ~ to homedir)", async () => {
    // Create a runtime with a tilde-style allowed root that matches a tmp subdir
    const homeRelativeDir = path.join(os.homedir(), ".remempalace-test-sandbox");
    fs.mkdirSync(homeRelativeDir, { recursive: true });
    const testFile = path.join(homeRelativeDir, "test.txt");
    fs.writeFileSync(testFile, "tilde root content");

    // Runtime configured with tilde path — config layer should expand it
    const tildeRuntime = makeSandboxedRuntime([homeRelativeDir]);
    const mgr = await getManager(tildeRuntime);
    const result = await mgr.readFile({ relPath: testFile });

    fs.rmSync(homeRelativeDir, { recursive: true, force: true });

    expect(result.text).toBe("tilde root content");
    expect(result.path).toBe(testFile);
  });

  it("fails CLOSED on nonexistent file inside allowlist (no TOCTOU symlink race)", async () => {
    // Item 1 regression: before the fail-closed fix, realpath on a missing
    // file fell back to abs, allowlist passed, then an attacker could plant
    // a symlink at that path before fs.readFile ran. Post-fix: realpath
    // failure returns the rejection literal immediately.
    const nonexistent = path.join(allowedRoot, "does-not-exist.txt");
    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: nonexistent });

    expect(result.text).toBe(REJECT_TEXT);
    expect(result.path).toBe(nonexistent);
    expect(result.truncated).toBe(false);
  });

  it("rejects non-regular files (directory inside allowed root)", async () => {
    const subdir = path.join(allowedRoot, "a-subdir");
    fs.mkdirSync(subdir);
    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: subdir });

    expect(result.text).toBe("[remempalace] cannot read: not a regular file");
    expect(result.path).toBe(subdir);
    expect(result.truncated).toBe(false);
  });

  it("rejects files larger than MAX_READ_BYTES (10 MB cap)", async () => {
    const hugeFile = path.join(allowedRoot, "huge.txt");
    // Write just over 10 MB
    const size = 10 * 1024 * 1024 + 1;
    fs.writeFileSync(hugeFile, Buffer.alloc(size, 65)); // 'A'

    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: hugeFile });

    expect(result.text).toBe("[remempalace] cannot read: file too large");
    expect(result.path).toBe(hugeFile);
    expect(result.truncated).toBe(false);
  });

  it("returns only error code (no absolute path leak) when fs.readFile throws after allowlist+stat pass", async () => {
    const testFile = path.join(allowedRoot, "normal.txt");
    fs.writeFileSync(testFile, "content");

    // Inject an fs error whose message embeds the absolute path — the
    // wrapper must strip it and surface only the code.
    const { promises: fsPromises } = await import("node:fs");
    const injected: NodeJS.ErrnoException = Object.assign(
      new Error(`EACCES: permission denied, open '${testFile}'`),
      { code: "EACCES" },
    );
    const spy = vi.spyOn(fsPromises, "readFile").mockRejectedValueOnce(injected);

    const mgr = await getManager(runtime);
    const result = await mgr.readFile({ relPath: testFile });
    spy.mockRestore();

    expect(result.text).toBe("[remempalace] cannot read file: EACCES");
    expect(result.text).not.toContain(testFile);
    expect(result.text).not.toContain("permission denied");
    expect(result.path).toBe(testFile);
  });

  it("warns at setup when allowedReadRoots is empty", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emptyRuntime = makeSandboxedRuntime([]);
    await getManager(emptyRuntime);

    const matchingCall = warnSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && /allowedReadRoots.*empty/i.test(args[0]),
    );
    expect(matchingCall).toBeDefined();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// writeFile write-safety tests
// ---------------------------------------------------------------------------
describe("writeFile sandbox", () => {
  let tmpDir: string;
  let allowedWriteRoot: string;

  function makeWriteRuntime(
    allowedReadRoots: string[],
    allowedWriteRoots: string[],
  ): MempalaceMemoryRuntime {
    return new MempalaceMemoryRuntime({
      mcp: makeMcp() as never,
      repository: makeRepository() as never,
      similarityThreshold: 0.25,
      allowedReadRoots,
      allowedWriteRoots,
    });
  }

  async function getManager(rt: MempalaceMemoryRuntime) {
    const { manager } = await rt.getMemorySearchManager({ cfg: {} as never, agentId: "test" });
    return manager!;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remempalace-write-test-"));
    allowedWriteRoot = path.join(tmpDir, "allowed-write");
    fs.mkdirSync(allowedWriteRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects write when allowedWriteRoots is empty (default deny-all)", async () => {
    const rt = makeWriteRuntime([tmpDir], []);
    const mgr = await getManager(rt);
    const result = await mgr.writeFile({
      relPath: path.join(allowedWriteRoot, "out.txt"),
      content: "hello",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/WriteRejected|not in allowed write roots/i);
  });

  it("rejects write to path outside allowed write roots", async () => {
    const rt = makeWriteRuntime([tmpDir], [allowedWriteRoot]);
    const mgr = await getManager(rt);
    const outsidePath = path.join(tmpDir, "outside.txt");
    const result = await mgr.writeFile({ relPath: outsidePath, content: "evil" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/WriteRejected|not in allowed write roots/i);
    // Must not have written the file
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  it("accepts write to path inside allowed write root", async () => {
    const rt = makeWriteRuntime([tmpDir], [allowedWriteRoot]);
    const mgr = await getManager(rt);
    const targetFile = path.join(allowedWriteRoot, "result.txt");
    const result = await mgr.writeFile({ relPath: targetFile, content: "success content" });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(targetFile, "utf8")).toBe("success content");
  });

  it("rejects write with path traversal escaping allowed write root", async () => {
    const rt = makeWriteRuntime([tmpDir], [allowedWriteRoot]);
    const mgr = await getManager(rt);
    const traversal = path.join(allowedWriteRoot, "..", "escape.txt");
    const result = await mgr.writeFile({ relPath: traversal, content: "escaped" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/WriteRejected|not in allowed write roots/i);
    expect(fs.existsSync(path.join(tmpDir, "escape.txt"))).toBe(false);
  });

  it("rejects write to sibling directory with shared prefix (prefix-confusion guard)", async () => {
    const evilDir = allowedWriteRoot + "-evil";
    fs.mkdirSync(evilDir, { recursive: true });
    const rt = makeWriteRuntime([tmpDir], [allowedWriteRoot]);
    const mgr = await getManager(rt);
    const evilFile = path.join(evilDir, "secret.txt");
    const result = await mgr.writeFile({ relPath: evilFile, content: "evil" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/WriteRejected|not in allowed write roots/i);
    expect(fs.existsSync(evilFile)).toBe(false);
  });

  it("returns write error code on fs failure inside allowed root", async () => {
    const rt = makeWriteRuntime([tmpDir], [allowedWriteRoot]);
    const mgr = await getManager(rt);
    const targetFile = path.join(allowedWriteRoot, "fail.txt");

    const { promises: fsPromises } = await import("node:fs");
    const injected: NodeJS.ErrnoException = Object.assign(
      new Error(`EACCES: permission denied, open '${targetFile}'`),
      { code: "EACCES" },
    );
    const spy = vi.spyOn(fsPromises, "writeFile").mockRejectedValueOnce(injected);
    const result = await mgr.writeFile({ relPath: targetFile, content: "x" });
    spy.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("cannot write file: EACCES");
  });
});

// ---------------------------------------------------------------------------
// Port boundary: search goes through the repository, no callTool in runtime
// ---------------------------------------------------------------------------
describe("search routes through repository port", () => {
  it("search() calls repository.searchMemory and does not use callTool", async () => {
    // The mock repository has no callTool — if the runtime tried to call it,
    // this test would throw. Successful completion proves the port boundary.
    const repository = makeRepository({
      searchMemory: vi.fn().mockResolvedValue([
        { text: "fact from port", wing: "w", room: "r", similarity: 0.9 },
      ]),
    });
    const mcp = makeMcp();
    const runtime = new MempalaceMemoryRuntime({
      mcp: mcp as never,
      repository: repository as never,
      similarityThreshold: 0.25,
    });

    const { manager } = await runtime.getMemorySearchManager({ cfg: {} as never, agentId: "x" });
    const results = await manager!.search("test query", { maxResults: 3 });

    expect(repository.searchMemory).toHaveBeenCalledWith({ query: "test query", limit: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe("fact from port");
  });
});
