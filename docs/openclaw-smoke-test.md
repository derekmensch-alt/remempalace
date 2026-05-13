# OpenClaw Smoke Test

Use this checklist before a remempalace release or after changing OpenClaw/plugin wiring.

## 1. Build the plugin

```bash
npm run build
npm run lint
npm test
```

Expected: build and lint complete without TypeScript errors; the default Vitest suite passes, with integration tests skipped unless `REMEMPALACE_TEST_PY` is set.

## 2. Validate OpenClaw config

```bash
openclaw config validate
openclaw config get plugins.slots.memory
openclaw config get plugins.entries.remempalace.enabled
```

Expected:

- `plugins.slots.memory` is `remempalace`
- `plugins.entries.remempalace.enabled` is `true`
- no config validation errors

If OpenClaw runs inside WSL, `plugins.load.paths` should point to a trusted Linux path such as `/home/YOU/.openclaw/plugins/remempalace`, not `/mnt/c/...`.

## 3. Restart and check gateway health

```bash
openclaw gateway restart
sleep 15
openclaw gateway health --timeout 15000
openclaw gateway probe --timeout 15000
```

Expected:

- health reports `OK`
- probe says local loopback is reachable
- capability is admin-capable when using the local authenticated gateway

If health is OK but the agent does not answer, check the model provider before blaming remempalace. Local model overloads can make OpenClaw feel stuck while the gateway and plugin are healthy.

## 4. Check memory status

```bash
openclaw status --timeout 15000
```

Expected memory row:

```text
plugin remempalace
vector ready
cache on
```

The file and chunk counts may be zero. That is OK for the MemPalace-backed runtime because the host-facing memory status is a compatibility surface, not the full MemPalace palace inventory.

## 4a. Check remempalace detailed status (Phase 6B+)

After running at least one session with a prompt, check the full status output:

```bash
openclaw plugins inspect remempalace
# or for raw JSON:
openclaw plugins inspect remempalace --json | jq '.status'
```

Expected fields in `/remempalace status` (available via the gateway or plugin API):

- `health:` one of `healthy`, `degraded`, `offline`
- `capabilities:` mcp_ready, diary_write, diary_read, kg_writable, etc.
- `circuit_breakers:` per-backend state (all should be `closed` if healthy)
- `latency:` at least `before_prompt_build.total` with p50/p95/count after one prompt
- `diary:` state and persistence status
- `caches:` search and kg cache hit counts
- `last_recall:` session key, fact/result counts, timestamp

Example healthy status (abbreviated):

```
remempalace status — healthy

health: healthy
last_probe: 2026-05-12T15:42:30.123Z — session_start_complete

capabilities:
  mcp_ready: yes
  diary_persistent: yes
  diary_write: yes
  diary_read: yes
  kg_writable: yes

circuit_breakers:
  search: closed
  kg: closed
  diary: closed

latency:
  before_prompt_build.total: p50=120.5ms p95=180.2ms last=110.0ms n=2
  before_prompt_build.fetch: p50=85.1ms p95=115.3ms last=80.0ms n=2
  mempalace_search: p50=65.0ms p95=70.0ms last=68.5ms n=1

diary:
  state: active
  persistence: verified
  pending_fallback: 0
  last_replay: 3/3 succeeded, 0 failed (2026-05-12T15:40:00Z)

caches:
  search: 2 hits, 1 misses, 3 entries
  kg: 1 hits, 0 misses, 1 entries

last_recall:
  session: session-abc123
  at: 2026-05-12T15:42:28.456Z
  prompt: what did we discuss about X?
  KG facts: 2
  search results: 3
  injected lines: 8
  identity included: yes
```

Health label rules:
- `offline` — MCP not ready
- `degraded` — any circuit breaker open or diary persistence unverified/fallback-active
- `healthy` — otherwise

Latency overruns remain visible in the `latency:` section and gateway logs, but they are advisory
budget telemetry rather than backend health failures.

## 5. Check process count

```bash
ps -ef | grep -E "openclaw|mempalace" | grep -v grep
```

Expected:

- one `openclaw-gateway`
- one gateway-owned `/path/to/python -m mempalace.mcp_server`

More than one long-lived `mempalace.mcp_server` child usually means an old build is still running or the gateway needs a restart.

## 6. Optional recall probe

Add a harmless KG fact through your MemPalace/OpenClaw interface, then ask the agent a direct question about it.

Example fact:

```text
remempalace ships_with tiered KG-first recall
```

Expected: the agent can answer with the stored object when asked what remempalace ships with. If not, see `TROUBLESHOOTING.md#recall-returns-nothing`.

For status smoke evidence, use a question or explicit prior-context prompt such as:

```text
what do you remember about remempalace?
```

That prompt forces full recall and should make `/remempalace status` show non-zero search/KG cache
entries after the prompt completes. A minimal command prompt such as "reply with ok" is intentionally
cheap and may leave caches empty.

## 7. Recall mode classification (optional)

Test that the plugin correctly selects cheap/cheap+kg1/full recall based on prompt content:

- **Cheap** (no backend calls): "ok", "thanks", "got it", "looks good" → agent should respond with no memory context or only identity.
- **Cheap+kg1** (single KG query): "continue", "next step" (after an entity-bearing turn) → agent should use memory but with reduced latency vs. full recall.
- **Full** (search + KG): "what did we discuss about X?", "remind me", questions with `?` → agent should have rich memory context.

Enable `REMEMPALACE_DEBUG=1` to watch mode selection:

```bash
export REMEMPALACE_DEBUG=1
openclaw stop && openclaw start
tail -f /tmp/remempalace-last-inject.log
# In the agent: ask different types of prompts and watch the decision logs
```

## 8. Hot cache persistence (optional)

Test that cache survives a plugin restart:

1. Have a multi-turn conversation covering 3–4 distinct topics.
2. Restart the gateway: `openclaw gateway restart`.
3. Repeat a similar prompt from an earlier topic (e.g., "tell me more about X" right after restarting).
4. Enable `REMEMPALACE_DEBUG=1` and check `/tmp/remempalace-last-inject.log` for a cache hit vs. a fresh backend call.

Expected: the reused bundle should appear in the inject log with a short latency, indicating the hot cache was loaded from disk.
