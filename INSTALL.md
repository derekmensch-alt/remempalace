# Installation Guide

This is the step-by-step walkthrough for getting **remempalace** wired into your OpenClaw installation. If you just want a TL;DR, see [README.md](README.md). If something goes wrong, check [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| **Node.js** | 22.16+ (24+ recommended) | Same baseline as OpenClaw. |
| **Python** | 3.10+ | Needs the `mempalace` package installed. |
| **OpenClaw** | 2026.4.x or newer | Token-auth gateway is mandatory. |
| **OS** | Linux, macOS, WSL2 | Native Windows is untested. |
| **Git** | any recent | For cloning the repo. |

Verify with:

```bash
node --version     # → v22.16.0 or higher
python3 --version  # → Python 3.10.0 or higher
openclaw --version # → 2026.4.x or higher
```

---

## Step 1 — Install MemPalace (Python backend)

remempalace doesn't reimplement memory storage — it talks to a long-running MemPalace process over MCP. Install the Python package first.

### Option A — pipx (recommended)

`pipx` keeps `mempalace` in its own virtualenv so it can't collide with system packages:

```bash
# If you don't have pipx:
python3 -m pip install --user pipx
python3 -m pipx ensurepath

pipx install mempalace
```

The python binary you'll point remempalace at lives at:

```
~/.local/share/pipx/venvs/mempalace/bin/python
```

Note that path — you'll need it in step 4.

### Option B — pip in your active environment

```bash
pip install mempalace
```

remempalace will use whatever `python3` is on your PATH. Check that it has the package:

```bash
python3 -c "import mempalace; print(mempalace.__version__)"
```

If that errors, you installed into the wrong Python. Use pipx instead, or activate the right venv before launching OpenClaw.

### Verify the MCP server starts

```bash
python3 -m mempalace.mcp_server <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
```

You should see a JSON-RPC `result` come back within a couple of seconds. Hit `Ctrl-D` if it stays open. If you get a `ModuleNotFoundError` here, the install failed — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#mempalace-module-not-found).

---

## Step 2 — Clone and build the plugin

```bash
git clone <repo-url> remempalace
cd remempalace
npm install
npm run build
```

The build emits `dist/` next to `src/`. OpenClaw loads from the package root — it picks up `openclaw.plugin.json` and the compiled JS automatically.

Run the test suite to confirm a clean install:

```bash
npm test          # 134 unit tests
```

Two integration tests are skipped by default. To run them, point at your mempalace install:

```bash
REMEMPALACE_TEST_PY=$(which python3) npm test
# or for pipx:
REMEMPALACE_TEST_PY=~/.local/share/pipx/venvs/mempalace/bin/python npm test
```

All 136 tests should pass.

---

## Step 3 — Disable any existing memory-slot plugin

The OpenClaw `memory` slot is exclusive — only one plugin can hold it. If you currently have `memory-core`, `mempalace-auto-recall`, or any other memory plugin enabled, **disable it before continuing**, or remempalace's `before_prompt_build` hook will be silently overwritten.

Check what owns the slot:

```bash
openclaw config get plugins.slots.memory
```

If anything other than `remempalace` is set (or you see `memory-core` enabled), edit `~/.openclaw/openclaw.json` and either:

- Set `plugins.entries.memory-core.enabled` to `false`, or
- Remove the offending plugin from `plugins.allow`.

> See [TROUBLESHOOTING.md → memory-slot conflict](TROUBLESHOOTING.md#memory-slot-conflict) for the exact symptoms and root cause.

---

## Step 4 — Register remempalace with OpenClaw

Edit `~/.openclaw/openclaw.json` (the file is JSON5 — comments and trailing commas are fine).

Add the plugin path, allowlist it, claim the memory slot, and enable it:

```json5
{
  "plugins": {
    // Add the absolute path to your cloned repo:
    "load": {
      "paths": ["/absolute/path/to/remempalace"]
    },

    // Allow the plugin id to load:
    "allow": ["remempalace"],

    // Claim the memory slot:
    "slots": {
      "memory": "remempalace"
    },

    // Enable + configure:
    "entries": {
      "remempalace": {
        "enabled": true,
        "config": {
          // pipx users: use the venv python from step 1
          "mcpPythonBin": "/home/YOU/.local/share/pipx/venvs/mempalace/bin/python"
          // pip users: leave at the default "python3"
        }
      }
    }
  }
}
```

The full set of config options is documented in [CONFIGURATION.md](CONFIGURATION.md). For a first install, `mcpPythonBin` is the only field you typically need to set explicitly.

---

## Step 5 — (Optional) Identity files

remempalace will inject a compact identity block on every turn if it finds these files:

- `~/SOUL.md` — values, working style, what you care about
- `~/IDENTITY.md` — biographical facts, names, roles, projects

Both are optional. Each is capped at 2000 characters by default and AAAK-compressed before injection. Skip this step if you don't want identity injection — set `prefetch.identityEntities` to `false` in the config and remempalace will leave the slot empty.

You can also point at custom paths:

```json5
"identity": {
  "soulPath": "~/Documents/agent-soul.md",
  "identityPath": "~/Documents/agent-identity.md",
  "maxChars": 3000
}
```

`~` is expanded to your home directory at config-merge time.

---

## Step 6 — Restart the gateway and verify

```bash
openclaw stop
openclaw start
```

Confirm remempalace is loaded, activated, and holding the memory slot:

```bash
openclaw plugins inspect remempalace --json
```

You should see:

```json
{
  "id": "remempalace",
  "enabled": true,
  "activated": true,
  "hookCount": 6,
  "slot": "memory"
}
```

If `enabled: true` but `activated: false`, check the gateway logs:

```bash
openclaw logs --level debug | grep remempalace
```

A successful startup logs lines like:

```
[remempalace] register() complete
[remempalace] mcp ready
[remempalace] capability probe: diary_write=true diary_read=true kg_invalidate=true
```

---

## Step 7 — Smoke test the recall path

The fastest way to confirm it's working end-to-end: ask your agent something only the KG would know.

Add a fact to memory first:

```bash
# Through whatever interface you use to talk to mempalace
# Example: curl to a running mempalace server, or via the gateway:
openclaw gateway call mempalace.kg_add '{
  "subject": "remempalace",
  "predicate": "ships_with",
  "object": "tiered KG-first recall"
}'
```

Then ask the agent:

> what does remempalace ship with?

If the bot answers `tiered KG-first recall` (or words to that effect), recall is working. If it says "I don't have that in memory", check [TROUBLESHOOTING.md → recall returns nothing](TROUBLESHOOTING.md#recall-returns-nothing).

You can also enable debug mode to see exactly what's being injected:

```bash
# In the gateway environment:
export REMEMPALACE_DEBUG=1
openclaw stop && openclaw start

# Watch the dump:
tail -f /tmp/remempalace-last-inject.log
```

Each prompt produces a JSON record showing extracted entities, KG facts retrieved, and the final injected block. Turn this off in normal operation — it adds sequential KG lookups to every turn.

---

## Updating

```bash
cd /path/to/remempalace
git pull
npm install
npm run build
openclaw stop && openclaw start
```

Check the [CHANGELOG.md](CHANGELOG.md) for breaking changes between versions.

---

## Uninstall

1. Disable the plugin: `openclaw config set plugins.entries.remempalace.enabled false`
2. Remove the slot claim: edit `~/.openclaw/openclaw.json` and clear `plugins.slots.memory` (or assign it to a replacement plugin).
3. Remove the load path from `plugins.load.paths`.
4. Restart the gateway.
5. (Optional) `pipx uninstall mempalace` if you don't want the Python backend any more.

remempalace doesn't write outside `~/.mempalace/palace/diary/` (when using the JSONL fallback). Removing that directory clears any local diary entries the plugin produced.

---

## Where to next

- [CONFIGURATION.md](CONFIGURATION.md) — every config option in detail
- [docs/architecture.md](docs/architecture.md) — how the plugin is structured
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — fixes for common problems
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup and PR workflow
