# AGENTS.md — Runtime contract for LLM callers

This document describes the **runtime contracts** an LLM (or LLM-shaped tool runner) needs when calling the MCP Chrome bridge. It assumes you've already connected over MCP and can issue `tools/call` requests.

For the parameter reference of each tool, see `TOOLS.md`. For internal architecture, see `ARCHITECTURE.md`. This file documents the _behaviors_ — what the bridge promises to return, how to recover from failures, and the conventions you can rely on across tools.

---

## 1. Reading errors

When a tool fails, the response sets `isError: true` and the first text content block is **a JSON string** with this shape:

```json
{ "error": { "code": "TAB_CLOSED", "message": "...", "details": { "tabId": 42 } } }
```

`details` is optional; when present it's a small object with branchable hints (`tabId`, `arg`, `cause`, etc.). Parse the text content as JSON to branch on `error.code`.

### Error codes

Defined in `packages/shared/src/error-codes.ts` as `ToolErrorCode`:

| Code                    | When it fires                                                                                                                                                                                                                     | Right recovery                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAB_NOT_FOUND`         | Caller passed an invalid `tabId`, or no active tab is available.                                                                                                                                                                  | Check `chrome_get_windows_and_tabs`; pass an explicit `tabId`.                                                                                                                                                                   |
| `TAB_CLOSED`            | Tab was closed during the call.                                                                                                                                                                                                   | Open a new tab via `chrome_navigate`.                                                                                                                                                                                            |
| `TARGET_NAVIGATED_AWAY` | Page navigated mid-call between the tool's snapshot and dispatch.                                                                                                                                                                 | Re-read the page (`chrome_read_page`) and retry with fresh refs/selectors.                                                                                                                                                       |
| `INJECTION_FAILED`      | Chrome refused to inject a content script (restricted URL like `chrome://`, devtools://, store pages).                                                                                                                            | Don't retry the same URL. Tell the user the page can't be automated.                                                                                                                                                             |
| `INJECTION_TIMEOUT`     | Content script didn't respond to ping.                                                                                                                                                                                            | Retry once; if persistent, the page is likely hostile to automation.                                                                                                                                                             |
| `CDP_BUSY`              | DevTools or another debugger client owns the CDP session.                                                                                                                                                                         | Ask user to close DevTools, then retry.                                                                                                                                                                                          |
| `CDP_DETACHED`          | CDP session dropped mid-call.                                                                                                                                                                                                     | Retry once.                                                                                                                                                                                                                      |
| `TAB_LOCK_TIMEOUT`      | Another mutating call on the same tab held the lock past the per-call timeout (default 60s; tunable via `tabLockTimeoutMs`).                                                                                                      | Wait, or check for a stuck mutating call via `chrome_debug_dump`.                                                                                                                                                                |
| `QUEUE_FULL`            | Per-tab queue at `MAX_TAB_QUEUE_DEPTH` (16) waiters; refused before enqueue.                                                                                                                                                      | Back off and retry, or pin a different `tabId`. Inspect via `chrome_queue_inspect`.                                                                                                                                              |
| `TAB_NOT_OWNED`         | Caller targeted a tab owned by another MCP client.                                                                                                                                                                                | Use `chrome_get_windows_and_tabs` to see ownership, or claim via `browser_claim_tab` (optionally `{force: true}`).                                                                                                               |
| `TIMEOUT`               | A bounded wait expired (network request, JS execution, etc.).                                                                                                                                                                     | Increase `timeoutMs` (where the tool exposes it) and retry.                                                                                                                                                                      |
| `INVALID_ARGS`          | Required field missing or shape wrong. Also fires on selector strict-mode violations (multi-match) with `details: {matchCount, samples: [...]}` (IMP-0098).                                                                       | Fix the args. `details.arg` names the offending field when known. For strict-mode: add `index` or `multi: true`, or refine the selector.                                                                                         |
| `PERMISSION_DENIED`     | Chrome refused (e.g. extension lacks a permission).                                                                                                                                                                               | Don't retry; surface to user.                                                                                                                                                                                                    |
| `NOT_ACTIONABLE`        | Target exists but failed pre-action checks (visible/stable/enabled/editable/hit-test). `details.failures` names the failed checks (`['not_visible', 'occluded_by:#cookie-banner', 'disabled', 'unstable_bbox', 'not_editable']`). | Wait for the offending overlay (`chrome_await_element` on the blocker, `chrome_wait_for` on text), scroll, or dismiss the overlay; then retry. Pass `force: true` on the action to skip the suite (`scrollIntoView` still runs). |
| `UNKNOWN`               | Unclassified failure. Look at `error.message`.                                                                                                                                                                                    | Use `chrome_debug_dump` to triage; see §2.                                                                                                                                                                                       |

