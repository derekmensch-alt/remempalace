# remempalace Refactor Goal and Task Plan

## North-star goal

Build **remempalace as the OpenClaw ↔ MemPalace memory bridge**: a dependable memory subsystem that lets OpenClaw agents recall, learn, and persist useful context across sessions through MemPalace, while staying fast, auditable, safe, and resilient when MemPalace or MCP is partially broken.

At the end of the refactor, the plugin should be easy to judge against this promise:

> OpenClaw can ask one memory plugin for relevant context before a turn, write durable user-approved/derived memories after a turn, and inspect/recover memory health — without knowing MemPalace internals and without poisoning prompts or silently losing writes.

## Product contract

### What the plugin must do

1. **Recall** relevant memory before prompt build.
   - Prefer structured KG facts for crisp identity/project/user facts.
   - Use semantic drawers/search for richer context.
   - Inject bounded, deduplicated, source-labeled context.

2. **Learn** from conversation safely.
   - Extract candidate facts from user text.
   - Avoid assistant self-poisoning unless explicitly enabled.
   - Batch writes and invalidate recall caches after successful writes.

3. **Persist sessions** as diary entries.
   - Write session summaries to MemPalace diary using the current MCP schema.
   - Verify persistence, not just tool success.
   - Fall back to local JSONL when remote diary persistence is unavailable.
   - Replay fallback entries once persistence is healthy.

4. **Expose OpenClaw-native memory runtime operations.**
   - Search/read/write/delete where OpenClaw expects a memory runtime.
   - Hide MemPalace-specific tool schemas behind a stable internal port.

5. **Be observable and recoverable.**
   - `/remempalace status` should tell whether MCP is ready, which capabilities work, whether diary is truly persistent, cache stats, last recall, pending fallbacks, and recent errors.
   - Debug logs must be opt-in and scrub prompt/memory content where practical.

### What the plugin must not do

- It must not silently claim diary writes succeeded unless they can be read back or otherwise verified.
- It must not inject stale fallback warnings when the current capability is healthy.
- It must not couple OpenClaw hook logic directly to raw MCP tool argument shapes.
- It must not let legacy MemPalace schema drift break OpenClaw-facing behavior without a clear status/error.

## Current plugin summary

Current remempalace already has useful pieces:

- OpenClaw hooks: `session_start`, `llm_input`, `before_prompt_build`, `llm_output`, `session_end`, `gateway_stop`.
- One warm MemPalace MCP process via `McpClient`.
- Recall path: candidate extraction → KG query + search → tiered injection.
- Learning path: structured fact extraction → KG batcher.
- Persistence path: session summary → diary write, with JSONL fallback.
- Runtime path: `MempalaceMemoryRuntime` registered as OpenClaw memory runtime.
- Observability: `/remempalace status`, metrics, optional debug log.

## Key gaps found so far

- `McpClient.probeCapabilities()` only checks whether diary tools exist; it does not prove diary calls succeed or persist.
- Diary schema has changed upstream: current MemPalace expects `agent_name`, `entry`, optional `topic`/`wing`; older docs mention `wing`, `room`, `content`, `added_by` and fail with `Internal tool error`.
- `mempalace_diary_write` can return success while the entry is not readable afterward in this environment. That means write health must include persistence verification.
- Diary MCP calls are currently known to fail or fall back to JSONL in this environment. If read/write attempts still happen on the prompt/session path before fallback, they can add avoidable latency.
- `index.ts` is doing too much: lifecycle orchestration, injection assembly, learning, diary, status, cache invalidation, and debug logging are all interleaved.
- Fallback warning logic is tied to `hasDiaryWrite`, not a stronger `diaryPersistenceHealthy` state.
- OpenClaw-facing behavior and MemPalace-specific MCP tool schemas are not cleanly separated.
- Prompt-path recall can be too expensive by default: full recall can run for tiny acknowledgements, KG fanout can query several entities per prompt, and MCP call timeouts are too high for memory that should degrade gracefully.

## Target architecture

Use ports/adapters so OpenClaw and MemPalace can evolve independently.

```text
OpenClaw hooks/runtime/command
        │
        ▼
Remempalace Orchestrator
  ├─ RecallService
  ├─ LearningService
  ├─ DiaryService
  ├─ HealthService
  └─ MemoryRuntimeAdapter
        │
        ▼
MemPalaceRepository port
        │
        ▼
McpMemPalaceRepository adapter
        │
        ▼
MemPalace MCP server
```

### Proposed modules

