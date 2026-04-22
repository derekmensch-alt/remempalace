# remempalace Critique Report
**Date:** 2026-04-21
**Verdict:** REVISE

## Goal scorecard

| Goal | Verdict | Evidence |
|---|---|---|
| Speed       | MET     | cache.get ≈ 43ns (200k-iter microbench on `dist/cache.js`); warm MCP `search+kg` parallel p50=12.7ms, p95=13.2ms (10-run bench against live mempalace); one persistent MCP subprocess (`process-manager.ts:19` is the only `spawn` in src, and `McpClient.start` is called once at register). |
| Token cost  | PARTIAL | AAAK formatting, dedup, tiered back-off, relevance threshold all present and unit-tested. But identity injection (`index.ts:262-267`) dumps raw SOUL.md + IDENTITY.md on every turn (≈1000 tok) outside the budget manager, and KG L0 is effectively never populated because of the entity-query bug below — so the "facts-first, small" invariant isn't actually holding. |
| Completeness| MISSED  | `mempalace_diary_write` returns "Internal tool error" against the live server (bench run 22:05) — no diary entry will ever land on `session_end`. `mempalace_kg_invalidate` also returns "Internal tool error" *and* nothing in src calls it anyway. Identity is injected but unformatted/unbounded. KG reads return `count:0` for every real prompt (see below). |

## What works well

- Persistent MCP subprocess with JSON-RPC framing is clean and race-safe. `mcp-client.ts:102-124` buffers partial chunks, id-matches responses, and cancels timers on reply. Warm round-trip measured 12-13ms, comfortably under the 50ms p95 target.
- Cache hit path is essentially free — `cache.ts:30-38` is a single `lru.get` plus a counter increment, 43ns measured. No JSON.parse on hit (parsing only happens in `mcp-client.ts:84` on MCP response).
- `router.ts:54-60` runs `search` + `kgQuery` concurrently via `Promise.all` — correctly implemented, not sequential.
- Tiered back-off in `budget.ts:22-31` is correctly gated: ≥80% full → no injection, ≥70% → L0 only, etc. `tiers.test.ts` covers the thresholds.
- Dedup by SHA-256 of normalized text (`dedup.ts`) is reused for both injection de-duplication and KG batch coalescing — nice reuse.
- Test suite: 61 tests / 16 files all passing; `tsc --noEmit` clean; no TODO/FIXME/XXX in src; no dead exports that I could spot beyond `formatSearchResultsAaak` (used only via tests).
- Fire-and-forget diary writes and async KG batching (`diary.ts:52`, `kg.ts:69-82`) mean no user-facing latency from writes, as designed.

## What's broken or wasteful

Sorted by impact.

### 1. HIGH — KG layer queried with full prompt string, always returns 0 facts
- **Problem:** `router.readBundle(prompt, 5)` calls `this.kgQuery(query)` where `query` is the entire user prompt (`index.ts:227` → `router.ts:57`). MemPalace `kg_query` expects an **entity name** (e.g. `"Derek"`, `"remempalace"`), not a sentence.
- **Evidence:** Live MCP call — `kg_query({entity:"what should I do about remempalace today?"}) → {facts:[], count:0}`. Same prompt trimmed to `"remempalace"` returns 6 facts. Source: `src/router.ts:42-52`, `src/index.ts:227`.
- **Impact:** L0 tier is effectively empty on virtually every real turn. This is the highest-value tier (always injected, cheapest, most specific). Design goal "Identity/Facts at L0" is broken for the KG half. Tokens wasted: 0 (nothing is injected); recall quality damage: severe — the whole point of the KG layer is dead.
- **Proposed fix:** Extract entity candidates from the prompt before the KG call. Minimal version: capitalized-word heuristic + a small whitelist of known identity entities (Derek, OpenClaw, remempalace, MemPalace) loaded from config. Fan out to `kg_query` per candidate in parallel, flatten, dedup. Keep the current single-call path as fallback for zero candidates.

### 2. HIGH — Diary write-back is broken against the live server
- **Problem:** `mempalace_diary_write` returns `"Internal tool error"` for every arg combo tried. The `writeDiaryAsync` in `diary.ts:52-63` silently swallows this, so the failure is invisible.
- **Evidence:** Live MCP: `diary_write({wing:"claude_code",room:"general",content:"...",added_by:"remempalace"}) → "Internal tool error"`. `diary_read` also fails identically. Also: `/home/derek/.mempalace/palace/diary/` does not exist.
- **Impact:** Phase 3 success criterion ("after each session a diary entry appears in the palace") is 100% unmet in production. Next-session wake-up includes nothing. Currently masked by the silent `catch` block.
- **Proposed fix:** Two-part. (a) Probe diary tools at `McpClient.start` and surface the error via logger.warn + a capability flag on the client (`mcp.hasDiary`) so the plugin can disable the diary branch instead of pretending to write. (b) Investigate the mempalace-side tool — likely a schema mismatch or missing diary directory. If upstream is broken, fall back to appending to a local JSONL at `~/.mempalace/palace/diary/<date>.jsonl` and add an M.x cutover task for when upstream is fixed.

