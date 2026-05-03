# remempalace — Full-Lifecycle Memory Plugin for OpenClaw

**Date:** 2026-04-16
**Repo:** `derekmensch-alt/remempalace`
**Status:** Design approved, pending implementation plan

---

## 1. Purpose

Replace the current `mempalace-auto-recall` OpenClaw plugin with a complete, speed-optimized, cost-aware memory system. The current plugin shells out to the `mempalace` CLI binary on every turn (~200-500ms per call, no caching, no write-back). remempalace talks to MemPalace via MCP JSON-RPC (the server is already running and warm), caches aggressively, injects only what's relevant, and handles the full read-write-recall lifecycle.

### Design Goals (ordered by priority)

1. **Speed** — sub-20ms memory access on cache hits, sub-50ms on MCP round-trips. The user should never feel the memory layer.
2. **Token cost** — inject the minimum tokens needed for the model to have context. Tiered injection (L0/L1/L2), AAAK compression, relevance thresholds, context-window-aware budgeting.
3. **Completeness** — full lifecycle: recall on prompt, learn during conversation, persist on session end.

---

## 2. Architecture

```
┌─────────────────────────────────────┐
│           OpenClaw Agent            │
│  ┌───────────────────────────────┐  │
│  │       remempalace plugin      │  │
│  │                               │  │
│  │  ┌─────────┐  ┌───────────┐  │  │
│  │  │  Cache  │  │  Budget   │  │  │
│  │  │  (LRU)  │  │  Manager  │  │  │
│  │  └────┬────┘  └─────┬─────┘  │  │
│  │       │             │        │  │
│  │  ┌────┴─────────────┴────┐   │  │
│  │  │    Memory Router     │   │  │
│  │  │  (read / write / kg) │   │  │
│  │  └──────────┬───────────┘   │  │
│  └─────────────┼───────────────┘  │
│                │ MCP JSON-RPC     │
└────────────────┼──────────────────┘
                 ▼
┌─────────────────────────────────────┐
│      MemPalace MCP Server           │
│      (warm, ChromaDB loaded)        │
│                                     │
│  Tools: search, kg_query, kg_add,   │
│  kg_invalidate, diary_write,        │
│  diary_read, status, list_wings,    │
│  list_rooms, traverse               │
└─────────────────────────────────────┘
```

### Components

**Cache (LRU):** In-memory cache keyed by query hash. Stores recent search results, KG entities, identity context. TTL-based expiry (configurable, default 5 minutes). Cache hits skip MCP entirely — zero latency, zero cost.

**Budget Manager:** Tracks available token budget for memory injection. Reads the model's context window size and current conversation length. Outputs a budget cap (in tokens) that the Memory Router uses to decide injection tier.

**Memory Router:** Central coordinator. On read: checks cache first, falls back to parallel MCP calls (search + KG simultaneously). On write: batches facts, flushes async. On session end: writes diary entry. Respects budget caps from Budget Manager.

### Plugin Shape

Node.js OpenClaw plugin (same format as current `mempalace-auto-recall`). Registers on:

- `before_prompt_build` — inject memory context (read path)
- `after_response` — extract facts for KG updates (write path)
- `session_end` — diary write (persist path)

Registers `registerMemoryPromptSection` for the memory slot.

### MCP Communication

The plugin calls MemPalace tools via OpenClaw's MCP client (the server is already configured in `openclaw.json` under `mcp.servers.mempalace`). No CLI spawns. No new processes.

Key MCP tools used:

| Tool | Read/Write | Used in |
|------|-----------|---------|
| `mempalace_search` | Read | Every turn (cache-miss) |
| `mempalace_kg_query` | Read | Every turn (cache-miss) |
| `mempalace_status` | Read | Wake-up / pre-fetch |
| `mempalace_diary_read` | Read | Wake-up / pre-fetch |
| `mempalace_kg_add` | Write | During conversation |
| `mempalace_kg_invalidate` | Write | During conversation |
| `mempalace_diary_write` | Write | Session end |
| `mempalace_add_drawer` | Write | Storing new knowledge |

---

## 3. Tiered Injection (Token Cost Control)

Memory context is injected in tiers. Lower tiers are cheaper and always included. Higher tiers are only included when the budget allows and relevance justifies it.

### Tiers

| Tier | Content | Typical size | When included |
|------|---------|-------------|---------------|
| **L0 — Facts** | KG entities relevant to the query. Structured, compressed (AAAK format). | ~50-100 tokens | Always (if any match) |
| **L1 — Top Hits** | Top 1-2 semantic search results above the similarity threshold. | ~100-300 tokens | When similarity > 0.3 |
| **L2 — Deep Context** | Additional search hits, diary entries, related drawers. | ~300-800 tokens | Only when budget > 50% remaining AND similarity > 0.25 |

