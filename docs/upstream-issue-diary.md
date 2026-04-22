# mempalace_diary_write returns "Internal tool error"

## Summary

The upstream MCP tool `mempalace_diary_write` returns an "Internal tool error" response when called
from the remempalace plugin. This means session diary entries are silently lost on `session_end`.

## Reproduction

Call `mempalace_diary_write` via the MCP `tools/call` protocol with the following arguments:

```json
{
  "wing": "remempalace",
  "room": "session",
  "content": "probe",
  "added_by": "remempalace"
}
```

Observed MCP response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Internal tool error"
  }
}
```

## Environment

- Upstream server: Python `mempalace` package, `mempalace.mcp_server` module
- Protocol: MCP JSON-RPC over stdio
- Client: remempalace TypeScript plugin v0.1.0
- Transport: subprocess (`python -m mempalace.mcp_server`)

## Expected Behavior

`mempalace_diary_write` should write the diary entry and return a success result containing the
persisted entry or a confirmation message.

## Actual Behavior

The tool returns an MCP-level error (`"Internal tool error"`) immediately. No entry is persisted.
Prior to this fix, remempalace silently swallowed the error due to a fire-and-forget `.catch(() => {})`.

## Workaround

remempalace v0.1.0 now includes a health probe (`McpClient.probeCapabilities`) that runs at startup.
If `mempalace_diary_write` fails the probe, `hasDiaryWrite` remains `false` and all subsequent diary
writes are redirected to a local JSONL fallback at:

```
~/.mempalace/palace/diary/<YYYY-MM-DD>.jsonl
```

Each line is a JSON object with the shape:

```json
{"wing":"remempalace","room":"session","content":"...","ts":"2026-04-21T12:00:00.000Z"}
```

The session builder also injects a one-line notice into the system prompt so the user is aware that
diary is falling back to local storage.

## Next Steps for Upstream Fix

1. Check that the mempalace Python server has the `diary_write` handler registered and that the
   required backing store (database, file, etc.) is accessible at the configured path.
2. Verify the MCP tool schema matches the arguments being sent (`wing`, `room`, `content`, `added_by`).
3. Check server-side logs for the root Python traceback that maps to "Internal tool error".
