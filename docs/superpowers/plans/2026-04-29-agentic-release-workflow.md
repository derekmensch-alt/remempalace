# remempalace Agentic Release Workflow

Date: 2026-04-29
Status: active
Task board: `tasks/agentic-workflow.json`

## Purpose

This plan turns the latest OpenClaw critique and the live WSL/OpenClaw bugs into an agent-ready workflow. Each task has a stable id, owner profile, dependencies, acceptance criteria, and verification commands so a coding agent can pick up one item at a time without rediscovering the whole project.

## Current Baseline

- OpenClaw loads remempalace from `/home/YOU/.openclaw/plugins/remempalace`.
- MemPalace Python backend is installed at `/home/YOU/.venvs/mempalace/bin/python`.
- OpenClaw config uses `plugins.slots.memory = "remempalace"` and `agents.defaults.memorySearch.enabled = true`.
- Recent fixes made OpenClaw status show: `0 files · 0 chunks · sources memory · plugin remempalace · vector ready · fts off · cache on`.
- Full test suite currently passes in WSL after the recent runtime patch: `27 test files passed`, `1 skipped`, `248 tests passed`, `2 skipped`.

## Release Goals

1. Make KG learning semantically safer before public release.
2. Prevent runtime/plugin lifecycle bugs from making OpenClaw feel unresponsive.
3. Reduce noisy or stale release signals in docs, tests, and logs.
4. Preserve fast startup and the persistent MCP design.

## Workstreams

### A. KG Semantic Reliability

The 2026-04-26 critique says the architecture is good but semantic reliability is still shaky. The main risk is KG pollution from brittle extraction and overconfident contradiction policy.

Primary tasks:

- `KG-001`: Stop predicate explosion by constraining extraction to a stable predicate vocabulary.
- `KG-002`: Revisit cardinality defaults; make `is_a` and `decided_to` list-cardinality unless a narrower predicate is used.
- `KG-003`: Make negation policy explicit and consistent.
- `KG-004`: Add provenance/source weighting so user-originated claims outrank assistant restatements.
- `KG-005`: Add adversarial compound-clause tests.

### B. Runtime and OpenClaw Integration

Live testing found that OpenClaw can be healthy while user-facing replies fail because model calls overload, and repeated plugin/runtime loads can still spawn extra MemPalace MCP children during real agent activity.

Primary tasks:

- `RT-001`: Enforce a process-level singleton guard for the MemPalace MCP client.
- `RT-002`: Add shutdown/abort cleanup coverage for plugin runtime loads, agent errors, and OpenClaw restarts.
- `RT-003`: Add OpenClaw integration smoke tests for status, health, and process count.
- `RT-004`: Document WSL deployment constraints and the `/mnt/c` world-writable plugin path block.

### C. Release Hygiene

These are trust-building tasks. They are smaller, but they matter for public release.

Primary tasks:

- `DOC-001`: Update README test counts and avoid precise claims that drift quickly.
- `DOC-002`: Document known upstream/runtime issues: Ollama 503 overload, chat-channel reconnect, MemPalace diary fallback behavior.
- `TEST-001`: Quiet expected test warnings or assert them explicitly.
- `PKG-001`: Resolve or document npm lockfile churn from optional dependency metadata.

## Agentic Workflow Rules

1. Pick exactly one `ready` task from `tasks/agentic-workflow.json`.
2. Set it to `in_progress` with an `active_agent` note before editing.
3. Make the smallest code/doc change that satisfies the task.
4. Run the task's `verification.commands`.
5. Update the task with:
   - `status`: `done` or `blocked`
   - `evidence`: commands run and key output
   - `changed_files`: exact paths
   - `followups`: new task ids if needed
6. Do not start dependent tasks until all dependencies are `done`.

## Recommended Execution Order

1. `RT-001`
2. `RT-002`
3. `KG-001`
4. `KG-002`
5. `KG-003`
6. `KG-005`
7. `KG-004`
8. `TEST-001`
9. `DOC-001`
10. `DOC-002`
11. `RT-003`
12. `RT-004`
13. `PKG-001`

## Done Criteria For Public Release

- Full suite passes in WSL with MemPalace backend enabled.
- `openclaw gateway call health --json --timeout 30000` returns no plugin errors.
- Process check after status/agent probes shows one gateway-owned `mempalace.mcp_server` child.
- KG extraction tests cover compound clauses, negation, comparisons, multiple tools, multiple roles, and assistant-vs-user provenance.
- README and install docs match the current verified behavior.