### Budget Calculation

```
available_budget = context_window - current_conversation_tokens - safety_margin(10%)
memory_budget = min(available_budget * 0.15, max_memory_tokens)
```

- `max_memory_tokens`: configurable cap (default: 800 tokens, ~3200 chars)
- When conversation is short (< 20% of context): inject more liberally (up to L2)
- When conversation is long (> 60% of context): L0 only
- When conversation is near limit (> 80% of context): skip injection entirely

### Relevance Threshold

Search results below a configurable similarity score (default: 0.25) are dropped entirely. The current plugin injects everything regardless — this is the single biggest source of wasted tokens.

### AAAK Compression

All injected memory uses AAAK dialect where possible. Entity codes, emotion markers, pipe-separated fields. The model reads AAAK natively (confirmed by existing palace protocol). A 500-token prose paragraph becomes ~80 tokens in AAAK.

### Deduplication

Facts returned by both `mempalace_search` and `mempalace_kg_query` are deduplicated by content hash before injection. No paying twice for the same information.

---

## 4. Caching Strategy

### LRU Cache

- **Capacity:** 200 entries (configurable)
- **TTL:** 5 minutes per entry (configurable, aligns with typical session length)
- **Key:** SHA-256 hash of (tool_name + query_params)
- **Eviction:** LRU when at capacity, TTL expiry checked on read

### What Gets Cached

| Data | Cache? | TTL | Why |
|------|--------|-----|-----|
| Search results | Yes | 5 min | Same/similar queries recur within a conversation |
| KG entities | Yes | 10 min | Facts change rarely, high reuse |
| Identity context | Yes | Session lifetime | Loaded once on wake-up, never changes |
| Palace status | Yes | Session lifetime | Structural info, doesn't change mid-session |
| Diary entries | No | — | Write-only from this plugin's perspective |

### Cache Warming (Pre-fetch)

On session start (`before_prompt_build`, first turn):

1. `mempalace_status` — cache palace structure
2. `mempalace_diary_read` (last 3 entries) — cache recent session history
3. `mempalace_kg_query` for identity entities — cache identity context

All three fire in parallel. Total pre-fetch: ~50-100ms. Subsequent turns that need this data get it from cache at ~0ms.

---

## 5. Phase Breakdown

### Phase 1 — MCP Transport + Cache

**Goal:** Drop-in replacement for `mempalace-auto-recall` that's 10-25x faster.