- `src/plugin.ts` — register hooks/commands only; no business logic.
- `src/orchestrator.ts` — session lifecycle coordination.
- `src/ports/mempalace-repository.ts` — stable internal interface.
- `src/adapters/mcp-mempalace-repository.ts` — raw MCP tool calls and schema negotiation.
- `src/services/recall-service.ts` — candidate extraction, KG/search bundle, tiered injection.
- `src/services/learning-service.ts` — fact extraction, dedup, batching.
- `src/services/diary-service.ts` — summarize/write/verify/fallback/replay.
- `src/services/health-service.ts` — capability probes, persistence probes, status model.
- `src/openclaw/memory-runtime-adapter.ts` — OpenClaw memory runtime surface.
- `src/openclaw/prompt-injection.ts` — exact hook/builder compatibility handling.

## Task tracking

### Phase 0 — Baseline and safety net

- [x] Capture current behavior with tests and smoke scripts. See `docs/phase-0-baseline.md`.
- [x] Add integration test harness gated by `REMEMPALACE_TEST_PY`. See `tests/diary-integration.test.ts`.
- [x] Add diary persistence probe test: write → read recent entries → confirm probe content/id.
- [x] Record current failing diary behavior in docs/status.
- [x] Gate: `npm run lint && npm test` green.
- [x] Run gated integration probe and record current pass/fail output. Result: 3/4 passed; persistence probe fails because write success is not readable afterward.

### Phase 1 — Define stable internal contracts

- [x] Create `MemPalaceRepository` interface for KG, search, diary, status, and capability checks.
- [x] Move raw MCP calls behind `McpMemPalaceRepository`.
- [x] Preserve current `McpClient` process management but stop leaking tool schemas into plugin services.
- [x] Add typed errors: `CapabilityMissing`, `ToolFailed`, `PersistenceUnverified`, `BackendUnavailable`.
- [x] Gate: unit tests cover adapter success/failure mapping.

### Phase 2 — Fix diary as a first-class subsystem

- [x] Update diary writes to current MemPalace schema: `agent_name`, `entry`, `topic`, optional `wing`.
- [x] Add startup diary health probe that tests persistence, not just tool presence.
- [x] Change status from `hasDiaryWrite` to states: `unavailable`, `tool-present`, `write-ok-unverified`, `persistent`, `fallback-active`.
- [x] Use local JSONL fallback whenever persistence is not verified.
- [x] Short-circuit diary read/write to local JSONL while diary MCP persistence is known broken, or enforce a tiny diary MCP timeout around 200-500ms before fallback.
- [x] Replay fallback only after persistence is verified.
- [x] Make fallback warnings reflect actual health state.
- [x] Gate: diary tests cover schema drift, write success/read miss, fallback, replay.

### Phase 3 — Extract recall and injection

- [x] Move candidate extraction + bundle reads into `RecallService`.
- [x] Move identity/timeline/runtime disclosure assembly into `PromptInjectionService`.
- [x] Keep the exactly-once hook/builder compatibility behavior covered by tests.
- [x] Add source labels and tighter injection snapshots for auditability.
- [x] Make recall conditional: skip full recall or use cheap mode for tiny acknowledgements, thanks/ok messages, simple tool follow-up chatter, and prompts without enough semantic content.
- [x] Add a two-tier recall mode: cheap lexical/entity recall by default, full semantic search + KG only for question-like, project-specific, prior-context, or named-entity prompts. Initial cheap/full classifier, cheap diary-prefetch lexical context, and prompt-path snapshots are in place.
- [x] Precompute recall on `llm_input` when possible so `before_prompt_build` can reuse already-started or already-completed work.
- [ ] Race fast sources first: use cached recall, identity, and last-session summaries immediately; let slower KG/search update cache in the background for the next turn.
- [ ] Reduce KG fanout: cap per-prompt entity KG queries to 1-2 by default unless the prompt clearly needs broader memory, or batch KG on the MemPalace side if available.
- [ ] Deduplicate KG entity queries across aliases/normalized roots and skip generic entities like `project`, `this`, `it`, `memory`, and `OpenClaw` unless explicitly useful.
- [ ] Cache recall more aggressively with a normalized "last user intent" cache, TTL around 2-5 minutes, and reuse previous recall bundles for same-topic follow-up messages.
- [ ] Add negative caching for empty or timed-out KG/search queries with a short TTL around 1-5 minutes.
- [ ] Persist a small hot recall/health cache across plugin restarts to reduce cold-start latency.
- [ ] Lower prompt-path recall MCP timeouts from 8000ms to roughly 1200-2000ms, with graceful empty fallback.
- [ ] Add a hard shared prompt-path memory budget, e.g. 1500ms total for `before_prompt_build`, where search, KG, identity, formatting, and token-budget work all consume from one deadline.
- [ ] Limit formatting/token-budget work by building fewer candidate lines before token counting instead of assembling a large block and trimming afterward.
- [ ] Gate: before_prompt_build tests compare expected injection blocks.

