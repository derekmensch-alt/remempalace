<p align="center">
  <img src="assets/remempalace-logo.png" alt="remempalace logo — a smart lobster memory mascot" width="220" />
</p>

<h1 align="center">remempalace</h1>

<p align="center">
  <strong>A full-lifecycle memory plugin for OpenClaw, powered by MemPalace.</strong>
</p>

<p align="center">
  <a href="INSTALL.md">Install</a> ·
  <a href="CONFIGURATION.md">Configure</a> ·
  <a href="TROUBLESHOOTING.md">Troubleshoot</a> ·
  <a href="docs/openclaw-smoke-test.md">Smoke test</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img alt="Status: release candidate" src="https://img.shields.io/badge/status-release--candidate-orange" />
  <img alt="OpenClaw memory plugin" src="https://img.shields.io/badge/OpenClaw-memory%20plugin-blue" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green" />
</p>

> **Status:** Release-candidate quality and in active OpenClaw testing. Verify with `npm run build`, `npm run lint`, and `npm test`.

## What it does

Lets an OpenClaw agent remember things across conversations with a live MemPalace-backed recall, learning, and persistence loop.

remempalace sits in OpenClaw's exclusive `memory` plugin slot and handles three jobs:

- **Recall** — pulls relevant KG facts and semantic memory from MemPalace before each turn.
- **Learn** — captures conservative facts from the conversation and writes them to the knowledge graph.
- **Persist** — writes session summaries to the MemPalace diary so future sessions can recover what happened.

Its strengths are:

- **Structured memory** — stores concise facts in a knowledge graph instead of relying only on long Markdown notes.
- **Low prompt overhead** — injects a small ranked memory bundle rather than broad memory files.
- **Fast repeated recall** — keeps a warm MCP connection and caches repeat searches, KG lookups, and recall bundles.
- **Timeline awareness** — uses diary plus KG context for questions like “what happened yesterday?” or “what did we work on recently?”
- **Two-way memory** — both recalls existing memory and writes conservative new facts over time.
- **Operational visibility** — exposes health, diary persistence, latency, circuit breakers, and cache state through `/remempalace status`.
- **Drop-in OpenClaw integration** — runs as the active memory plugin and exposes agent tools when supported by the host.

It also exposes agent-callable tools for search, explicit notes, recent diary entries, and health/status when the OpenClaw host supports plugin tools.

## Why it exists

OpenClaw's built-in `memory-core` is a strong transparent default: durable memory is mostly Markdown files (`MEMORY.md`, `memory/YYYY-MM-DD.md`, optional `DREAMS.md`) plus an index/search layer and optional dreaming-based promotion.

That file-first model is easy to inspect and repair, but long-running agents can run into predictable problems: messy Markdown, delayed promotion, token creep from broad context loading, search misses, and weak structure around entities and relationships.

remempalace explores a different shape: **memory as a live runtime service**.

- A **persistent connection** to MemPalace avoids per-turn process startup.
- An **in-memory LRU/hot cache** makes repeated queries fast.
- **Tiered injection** loads only the memory bundle that appears relevant to the current turn.
- **Two-way memory** reads from and writes conservative learned facts to a KG.
- **Identity injection** loads SOUL.md + IDENTITY.md once per session at low latency.
- **Timeline queries** detect prompts like "what happened yesterday?" and inject diary/KG context.
- **Operational status** reports MCP readiness, diary persistence, circuit breakers, latency, and cache behavior.

## remempalace vs memory-core

remempalace is not trying to make `memory-core` obsolete. It is testing whether OpenClaw memory can feel more like part of the live agent runtime instead of primarily a Markdown-and-index workflow.

| `memory-core` pain point | remempalace approach |
| --- | --- |
| Markdown can become messy, duplicated, or stale. | Store concise facts in a KG and session history in diary entries. |
| Recall can require loading or searching broad files. | Inject only a small ranked bundle of relevant facts/results. |
| Important facts depend on the agent remembering to edit files. | Learn conservative facts between turns and write them to the KG. |
| Exact file/search wording can miss entity relationships. | Query entities and relations through the KG as well as semantic search. |
| Dreaming/promotion can be delayed or operationally complex. | Use an always-on recall/learn/persist lifecycle per session. |
| Process startup and repeated backend calls can add latency. | Keep a warm MCP connection and cache repeated lookups. |
| “What happened recently?” questions are awkward in raw files. | Use diary plus KG timeline recall. |

Use `memory-core` when you want the most stable, transparent, file-first memory system with minimal dependencies. Use remempalace when you want to test KG facts, diary persistence, tiered recall, and lower prompt overhead for long-lived agents.

## Current state and direction

remempalace is release-candidate quality and actively tested. The current plugin has working before-turn recall, KG writes, diary persistence checks, status reporting, caching, tiered recall modes, and agent tools.

It is still not a finished replacement for `memory-core`. The main tradeoff is operational complexity: remempalace depends on the OpenClaw plugin, the MemPalace Python backend, MCP transport, and diary persistence all behaving correctly.

The project is trying to become a drop-in memory slot that feels boringly reliable:

1. Install and configure it with minimal steps.
2. Ask the agent to remember something.
3. Come back later and get accurate recall without bloating context.
4. Verify health with one status command.
5. Inspect, edit, and eventually forget memory safely.

Near-term priorities are packaging, status clarity, smoke tests, inspection tools, safe lifecycle controls, and migration/interop with existing `MEMORY.md` and daily notes.

## Architecture

A Node.js/TypeScript plugin that keeps one MemPalace process warm and talks to it over MCP / JSON-RPC. Recent results are LRU-cached. Before each turn the plugin injects a small, ranked summary of relevant memories — sized to fit the remaining context window. Between turns it batches up new facts and writes them to the knowledge graph. At session end it writes a diary entry.

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

For every option in detail — `cache`, `tiers`, `diary`, `kg`, `learning`, `prefetch`, `identity`, `memoryRuntime`, `hotCache`, and `breaker` — see **[CONFIGURATION.md](CONFIGURATION.md)**.

## Debug mode

Set `REMEMPALACE_DEBUG=1` in the OpenClaw gateway environment to dump per-prompt decisions (candidates, per-entity KG counts, injected block) to `/tmp/remempalace-last-inject.log`. Useful when diagnosing why a particular fact did or didn't surface. Leave unset in normal operation — the debug path adds sequential KG lookups.

## Agent tools

When the host supports plugin tools, remempalace registers:

- `remempalace_search` — search KG facts and semantic memory.
- `remempalace_remember` — store an explicit user note as a KG `user_note`.
- `remempalace_status` — expose the same health surface as `/remempalace status`.
- `remempalace_recent` — read recent diary entries.

No agent-facing forget tool is registered until KG deletion/invalidation semantics are implemented.

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
