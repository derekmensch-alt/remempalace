# remempalace

A full-lifecycle memory plugin for [OpenClaw](https://github.com/derekmensch-alt/openclaw), powered by [MemPalace](https://github.com/derekmensch-alt/mempalace).

**Status:** Planning. Implementation hasn't started yet — see [the plan](docs/superpowers/plans/2026-04-16-remempalace-implementation.md).

## What it does

Lets an OpenClaw agent remember things across conversations — without the speed and token cost of the current memory plugin.

remempalace sits in OpenClaw's memory slot and handles three jobs:

- **Recall** — pulls relevant facts from MemPalace before each turn
- **Learn** — captures new facts from the conversation as it happens
- **Persist** — writes a session summary at the end so the next session knows what happened

## Why it exists

The current plugin (`mempalace-auto-recall`) shells out to a CLI on every turn. That's slow (~200–500ms each call), there's no caching, and it can't write anything back. remempalace replaces it with:

- A **persistent connection** to MemPalace (no per-turn process spawning)
- An **in-memory cache** so repeat queries are instant
- **Tiered injection** that only loads what's actually relevant
- **Two-way memory** — reads *and* writes, so the agent actually learns over time

## Architecture in one paragraph

A Node.js/TypeScript plugin that keeps one MemPalace process warm and talks to it over MCP / JSON-RPC. Recent results are LRU-cached. Before each turn the plugin injects a small, ranked, deduplicated summary of relevant memories — sized to fit the remaining context window. Between turns it batches up new facts and writes them to the knowledge graph. At session end it writes a diary entry.

For the deep version, read the [design doc](docs/superpowers/specs/2026-04-16-remempalace-design.md).

## Project layout

```
remempalace/
├── README.md
├── LICENSE
├── docs/
│   └── superpowers/
│       ├── specs/    # design doc — the "why" and "what"
│       └── plans/    # implementation plan — the "how"
└── src/              # plugin code (coming soon)
```

## Roadmap

The implementation plan breaks the work into 6 phases:

1. **MCP transport + cache** — drop-in replacement, 10–25× faster
2. **Tiered injection + budget** — minimize tokens injected per turn
3. **Diary write-back** — remember what happened after the session
4. **KG lifecycle** — learn and correct facts during the conversation
5. **Proactive memory** — pre-fetch likely context, identity at zero cost
6. **Critique pass** — measure against goals, write follow-up tasks

## License

MIT — see [LICENSE](LICENSE).