### 3. HIGH — Identity dumped raw on every turn, outside budget manager
- **Problem:** `index.ts:262-268` unconditionally prepends `start.identity.soul` + `start.identity.identity` (up to 2000 chars each = ~1000 tokens) to the builder output. This bypasses `BudgetManager` entirely, is not AAAK-compressed, and is not dedup-aware. When context is near-full the budget manager correctly returns `allowedTiers: []` but identity still goes in.
- **Evidence:** `index.ts:263-267`; `identity.ts:17` defaults `maxChars:4000` (caller passes `2000`).
- **Impact:** Baseline injection size is ~1000 tokens per turn *before* any L0/L1/L2 content. Design target is 150-300 total. Token cost goal is unachievable as long as this exists. Also contradicts §3 of the design ("injected memory uses AAAK dialect where possible").
- **Proposed fix:** Summarize SOUL.md + IDENTITY.md once at session start into ≤150 tokens of AAAK facts and cache that. Route the compressed string through `BudgetManager` at L0 so it respects the "skip when context >80% full" rule. Keep raw markdown only when a config flag (`injection.rawIdentity`) is explicitly true.

### 4. MEDIUM — Prefetch misses the 100ms target
- **Problem:** Design §4 requires pre-fetch <100ms. Measured 230.7ms (status + diary_read in parallel, dry run after cold MCP start).
- **Evidence:** Ad-hoc bench this session: `prefetch (status+diary): 230.7ms`. First cache-miss `search+kg` in same run took 208ms (ChromaDB first-query warmup).
- **Impact:** Adds ~130ms to first-turn latency. Modest — it's a one-time cost per session — but misses the stated success criterion.
- **Proposed fix:** Fire a zero-result dummy `mempalace_search({query:"warmup",limit:1})` in parallel with status+diary during prefetch. This pre-warms ChromaDB so the first real search is fast. Also cache palace status across sessions (disk-backed) since it rarely changes.

### 5. MEDIUM — No KG invalidation pathway exists
- **Problem:** Phase 4 explicitly lists "stale fact invalidation when contradicted" as a deliverable. `grep -r kg_invalidate src/` returns zero hits. `KgBatcher` only adds.
- **Evidence:** `src/kg.ts` has no invalidate logic; live `kg_invalidate` also returns "Internal tool error" so even calling it won't help right now.
- **Impact:** KG will accumulate stale/contradicting facts indefinitely. Correctness drift over time.
- **Proposed fix:** Deferred — first fix the upstream tool (same root as #2), then add a contradiction-detection pass in `kg.ts` that, before an `add`, runs `kg_query` on the subject and emits `kg_invalidate` for any same-predicate fact with a different object. Keep this behind a config flag since the upstream tool is currently broken.

### 6. LOW — `BudgetManager` allocated per turn
- **Problem:** `index.ts:217` does `new BudgetManager({...}).compute({conversationTokens})` every turn. Trivial allocation but unnecessary — the constructor config is constant across the session.
- **Evidence:** `src/index.ts:217-222`.
- **Impact:** Micro (~µs per turn). Listed for code quality only.
- **Proposed fix:** Hoist `const budgetManager = new BudgetManager({...})` above the hook registration, just call `budgetManager.compute()` per turn. One-liner.

### 7. LOW — Fact extractor regexes are fragile
- **Problem:** `kg.ts:8` regex matches `SUBJ (uses|prefers|runs|...) OBJ` but requires a trailing preposition/period. Real agent prose like "Derek uses OpenClaw to manage plugins" is captured (stops at "to"? no — "to" isn't in the stop list, so it'd grab "OpenClaw to manage plugins"). Worth a closer pass.
- **Evidence:** `src/kg.ts:7-8`.
- **Impact:** Noise in the KG (wrong objects) or missed facts. Low because auto-learn is a nice-to-have and batcher dedups.
- **Proposed fix:** Swap hand-rolled regex for a proper POS-lite tokenizer or port a small rules file. Out of scope for a revision pass unless KG quality complaints materialize.

## Recommended plan revisions

Plan edits: add a **Phase 7: Revisions** section just before Migration & Cutover. Existing tasks are not deleted; items superseded are marked inline.

New tasks being added:

- **Task 7.1** [Model: sonnet] — Extract entity candidates from prompts before kg_query (fix #1)
- **Task 7.2** [Model: sonnet] — Diary health check + fallback + upstream issue report (fix #2)
- **Task 7.3** [Model: sonnet] — AAAK-compressed identity through BudgetManager (fix #3)
- **Task 7.4** [Model: haiku]  — Prefetch ChromaDB warm-up search (fix #4)
- **Task 7.5** [Model: sonnet] — KG invalidation pathway behind feature flag (fix #5, gated on upstream)
- **Task 7.6** [Model: haiku]  — Hoist BudgetManager out of hot path (fix #6)

## Decision gate

Two HIGH items (#1 entity-query bug, #2 diary broken) are correctness failures but the plugin is still useful as a search+injection layer. The L0 KG layer being dead is the most painful since it removes the fastest, cheapest recall tier. No rollback needed — remempalace in its current form still outperforms mempalace-auto-recall on speed and token cost for L1/L2 — but Phase 7 must land before this can be called "complete".

**Verdict: REVISE.** Appending Phase 7 to the implementation plan now.