The serializer is `serializeToolError` in `packages/shared/src/error-codes.ts`. Tagged-error class is `ToolError` in the same file. Extension-side wrapper is `createErrorResponse(message, code?, details?)` in `app/chrome-extension/common/tool-handler.ts`.

---

## 2. Triaging failures with `chrome_debug_dump`

Every tool call gets a server-side `requestId` (UUID v4) that the bridge stamps into a persistent ring buffer in the extension. When something fails, `chrome_debug_dump` is your triage tool.

### Filters

```ts
chrome_debug_dump({
  requestId?: string,   // narrow to one call's events
  tool?: string,        // filter to e.g. "chrome_click_element"
  tabId?: number,       // scope to a tab
  level?: "debug" | "info" | "warn" | "error",
  sinceMs?: number,     // epoch ms — only entries newer than this
  limit?: number,       // default 200, max 1000
  clear?: boolean,      // true to wipe the buffer instead of returning entries
})
```

Filters compose with AND. Returns `{ ok, entries, returned, bufferSize }`. Entries are chronological.

### Markers

Each call writes at minimum:

- `tool call start` — entry on entering the dispatcher
- `tool call done` — entry on exit; `data.ok: boolean` indicates success
- `tool call threw` — entry on uncaught error; `data.error: string`
- `client tab recorded` — debug-level; records the tab the dispatcher associated with this client

The buffer survives service-worker restarts (persisted in `chrome.storage.session`), capped at 1000 entries with auto-trim.

Implementation: `app/chrome-extension/entrypoints/background/utils/debug-log.ts`. Tool: `app/chrome-extension/entrypoints/background/tools/browser/debug-dump.ts`.

### Correlating without `requestId`

Tool responses don't carry the server-side `requestId` directly. To correlate after the fact: filter by `tool` + `sinceMs` (the timestamp just before your call). The most recent matching entry's `requestId` is yours; re-dump with `{ requestId }` for the full ordered trail.

---

## 3. Per-client tab semantics

Each connected MCP session is its own client. The bridge tracks each client's **owned tabs** — the set of tabs that client opened or explicitly claimed (IMP-0086). Reads can target any tab; mutating tools can only target tabs the client owns.

### Resolution priority (mutating tools)

1. Explicit `tabId` argument — must be in the caller's owned set or unowned. If owned by another client, the call errors with `TAB_NOT_OWNED`.
2. The client's `activeTabId` (most-recently-acted-on owned tab) when it still exists.
3. Most-recently-touched tab in the client's owned set that still exists.
4. **Auto-spawn** — a fresh `about:blank` background tab is created and added to the client's owned set. The dispatcher never falls back to the globally-active tab.

Read-only tools skip the ownership check entirely.

### Why this matters

If two MCP clients are connected (e.g. Claude Code + curl), neither one collides with the other on implicit calls. Within one client, ownership follows successful navigate/click/etc. calls, so a sequence like `chrome_navigate → chrome_read_page → chrome_click_element` stays on the same tab without repeating `tabId`.

