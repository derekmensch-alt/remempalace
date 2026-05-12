# Current Refactor Status

Updated: 2026-05-12T18:10:00-04:00

## Summary

The remempalace refactor has completed Phase 0, Phase 1, and Phase 2. Phase 3 is underway and the low-risk extraction slices completed so far are covered by tests.

Current default gate:

```text
npm run lint
npm test
```

Latest observed default test result:

```text
Test Files  34 passed | 2 skipped (36)
Tests       472 passed | 6 skipped (478)
```

Latest corrective gate after addressing blocking concerns:

```text
git diff --check  passed
npm run lint      passed
npm test          34 passed | 2 skipped; 472 passed | 6 skipped
```

## Completed

- Added Phase 0 docs and a gated diary integration harness.
- Added `MemPalaceRepository` and `McpMemPalaceRepository`.
- Kept raw MemPalace MCP tool schemas behind `src/adapters/mcp-mempalace-repository.ts` and `src/ports/mempalace-repository.ts`.
- Routed recall, KG writes/invalidation, prefetch, timeline, diary replay, diary writes, status, and runtime search through the repository boundary.
- Added typed repository errors: `CapabilityMissing`, `ToolFailed`, `PersistenceUnverified`, `BackendUnavailable`.
- Added diary persistence verification that distinguishes tool presence from verified persistence.
- Session diary writes fall back to local JSONL unless persistence is verified.
- Fallback replay runs only after persistence is verified.
- `/remempalace status` reports diary health using persistence state rather than raw diary-write tool presence.
- Added prompt-path diary read timeout support with a 500ms default for prefetch/timeline reads.
- Added `DiaryService`, `RecallService`, and `PromptInjectionService` slices.
- Moved candidate extraction and bundle reads into `RecallService`.
- Added `RecallService.shouldSkipRecall()` classifier coverage for tiny acknowledgements, tool follow-up chatter, short low-semantic prompts, and project/entity/question prompts.
- Wired low-semantic recall gating into `before_prompt_build` so acknowledgement/tool-chatter turns skip KG/search while project and question prompts keep full recall.
- Added an initial cheap/full recall mode in `RecallService`: ordinary non-specific prompts use a cheap empty bundle, while questions, prior-context prompts, and entity/project prompts keep full search + KG recall.
- Refined the cheap recall tier to inject lexically matched session-start diary-prefetch context without prompt-path semantic search or KG fanout.
- Added session-scoped `llm_input` full-recall precompute and reuse in `before_prompt_build` when prompt/candidates still match, avoiding duplicate search/KG calls.
- Added a 1500ms shared prompt-path memory deadline around MCP init readiness, timeline reads, and full recall waits, including reused precompute promises, with graceful fallback on timeout.
- Reduced KG fanout by capping per-prompt entity KG queries to 2 by default, deduplicating normalized aliases/roots, and filtering generic entities such as `project`, `this`, `it`, `memory`, and `OpenClaw`.
- Added router/repository timeout propagation for search/KG reads and negative caching of empty fallback results on timeout/backend-unavailable read failures.
- Moved runtime disclosure, identity, memory, and timeline block assembly into `PromptInjectionService`.
- Strengthened exactly-once hook/builder compatibility tests.
- Added inline snapshots for source-labelled injection output.
- Limited tiered injection formatting/token-budget work by capping L0/L1/L2 candidate scans before formatting/token counting when the remaining budget cannot fit more candidates.
- Fixed hot recall cache export/import correctness: exports now use most-recent entries first, imported entity reverse-index keys are normalized for KG invalidation, and non-timeout backend failures are no longer negative-cached as empty recall.
- Added `cheap+kg1` recall mode for entity-bearing continuation prompts: it skips semantic search, performs at most one KG query under the fast recall window, and falls back to cheap diary-prefetch lines on timeout.
- Reused `llm_input` precomputed full recall across normalized-equivalent prompts using `normalizeIntent()` plus TTL, so near-identical `before_prompt_build` prompts can avoid duplicate full recall work.
- Included request shape (`mode`, `limit`, KG fanout) in router bundle cache keys so normalized-intent entries do not cross-contaminate narrower/broader recall requests.
- Precomputed static prompt wrapper token costs in `PromptInjectionService` and reused the cached runtime disclosure lines for rendering, avoiding repeated wrapper token counts during `before_prompt_build`.
- Fixed bounded L1/L2 formatting so search hits are filtered by threshold before applying the formatting/token-count candidate window, preserving qualifying later hits from unsorted result sets.
- Hardened hot recall cache invalidation bookkeeping: alias/root reverse indexes are normalized, stale bundle/KG reverse-index entries are pruned, warm imports do not overwrite fresher in-session bundles, and KG invalidation clears matching timeout-negative fallbacks.

## Corrective Fixes From Review

- Removed trailing whitespace reported by `git diff --check`.
- Added `timeoutMs` support to diary writes, not just diary reads.
- Bounded `verifyDiaryPersistence()` diary write/read probes with 500ms timeouts.
- Stopped injecting diary fallback/health warnings into model prompts; health remains visible in status/logs.
- Made fallback replay run a fresh persistence probe when the repository supports it before marking JSONL lines replayed.
- Added startup warning logs for unverified diary persistence probe results, not just thrown probe errors.

## Current Boundaries

Raw MCP `callTool(` usage should remain isolated to:

```text
src/adapters/mcp-mempalace-repository.ts
```

Known MCP capability field names such as `hasDiaryWrite`, `hasDiaryRead`, and `hasKgInvalidate` still exist in the MCP client and adapter boundary. Plugin services should use repository-facing names such as `canWriteDiary`, `canReadDiary`, `canInvalidateKg`, and `canPersistDiary`.

## Worktree Note

The worktree contains many modified files plus untracked docs, adapter/port/service files, and new tests from the refactor. These are expected in the current slice. Do not revert unrelated untracked files.

## Remaining Phase 3 Work

- Persist a small hot health/status cache across plugin restarts to reduce cold-start status latency.
- Document the current recall/cache configuration surface in `CONFIGURATION.md`, `INSTALL.md`, and smoke-test notes.

## Next Recommended Slice

Update configuration and smoke-test docs for the new fast-path settings (`cache.bundleTtlMs`, `injection.fastRaceMs`, hot recall cache persistence, and recall modes) before moving into Phase 4 learning extraction.

## Newly Added Backlog (Speed + Intuition)

- Add stage-level prompt-path sub-budgets and latency metrics (`init`, `fetch`, `format`) plus `/remempalace status` summaries (p50/p95).
- Harden diary timeout coverage: thread bounded timeouts through persistence probe/write/read paths so startup/prompt flow cannot stall.
- Add normalized-intent precompute reuse (short TTL) so near-identical follow-ups avoid duplicate full recall calls.
- Add a middle recall mode (`cheap+kg1`) for "continue/next step" prompts to improve relevance with low latency.
- Keep operational health state out of prompts and present it as clear labels in status/logs (`healthy`, `degraded`, `offline`) with last probe reason.
- Make replay marking durable-aware: require post-write read verification or same-cycle successful persistence probe before marking JSONL entries replayed.
- Precompute static token costs for fixed injection headers/prefixes to reduce repeated token counting in prompt path.
- Persist a small hot recall/health cache across plugin restarts to reduce cold-start latency.
