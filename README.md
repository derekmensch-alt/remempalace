# remempalace

A full-lifecycle memory plugin for [OpenClaw](https://github.com/derekmensch-alt/openclaw), powered by [MemPalace](https://github.com/derekmensch-alt/mempalace).

**Status:** Shipped — 136 tests passing, in production use.

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

### 1. Install MemPalace (the Python backend)

```bash
# Recommended — isolated install via pipx
pipx install mempalace

# Or install into your active Python environment
pip install mempalace
```

### 2. Install the plugin

```bash
git clone https://github.com/derekmensch-alt/remempalace.git
cd remempalace
npm install
npm run build
```

Register it in your OpenClaw config so it holds the `memory` slot. In `~/.openclaw/openclaw.json`:

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

> **Note:** If you have `memory-core` (or another memory plugin) currently claiming the `memory` slot, disable it first — the slot is exclusive.

### 3. (Optional) Create SOUL.md and IDENTITY.md

remempalace can inject a compact identity block on every turn. Create these files at `~/SOUL.md` and `~/IDENTITY.md` with whatever persistent context you want the agent to carry. Both are optional and the feature can be disabled via `prefetch.identityEntities: false`.

## Configuration

All options have defaults and are optional. Override via your OpenClaw plugin config:

```json5
{
  "plugins": {
    "entries": {
      "remempalace": {
        "enabled": true,
        "config": {
          // Python binary that has the `mempalace` package installed.
          // Default: "python3" on PATH.
          // pipx users: "~/.local/share/pipx/venvs/mempalace/bin/python"
          "mcpPythonBin": "python3",

          "cache": { "capacity": 200, "ttlMs": 300000, "kgTtlMs": 600000 },

          "injection": {
            "maxTokens": 800,
            "budgetPercent": 0.15,
            "similarityThreshold": 0.25,
            "useAaak": true,
            // Entities always considered for KG lookup regardless of NER.
            // Add your name, project names, key collaborators, etc.
            "knownEntities": ["OpenClaw", "MemPalace", "remempalace"]
          },

          "tiers": { "l1Threshold": 0.3, "l2Threshold": 0.25, "l2BudgetFloor": 0.5 },
          "diary": { "enabled": true, "maxEntryTokens": 500 },
          "kg": { "autoLearn": true, "batchSize": 5, "flushIntervalMs": 30000 },
          "prefetch": { "diaryCount": 3, "identityEntities": true },

          // Paths for the optional identity injection feature.
          // ~ is expanded to the user's home directory.
          "identity": {
            "soulPath": "~/SOUL.md",
            "identityPath": "~/IDENTITY.md",
            "maxChars": 2000
          },

          // Sandbox for file reads exposed via the memory runtime.
          // Reads outside these roots are rejected.
          "memoryRuntime": {
            "allowedReadRoots": ["~/.mempalace", "~/.openclaw/workspace"]
          }
        }
      }
    }
  }
}
```

## Debug mode

Set `REMEMPALACE_DEBUG=1` in the OpenClaw gateway environment to dump per-prompt decisions (candidates, per-entity KG counts, injected block) to `/tmp/remempalace-last-inject.log`. Useful when diagnosing why a particular fact did or didn't surface. Leave unset in normal operation — the debug path adds sequential KG lookups.

## Project layout

```
remempalace/
├── README.md
├── LICENSE
├── openclaw.plugin.json       # plugin manifest
├── docs/
│   ├── architecture.md        # module-level architecture
│   └── superpowers/           # historical design + implementation docs
├── src/                       # TypeScript source (entry point: index.ts)
└── tests/                     # 136 Vitest unit + integration tests
```

See [docs/architecture.md](docs/architecture.md) for the module-level breakdown.

## License

MIT — see [LICENSE](LICENSE).