### Claiming and releasing tabs

- `browser_claim_tab({tabId})` adopts an unowned tab (one the user opened manually, or one another client released). Pass `{tabId, force: true}` to seize a tab owned by another client (audit-logged to the bridge stderr).
- On MCP client disconnect, the bridge sends `CLIENT_DISCONNECTED` and the extension calls `releaseClient(clientId)`. The client's owned tabs become unowned — they are NOT closed; the user keeps the browser.
- `browser_close_my_tabs({keep?: number[]})` is the opt-in cleanup for callers (CI runs, one-shot scripts) that want to dismiss their tabs before disconnecting.

### Pass `tabId` explicitly when

- You're driving multiple owned tabs in parallel from one client.
- You just opened a new tab and want to confirm the dispatcher uses it.
- A previous call returned `TAB_CLOSED` and you want to switch targets.

### Session identity

The bridge derives a stable `clientId` from one of (in priority order): a `_meta.humanchrome.session` value on MCP `initialize`, an `X-Humanchrome-Session: <name>` header on HTTP/SSE, or for stdio the `HUMANCHROME_SESSION` env var (falling back to `path.basename(cwd)`). A reconnecting client that supplies the same session name reclaims its prior owned set (persisted across SW restarts via `chrome.storage.session`).

Use `chrome_get_windows_and_tabs` to enumerate ids; each tab carries an `owner: clientId | null` field. Tab-state module: `app/chrome-extension/entrypoints/background/utils/client-state.ts`.

---

## 4. Truncation envelope

Tools that cap output return a structured `truncation` field on success responses (or, for tool-specific shapes, related fields like `truncated: bool`). The unified shape:

```ts
{
  truncated: boolean,
  originalSize?: number,   // bytes, items, or messages — see `unit`
  limit: number,           // same units as originalSize
  rawAvailable: boolean,   // true if `raw: true` would yield more
  unit: "bytes" | "items" | "messages" | "elements",
}
```

Helper: `app/chrome-extension/utils/truncate.ts` (`truncateString`, `truncateArray`, `truncateJson`, `modeFromRaw`).

### Tools that honor it

| Tool                        | Field                                  | Unit                 | `raw:true` honored?                     |
| --------------------------- | -------------------------------------- | -------------------- | --------------------------------------- |
| `chrome_read_page`          | `truncation` (on the fallback path)    | `elements` (cap 150) | yes                                     |
| `chrome_console`            | `truncation` (both modes)              | `messages`           | yes (snapshot mode only)                |
| `chrome_network_capture`    | `responseBodyTruncation` (per-request) | `bytes` (cap 1 MiB)  | no — limit is structural                |
| `chrome_intercept_response` | `responseBodyTruncation` (per-match)   | `bytes` (cap 1 MiB)  | no — limit is structural                |
| `chrome_javascript`         | `truncated: bool` (separate shape)     | bytes                | partial — use `maxOutputBytes` to widen |

### Pattern

```text
1. Call tool → receive response.
2. If response.truncation.truncated and response.truncation.rawAvailable: retry with { raw: true }.
3. Otherwise the limit is structural (no escape) — work with what you have.
```

For `chrome_javascript`: branch on the top-level `truncated` field; widen by passing a larger `maxOutputBytes`.

---

## 5. Per-tab serialization

Mutating tools targeting the same tab serialize through a per-tab queue (IMP-0087). Reads pass through.

### Mutating tools

`chrome_navigate`, `chrome_click_element`, `chrome_fill_or_select`, `chrome_keyboard`, `chrome_javascript`, `chrome_computer`, `chrome_upload_file`. Marked via `static readonly mutates = true` on each tool class.

### Behavior