**Scope:**
- New plugin skeleton (`remempalace`) with `openclaw.plugin.json`
- MCP client integration (call MemPalace tools via OpenClaw's MCP infrastructure)
- LRU cache with TTL
- Parallel search + KG query on every turn
- Relevance threshold filtering (drop results below 0.25 similarity)
- `before_prompt_build` hook + `registerMemoryPromptSection`
- Config schema: `maxTokens`, `similarityThreshold`, `cacheTTL`, `cacheCapacity`

**Replaces:** `mempalace-auto-recall` in the `plugins.slots.memory` slot.

**Success criteria:** Same or better recall quality, measurably faster (< 50ms p95 per turn vs. current ~300ms+).

### Phase 2 — Tiered Injection + Budget Manager

**Goal:** Minimize token cost without sacrificing recall quality.

**Scope:**
- Budget Manager component (reads context window size, tracks conversation length)
- L0/L1/L2 tiered injection logic
- AAAK formatting for injected context
- Deduplication of search + KG overlaps
- Context-window-aware back-off (reduce injection as conversation grows)
- Config: `maxMemoryTokens`, `budgetPercent`, `tiers.l1Threshold`, `tiers.l2Threshold`

**Success criteria:** Average injection size drops from ~1000 tokens to ~150-300 tokens per turn. No degradation in agent response quality (manual evaluation).

### Phase 3 — Diary Write-back

**Goal:** The agent remembers what happened after the session ends.

**Scope:**
- `session_end` hook: summarize conversation in AAAK format
- Call `mempalace_diary_write` with structured summary (what happened, what learned, what matters)
- Async/non-blocking — fire-and-forget, never blocks the session closing
- Configurable: enable/disable, max diary entry length

**Success criteria:** After each session, a diary entry appears in the palace. Next session's wake-up includes it.

### Phase 4 — KG Lifecycle

**Goal:** The agent learns and corrects facts during conversation.

**Scope:**
- `after_response` hook: extract factual claims from agent responses
- Batch KG writes: accumulate facts, flush every N turns or on idle
- Fact invalidation: when a contradiction is detected, `mempalace_kg_invalidate` the old fact + `mempalace_kg_add` the new one
- Cache-first KG reads: check local cache before MCP round-trip
- Write coalescing: multiple updates to the same entity become one write

**Success criteria:** KG grows with accurate facts over sessions. Stale facts get invalidated. Zero user-facing latency from writes (all async).

### Phase 5 — Proactive Memory + Full Autonomy

**Goal:** The memory system anticipates what the agent will need.

**Scope:**
- Heartbeat-driven cache warming: on 30m heartbeat tick, pre-fetch likely-needed context based on recent activity
- Identity chain integration: load SOUL.md / IDENTITY.md context into the palace, inject identity facts at L0
- Timeline queries: "what happened last week?" resolved from diary entries + KG
- Stale fact pruning: flag KG entries that haven't been accessed in N days
- Proactive surfacing: if a cached fact is highly relevant to the current turn but wasn't queried, inject it anyway

**Success criteria:** Agent has relevant context before being asked. Heartbeat keeps cache warm. Identity is always available at L0 cost.

---

## 6. Configuration

All config lives in `openclaw.json` under `plugins.entries.remempalace.config`:

```json
{
  "remempalace": {
    "enabled": true,
    "config": {
      "cache": {
        "capacity": 200,
        "ttlMs": 300000,
        "kgTtlMs": 600000
      },
      "injection": {
        "maxTokens": 800,
        "budgetPercent": 0.15,
        "similarityThreshold": 0.25,
        "tiers": {
          "l1Threshold": 0.3,
          "l2Threshold": 0.25,
          "l2BudgetFloor": 0.5
        },
        "useAaak": true
      },
      "diary": {
        "enabled": true,
        "maxEntryTokens": 500
      },
      "kg": {
        "autoLearn": true,
        "batchSize": 5,
        "flushIntervalMs": 30000
      },
      "prefetch": {
        "diaryCount": 3,
        "identityEntities": true
      }
    }
  }
}
```

---

## 7. File Structure

```
remempalace/
├── src/
│   ├── index.ts              # Plugin entry point, hook registration
│   ├── mcp-client.ts         # MCP JSON-RPC calls to MemPalace
│   ├── cache.ts              # LRU cache with TTL
│   ├── budget.ts             # Token budget manager
│   ├── router.ts             # Memory router (read/write coordinator)
│   ├── tiers.ts              # Tiered injection logic (L0/L1/L2)
│   ├── aaak.ts               # AAAK formatting/compression
│   ├── dedup.ts              # Deduplication of search + KG results
│   ├── diary.ts              # Session-end diary write-back
│   ├── kg.ts                 # KG lifecycle (add/invalidate/batch)
│   └── prefetch.ts           # Wake-up pre-fetch and cache warming
├── openclaw.plugin.json      # Plugin manifest
├── package.json
├── tsconfig.json
├── tests/
│   ├── cache.test.ts
│   ├── budget.test.ts
│   ├── tiers.test.ts
│   ├── router.test.ts
│   └── integration.test.ts
├── README.md
├── LICENSE                   # MIT (same as upstream mempalace)
└── docs/
    └── architecture.md
```

---

## 8. Migration Path

1. Build remempalace Phase 1
2. Install alongside `mempalace-auto-recall` for testing
3. Swap `plugins.slots.memory` from `mempalace-auto-recall` to `remempalace`
4. Remove `mempalace-auto-recall` from `plugins.allow`, `plugins.entries`, `plugins.load.paths`
5. Verify via Telegram: send a message, confirm memory injection is present and fast

---

## 9. Non-Goals

- **Modifying MemPalace core** — this plugin is a consumer, not a fork. If upstream improves search or KG, we benefit automatically via MCP.
- **Live dashboard** — no real-time memory visualization in Phase 1-5.
- **Multi-palace support** — single shared palace at `~/.mempalace/palace` only.
- **LLM-powered fact extraction** — Phase 4 KG updates use pattern matching, not an LLM call (that would negate the speed/cost goals).

---

## 10. Open Questions

- **MCP client access from plugins:** Need to verify that OpenClaw's plugin API exposes MCP tool calling. If not, the plugin may need to connect to the MCP server directly via stdio (still fast, just different wiring).
- **Context window size availability:** Budget Manager needs to know the model's context window. This may come from `openclaw.json` model config or the plugin API. Need to check what's exposed.
- **after_response hook:** Need to verify this hook exists in OpenClaw's plugin API. If not, Phase 4 KG lifecycle would need a different trigger.
