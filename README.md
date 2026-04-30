# remempalace

A full-lifecycle memory plugin for OpenClaw, powered by MemPalace.

**Status:** Release-candidate quality and in active OpenClaw testing. Verify with `npm run build`, `npm run lint`, and `npm test`.

**Docs:** [Install](INSTALL.md) · [Configure](CONFIGURATION.md) · [Troubleshoot](TROUBLESHOOTING.md) · [Smoke test](docs/openclaw-smoke-test.md) · [Architecture](docs/architecture.md) · [Contribute](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## What it does

Lets an OpenClaw agent remember things across conversations — without the speed and token cost of the current memory plugin.

remempalace sits in OpenClaw's memory slot and handles three jobs:

- **Recall** — pulls relevant facts from MemPalace before each turn
- **Learn** — captures new facts from the conversation as it happens
- **Persist** — writes a session summary at the end so the next session knows what happened

## Why it exists

An alternative to memory-core.

- A **persistent connection** to MemPalace (no per-turn process spawning)
- An **in-memory LRU cache** so repeat queries are instant (<5ms)
- **Tiered injection** that only loads what's actually relevant
- **Two-way memory** — reads *and* writes, so the agent actually learns over time
- **Identity injection** — loads SOUL.md + IDENTITY.md once per session at zero latency
- **Timeline queries** — detects "what happened yesterday?" and injects a chronological diary/KG summary

## Architecture

A Node.js/TypeScript plugin that keeps one MemPalace process warm and talks to it over MCP / JSON-RPC. Recent results are LRU-cached. Before each turn the plugin injects a small, ranked, deduplicated summary of relevant memories — sized to fit the remaining context window. Between turns it batches up new facts and writes them to the knowledge graph. At session end it writes a diary entry.

For the deep version, read the [architecture doc](docs/architecture.md) or the [design spec](docs/superpowers/specs/2026-04-16-remempalace-design.md).

## Installation

The 60-second version:

```bash
# 1. Install the Python backend
pipx install mempalace          # or: pip install mempalace

# 2. Build the plugin
git clone <repo-url> remempalace
cd remempalace
npm ci && npm run build

# Optional release checks
npm run lint && npm test

# 3. Register it in ~/.openclaw/openclaw.json
```

```json5
{
  "plugins": {
    "load": { "paths": ["/absolute/path/to/remempalace"] },
    "allow": ["remempalace"],
    "slots": { "memory": "remempalace" },
    "entries": {
      "remempalace": { "enabled": true }
    }
  }
}
```

```bash
# 4. Restart the gateway
openclaw stop && openclaw start
```

> **WSL note:** When OpenClaw runs inside WSL, keep the plugin checkout on a trusted Linux path such as `~/.openclaw/plugins/remempalace`. OpenClaw may reject `/mnt/c/...` plugin paths because Windows-mounted directories can appear world-writable from WSL.

> **Heads-up:** If `memory-core` (or another memory plugin) currently claims the `memory` slot, disable it first — the slot is exclusive. See [TROUBLESHOOTING.md → memory-slot conflict](TROUBLESHOOTING.md#memory-slot-conflict).

For the full walkthrough — pipx vs pip tradeoffs, identity files, smoke test, gateway verification — see **[INSTALL.md](INSTALL.md)** and **[docs/openclaw-smoke-test.md](docs/openclaw-smoke-test.md)**.

## Configuration

All options have defaults and are optional. The most impactful one to customize is `injection.knownEntities` — adding your name, project names, and key collaborators here dramatically improves recall quality.

A minimal override (the 90% case):

```json5
{
  "plugins": {
    "entries": {
      "remempalace": {
        "enabled": true,
        "config": {
          // pipx users: point at the venv python
          "mcpPythonBin": "~/.local/share/pipx/venvs/mempalace/bin/python",

          "injection": {
            // ⭐ Add your own canonical entities
            "knownEntities": ["OpenClaw", "MemPalace", "remempalace", "YourName", "YourProject"]
          }
        }
      }
    }
  }
}
```

For every option in detail — `cache`, `tiers`, `diary`, `kg`, `prefetch`, `identity`, `memoryRuntime` — see **[CONFIGURATION.md](CONFIGURATION.md)**.

## Debug mode

Set `REMEMPALACE_DEBUG=1` in the OpenClaw gateway environment to dump per-prompt decisions (candidates, per-entity KG counts, injected block) to `/tmp/remempalace-last-inject.log`. Useful when diagnosing why a particular fact did or didn't surface. Leave unset in normal operation — the debug path adds sequential KG lookups.

## Project layout

```
remempalace/
├── README.md
├── INSTALL.md                 # full install walkthrough
├── CONFIGURATION.md           # every config option
├── TROUBLESHOOTING.md         # fixes for common problems
├── CONTRIBUTING.md            # dev setup + PR workflow
├── CHANGELOG.md               # release notes
├── LICENSE
├── openclaw.plugin.json       # plugin manifest
├── docs/
│   ├── architecture.md        # module-level architecture
│   ├── openclaw-smoke-test.md # release/runtime smoke checklist
│   └── superpowers/           # historical design + implementation docs
├── src/                       # TypeScript source (entry point: index.ts)
└── tests/                     # Vitest unit + integration tests
```

See [docs/architecture.md](docs/architecture.md) for the module-level breakdown.

## License

MIT — see [LICENSE](LICENSE).