- Two parallel mutating calls on the same tab → second waits for first to complete, then runs.
- Different tabs run in parallel.
- A reader (e.g. `chrome_read_page`) does not block and is not blocked.
- **Round-robin fairness**: when multiple clients contend on one tab, the queue rotates between distinct `clientId`s so a runaway loop in one client can't starve a polite one.
- **Bounded depth**: per-tab waiter cap is `MAX_TAB_QUEUE_DEPTH` (16). Beyond that, new acquirers receive `QUEUE_FULL` synchronously instead of being enqueued.
- **Per-call timeout opt-in**: callers can pass `tabLockTimeoutMs` on any mutating tool to override the default 60 s (clamped to `[100, 300_000]`). Long-running tools (perf trace, GIF recorder, intercept-response) may also set a class-level default.
- If the queue can't drain within the effective timeout, the waiting call returns `TAB_LOCK_TIMEOUT`.

### Inspecting contention

`chrome_queue_inspect({tabId?: number})` returns a snapshot per active tab: holder + waiters with `clientId`, `position`, `waitedMs`, `expectedWaitMs` (EWMA-based). Pass no args for every active queue. Use this when calls feel slow or you suspect a stuck holder.

Implementation: `app/chrome-extension/entrypoints/background/utils/tab-queue.ts` (with `tab-lock.ts` as a re-export shim for back-compat).

### What this means for you

Don't add your own retry-on-busy loop for "another tool is acting on this tab" — the bridge handles it. Treat `TAB_LOCK_TIMEOUT` and `QUEUE_FULL` as signals to back off; `chrome_queue_inspect` and `chrome_debug_dump` together are usually enough to localize a stuck holder.

---

## 6. Navigation guard

Mutating tools that resolve a target via ref/selector and then act on it check whether the page navigated between resolution and dispatch. Mid-call hard navigation surfaces as `TARGET_NAVIGATED_AWAY` rather than the action landing on the wrong document silently.

### Tools that guard

