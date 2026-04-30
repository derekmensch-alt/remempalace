# remempalace Task Workflow

This directory contains the task board for agentic release work.

Primary board:

- `agentic-workflow.json`

## How Agents Should Use It

1. Read `docs/superpowers/plans/2026-04-29-agentic-release-workflow.md`.
2. Open `agentic-workflow.json`.
3. Choose one task where `status` is `ready` and all `depends_on` tasks are `done`.
4. Mark it `in_progress` before making edits.
5. Run the task's verification commands.
6. Update the task with evidence, changed files, and final status.

## Status Values

- `ready`: can be started now.
- `blocked`: needs a dependency, decision, or upstream change.
- `in_progress`: an agent is actively working it.
- `review`: implementation is done, needs human/agent review.
- `done`: verified and complete.

## Priority Values

- `P0`: public-release blocker.
- `P1`: important before release unless explicitly deferred.
- `P2`: polish or documentation.

## Board Discipline

Keep tasks small enough that a single agent can finish one in a focused pass. If a task grows, split it and record the new child ids in `followups`.
