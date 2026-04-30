# Troubleshooting

Common problems with remempalace, what causes them, and how to fix them. If your issue isn't here, open an issue with gateway logs (`openclaw logs --level debug | grep remempalace`) and the output of `openclaw plugins inspect remempalace --json`.

---

## Quick triage

Run these three commands first — they pinpoint 90% of issues:

```bash
# Is the plugin loaded, activated, and holding the memory slot?
openclaw plugins inspect remempalace --json

# Are there any startup errors in the gateway?
openclaw logs --level debug | grep -i remempalace

# Is anything else claiming the memory slot?
openclaw config get plugins.slots.memory
openclaw config get plugins.entries.memory-core.enabled
```

What you want to see:

- `plugins inspect`: `enabled: true`, `activated: true`, `slot: "memory"`, `hookCount: 6`
- `slots.memory`: `"remempalace"` (or unset on a fresh install before slot is claimed)
- `memory-core.enabled`: `false` (if the field exists at all — see [memory-slot conflict](#memory-slot-conflict))

---

## OpenClaw isn't responding

**Symptom:** The OpenClaw UI, Telegram bot, or agent command feels stuck after enabling remempalace.

**First split the problem in two:** the gateway can be healthy while the model provider is overloaded. Check gateway health before blaming memory:

```bash
openclaw gateway health --timeout 15000
openclaw gateway probe --timeout 15000
```

If those are OK but the agent still does not answer, inspect the model/provider logs next. During local testing, Ollama `503` overloads made OpenClaw look unresponsive even while remempalace and the gateway were healthy.

**Expected remempalace process state:** one gateway process and one MemPalace MCP child owned by that gateway:

```bash
ps -ef | grep -E "openclaw|mempalace" | grep -v grep
```

You want to see one `openclaw-gateway` and one `/path/to/python -m mempalace.mcp_server`. More than one long-lived `mempalace.mcp_server` child usually means an old plugin build is running or the gateway needs a restart.

**Recovery sequence:**

```bash
openclaw gateway restart
sleep 15
openclaw gateway health --timeout 15000
ps -ef | grep -E "openclaw|mempalace" | grep -v grep
```

If health is OK and there is only one MCP child, remempalace is not the bottleneck; check model-provider load, channel connectivity, and agent logs.

For the full release/runtime checklist, see [docs/openclaw-smoke-test.md](docs/openclaw-smoke-test.md).

---

## WSL plugin path is rejected

**Symptom:** OpenClaw refuses to load the plugin from a `/mnt/c/...` path or reports that the plugin path is unsafe/world-writable.

**Cause:** Windows-mounted paths can appear world-writable from WSL. OpenClaw correctly rejects unsafe plugin roots.

**Fix:** Keep the OpenClaw-loaded checkout on a trusted WSL-native path:

```bash
mkdir -p ~/.openclaw/plugins
git clone <repo-url> ~/.openclaw/plugins/remempalace
cd ~/.openclaw/plugins/remempalace
npm install
npm run build
```

Then point OpenClaw at the Linux path:

```json5
"plugins": {
  "load": { "paths": ["/home/YOU/.openclaw/plugins/remempalace"] },
  "allow": ["remempalace"],
  "slots": { "memory": "remempalace" }
}
```

---

## mempalace module not found

**Symptom:**

```
[remempalace] mcp error: ModuleNotFoundError: No module named 'mempalace'
```

…or the gateway logs `mcp ready` is never logged, and recall returns nothing on every turn.

**Cause:** `mcpPythonBin` points at a Python that doesn't have the `mempalace` package importable. This is the single most common install issue.

**Fix:**

1. Identify which Python actually has the package:

   ```bash
   # Did you pipx-install?
   ls ~/.local/share/pipx/venvs/mempalace/bin/python && \
     ~/.local/share/pipx/venvs/mempalace/bin/python -c "import mempalace; print(mempalace.__version__)"

   # Did you pip-install?
   python3 -c "import mempalace; print(mempalace.__version__)"

   # Custom venv?
   /path/to/your/venv/bin/python -c "import mempalace; print(mempalace.__version__)"
   ```

   The one that prints a version is the one to point at.

2. Set `mcpPythonBin` to that exact path in `~/.openclaw/openclaw.json`:

   ```json5
   "config": {
     "mcpPythonBin": "/home/YOU/.local/share/pipx/venvs/mempalace/bin/python"
   }
   ```

3. Restart the gateway: `openclaw stop && openclaw start`.

If none of the candidates above can import `mempalace`, install it: `pipx install mempalace` (recommended) or `pip install mempalace`.

---

## memory-slot conflict

**Symptom:** The agent insists it doesn't know about your project, or describes MemPalace (the backend) when asked about remempalace (the plugin), or just says "I don't have that in memory" for every question that should hit the KG. Logs may show `[remempalace] register() complete` and `mcp ready` — everything *looks* fine — but injected facts never reach the model.

**Cause:** OpenClaw's `registerMemoryCapability(pluginId, capability)` is last-write-wins. It stores a single `memoryPluginState.capability`. The loader's slot-selection check only enforces slots for dual-kind (array) plugins; remempalace and `memory-core` both declare single-kind `"memory"`, so both pass the kind check and register. Whichever plugin loads second silently overwrites the first — and the `plugins.slots.memory` config is ignored for single-kind plugins.

If `memory-core` (or any other memory plugin) is enabled at the same time as remempalace, remempalace's `promptBuilder` hook can be overwritten and never run.

**Fix:**

```bash
openclaw plugins disable memory-core
openclaw stop && openclaw start
```

Then verify in `~/.openclaw/openclaw.json`:

```json5
"plugins": {
  "slots": { "memory": "remempalace" },
  "entries": {
    "memory-core":  { "enabled": false },   // ← critical
    "remempalace":  { "enabled": true }
  }
}
```

The same applies if any future stock memory-kind plugin gets installed alongside remempalace — only the slot holder should be enabled.

---

## recall returns nothing

**Symptom:** You added facts to the KG (via `mempalace_kg_add` or in a previous session) but the agent can't see them. Asked "what does remempalace ship with?" returns "I don't have that in memory" even though the fact is definitely stored.

**Cause:** Several possibilities, in decreasing order of likelihood:

1. **Memory-slot conflict** — see [above](#memory-slot-conflict). Always check this first.
2. **Entity not extracted from the question.** remempalace runs an NER heuristic on the user message; if it doesn't pull out an entity name, KG lookup never fires for that subject. The fix is to add the entity to `injection.knownEntities`.
3. **Similarity threshold filtering it out.** Free-text search results below `injection.similarityThreshold` (default `0.25`) are dropped before tier ranking. Only relevant if the fact lives in palace search rather than the KG.
4. **Cache staleness.** A KG write made *after* the cache populated won't be visible until `kg.kgTtlMs` (default 10 min) expires.

**Fix sequence:**

1. Confirm the fact is actually in the KG:

   ```bash
   openclaw gateway call mempalace.kg_query '{"subject": "remempalace"}'
   ```

   If this returns empty, the write didn't land — check MemPalace itself, not remempalace.

2. Turn on debug mode and watch what's being injected:

   ```bash
   export REMEMPALACE_DEBUG=1
   openclaw stop && openclaw start
   tail -f /tmp/remempalace-last-inject.log
   # ...send a turn...
   ```

   The log shows extracted entities, KG facts retrieved per entity, and the final injected block. If the entity you care about isn't in `extractedEntities`, you've hit case 2 above.

3. Fix it by adding the entity to `knownEntities` (the most impactful single config change):

   ```json5
   "injection": {
     "knownEntities": ["OpenClaw", "MemPalace", "remempalace", "YourName", "YourProject"]
   }
   ```

4. Restart: `openclaw stop && openclaw start`.

If the fact appears in the debug log's `injectedBlock` but the model still claims ignorance, the issue isn't remempalace — it's the model's instruction-following. Check that the model isn't trained to disclaim memory.

---

## Plugin loads but stays inactive

**Symptom:** `openclaw plugins inspect remempalace --json` shows `enabled: true` but `activated: false`, or `hookCount: 0`.

**Cause:** Activation failed during `register()`. The most common reasons:

- `mcpPythonBin` doesn't exist or isn't executable
- `mempalace` Python package can't be imported (see [above](#mempalace-module-not-found))
- The MCP `initialize` handshake timed out (slow disk, cold start, low memory)

**Fix:**

```bash
openclaw logs --level debug | grep -E "remempalace|mcp"
```

Look for the first `error` or `failed` line after `[remempalace] register() complete`. The error message names the cause. If the issue is a slow handshake, retry — remempalace's `register()` is synchronous and the async MCP init runs in the background, so a transient timeout fixes itself on the next restart.

---

## Identity block isn't appearing

**Symptom:** `prefetch.identityEntities` is `true` and `~/SOUL.md` / `~/IDENTITY.md` exist, but the agent has no awareness of them.

**Causes & fixes:**

1. **Wrong path in config.** `identity.soulPath` and `identity.identityPath` are absolute paths after `~` expansion. If you set them to relative paths like `SOUL.md`, they resolve relative to the gateway's CWD — which is *not* your home directory.

   Fix: use `~/SOUL.md` or `/absolute/path/SOUL.md`.

2. **File too small.** Empty files or files with just whitespace get treated as missing.

3. **Whole-file read but empty after AAAK compression.** Run with `injection.rawIdentity: true` temporarily to see the uncompressed block in `/tmp/remempalace-last-inject.log`. If raw text appears but compressed doesn't, file an AAAK bug upstream.

4. **`prefetch.identityEntities` is `false`.** The whole `identity` section is ignored when this is off. Check:

   ```bash
   openclaw config get plugins.entries.remempalace.config.prefetch.identityEntities
   ```

---

## KG facts aren't being learned

**Symptom:** You expect remempalace's auto-learn to extract facts from a conversation, but `mempalace.kg_query` shows nothing got written.

**Causes & fixes:**

- `kg.autoLearn: false` — check your config. Default is `true`.
- The conversation didn't contain any extractable facts. Auto-learn is conservative on purpose; explicit teaching ("remember that X is Y") works better than passive extraction.
- The batch hasn't flushed yet. Auto-learn buffers up to `kg.batchSize` (default 5) facts before writing. Force a flush by either ending the session (diary write triggers a flush) or waiting `kg.flushIntervalMs` (default 30s).
- Lower `kg.batchSize` to `1` for debugging — every fact flushes immediately.

---

## Diary write fails with "Internal tool error"

**Symptom:** Session-end logs show `[remempalace] diary_write failed: Internal tool error` (or similar from the MCP layer).

**Cause:** This is intermittent and originates in MemPalace, not remempalace. remempalace's local JSONL fallback should be writing the entry to `~/.mempalace/palace/diary/` even when the MCP write fails — check there to confirm no data was lost.

**Fix:**

1. Check the JSONL fallback wrote the entry:

   ```bash
   ls -lt ~/.mempalace/palace/diary/ | head -5
   ```

2. If the entry is there, the data is safe — the MCP call just failed loud. The next successful diary write will reconcile.

3. If the JSONL is also missing, file an issue with the gateway log around the failure timestamp.

---

## readFile rejects a path you expect to be allowed

**Symptom:** Calling `readFile` via the memory runtime returns `"[remempalace] path not allowed"` even though the file is under one of your `allowedReadRoots`.

**Cause:** The sandbox uses real-path resolution (`fs.realpath`), so:

- A symlink whose target is outside the allowlist is rejected, even if the symlink itself lives in an allowed root.
- A file that doesn't exist is rejected (fail-closed) — the runtime won't trust a path it can't `realpath`.
- Prefix-confusion is blocked: `/allowed-evil` does not match an allowlist entry of `/allowed` because the check requires `path.sep` after the root.

**Fix sequence:**

1. Resolve the path yourself and check whether it's actually under a root:

   ```bash
   readlink -f /the/path/you/want
   ```

   Compare the output with each entry in `memoryRuntime.allowedReadRoots` (after `~` expansion).

2. If the resolved path is outside the allowlist, either move the file or add a new allowed root.

3. If the file doesn't exist yet, create it first. The sandbox doesn't allow reads of nonexistent paths.

4. To temporarily widen the sandbox for debugging only, add the parent directory to `allowedReadRoots`. Don't put `/` or `~` in there in production.

---

## Cache returns stale data

**Symptom:** A KG write made earlier in the session isn't visible until much later, or until the gateway restarts.

**Cause:** The in-memory LRU cache holds responses for `cache.ttlMs` (search/diary, default 5 min) or `cache.kgTtlMs` (KG, default 10 min). Writes don't invalidate the cache.

**Fix:**

- Lower `cache.kgTtlMs` if same-session write visibility matters more than MCP roundtrip count.
- Set `kg.invalidateOnConflict: true` once your MemPalace install reliably handles `kg_invalidate` — that path triggers a targeted cache invalidation rather than waiting on TTL.
- Restart the gateway to clear the cache entirely (drastic, but sometimes useful for debugging).

---

## Tests fail with "REMEMPALACE_TEST_PY not set"

**Symptom:** Two integration tests are skipped on `npm test`. You want to run them.

**Fix:** Point `REMEMPALACE_TEST_PY` at a Python that has `mempalace` installed:

```bash
# pip install:
REMEMPALACE_TEST_PY=$(which python3) npm test

# pipx install:
REMEMPALACE_TEST_PY=~/.local/share/pipx/venvs/mempalace/bin/python npm test
```

The integration tests should run instead of being skipped. If any fail with the env var set, file an issue with the failing test name and full output.

---

## Gateway won't start at all after enabling remempalace

**Symptom:** `openclaw start` fails with errors mentioning remempalace before the prompt comes back.

**Cause:** A malformed `config` block in `openclaw.json` — usually a typo in `mcpPythonBin` or invalid JSON5.

**Fix:**

1. Validate the JSON5:

   ```bash
   node -e "console.log(require('json5').parse(require('fs').readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8')))" >/dev/null
   ```

   Any error here points to the line.

2. Disable the plugin to recover the gateway, then iterate on config:

   ```bash
   openclaw config set plugins.entries.remempalace.enabled false
   openclaw start
   # fix config
   openclaw config set plugins.entries.remempalace.enabled true
   openclaw stop && openclaw start
   ```

---

## "tools/list returned unexpected shape — capabilities default to false"

**Symptom:** This warning appears on startup. The plugin still loads, but `kg_invalidate`, `diary_write`, and `diary_read` capability flags are all `false`, so the corresponding features silently do nothing.

**Cause:** The MCP `tools/list` response from MemPalace doesn't match the shape remempalace expects. This usually means an old MemPalace version that doesn't expose `tools/list` properly.

**Fix:**

```bash
pipx upgrade mempalace
# or
pip install --upgrade mempalace

openclaw stop && openclaw start
```

If the warning persists with the latest MemPalace, file an issue with the raw `tools/list` response — set `REMEMPALACE_DEBUG=1` and inspect the MCP traffic.

---

## See also

- [INSTALL.md](INSTALL.md) — first-install walkthrough
- [CONFIGURATION.md](CONFIGURATION.md) — full config reference
- [docs/openclaw-smoke-test.md](docs/openclaw-smoke-test.md) — release/runtime smoke checklist
- [docs/architecture.md](docs/architecture.md) — how the pieces fit together
