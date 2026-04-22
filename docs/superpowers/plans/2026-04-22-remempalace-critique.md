# remempalace Critique Report — Pass 2
**Date:** 2026-04-22
**Verdict:** SHIP

## Goal scorecard

| Goal | Verdict | Evidence |
|---|---|---|
| Speed | MET | One persistent MCP subprocess — `spawn` appears once at `process-manager.ts:19`, `McpClient.start` called once at `index.ts:107`. Cache hit is a single `lru.get` + counter bump (`cache.ts:30-38`). `router.readBundle` runs search + `kgQueryMulti` concurrently via `Promise.all` (`router.ts:88-91`); `kgQueryMulti` fans out entities in parallel as well (`router.ts:69`). Prefetch now fires status + diary + warmup search in one `Promise.all` (`prefetch.ts:24-31`), so the first real search is no longer cold. No CLI spawns per turn anywhere in `src/`. |
| Token cost | MET | Identity is routed through `compactIdentity` (`index.ts:234-240`), gated on `budget.allowedTiers.includes("L0")`, so when context is ≥80 % full even identity is suppressed. Live check against real SOUL.md (2878 B) + IDENTITY.md (1531 B) with `maxTokens:150` produced 600 chars ≈ 150 tokens of `SECTION: val \| val` lines — exactly on target (see `identity-compact.ts:41-104`, test `identity-compact.test.ts:22-24`). AAAK formatting (`aaak.ts`), SHA-256 dedup (`dedup.ts`), and 80/70/50 % tier back-off (`budget.ts:22-31`, `tiers.test.ts`) all intact. |
| Completeness | MET | **Diary**: capability probe runs at startup (`mcp-client.ts:60-93`), sets `hasDiaryWrite`; when false `writeDiaryAsync` falls through to `appendLocalDiary` (`diary.ts:50-64`). Live disk check: `/home/derek/.mempalace/palace/diary/2026-04-22.jsonl` exists, 12 valid JSONL lines, correct shape. **KG**: entity extraction (`entity-extractor.ts:21-33`) feeds `kgQueryMulti` — real prompts now yield candidates (e.g. "what should I do about remempalace today?" → `["remempalace"]` via the whitelist path, `entity-extractor.test.ts:15-23`). **KG invalidation** correctly gated: `invalidateOnConflict:false` by default + runtime `hasKgInvalidate` check (`kg.ts:80-82`); `kg-invalidate.test.ts:20-36` verifies flag-off is silent, `:39-55` verifies flag-on + upstream-broken is also silent, `:57-92` verifies flag-on + healthy invalidates correctly. **Identity** compacted, bounded, and budget-routed. |

## What works well

- **Diary fallback is end-to-end proven.** The probe → capability flag → local-JSONL write path is live: `hasDiaryWrite=false` on the real system (upstream still broken), and the on-disk `2026-04-22.jsonl` shows 12 successful writes from real sessions. Next-session wake-up will actually have content to read. `diary.test.ts` and `diary-fallback.test.ts` together cover both branches.
- **Entity extraction is a clean two-strategy lookup** — capitalized-word regex + known-entity whitelist, case-insensitive dedup, capped at 4 candidates (`entity-extractor.ts:14-35`). Wired through `MemoryRouter.extractCandidates` (`router.ts:74-80`) and used by `readBundle` with a single-call fallback for zero-candidate prompts (`router.ts:90`). Six tests covering: caps, whitelist-only, case-dedup, empty cases.
- **compactIdentity** preserves section structure (`SECTION: val1 | val2 | val3`), honours `rawIdentity` escape hatch for debugging, and binary-searches truncation (`identity-compact.ts:12-26`) — clean and efficient. Live measurement against the actual SOUL/IDENTITY files hit exactly the 150-token target.
- **KG invalidation runtime gating** is defensive: requires *both* `invalidateOnConflict:true` *and* `hasKgInvalidate:true` from the capability probe (`kg.ts:80-82`). Default config ships with the flag off (`config.ts:17`), so no accidental upstream traffic. When upstream is fixed, enabling is a one-line config change.
- **Prefetch warmup** is non-intrusive: the third `Promise.all` slot fires `mempalace_search({query:"__warmup__",limit:1})` but the result is discarded from `PrefetchResult` (`prefetch.ts:24-34`). `prefetch.test.ts:34-46` locks the contract.
- **BudgetManager hoisted** once per session (`index.ts:121-125`) — no per-turn allocation.
- **Test suite healthy**: 20 files / 83 tests, all passing; covers the new entity-extractor, identity-compact, diary-fallback, prefetch warmup, and KG invalidation paths. Integration test actually hits the live MemPalace MCP subprocess (`integration.test.ts`, 379 ms). No TODO/FIXME/XXX in `src/`.

