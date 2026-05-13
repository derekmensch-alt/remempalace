# Configuration Reference

Every option remempalace exposes, what it does, and what to set it to. All options are optional and ship with sensible defaults — `mcpPythonBin` is the only one most installs need to touch.

For an opinionated walkthrough of a first install, see [INSTALL.md](INSTALL.md). For a high-level tour, see [README.md](README.md).

---

## Where config lives

remempalace reads its config from `~/.openclaw/openclaw.json` under `plugins.entries.remempalace.config`. The file is JSON5 — comments and trailing commas are fine.

```json5
{
  "plugins": {
    "entries": {
      "remempalace": {
        "enabled": true,
        "config": {
          // Every option below goes in here.
        }
      }
    }
  }
}
```

User config is **shallow-merged** into the defaults at startup. Each top-level section (`cache`, `injection`, `tiers`, `diary`, `kg`, `prefetch`, `identity`, `memoryRuntime`) is merged independently — set only the fields you want to override and the rest fall back to defaults.

`~` in any path field is expanded to the current user's home directory at config-merge time.

---

## Config schema at a glance

```ts
interface RemempalaceConfig {
  mcpPythonBin: string;
  cache:          { capacity: number; ttlMs: number; kgTtlMs: number; bundleTtlMs: number };
  injection:      { maxTokens: number; budgetPercent: number; similarityThreshold: number;
                    useAaak: boolean; knownEntities: string[];
                    identityMaxTokens: number; rawIdentity: boolean; fastRaceMs: number };
  tiers:          { l1Threshold: number; l2Threshold: number; l2BudgetFloor: number };
  diary:          { enabled: boolean; maxEntryTokens: number };
  kg:             { autoLearn: boolean; batchSize: number; flushIntervalMs: number;
                    invalidateOnConflict: boolean };
  prefetch:       { diaryCount: number; identityEntities: boolean };
  identity:       { soulPath: string; identityPath: string; maxChars: number };
  memoryRuntime:  { allowedReadRoots: string[] };
  hotCache:       { enabled: boolean; path: string; maxEntries: number; flushIntervalMs: number };
}
```

The defaults live in [src/config.ts](src/config.ts) — that file is the source of truth.

---

## `mcpPythonBin`

**Type:** `string`
**Default:** `"python3"`

The Python binary remempalace uses to spawn the MemPalace MCP server. Whatever you point at must have the `mempalace` package importable.

| Install method | What to set |
|----------------|-------------|
| `pip install mempalace` into your active env | leave at `"python3"` |
| `pipx install mempalace` | `"~/.local/share/pipx/venvs/mempalace/bin/python"` |
| Custom virtualenv | absolute path to that venv's `python` |

