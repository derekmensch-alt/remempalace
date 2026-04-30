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
