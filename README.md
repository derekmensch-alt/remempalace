# remempalace

A full-lifecycle memory plugin for [OpenClaw](https://github.com/derekmensch-alt/openclaw), powered by [MemPalace](https://github.com/derekmensch-alt/mempalace).

**Status:** Implemented — all 6 phases complete, 61 tests passing.

## What it does

Lets an OpenClaw agent remember things across conversations — without the speed and token cost of the current memory plugin.

remempalace sits in OpenClaw's memory slot and handles three jobs:

- **Recall** — pulls relevant facts from MemPalace before each turn
- **Learn** — captures new facts from the conversation as it happens
- **Persist** — writes a session summary at the end so the next session knows what happened

## Why it exists

The current plugin (`mempalace-auto-recall`) shells out to a CLI on every turn. That's slow (~200–500ms each call), there's no caching, and it can't write anything back. remempalace replaces it with:

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

```bash
npm install
npm run build
```

Copy the built plugin into your OpenClaw plugins directory and register it in `openclaw.json`:

```json
{
  "plugins": ["path/to/remempalace/dist/index.js"]
}
```

## Configuration

All options have defaults and are optional. Override via `openclaw.json` plugin config:

```json
{
  "remempalace": {
    "mcpPythonBin": "python",
    "cache": {
      "capacity": 256,
      "ttlMs": 300000,
      "kgTtlMs": 120000
    },
    "injection": {
      "maxTokens": 2000,
      "budgetPercent": 0.15,
      "similarityThreshold": 0.5,
      "useAaak": true
    },
    "diary": {
      "enabled": true,
      "maxEntryTokens": 400
    },
    "kg": {
      "autoLearn": true,
      "batchSize": 10,
      "flushIntervalMs": 30000
    },
    "prefetch": {
      "diaryCount": 3,
      "identityEntities": true
    }
  }
}
```

## Project layout

```
remempalace/
├── README.md
├── LICENSE
├── openclaw.plugin.json       # plugin manifest
├── docs/
│   ├── architecture.md        # module-level architecture
│   └── superpowers/
│       ├── specs/             # design doc
│       └── plans/             # implementation plan
├── src/
│   ├── index.ts               # plugin entry point
│   ├── types.ts               # shared types
│   ├── config.ts              # config defaults + merge
│   ├── logger.ts              # structured logger
│   ├── cache.ts               # LRU cache with TTL
│   ├── process-manager.ts     # stdio subprocess manager
│   ├── mcp-client.ts          # JSON-RPC MCP client
│   ├── router.ts              # cache-first search + KG router
│   ├── token-counter.ts       # token estimation
│   ├── dedup.ts               # SHA-256 content deduplication
│   ├── budget.ts              # context window budget manager
│   ├── aaak.ts                # AAAK compression formatting
│   ├── tiers.ts               # tiered injection builder
│   ├── diary.ts               # session summarizer + diary write
│   ├── kg.ts                  # fact extractor + KG batcher
│   ├── identity.ts            # SOUL.md / IDENTITY.md loader
│   ├── prefetch.ts            # session wake-up prefetch
│   ├── heartbeat.ts           # periodic cache warmer
│   └── timeline.ts            # temporal query detection
└── tests/                     # 61 Vitest unit + integration tests
```

## License

MIT — see [LICENSE](LICENSE).
