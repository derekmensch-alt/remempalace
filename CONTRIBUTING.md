# Contributing to remempalace

Thanks for your interest. remempalace is small enough that a single dev can hold the whole thing in their head, and the goal is to keep it that way. This guide covers how to get a working dev environment, the code style we follow, and what we look for in pull requests.

---

## Ground rules

1. **Tests first.** Every change ships with tests. The test suite is fast — there's no excuse.
2. **No silent behavior changes.** If you change a default or rename a config field, document the migration in the PR.
3. **Keep modules small.** Files over ~400 lines get refactored. Many small files > few large files.
4. **Don't expand the plugin's surface area without a use case.** Memory plugins should do one job.

---

## Dev setup

Same prerequisites as the install — see [INSTALL.md → Prerequisites](INSTALL.md#prerequisites). Plus:

```bash
git clone <repo-url> remempalace
cd remempalace
npm ci
```

You don't *need* a working MemPalace install to develop most of the plugin — the default suite uses mocked MCP calls and skips the real MemPalace integration tests unless you opt in.

Use `npm ci` for routine setup and verification. It installs from `package-lock.json` and is still preferred over `npm install` for normal test runs. npm `10.9.x` can rewrite optional dependency `libc` metadata even when dependency versions do not change; WSL installs on `/mnt/c/...` can also create line-ending-only lockfile churn. Prefer a WSL-native checkout for dependency work, check `git diff -- package-lock.json` before committing, and restore lockfile-only churn unless you intentionally regenerated dependencies.

For the two integration tests that hit a real MemPalace MCP server:

```bash
# pipx
REMEMPALACE_TEST_PY=~/.local/share/pipx/venvs/mempalace/bin/python npm test

# pip
REMEMPALACE_TEST_PY=$(which python3) npm test
```

---

## Day-to-day commands

```bash
# Run the test suite
npm test                    # default suite; real MemPalace integration tests are skipped unless configured
npx vitest run --reporter=dot   # quieter

# Type-check without emitting
npx tsc --noEmit

# Build the dist/ artifacts (what OpenClaw loads)
npm run build

# Run a single test file in watch mode
npx vitest tests/memory-runtime.test.ts
```

Before pushing, both of these MUST be green:

```bash
npx vitest run
npx tsc --noEmit
```

---

## Iteration loop against a live gateway

For features that interact with OpenClaw (hooks, runtime registration, status command), the loop is:

```bash
# 1. Make changes in src/
# 2. Rebuild
npm run build

# 3. Restart the gateway
openclaw stop && openclaw start

# 4. Verify
openclaw plugins inspect remempalace --json
openclaw logs --level debug | grep remempalace | tail -20

# 5. Send a test turn through your usual channel (Telegram, Discord, etc.)
```

Set `REMEMPALACE_DEBUG=1` in the gateway env to dump per-prompt decisions to `/tmp/remempalace-last-inject.log` while iterating.

---

## Code style

We extend the user-global TypeScript rules. The short version:

- **TypeScript everywhere.** No `.js` files in `src/`.
- **Avoid `any`.** Use `unknown` for external input and narrow it. Use generics when types depend on the caller.
- **Public APIs get explicit types** — exported functions, shared utilities, public class methods. Local variables can rely on inference.
- **Immutability by default.** Spread to update; never mutate inputs.
- **No `console.log` in `src/`.** Use the structured logger. (`console.warn` for unrecoverable misconfig is acceptable — see `memory-runtime.ts` for an example.)
- **Comments are rare.** Default to no comment. Only add one when the *why* is non-obvious — a hidden constraint, a workaround for a specific bug, behavior that would surprise a reader.

Repo-specific conventions:

- **Module size.** Keep files under ~400 lines. The largest files (`index.ts`, `mcp-client.ts`, `memory-runtime.ts`) are at that limit on purpose.
- **Imports.** Use `.js` extensions in TypeScript imports (NodeNext module resolution): `import { foo } from "./bar.js"`.
- **Tests live next to the module.** Each `src/X.ts` has a `tests/X.test.ts`. The test file is part of the contract.

---

## TDD workflow

Every PR follows red → green → refactor:

1. **RED:** Write the test for the new behavior. Run `npx vitest <file>` — it should fail for the *right reason*.
2. **GREEN:** Write the minimal code to make the test pass. No extras, no "while I'm in here" cleanups.
3. **REFACTOR:** Improve clarity, names, structure — without changing behavior. Run the full suite to confirm nothing else broke.

If you find yourself writing implementation before the test, stop and back up. The point of TDD here is that the test suite is the spec — if behavior isn't in a test, future-you might break it without noticing.

---

## What we look for in PRs

A good PR:

- Changes one thing. Drive-by refactors get split into separate commits or separate PRs.
- Has tests that fail before the change and pass after.
- Updates docs if it changes user-visible behavior (config fields, hook contract, status command output).
- Has a commit message that explains *why*, not just *what* — the diff already shows the what.

A good PR description answers:

1. What problem does this solve?
2. How does this change solve it?
3. What did you consider and reject?
4. How was it tested?

Use the [Conventional Commits](https://www.conventionalcommits.org/) style: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.

---

## Architecture quick reference

```
src/
├── index.ts             # plugin entry point — register() and hook wiring
├── config.ts            # defaults + mergeConfig
├── types.ts             # shared types incl. RemempalaceConfig
├── mcp-client.ts        # JSON-RPC client over stdio to mempalace
├── process-manager.ts   # spawn/respawn the python MCP server
├── cache.ts             # LRU with TTL
├── router.ts            # decides which MCP tools to call for a given turn
├── tiers.ts             # L0/L1/L2 ranking + budget allocation
├── budget.ts            # token math
├── kg.ts                # KG read/write/buffering
├── kg-invalidate.ts     # KG conflict resolution path
├── diary.ts             # session-summary writer
├── diary-fallback.ts    # local JSONL backup when MCP write fails
├── entity-extractor.ts  # NER heuristic for KG lookup
├── identity.ts          # SOUL.md / IDENTITY.md loader + AAAK compression
├── timeline.ts          # "what happened yesterday?" detection + injection
├── prefetch.ts          # session-start warmup (status, diary, search)
├── heartbeat.ts         # liveness keepalive
├── memory-runtime.ts    # OpenClaw memory-runtime API surface (search, readFile)
└── status-command.ts    # /remempalace status slash command
```

For the deep version, read [docs/architecture.md](docs/architecture.md). For the original design intent, [docs/superpowers/specs/2026-04-16-remempalace-design.md](docs/superpowers/specs/2026-04-16-remempalace-design.md).

---

## Reporting bugs

Open a GitHub issue with:

1. What you ran (the exact command or the action you took).
2. What you expected.
3. What happened.
4. Output of `openclaw plugins inspect remempalace --json`.
5. Relevant gateway logs: `openclaw logs --level debug | grep remempalace | tail -100`.
6. Your `~/.openclaw/openclaw.json` `plugins.entries.remempalace.config` block (redact secrets if any).
7. `REMEMPALACE_DEBUG=1` log dump from `/tmp/remempalace-last-inject.log` if the issue is recall-related.

---

## Releasing

remempalace doesn't have an automated release pipeline. The flow:

1. Make sure `main` is green: `npx vitest run && npx tsc --noEmit`.
2. Update [CHANGELOG.md](CHANGELOG.md) with the new version's entries.
3. Bump `version` in `package.json` (semver — breaking config changes = major).
4. Tag: `git tag vX.Y.Z && git push --tags`.
5. The plugin loads from the package root — there's no npm publish step. Users update via `git pull && npm install && npm run build && openclaw stop && openclaw start`.

---

## See also

- [README.md](README.md) — what the plugin does and why
- [INSTALL.md](INSTALL.md) — install walkthrough
- [CONFIGURATION.md](CONFIGURATION.md) — full config reference
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — fixes for common problems
- [docs/architecture.md](docs/architecture.md) — module-level architecture
