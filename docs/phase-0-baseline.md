# Phase 0 Baseline — remempalace refactor

Created: 2026-05-11

## Purpose

Phase 0 creates a safety net before the architecture refactor. It captures current behavior, adds gated integration coverage for real MemPalace MCP diary calls, and records known failures so later phases can improve them deliberately.

## Current baseline

### Unit tests

Command:

```bash
npm test -- tests/diary.test.ts tests/diary-fallback.test.ts tests/mcp-client.test.ts
```

Observed result on 2026-05-11:

```text
Test Files  3 passed (3)
Tests       32 passed (32)
```

### Diary MCP manual probe

Runtime tested:

```text
/home/derek/.venvs/mempalace/bin/python -m mempalace.mcp_server
mempalace 3.3.3
```

Findings:

- `tools/list` includes both `mempalace_diary_write` and `mempalace_diary_read`.
- Current write schema is accepted:

```json
{
  "agent_name": "remempalace",
  "entry": "...",
  "topic": "session"
}
```

- Legacy write schema is rejected with `Internal tool error`:

```json
{
  "wing": "remempalace",
  "room": "session",
  "content": "...",
  "added_by": "remempalace"
}
```

- In this environment, `mempalace_diary_write` can return `success: true` and append a WAL entry, while a subsequent `mempalace_diary_read` does not return the new probe entry.
- Raw Chroma `collection.add(...)` against the existing `~/.mempalace/palace` also did not increase collection count during the probe, suggesting the persistence issue may be below remempalace's TypeScript layer.

## New safety net

Added `tests/diary-integration.test.ts`.

These tests are skipped by default and only run when `REMEMPALACE_TEST_PY` points to a Python executable with MemPalace installed:

```bash
REMEMPALACE_TEST_PY=/home/derek/.venvs/mempalace/bin/python npm test -- tests/diary-integration.test.ts
```

Coverage:

- diary tools are listed
- current diary write schema is accepted
- write → read persistence is verified
- legacy diary write schema rejection is documented

The persistence test is expected to fail in the currently observed environment until Phase 2 fixes/falls back around diary persistence health.

## Phase 0 acceptance checklist

- [x] Capture current diary unit-test baseline.
- [x] Add integration test harness gated by `REMEMPALACE_TEST_PY`.
- [x] Add diary persistence probe test: write → read recent entries → confirm probe content.
- [x] Record current failing diary behavior in docs/status.
- [x] Run full default gate: `npm run lint && npm test`.
- [x] Run gated integration probe and record whether persistence still fails.

## Gate results

### Default gate

Command:

```bash
npm run lint && npm test
```

Observed result on 2026-05-11:

```text
Test Files  28 passed | 2 skipped (30)
Tests       293 passed | 6 skipped (299)
```

### Gated MemPalace diary integration

Command:

```bash
REMEMPALACE_TEST_PY=/home/derek/.venvs/mempalace/bin/python npm test -- tests/diary-integration.test.ts
```

Observed result on 2026-05-11:

```text
Test Files  1 failed (1)
Tests       1 failed | 3 passed (4)
```

Passes:

- `tools/list` includes diary tools.
- current `agent_name`/`entry`/`topic` write schema returns success.
- legacy `wing`/`room`/`content` schema is rejected with `Internal tool error`.

Fails:

- write → read persistence check. `mempalace_diary_write` returns success, but `mempalace_diary_read` returns no matching entries.

## Next steps

1. Begin Phase 1 contracts if we want architecture separation first.
2. Or jump to Phase 2 diary service/health if we want to fix the highest-risk behavior first: successful-looking diary writes that are not actually readable.
