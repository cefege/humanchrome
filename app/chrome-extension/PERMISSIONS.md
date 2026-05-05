# HumanChrome — Permission Justifications

This document explains, one paragraph per permission, why every Chrome permission listed in [`wxt.config.ts`](./wxt.config.ts) (lines 40-58) is required for HumanChrome to function. These justifications are written in the form Chrome Web Store reviewers expect: a single user-visible feature that breaks if the permission is removed.

`host_permissions: ["<all_urls>"]` is required because the user (via their AI client) decides at runtime which site to operate on. HumanChrome cannot enumerate the set of sites in advance — the whole point of the extension is to drive whatever page you have open. Restricting `host_permissions` would make the extension useless on any site not pre-declared.

## `nativeMessaging`

Used to launch and communicate with the local `humanchrome-bridge` Native Messaging host, which exposes the browser tools to AI clients over MCP (stdio and Streamable HTTP) and a plain HTTP REST API on `127.0.0.1:12306`. Without this permission the extension cannot reach any AI client; the entire MCP and HTTP integration is off.

## `tabs`

The MCP/HTTP tool surface is tab-scoped. Tool-call routing requires the extension to read the active tab's id and URL, and to enumerate windows/tabs for tools like `chrome_get_windows_and_tabs`, `chrome_switch_tab`, and `chrome_close_tab`. Without `tabs` the agent cannot answer "which tab is the user looking at?" and every tool that takes a `tabId` argument fails.

## `activeTab`

Required so user-initiated actions (clicking the extension icon, invoking the keyboard shortcuts `Ctrl/Cmd+Shift+O` for the Web Editor and `Ctrl/Cmd+Shift+U` for the Quick Panel, or right-clicking via the context menu) can grant the extension immediate access to the currently focused tab without a broader permission prompt for that one-off interaction.

## `scripting`

Used by every tool that interacts with page content. The extension injects helper scripts (`inject-scripts/click-helper.js`, `fill-helper.js`, `screenshot-helper.js`, `interactive-elements-helper.js`, `keyboard-helper.js`, `wait-helper.js`, `dom-observer.js`, `web-fetcher-helper.js`, `network-helper.js`, `props-agent.js`, `recorder.js`, `web-editor.js`, `accessibility-tree-helper.js`) into the active tab to perform clicks, form fills, screenshots, and DOM reads. Without `scripting` none of the page-interaction tools work.

## `contextMenus`

Powers the right-click "Mark element" entry that lets a user pick an element on the page and save it as a stable selector for later reuse in workflows and tool calls. Removing this permission removes the only ergonomic way to capture a selector.

## `downloads`

Backs the `chrome_handle_download` tool, which lets the AI client list, observe, accept, or reject downloads triggered by the page. Required for any automation that ends in a file save (export-to-CSV flows, generated-PDF receipts, screenshot-based artifacts).

## `webRequest`

Backs the `chrome_network_capture` tool, which records the page's network activity (requests and response metadata) so the AI client can answer questions like "what did the page POST?" or "wait until the API call to /api/x finishes." Without `webRequest` the network-capture tool has no source of events.

## `webNavigation`

Used by the wait-for-navigation step in the record-replay engine and by tools that need to coordinate with full-page navigations (`chrome_navigate`, multi-step workflows). It provides reliable navigation lifecycle events that DOM observers cannot replicate.

## `debugger`

Required only for CDP-only operations: `Runtime.evaluate` with deterministic timeouts, the trace-collection used by `chrome_performance_start_trace`/`chrome_performance_stop_trace`/`chrome_performance_analyze_insight`, and a small number of edge-case tools (e.g. dialog interception, certain network-interception modes) that the standard extension APIs cannot deliver. The Chrome "this browser is being debugged" warning bar is an accepted cost of enabling these tools.

## `history`

Backs the `chrome_history` tool, which performs full-text search across the user's browsing history. The agent uses this for tasks like "find the article I read last Tuesday about X." Without `history` this tool is unavailable.

## `bookmarks`

Backs the `chrome_bookmark_search`, `chrome_bookmark_add`, `chrome_bookmark_update`, and `chrome_bookmark_delete` CRUD tools. The agent uses these to organize bookmarks on the user's behalf or to look up a previously bookmarked page.

## `cookies`

Backs the `chrome_get_cookies`, `chrome_set_cookie`, and `chrome_remove_cookie` tools, which expose `chrome.cookies.getAll`/`chrome.cookies.set`/`chrome.cookies.remove` to the AI client. Without this permission the agent can drive a page that has cookies (the existing `chrome_network_request` tool already sends them implicitly), but it cannot inspect what cookies the browser is holding for a domain or seed/clear an auth cookie before navigation. That's a hard requirement for session-debugging on sites like LinkedIn and WhatsApp Web, and for restoring a saved login state without forcing the user to walk through a UI sign-in flow each time.

## `offscreen`

Hosts the offscreen document that runs the semantic search worker (`workers/similarity.worker.js`) used by `chrome_search_tabs_content`. The MV3 service worker cannot load WebAssembly modules with `instantiateStreaming` or hold the long-lived state the embedding model requires; an offscreen document is the only supported MV3 way to run this worker.

## `storage`

Required for `chrome.storage.local`/`chrome.storage.sync` writes that hold extension settings, the output-redaction toggle, element markers, saved workflows, and recorder configurations. Without `storage` no user preference or saved artifact persists across browser restarts.

## `alarms`

Backs cron-style triggers in record-replay v3 — the user can schedule a workflow to run on an interval. `chrome.alarms` is the only MV3-supported way to fire deferred work after the service worker has been suspended.

## `sidePanel`

Allows the extension to programmatically open and close the Chrome side panel that hosts the workflow management UI (`sidepanel.html`). Used both by the keyboard-shortcut commands and by tool calls that surface UI back to the user.