### Phase 4 — Extract learning

- [ ] Move KG extraction/dedup/batching into `LearningService`.
- [ ] Make source-role policy explicit: user default enabled, assistant disabled by default, system restricted.
- [ ] Add explicit handling for user memory commands (`remember`, `forget`) or document that they are logged only.
- [ ] Gate: extraction thresholds and dedup tests green.

### Phase 5 — OpenClaw runtime adapter cleanup

- [ ] Ensure `MempalaceMemoryRuntime` uses the repository port instead of raw MCP.
- [ ] Map OpenClaw memory runtime methods to consistent MemPalace operations.
- [ ] Enforce allowed read roots and write safety at the adapter boundary.
- [ ] Gate: runtime tests green.

### Phase 6 — Observability and operations

- [ ] Redesign `/remempalace status` around health states and last operation summaries.
- [ ] Add concise probe output: MCP ready, tools present, diary persistent, KG writable, pending fallback count, cache stats, last recall.
- [ ] Add latency metrics, not just counters: `before_prompt_build`, `mempalace_search`, `mempalace_kg_query`, diary read/write, formatting, and token-budget work.
- [ ] Show latency summaries in `/remempalace status` so slow recall, KG, search, diary, formatting, and token-budget work are visible.
- [ ] Add backend circuit breakers: if MemPalace search, KG, or diary times out/fails repeatedly, disable that backend briefly and serve local/cache-only memory during cooldown.
- [ ] Keep status/health probes out of the prompt path; prompt build should consume cached health, not discover backend health synchronously.
- [ ] Keep opt-in debug logging but avoid dumping full prompt content by default.
- [ ] Update `TROUBLESHOOTING.md`, `CONFIGURATION.md`, and smoke test docs.
- [ ] Gate: manual `/remempalace status` check plus smoke script.

### Performance fast path — recommended first patch

- [ ] Add timing metrics for prompt-path work and MCP calls.
- [ ] Short-circuit broken diary MCP calls to JSONL fallback, or enforce a 200-500ms diary MCP timeout.
- [ ] Reduce recall call timeout to roughly 1200-2000ms and return empty memory context on timeout.
- [ ] Add a shared `before_prompt_build` memory deadline so slow sources cannot stall the whole assistant.
- [ ] Add negative caching and basic backend circuit breakers for repeated timeouts.
- [ ] Use cheap recall mode for short acknowledgements and low-semantic-content turns.
- [ ] Keep behavior graceful: memory should help when fast, not stall the assistant.
- [ ] Gate: `npm run lint && npm test`; status output shows latency data.

### Phase 7 — Final acceptance

- [ ] `npm run build` passes.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] Integration smoke against `/home/derek/.venvs/mempalace/bin/python` documents diary persistence result.
- [ ] OpenClaw status shows remempalace active.
- [ ] One real prompt build injects exactly one bounded memory block.
- [ ] Session-end diary behavior is either verified persistent or clearly local fallback with replay pending.

## Definition of done

The refactor is successful if:

1. The OpenClaw-facing plugin API is small and stable.
2. MemPalace MCP schema quirks are contained in one adapter.
3. Diary persistence cannot silently fail.
4. Recall remains fast and bounded.
5. Learning remains conservative and auditable.
6. `/remempalace status` explains what is working, degraded, or blocked.
7. The final implementation can be compared directly against the north-star goal above.

## Current state

- Created: 2026-05-11
- Owner: main OpenClaw assistant session
- Last updated: 2026-05-11T12:03:20-04:00
- Status: Phase 0, Phase 1, and Phase 2 complete. Phase 3 extraction is partially complete: `RecallService`, `PromptInjectionService`, exactly-once hook/builder coverage, source-label snapshots, low-semantic recall skips, two-tier recall with cheap diary-prefetch context, and `llm_input` recall precompute are in place.
- Current gate: `npm run lint` and `npm test` pass in the default suite.
- Boundary check: raw `callTool(` usage is isolated to `src/adapters/mcp-mempalace-repository.ts`.
- Handoff details: see `docs/current-refactor-status.md`.
- Immediate next task: add prompt-path deadline controls around full recall so reused or freshly-started search/KG work cannot stall `before_prompt_build` indefinitely.
