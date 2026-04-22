# remempalace — Architecture

## Overview

remempalace is a full-lifecycle memory plugin for OpenClaw. It keeps one MemPalace MCP subprocess alive for the duration of a session, routes memory reads through an LRU cache, and writes new facts and diary entries back asynchronously.

## Module map

```
src/index.ts
    │
    ├── config.ts          mergeConfig() — defaults + user overrides
    ├── logger.ts          createLogger(prefix) — structured logging
    │
    ├── process-manager.ts ProcessManager — spawn/stdio/event handlers
    ├── mcp-client.ts      McpClient — JSON-RPC over ProcessManager
    │
    ├── cache.ts           MemoryCache<V> — LRU + TTL, hit/miss stats
    ├── router.ts          MemoryRouter — cache-first search + KG, readBundle()
    │
    ├── token-counter.ts   countTokens(), countLines()
    ├── dedup.ts           contentHash(), dedupeByContent(), dedupeWithKey()
    ├── budget.ts          BudgetManager — context-fill-ratio → allowed tiers
    ├── aaak.ts            formatKgFact(), formatSearchResult() — AAAK encoding
    ├── tiers.ts           buildTieredInjection() — L0/L1/L2 assembly
    │
    ├── diary.ts           summarizeSession(), writeDiaryAsync()
    ├── kg.ts              extractFacts(), KgBatcher — coalescing KG writes
    ├── identity.ts        loadIdentityContext() — SOUL.md + IDENTITY.md
    ├── prefetch.ts        prefetchWakeUp() — status + diary on session_start
    ├── heartbeat.ts       HeartbeatWarmer — periodic warm-up timer
    └── timeline.ts        isTimelineQuery(), queryTimeline()
```

## Request lifecycle

```
session_start
  └─ prefetchWakeUp() + loadIdentityContext()  →  sessionStartCache[key]

llm_input
  └─ capture historyMessages  →  sessionMessages[key]

before_prompt_build
  ├─ isTimelineQuery?
  │     yes → queryTimeline() → inject ## Timeline Context
  │     no  → BudgetManager.compute() → allowedTiers
  │               └─ router.readBundle()
  │                     ├─ MemoryRouter.search()   (cache-first)
  │                     └─ MemoryRouter.kgQuery()  (cache-first)
  │                         → buildTieredInjection()
  │                             → ## Memory Context
  └─ cachedBySession[key] = lines

prompt_build (OpenClaw calls builder())
  └─ identityLines (from sessionStartCache) + recallLines (from cachedBySession)

llm_output
  └─ extractFacts(assistantText) → KgBatcher.add()
        └─ on batchSize || interval: mcp.callTool("mempalace_kg_add")

session_end
  └─ summarizeSession(messages) → writeDiaryAsync()
        └─ mcp.callTool("mempalace_diary_write")  [fire-and-forget]

gateway_stop
  └─ heartbeat.stop() + kgBatcher.stop() + mcp.stop()
```

## Tiered injection

Memory is injected in three tiers, each gated by the context budget:

| Tier | Content | Threshold |
|------|---------|-----------|
| L0 | KG facts (AAAK-compressed) | always included when budget allows |
| L1 | Top search hits (similarity ≥ l1Threshold) | included when L0+L1 fit |
| L2 | Deeper search hits (≥ l2Threshold, < l1Threshold) | included when all tiers fit |

Budget gating uses context fill ratio:
- ≥ 0.80 → no injection (context nearly full)
- ≥ 0.70 → L0 only
- > 0.50 (accounting for l2BudgetFloor) → L0 + L1
- else → L0 + L1 + L2

## Caching

`MemoryCache<V>` wraps `lru-cache` with:
- Configurable capacity (default 256 entries)
- Per-entry TTL (search: 5 min, KG: 2 min)
- SHA-256 content-hash keys via `hashKey()`
- Hit/miss stats via `.stats()`

## MCP transport

`McpClient` sends newline-delimited JSON-RPC 2.0 requests over stdin to a long-lived `python -m mempalace.mcp_server` subprocess. Responses are matched by `id` with per-request timeouts (default 10s). The MCP `initialize` handshake runs once on `start()`.

## Fact extraction

`extractFacts()` applies two regex patterns to assistant output:

- `USES_PATTERN` — "X uses/prefers/works with Y" (stops at prepositions)
- `APOSTROPHE_IS_PATTERN` — "X's favorite/preferred Y is Z"

Extracted facts are buffered by `KgBatcher` and flushed in batches to avoid per-sentence MCP calls. Duplicates are removed via `dedupeWithKey` before each flush.

## Identity injection

`loadIdentityContext()` reads SOUL.md and IDENTITY.md in parallel on `session_start` and stores the result in `sessionStartCache`. The builder prepends these lines before recall context — zero per-turn latency.

## Timeline queries

`isTimelineQuery()` matches prompts like "what happened yesterday?", "recap last week", "show me recent activity". When matched, `queryTimeline()` fires `mempalace_diary_read` and `mempalace_kg_timeline` in parallel and injects a `## Timeline Context` block instead of the standard tiered recall.