> If you see `ModuleNotFoundError: No module named 'mempalace'` in the gateway logs, this is the field to fix. See [TROUBLESHOOTING.md → mempalace module not found](TROUBLESHOOTING.md#mempalace-module-not-found).

---

## `cache`

In-memory LRU cache for MemPalace responses. Keeps repeat queries near-zero latency without hitting the MCP server.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `capacity` | `number` | `200` | Max number of cached entries. The cache is shared across `search`, `kg_query`, `diary_read`, and identity reads. |
| `ttlMs` | `number` | `300000` (5 min) | TTL for search and diary results. Anything older is treated as a miss and re-fetched. |
| `kgTtlMs` | `number` | `600000` (10 min) | Separate TTL for KG queries. KG facts change less often than free-text search results, so they're cached longer by default. |
| `bundleTtlMs` | `number` | `180000` (3 min) | TTL for normalized-intent recall bundles. When follow-up prompts have the same semantic intent (after whitespace/case normalization), the recall result is reused within this window. Prevents duplicate `search` + `kg_query` work on near-identical follow-ups. |

When to tune:

- **Lower `ttlMs`** if you care about same-session writes being visible immediately to other agents reading from the same cache.
- **Raise `capacity`** if you have a large `knownEntities` list and want to avoid eviction churn at the start of every turn.
- **Set `kgTtlMs` lower than `ttlMs`** if you write to the KG frequently and want fresher reads at the cost of slightly more MCP traffic.
- **Lower `bundleTtlMs`** if you want fresher recall on every turn; **raise it** if your conversation has many near-identical follow-ups (e.g., "continue", "next step", "go on") and you want to skip redundant backend calls.

---

## `injection`

Controls how much memory remempalace puts into the prompt and how it's formatted.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `maxTokens` | `number` | `800` | Hard cap on the injected memory block, in tokens. Identity injection gets its own budget (`identityMaxTokens`) on top of this. |
| `budgetPercent` | `number` | `0.15` | Soft cap: don't use more than 15% of the *remaining* context window for memory injection. Whichever of `maxTokens` and `budgetPercent` produces the smaller number wins. |
| `similarityThreshold` | `number` | `0.25` | Minimum similarity score for a search result to be considered for injection. Below this, the result is dropped before tier ranking. |
| `useAaak` | `boolean` | `true` | Compress the injected block using AAAK (the MemPalace-native abbreviation format). Roughly halves token count vs. raw text. |
| `knownEntities` | `string[]` | `["OpenClaw", "MemPalace", "remempalace", "Anthropic", "Claude"]` | Entities that are *always* considered for KG lookup, even if the NER heuristic doesn't extract them from the user message. **Add the user's name, project names, and key collaborators here.** This is the single most impactful config knob for recall quality. |
| `identityMaxTokens` | `number` | `150` | Token budget for the SOUL.md/IDENTITY.md block specifically. Separate from `maxTokens` so identity isn't crowded out by recall on long turns. |
| `rawIdentity` | `boolean` | `false` | If `true`, identity is injected verbatim instead of AAAK-compressed. Useful if your SOUL.md uses syntax that doesn't compress well, or for debugging. |
| `fastRaceMs` | `number` | `50` | In `before_prompt_build`, this is the window (in ms) during which cheap-tier sources (`cache`, `identity`, `last session`) are allowed to return before the full-recall backend (`search`, `kg_query`) is started. If cheap sources hit within this window, full recall is cancelled and only cheap results are used. Trades latency for completeness: set lower to always wait for full recall, or raise it to prefer cached/cheap sources and skip expensive backend calls. |

When to tune:

- The most common change is **`knownEntities`**. Default list is generic; the user's own canonical entity names belong here.
- **Lower `similarityThreshold`** if recall is too thin (`0.18`–`0.22`). **Raise it** if irrelevant facts are sneaking in (`0.30`–`0.35`).
- **Disable `useAaak`** only when debugging — raw text is easier to read in `/tmp/remempalace-last-inject.log` but eats roughly 2× the tokens.
- **`fastRaceMs`**: Set to `0` to always run full recall; raise to `100`–`200` ms to prefer cached/cheap sources over backend latency on chatty turns.

---

## `tiers`

remempalace ranks candidate memories into three tiers and injects from the top down until the budget is full.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `l1Threshold` | `number` | `0.3` | Similarity cutoff above which a result is marked **L1** (high-confidence, always inject if budget allows). |
| `l2Threshold` | `number` | `0.25` | Similarity cutoff for **L2** (mid-confidence; injected only if budget remains after L1). Anything below this is dropped. |
| `l2BudgetFloor` | `number` | `0.5` | Fraction of `maxTokens` that's *guaranteed* to L1 results before any L2 is considered. Stops a flood of L2 results from crowding out the strongest matches. |

The tiering is inclusive: **L0** is identity (always-on, separate budget), **L1** is high-similarity recall, **L2** is mid-similarity supporting context.

You usually don't need to change these. If you do, change them in concert with `injection.similarityThreshold`.

---

## `diary`

Controls the end-of-session diary write.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `enabled` | `boolean` | `true` | Master switch for diary writes. If `false`, remempalace won't write a session summary at all. |
| `maxEntryTokens` | `number` | `500` | Hard cap on the diary entry size, in tokens. Larger sessions get summarized more aggressively. |

When to tune:

- Set `enabled: false` if you don't want any persistent record of sessions. (You can still use KG writes for facts.)
- Raise `maxEntryTokens` for long working sessions where the default summary feels too lossy.

---

## `kg`

Controls automatic knowledge-graph writes from conversation.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `autoLearn` | `boolean` | `true` | Enable auto-extraction of facts from the conversation into the KG. If `false`, only explicit `kg_add` calls write anything. |
| `batchSize` | `number` | `5` | Buffer up to N pending facts before flushing. Reduces MCP roundtrips on chatty turns. |
| `flushIntervalMs` | `number` | `30000` (30s) | Flush the buffer every N ms even if `batchSize` hasn't been reached. Backstop for slow sessions. |
| `invalidateOnConflict` | `boolean` | `false` | When a new fact contradicts an existing one (same subject+predicate, different object), mark the old fact `current: false` instead of dropping the write. Off by default while the upstream `kg_invalidate` MCP tool is still firming up. |

When to tune:

- Set `autoLearn: false` for read-only sessions (analytics, audits) where you don't want the KG to grow.
- Lower `batchSize` to `1` for debugging — every extracted fact flushes immediately so you can watch them appear in the KG in real time.
- Set `invalidateOnConflict: true` once your MemPalace install reliably handles `kg_invalidate` (see [docs/architecture.md](docs/architecture.md#kg-invalidation)).

---

## `prefetch`

Controls what gets warmed up at session start, before the first turn.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `diaryCount` | `number` | `3` | Number of recent diary entries to prefetch and inject as session context. Set to `0` to disable diary prefetch entirely. |
| `identityEntities` | `boolean` | `true` | If `true`, load SOUL.md and IDENTITY.md (per the `identity` section) and inject as the L0 identity block. Set to `false` to skip identity injection entirely. |

When to tune:

- `diaryCount: 0` if you want a clean slate every session.
- `identityEntities: false` if you don't have or want SOUL/IDENTITY files. The whole `identity` section is then ignored.

---

## `identity`

Paths for the optional SOUL.md / IDENTITY.md injection. Only consulted if `prefetch.identityEntities` is `true`.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `soulPath` | `string` | `~/SOUL.md` | Path to the SOUL file (values, working style, what you care about). |
| `identityPath` | `string` | `~/IDENTITY.md` | Path to the IDENTITY file (biographical facts, names, roles, projects). |
| `maxChars` | `number` | `2000` | Per-file character cap. Files larger than this are truncated at this boundary before AAAK compression. |

`~` is expanded at merge time. Both files are optional — if a file is missing, that slot is silently skipped. Missing both files is the same as setting `prefetch.identityEntities: false`.

Example with custom paths:

```json5
"identity": {
  "soulPath": "~/Documents/agent-soul.md",
  "identityPath": "/etc/agents/identity.md",
  "maxChars": 3000
}
```

---

## `memoryRuntime`

Sandbox for file reads exposed via the OpenClaw memory runtime API. This is the boundary that prevents agents from reading arbitrary files via the memory plugin.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `allowedReadRoots` | `string[]` | `["~/.mempalace", "~/.openclaw/workspace"]` | Allowlist of directory roots. A `readFile` call is rejected unless the resolved real path falls under one of these roots (after symlink resolution). |

Path resolution semantics:

1. The requested path is resolved to an absolute path with `path.resolve`.
2. Symlinks are followed via `fs.realpath` — symlinks pointing outside the allowlist are rejected.
3. The resolved path must be exactly one of the roots, or under it (with a directory separator).
4. On rejection, the runtime returns a non-throwing error shape — the resolved path is *not* leaked in the error message.

When to tune:

- **Add a root** if you want the agent to read from a project-specific directory (e.g. `~/Projects/myrepo/notes`). Use absolute paths or `~`-prefixed paths.
- **Replace the whole list** with `[]` to disable file reads entirely. The plugin will still inject memory; only the explicit `readFile` runtime API is locked out.

⚠️ Don't add `~` or `/` here. The whole point of the allowlist is to be a small, audited set of directories.

---

## `hotCache`

Persistent on-disk cache of recently recalled bundles. Across plugin restarts and gateway restarts, remempalace imports live hot-cache entries to reduce cold-start latency. Entries expire according to their original TTL, and the health cache (diary persistence state, last probe time) is persisted separately.

| Field | Type | Default | What it controls |
|-------|------|---------|------------------|
| `enabled` | `boolean` | `true` | Master switch for hot-cache persistence. If `false`, cache is in-memory only and cleared on plugin shutdown. |
| `path` | `string` | `~/.mempalace/remempalace/hot-cache.json` | File path where the hot recall cache snapshot is saved. Directory is created if it doesn't exist. `~` is expanded at config merge time. |
| `maxEntries` | `number` | `50` | Maximum number of normalized-intent recall bundles to persist. When the limit is reached, oldest entries are dropped on flush. |
| `flushIntervalMs` | `number` | `60000` (60s) | How often the in-memory cache is written to disk. Does not block prompt builds; happens asynchronously in the background. |

Additionally, a separate health snapshot is persisted at `~/.mempalace/remempalace/health-cache.json` with diary persistence state, MCP readiness, capability flags, and last probe timestamp. Health snapshots are stale after 10 minutes and refreshed on each probe.

When to tune:

- Set `enabled: false` if you want a fresh start every session (e.g., in testing or sandboxed environments).
- **Lower `maxEntries`** if disk space is limited; **raise it** if you have many different conversation contexts and want more hot recall entries to survive a restart.
- **Raise `flushIntervalMs`** if you restart the gateway very frequently and want to reduce write churn (e.g., `120000` for once every 2 minutes).

---

## Recall modes and prompt-path deadlines

remempalace uses adaptive recall to keep `before_prompt_build` fast. The plugin automatically classifies user prompts and selects the right recall strategy:

- **cheap** — Skipped for low-semantic acknowledgements (ok, thanks, yes/no), tool follow-up chatter (tests passed, looks good), and short prompts without semantic content. Also used for continuation prompts when there are no extracted entity candidates. Returns empty recall bundle with no backend calls.
- **cheap+kg1** — Used for continuation prompts (continue, next, keep going, carry on) that have extracted entities. Runs lexical diary prefetch and at most one KG entity query within the fast-race window. Skips semantic search entirely.
- **full** — Used for question prompts (`?`), explicit prior-context prompts (remember, what did, last session), prompts with extracted entity candidates, and anything else. Runs both KG and semantic search in parallel with a shared 1500 ms budget.

Recall happens in two phases:

1. **Session start prefetch** (`session_start` hook): Diary entries and identity are loaded asynchronously in the background.
2. **Prompt build** (`before_prompt_build` hook): The plugin allocates a **1500 ms total budget** for timeline reads, full recall (search + KG), and formatting. If MCP init hasn't completed by then, or if recall times out, the plugin degrades gracefully by returning only identity and cheap-tier context.

The **`injection.fastRaceMs`** window (default 50 ms) controls whether cheap-tier sources are used alone or whether expensive full recall is triggered. If cached/identity results return within the race window, full recall is cancelled.

**Diary timeouts**: Diary reads during prefetch and prompt-path work are bounded at 500 ms each. If a diary read or write takes longer, the request is timed out and local JSONL fallback is used (with eventual replay once MCP persistence is verified healthy).

When to tune:

- Lower diary timeout or raise `injection.fastRaceMs` if your MemPalace backend is slow and you want memory injection to finish quickly rather than wait for backend sources.
- Disable cheap-mode skipping by setting recall thresholds appropriately if you always want full recall regardless of prompt content.

---

## Environment variables

A handful of behaviors are toggled via env vars in the gateway environment, not via JSON config:

| Variable | Effect |
|----------|--------|
| `REMEMPALACE_DEBUG=1` | Dump per-prompt decisions (extracted entities, KG counts, final injected block) to `/tmp/remempalace-last-inject.log`. Adds sequential KG lookups — leave off in normal operation. |
| `REMEMPALACE_TEST_PY=<path>` | Used by the test suite (`npm test`) to point integration tests at a real `mempalace` Python install. Has no effect at runtime. |

Set these in the gateway's environment, then restart the gateway:

```bash
export REMEMPALACE_DEBUG=1
openclaw stop && openclaw start
```

---

## Full annotated example

A complete config showing every option at its default value, with comments on the ones you might actually change:

```json5
{
  "plugins": {
    "load": { "paths": ["/absolute/path/to/remempalace"] },
    "allow": ["remempalace"],
    "slots": { "memory": "remempalace" },
    "entries": {
      "remempalace": {
        "enabled": true,
        "config": {
          // pipx users: replace with the venv python path
          "mcpPythonBin": "python3",

          "cache": {
            "capacity": 200,
            "ttlMs": 300000,
            "kgTtlMs": 600000,
            "bundleTtlMs": 180000
          },

          "injection": {
            "maxTokens": 800,
            "budgetPercent": 0.15,
            "similarityThreshold": 0.25,
            "useAaak": true,
            // ⭐ Most worth customizing — add your name, project names, etc.
            "knownEntities": ["OpenClaw", "MemPalace", "remempalace", "Anthropic", "Claude"],
            "identityMaxTokens": 150,
            "rawIdentity": false,
            "fastRaceMs": 50
          },

          "tiers": {
            "l1Threshold": 0.3,
            "l2Threshold": 0.25,
            "l2BudgetFloor": 0.5
          },

          "diary": {
            "enabled": true,
            "maxEntryTokens": 500
          },

          "kg": {
            "autoLearn": true,
            "batchSize": 5,
            "flushIntervalMs": 30000,
            "invalidateOnConflict": false
          },

          "prefetch": {
            "diaryCount": 3,
            "identityEntities": true
          },

          "identity": {
            "soulPath": "~/SOUL.md",
            "identityPath": "~/IDENTITY.md",
            "maxChars": 2000
          },

          "memoryRuntime": {
            "allowedReadRoots": ["~/.mempalace", "~/.openclaw/workspace"]
          },

          "hotCache": {
            "enabled": true,
            "path": "~/.mempalace/remempalace/hot-cache.json",
            "maxEntries": 50,
            "flushIntervalMs": 60000
          }
        }
      }
    }
  }
}
```

---

## See also

- [INSTALL.md](INSTALL.md) — first-install walkthrough
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — fixes for common config-related errors
- [docs/architecture.md](docs/architecture.md) — how the pieces fit together
- [src/config.ts](src/config.ts) — defaults source of truth