| Tool                    | Pattern                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `chrome_click_element`  | Pre-action assert (clicks may legitimately navigate via `waitForNavigation: true`) |
| `chrome_fill_or_select` | Snapshot + post-action assert (fills don't navigate)                               |
| `chrome_keyboard`       | Pre-action assert (Enter on a form may submit and navigate)                        |
| `chrome_upload_file`    | Snapshot + post-action assert (uploads don't navigate)                             |

The primitive is `documentId`-based when available (`chrome.webNavigation.getFrame`), falls back to URL comparison ignoring hash-only changes.

### Recovery

When you get `TARGET_NAVIGATED_AWAY`:

1. Re-read the page (`chrome_read_page`) — refs from a prior read are now stale.
2. Re-resolve your target on the new document.
3. Retry the action with fresh refs.

Helpers: `snapshotTabState`, `assertSameDocument`, `withNavigationGuard` in `app/chrome-extension/entrypoints/background/tools/base-browser.ts`.

---

## 7. Patterns

### Read a long page in full

```ts
const preview = await chrome_read_page({ tabId, filter: 'interactive' });
const t = preview.truncation;
if (t?.truncated && t.rawAvailable) {
  return chrome_read_page({ tabId, filter: 'interactive', raw: true });
}
return preview;
```

### Recover from mid-navigation click

```ts
let result = await chrome_click_element({ tabId, ref: 'ref_42' });
const env = parseError(result);
if (env?.code === 'TARGET_NAVIGATED_AWAY') {
  const fresh = await chrome_read_page({ tabId });
  // Re-resolve your target against `fresh` — refs from the prior read are stale.
  const newRef = findTargetRef(fresh);
  result = await chrome_click_element({ tabId, ref: newRef });
}
```

### Diagnose an opaque failure

```ts
const sinceMs = Date.now();
const result = await chrome_javascript({ tabId, code: '...' });
if (result.isError) {
  const dump = await chrome_debug_dump({
    tool: 'chrome_javascript',
    sinceMs,
    limit: 50,
  });
  // dump.entries[i].requestId on the most recent entry is your call's id.
  // Filter again with that requestId for the full ordered trail.
}
```

### Anti-pattern: implicit tabs in parallel

```ts
// DON'T — two parallel tools without tabId may share a tab if your client
// just acted on it. Probably fine within one client, but easy to confuse.
await Promise.all([chrome_navigate({ url: '/a' }), chrome_navigate({ url: '/b' })]);

// DO — be explicit about which tab is which.
const tabA = parsedTabIdFrom(await chrome_navigate({ url: '/a' }));
const tabB = parsedTabIdFrom(await chrome_navigate({ url: '/b' }));
await Promise.all([chrome_read_page({ tabId: tabA }), chrome_read_page({ tabId: tabB })]);
```

---

## 8. Playwright-style locators + strict mode (IMP-0098)

`chrome_click_element`, `chrome_fill_or_select`, `chrome_await_element`, `chrome_wait_for`, `chrome_focus`, `chrome_drag_drop`, and `chrome_computer` accept the same selector shapes Playwright exposes via `getBy*`:

| selectorType  | Selector value                     | Resolution                                           |
| ------------- | ---------------------------------- | ---------------------------------------------------- |
| `css`         | `body > .foo`                      | `document.querySelector` (default)                   |
| `xpath`       | `//button[1]`                      | XPath via `document.evaluate`                        |
| `role`        | `button[name="Submit",exact=true]` | Implicit/explicit ARIA role + accessible-name filter |
| `label`       | `Email`                            | Form labels (label[for], wrapping, aria-label)       |
| `placeholder` | `Search`                           | `<input>` / `<textarea>` `placeholder`               |
| `alt`         | `Logo`                             | `<img>`/`<area>` `alt`                               |
| `title`       | `Close`                            | `title` attribute                                    |
| `testid`      | `submit-btn`                       | `data-testid` / `data-cy` / `data-test` / `data-qa`  |
| `text`        | `Login`                            | Visible text content (case-insensitive contains)     |

You can also use prefixed strings via `selector` alone (selectorType defaults to `css` and the prefix is auto-detected):

```ts
chrome_click_element({ selector: 'role:button[name="Submit"]' });
chrome_click_element({ selector: 'label:Email' });
chrome_click_element({ selector: 'testid:submit-btn' });
```

Composite (iframe traversal) still uses `|>`:

```ts
chrome_click_element({ selector: 'iframe#payment |> role:button[name="Pay"]' });
```

### Strict mode

Every selector resolution path is strict by default: if more than one element matches and you have not passed `index` or `multi: true`, the call errors with `INVALID_ARGS` and `details: { matchCount, samples: [{tag, text}, ...] }`. Use the samples to disambiguate, then either:

- Refine the selector (`role:button[name="Save Changes"]` instead of `role:button`).
- Pass `index: N` to pick the N-th match (zero-based).
- Pass `multi: true` to accept the first match (opt out of strict mode).

The accessible-name compute is a subset of W3C accname-1.2: `aria-labelledby` chains, `aria-label`, `label[for]`, wrapping `<label>`, `alt`, `title`, name-from-content. CSS pseudo-content (`::before` / `::after`) is deliberately skipped.

---

## Summary

- Errors are JSON-encoded inside `text` content; branch on `error.code`.
- Use `chrome_debug_dump` to triage anything you can't explain.
- The bridge tracks your preferred tab per client; pass `tabId` to override.
- Truncation is uniform: check `truncation.truncated` and `truncation.rawAvailable`, retry with `raw: true` if applicable.
- Mutating same-tab calls serialize automatically; don't roll your own retry loop.
- Mid-call navigation is detected and reported as `TARGET_NAVIGATED_AWAY`; recover by re-reading the page.
- Playwright-style locators (`role:`, `label:`, `placeholder:`, `alt:`, `title:`, `testid:`, `text:`) are supported across the click/fill/await/wait/focus/drag/computer surface; strict mode errors on multi-match — pass `index` or `multi: true` to opt out.
