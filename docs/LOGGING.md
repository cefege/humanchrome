# Logging

HumanChrome ships a unified, correlation-id-aware logging system across both
halves of the system: the native bridge (Node, pino) and the Chrome
extension (service worker + sidepanel + tools, in-house structured logger).
Every log entry carries the same `requestId` so a single tool call can be
traced from the AI client all the way to the inject-script and back.

## TL;DR

- Bridge logs go to **stderr** (NDJSON in prod, pretty-printed in dev TTY).
  Never stdout — that channel is the Native Messaging wire.
- Extension logs land in a **5 MB ring buffer in `chrome.storage.local`**
  that survives service-worker restarts and browser restarts; they're
  mirrored to the DevTools console when the SW is alive.
- Both halves redact secrets (`password`, `token`, `authorization`,
  `cookie`, `apiKey`, `Authorization`, `set-cookie`) before they hit
  storage or the console.
- Pull a slice of the extension ring buffer via the
  `chrome_debug_dump` MCP tool — newest-first, paginated, filterable
  by `requestId`, `clientId`, `tool`, `tabId`, `level`, or `sinceMs`.

## Levels

Both halves share the same level vocabulary:

| Level   | When to use                                                    |
| ------- | -------------------------------------------------------------- |
| `trace` | Per-message tracing (bridge only). Off by default.             |
| `debug` | Verbose flow: arg dumps, internal state.                       |
| `info`  | Lifecycle: server started, tool call start/done, session init. |
| `warn`  | Recoverable issue: timeout, missing permission, bad config.    |
| `error` | Failed tool call, persistence failure, bad inbound message.    |
| `fatal` | Bridge process can't continue (uncaughtException, etc.).       |

## Environment variables

### Bridge (`app/native-server`)

- `HUMANCHROME_LOG_LEVEL` — one of `trace|debug|info|warn|error|fatal`.
  Defaults to `info`. Falls back to legacy `MCP_LOG_LEVEL` if unset.
- `NODE_ENV` — when not `production`, logs are pretty-printed via
  `pino-pretty` if stderr is a TTY. Otherwise NDJSON.

### Extension

- `humanchrome:logLevel` (key in `chrome.storage.local`) — `debug|info|warn|error`.
  Set programmatically via `setLogLevel('debug')` from `@/utils/logger`.
  Defaults to `info`.

## Where logs land

| Origin                      | Destination                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge (humanchrome-bridge) | `process.stderr` of the bridge Node process. macOS users running the bridge from a wrapper script typically see this in `~/Library/Logs/humanchrome-bridge/bridge.log` (depends on the wrapper). When launched directly by Chrome via Native Messaging, stderr is captured by Chrome — see `chrome://policy` and the Native Messaging troubleshooting docs. |
| Extension SW + sidepanel    | DevTools console (live) **and** `chrome.storage.local` ring buffer (`__humanchrome_log_v2`, ~5 MB cap, newest-first oldest-dropped). Inspect via `chrome_debug_dump` or by opening the SW DevTools and running `chrome.storage.local.get('__humanchrome_log_v2', console.log)`.                                                                             |
| Inject scripts              | If they post a result back to the SW with `_humanchromeRequestId`, the SW-side handler logs them with that requestId — so they show up in the same ring buffer.                                                                                                                                                                                             |

> **Why stderr for the bridge?** Chrome Native Messaging frames messages
> over **stdin/stdout** with a 4-byte length prefix. Anything written to
> stdout corrupts the wire and the host gets killed. The pino logger in
> `app/native-server/src/util/logger.ts` is hard-pinned to stderr; do not
> change the destination.

## Reading the extension ring buffer

The `chrome_debug_dump` MCP tool returns structured entries directly from
the ring buffer.

Args (all optional):

- `requestId: string` — exact match.
- `clientId: string` — exact match (filter by MCP session).
- `tool: string` — exact match.
- `tabId: number` — exact match.
- `level: 'debug' | 'info' | 'warn' | 'error'` — minimum level.
- `sinceMs: number` — only entries newer than this absolute epoch ms.
- `limit: number` — entries returned per call (default 200, max ~4000).
- `offset: number` — pagination offset, applied newest-first (default 0).
- `chronological: boolean` — when `true`, oldest first. Default newest first.
- `clear: boolean` — when `true`, wipe the buffer.

Example:

```jsonc
// AI client → bridge → extension
{
  "tool": "chrome_debug_dump",
  "args": { "requestId": "9f2a…", "limit": 50 },
}
```

Response shape:

```jsonc
{
  "ok": true,
  "entries": [
    {
      "ts": 1730000000000,
      "level": "info",
      "msg": "tool call start",
      "requestId": "9f2a…",
      "clientId": "session-abc",
      "tool": "chrome_navigate",
      "tabId": 42,
      "extensionVersion": "1.0.0",
    },
  ],
  "returned": 1,
  "bufferSize": 832,
  "offset": 0,
  "limit": 50,
}
```

## Redaction

Both halves redact any object key matching (case-insensitive):

- `password`
- `token`
- `authorization`
- `cookie`
- `apiKey`
- `set-cookie`

Bridge: pino's `redact` paths cover those keys at root and on `headers.*`,
plus wildcards. Censor value is the literal string `[REDACTED]`.

Extension: a recursive walker rewrites matched keys before the entry hits
the buffer or the console mirror.

## Adding new context fields

### Bridge

```ts
import { withContext } from './util/logger';

const log = withContext({ component: 'my-thing', sessionId, requestId });
log.info({ durationMs: 42 }, 'did the thing');
log.warn({ err: e.message }, 'soft failure');
```

The first argument is the structured object, the second the message —
this is the standard pino call shape.

### Extension

```ts
import { logger } from '@/utils/logger';

const log = logger.with({ requestId, clientId, tool: 'agent-chat' });
log.info('connected to session', { data: { sessionId } });
log.error('cancel failed', { data: { err: e.message } });
```

The default fields recognized at the entry level are `requestId`,
`clientId`, `tool`, `tabId`, plus `extensionVersion` (auto-injected from
the manifest). Anything else goes into `data`.

## Correlation id flow

```
MCP client
   │  (call_tool)
   ▼
bridge / dispatch.ts        ← logs `{ requestId, tool, clientId }`
   │  native-messaging envelope (carries `requestId`, `clientId`)
   ▼
extension SW / tools/index.ts  ← logs same `requestId` + sets context for sub-calls
   │  chrome.tabs.sendMessage with `_humanchromeRequestId` tag
   ▼
inject script (e.g. click-helper.js)
   │
   ▼  response → SW logs response with same requestId
chrome_debug_dump can now stitch the whole timeline.
```

## Operational tips

- When debugging a flaky tool, first set both halves to `debug`:
  - bridge: `HUMANCHROME_LOG_LEVEL=debug` then restart the Native Host
    (in Chrome: open `chrome://extensions` → toggle off/on, or click
    the extension Disconnect/Connect button).
  - extension: from a SW DevTools console run
    `chrome.storage.local.set({ 'humanchrome:logLevel': 'debug' })` then
    reload the extension.
- The bridge's logger uses **synchronous** pino destination under
  `NODE_ENV=test` / `JEST_WORKER_ID` so jest hooks don't hang. Production
  uses async to keep the hot path off the event loop.
- The extension ring buffer trims oldest entries when the serialized JSON
  exceeds ~5 MB. For long-running diagnostic sessions, periodically
  `chrome_debug_dump` with `clear: true` after you've captured the slice
  you need.