## What's broken or wasteful

Only LOW-impact nits remain.

### 1. LOW — `normalizeKgResult` duplicated verbatim in `index.ts`, `router.ts`, and `kg.ts`
- **Problem:** Same 7-line function appears at `index.ts:72-79`, `router.ts:21-28`, and `kg.ts:5-12`. Now that three modules need it, it should move to a shared helper.
- **Impact:** Maintenance risk — if the MCP response shape changes, fixing it in one place and missing another will silently return `[]`.
- **Proposed fix:** Extract to `src/kg-normalize.ts` (or add it to `types.ts` alongside `KgFact`). One-commit cleanup.

### 2. LOW — Hardcoded SOUL/IDENTITY paths in `session_start`
- **Problem:** `index.ts:153-154` hardcodes `/home/derek/SOUL.md` and `/home/derek/IDENTITY.md`. No config override.
- **Impact:** Plugin will not function for any other user without a source edit. Contradicts "config-driven" spirit of the rest of the module.
- **Proposed fix:** Add `cfg.identity.soulPath` / `cfg.identity.identityPath` with sensible default (e.g. `${homedir()}/SOUL.md`). One-line config addition.

### 3. LOW — `compactIdentity` heading flush is non-idempotent
- **Problem:** `identity-compact.ts:63-69` pushes a blank-bullets section when a heading has no bullets yet, but the last-section flush at line 80 also pushes on `currentHeading` — an empty-body heading can be pushed twice if another heading follows immediately. Harmless (deduped downstream, truncated to token budget) but the control flow is tangled.
- **Impact:** None observed; the 150-token truncation trims any duplicates. Code-quality nit.
- **Proposed fix:** Track a `currentPushedHeadingOnly` flag, or simply flush at heading-transitions only. Optional.

### 4. LOW — `probeCapabilities` writes a real "probe" diary entry on startup
- **Problem:** `mcp-client.ts:62-68` issues an actual `mempalace_diary_write` with `content:"probe"` on every startup. When upstream works, this will spam one diary row per plugin instantiation.
- **Impact:** Currently masked because upstream is broken (so the probe always fails and no row lands). When fixed, this becomes visible noise.
- **Proposed fix:** Either (a) issue a `mempalace_diary_read` probe instead (read-only), or (b) use a sentinel content string like `__remempalace_selftest__` that downstream tooling can filter. Low priority since upstream is broken.

## Recommended plan revisions

None required for SHIP. If the team wants to file polish follow-ups, create a **Phase 8 (Polish)** section in the implementation plan with one task per LOW item above. Suggested naming:

- Task 8.1 [Model: haiku] — Extract shared `normalizeKgResult` helper (fix #1)
- Task 8.2 [Model: haiku] — Config-ify SOUL/IDENTITY paths (fix #2)
- Task 8.3 [Model: haiku] — Tidy `compactIdentity` heading flush (fix #3)
- Task 8.4 [Model: haiku] — Use read-only probe for diary capability (fix #4)

All four are easily parallelisable and none block shipping.

## Decision gate

All three original goals are now MET. Every HIGH item from the Pass 1 critique is fixed and covered by tests:

- #1 KG entity extraction — `entity-extractor.ts` + `router.kgQueryMulti` + 6 unit tests.
- #2 Diary write-back — capability probe + local JSONL fallback + verified on-disk output.
- #3 Identity bypass — `compactIdentity` routed through `BudgetManager`'s L0 gate, ≤150 tokens measured against real input.

MEDIUM items are also resolved: prefetch now fires a warmup search (#4), KG invalidation pathway exists and is correctly dual-gated behind config flag + capability probe (#5), BudgetManager hoisted out of the hot path (#6).

No HIGH or MEDIUM regressions introduced. Test suite is green (83/83). The only remaining issues are cosmetic LOW-impact cleanups that can ship in a follow-up.

**Verdict: SHIP.** Phase 7 landed cleanly; the plugin meets all three design goals and is ready for cutover from `mempalace-auto-recall`.
