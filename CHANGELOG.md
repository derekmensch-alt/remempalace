# Changelog

All notable changes to remempalace are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-25

First public release. Plugin shipped after the Phase 7 critique returned `SHIP` and the KG-first recall fix landed; in production use against the author's gateway since 2026-04-23.

### Added

#### Core recall pipeline
- Persistent MCP/JSON-RPC connection to MemPalace — eliminates per-turn process spawning. ([f0b5343], [52e8c58])
- LRU cache with separate TTLs for search/diary (`cache.ttlMs`, default 5 min) and KG queries (`cache.kgTtlMs`, default 10 min). ([3cd272d])
- Memory router with cache-first reads and parallel fetches across MCP tools. ([4621551])
- Token-budget manager with context-aware backoff via `injection.maxTokens` and `injection.budgetPercent`. ([f40cc6e], [7be5755])
- Three-tier injection (L0 identity / L1 high-confidence / L2 supporting) with `tiers.l1Threshold`, `tiers.l2Threshold`, and `tiers.l2BudgetFloor`. ([2033a75], [65d64d0])
- AAAK compression for injected blocks (`injection.useAaak`, default `true`). ([c2acfcb])
- Content-hash deduplication for repeat injections within a session. ([ccbb6dc])

#### Two-way memory
- KG auto-learn extracts facts from conversation and writes them via `mempalace_kg_add` (toggle: `kg.autoLearn`, default `true`). ([c353019], [e051963])
- KG batching with `kg.batchSize` (default 5) and `kg.flushIntervalMs` (default 30s). ([c353019])
- Session-end diary writes summarize the conversation via `mempalace_diary_write` (`diary.enabled`, `diary.maxEntryTokens`). ([5d2195b], [4c45127])
- Local JSONL diary fallback to `~/.mempalace/palace/diary/` when the MCP write fails — no data loss on intermittent backend errors. ([1a9ec48], [f5c2471])
- KG invalidation pathway behind `kg.invalidateOnConflict` flag (default `false` until upstream `mempalace_kg_invalidate` is fully reliable). ([44b7f19])

#### Identity injection
- Optional SOUL.md / IDENTITY.md loader with AAAK compression. ([06ca6b9])
- Toggle via `prefetch.identityEntities` (default `true`); paths via `identity.soulPath` / `identity.identityPath` with `~` expansion. ([a314081])
- Separate token budget for identity (`injection.identityMaxTokens`, default 150) so recall can't crowd it out. ([a314081])
- `injection.rawIdentity` flag to bypass AAAK compression for debugging. ([a314081])

#### Prefetch & warmup
- Session-start prefetch fires status, diary read, and a search warmup in parallel — amortizes cold-start latency. ([6a9af89], [1748fe2])
- Heartbeat-driven cache warmer keeps frequently-queried entities fresh between turns. ([6a389ad])

#### Entity extraction & timeline
- NER heuristic extracts entity candidates from user messages for targeted KG lookup. ([6870d3f])
- `injection.knownEntities` allowlist for entities that should always be considered, even if NER misses them. ([6870d3f])
- Timeline query detection ("what happened yesterday?") aggregates diary + KG results into a chronological summary. ([55a4641])

#### OpenClaw integration
- Plugin manifest (`openclaw.plugin.json`) with `before_prompt_build`, `session_start`, `session_end`, `llm_output`, `wake_up`, `heartbeat` hooks. ([fe3c319])
- `MemoryPluginRuntime` registration exposing `search` and `readFile` to OpenClaw's memory-runtime API. ([5822f05])
- `/remempalace status` slash command surfaces cache stats, MCP capability flags, and prefetch state. ([5822f05])
- Synchronous `register()` with deferred async MCP init behind `initPromise` — gateway never blocks on cold start. ([0d05a7c])

#### Security & sandbox
- `memoryRuntime.allowedReadRoots` allowlist for `readFile` calls — defaults to `["~/.mempalace", "~/.openclaw/workspace"]`. ([5822f05])
- Realpath-based path resolution rejects symlinks pointing outside the allowlist (TOCTOU-safe).
- Prefix-confusion guard: `/allowed-evil` does not match an allowlist of `/allowed`.
- Fail-closed on unresolvable paths (no fallback to the unverified absolute path).

### Documentation

- [README.md](README.md) — what the plugin does, why it exists, quick install
- [INSTALL.md](INSTALL.md) — full step-by-step install walkthrough
- [CONFIGURATION.md](CONFIGURATION.md) — every config option documented
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — fixes for common problems
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup and PR workflow
- [docs/architecture.md](docs/architecture.md) — module-level architecture
- [docs/superpowers/specs/2026-04-16-remempalace-design.md](docs/superpowers/specs/2026-04-16-remempalace-design.md) — original design intent

### Tests

- 134 unit tests + 2 integration tests (skipped by default; run with `REMEMPALACE_TEST_PY=<python>`).
- Test suite runs in ~440ms on a typical dev machine.

### Known limitations

- `kg.invalidateOnConflict` is off by default while the upstream MemPalace `kg_invalidate` MCP tool stabilizes. Same-session writes remain visible only after `cache.kgTtlMs` (default 10 min) expires.
- Native Windows is untested. Linux, macOS, and WSL2 are supported.
- The OpenClaw `memory` slot is exclusive — running `memory-core` alongside remempalace silently overwrites the prompt builder. See [TROUBLESHOOTING.md → memory-slot conflict](TROUBLESHOOTING.md#memory-slot-conflict).

