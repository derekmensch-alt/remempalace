# Current Refactor Status

Updated: 2026-05-11T12:03:20-04:00

## Summary

The remempalace refactor has completed Phase 0, Phase 1, and Phase 2. Phase 3 is underway and the low-risk extraction slices completed so far are covered by tests.

Current default gate:

```text
npm run lint
npm test
```

Latest observed default test result:

```text
Test Files  31 passed | 2 skipped (33)
Tests       365 passed | 6 skipped (371)
```

Latest corrective gate after addressing blocking concerns:

```text
git diff --check  passed
npm run lint      passed
npm test          31 passed | 2 skipped; 365 passed | 6 skipped
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
- Moved runtime disclosure, identity, memory, and timeline block assembly into `PromptInjectionService`.
- Strengthened exactly-once hook/builder compatibility tests.
- Added inline snapshots for source-labelled injection output.

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

- Race fast sources first: cached recall, identity, and last-session summaries immediately; let slower KG/search update cache in the background for the next turn.
- Reduce KG fanout and deduplicate aliases/generic entities.
- Add negative caching and stronger prompt-path deadline controls.

## Next Recommended Slice

Add prompt-path deadline controls around full recall so reused or freshly-started search/KG work cannot stall `before_prompt_build` indefinitely.
