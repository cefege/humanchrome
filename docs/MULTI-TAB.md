# Multi-tab in humanchrome

humanchrome is built so a single MCP client can drive multiple tabs in parallel
and so multiple clients can share one Chrome without stepping on each other.
This doc is the caller-facing recipe book. For the in-extension model, see
[`docs/AGENTS.md` §3](AGENTS.md#3--per-client-tab-semantics).

## What "per-client ownership" means

Every connected MCP session — and every UI surface (popup, sidepanel, options,
quickpanel) — is its own **client**. Each client has its own **owned-tab set**:
the tabs that client created or explicitly claimed.

| Operation | Behavior |
|---|---|
| **Mutating tool, explicit `tabId` you own** | Just works — tool runs against your tab. |
| **Mutating tool, explicit `tabId` owned by another client** | Returns `TAB_NOT_OWNED`. Use `browser_claim_tab({tabId, force: true})` to seize it (audit-logged). |
| **Mutating tool, no `tabId`** | Resolves to your `activeTabId` → most-recently-touched owned tab → auto-spawned `about:blank`. Never falls back to the globally-active tab. |
| **Read-only tool, explicit `tabId`** | Always honored. Reads cross clients freely. |
| **Read-only tool, no `tabId`** | Resolves to your owned set; no auto-spawn. Returns `TAB_NOT_FOUND` if you have none. |
| **MCP disconnect** | Your owned tabs become unowned. They are NOT closed. A reconnect under the same session name reclaims them. |

The full resolution priority lives in `app/chrome-extension/entrypoints/background/utils/client-state.ts:384`
(`resolveOwnedTabIdForClient`).

## Stable session identity

Two ways an MCP client gets a stable `clientId`:

- **HTTP/SSE**: send the `X-Humanchrome-Session: <name>` header on `initialize`.
- **stdio**: set `HUMANCHROME_SESSION=<name>` in the env, or rely on the
  fallback `path.basename(cwd)`.

`<name>` is normalized: lowercased, non-alphanumerics collapsed, `__`-prefixed
names rejected (those are reserved for UI lanes). Reconnecting under the same
`<name>` reclaims the prior owned set from `chrome.storage.session`.

UI surfaces stamp their own clientId: `__ui:popup:<windowId>`, `__ui:sidepanel:<windowId>`,
`__ui:options:<windowId>`, `__ui:quickpanel:<windowId>`. Each Chrome window gets
its own lane (see IMP-0167).

## Discovering what you own

```
chrome_owned_tabs()
→ {
    clientId: 'alice',
    count: 2,
    ownedTabs: [
      { tabId: 100, windowId: 5, url: 'https://example.com/',
        title: 'Example', active: false, isActive: false,
        status: 'complete', isPinnedActive: false },
      { tabId: 200, windowId: 5, url: 'https://checkout/',
        title: 'Checkout', active: true, isActive: true,
        status: 'complete', isPinnedActive: true }
    ],
    activeTabId: 200,
    lastWindowId: 5
  }
```

`isPinnedActive: true` marks the tab the dispatcher will pick when you omit
`tabId` from a mutating tool. Useful for UI rendering and for sanity-checking
your default before issuing a write.

## Recipe: driving two owned tabs in parallel

humanchrome's per-tab queue serializes mutations **per tab** but interleaves
**across tabs**. So:

```js
// Two MCP tool calls in parallel — they run concurrently because they
// target different tabs in your owned set.
const [checkoutResult, productResult] = await Promise.all([
  client.callTool('chrome_click_element', {
    tabId: 100,                                 // checkout tab
    selector: '#confirm',
  }),
  client.callTool('chrome_navigate', {
    tabId: 200,                                 // product tab
    url: 'https://product/item/42',
  }),
]);
```

Two clicks **on the same tab** would queue (per-tab lock), but two operations
on **different tabs you own** run concurrently. The bridge's
`sendRequestToExtensionAndWait` is fully concurrent — there is no per-client
serialization on top of the per-tab lock.

## Recipe: explicit claim before driving

```js
// Bring an unowned tab into your set, then drive it.
const { tabId } = (await client.callTool('chrome_get_windows_and_tabs', {}))
  .windows[0].tabs.find(t => !t.owner && t.url.includes('example'));

await client.callTool('browser_claim_tab', { tabId });
await client.callTool('chrome_click_element', { tabId, selector: '#button' });
```

If the tab is already owned by another client and you really need it:

```js
await client.callTool('browser_claim_tab', { tabId, force: true });
//                                            ^^^^^^^^^^^^
// audit-logged via debugLog.warn so the previous owner's logs show
// you took the tab.
```

## Recipe: cleanup at the end of a workflow

```js
// Close every tab you opened during this session.
await client.callTool('browser_close_my_tabs', {});

// Or keep a few:
await client.callTool('browser_close_my_tabs', { keep: [100, 200] });
```

A bare MCP disconnect releases ownership without closing — `browser_close_my_tabs`
is the opt-in cleanup for the opposite case (CI runs, one-shot scripts).

## Errors and how to react

| Code | Meaning | Caller action |
|---|---|---|
| `TAB_NOT_OWNED` | You tried to mutate a tab owned by another client. | `browser_claim_tab({tabId, force: true})` if you legitimately need it; otherwise back off. |
| `TAB_NOT_FOUND` | The resolver couldn't pick any tab. `details.reason ∈ {'no-owned-tab', 'closed', 'window-mismatch'}`. | Spawn or claim a tab, retry. |
| `TAB_LOCK_TIMEOUT` | Another mutator held the per-tab lock past `tabLockTimeoutMs` (default a few seconds, per-tool overridable via the `tabLockTimeoutMs` arg). | Retry after a short delay; if another client is holding the tab, coordinate with them. |
| `RECORDING_IN_PROGRESS` (gif-recorder) | `chrome_gif_recorder action:'start'` while another client owns the recording. Error message names the owner. | Wait for that client to stop, or use `force` via your team's coordination. |
| `CDP_BUSY` | Write-side CDP (intercept-response, etc.) exclusive lease held by another client. | Wait; intercepts release on tab close or explicit unregister. |

## What aliases will look like (future)

The plan calls for `browser_alias_tab({tabId, alias})` plus a `tabAlias?` arg
on every browser tool — so callers can say `chrome_navigate({url, as: 'checkout'})`
and then `chrome_click_element({tabAlias: 'checkout', selector: '#confirm'})`
without juggling raw tab ids. Not yet shipped; see the active IMPs in
`docs/improvement-backlog.md`.

## What multi-tab does NOT give you

- **Cross-browser-instance ownership.** If the user has two Chrome processes
  running humanchrome (e.g. their main Chrome + Chrome for Testing for E2E),
  each Chrome has its own SW with its own ownership map. The bridge daemon
  routes per-Chrome-process (IMP-0114/0115).
- **Tab transfer across clients.** Force-claim works but doesn't transfer
  client-scoped state (dialog defaults, recorder sessions, gif state). Per-page
  state (locator handlers, userscripts) lives in the system bucket so it does
  effectively transfer.
- **Cross-client `chrome_gif_recorder`.** The CDP screencast is a single
  per-Chrome resource — only one recording at a time, regardless of which
  client started it. Cross-client coordination is via the
  `RECORDING_IN_PROGRESS` error (IMP-0166).

## See also

- [`docs/AGENTS.md` §3](AGENTS.md#3--per-client-tab-semantics) — the
  in-extension narrative and the full error code table.
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — bridge / SW / NM topology.
- [`docs/improvement-backlog.md`](improvement-backlog.md) — search "Multi-tab"
  for the IMPs that landed this surface.
