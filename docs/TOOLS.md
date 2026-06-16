# HumanChrome API Reference 📚

Complete reference for all available tools and their parameters.

> The per-tool sections below are generated from `packages/shared/src/tools.ts`
> by `app/native-server/scripts/generate-tools-doc.mjs`. Edit the schemas (or
> `TOOL_CATEGORIES` in the same file) — never the generated section directly.
> Refresh after a schema change with:
> `pnpm -w build && pnpm --filter humanchrome-bridge run docs:tools`.

## 📋 Table of Contents

- [Browser management](#browser-management)
- [Reading](#reading)
- [Interaction](#interaction)
- [Scripting](#scripting)
- [Network](#network)
- [Files](#files)
- [State](#state)
- [Performance](#performance)
- [Diagnostics](#diagnostics)
- [Response Format](#-response-format)

<!-- AUTO-GEN BELOW -->

## Browser management

### `chrome_get_windows_and_tabs`

List every currently open browser window and its tabs. Use to resolve windowId/tabId before navigate, single-window enforcement, or session inspection. Example: {} → {windows:[{id, focused, tabs:[{id, url, title, active}]}]} Cross-ref: browser_tabs (MCP @playwright/mcp); context.pages, browser.contexts (Playwright API).

No parameters.

### `chrome_tab_groups`

Manage Chrome tab groups (create/update/query/get/add_tabs/remove_tabs/move) for partitioning agent tabs from user tabs. Colors from Chrome's fixed palette. Example: {action:"create", tabIds:[1,2], title:"agent", color:"blue"} → {groupId}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `create` \| `update` \| `query` \| `get` \| `add_tabs` \| `remove_tabs` \| `move` | ✓ | Operation to perform. |
| `groupId` | number |  | Existing group ID. Required for `update`, `get`, `add_tabs`, `move`. Optional for `create` (when set, the new tabs are added to this group instead of creating a new one — same shape as `add_tabs`). |
| `tabIds` | array<number> |  | Tab IDs to operate on. Required for `create`, `add_tabs`, `remove_tabs`. The first tab's window decides the group's window for `create` (Chrome rejects mixing windows). |
| `title` | string |  | Group label shown in the tab strip. Optional for `create` (set via `update` after) and `update`. For `query`, exact-match filter. |
| `color` | `grey` \| `blue` \| `red` \| `yellow` \| `green` \| `pink` \| `purple` \| `cyan` \| `orange` |  | Group color. Optional for `update` and as a `query` filter. Chrome auto-assigns one if omitted at create time. |
| `collapsed` | boolean |  | Collapse / expand the group in the tab strip. Optional for `update` and as a `query` filter. |
| `windowId` | number |  | Window scope for `query` (only return groups in this window) and `create` (when no tabIds are supplied — rare, prefer `tabIds`). |
| `index` | number |  | Target index for `move`. -1 places the group at the end. Group moves within its current window only; cross-window moves require a separate flow. |

### `chrome_navigate`

Navigate to a URL, refresh, or go back/forward in history. Optionally open in a new window/tab with custom size. Example: {url:"https://example.com"} → {tabId, url, status:"complete"} Cross-ref: browser_navigate (MCP @playwright/mcp); page.goto (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | URL to navigate to. Special values: "back" or "forward" to navigate browser history in the target tab. |
| `newWindow` | boolean |  | Create a new window to navigate to the URL or not. Defaults to false |
| `newTab` | boolean |  | Force a fresh tab even when a same-host tab is already open. Without this flag the navigate tool activates the existing tab instead. Ignored when tabId is also set. Defaults to false. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `width` | number |  | Window width in pixels (default: 1280). When width or height is provided, a new window will be created. |
| `height` | number |  | Window height in pixels (default: 720). When width or height is provided, a new window will be created. |
| `refresh` | boolean |  | Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false |

### `chrome_navigate_batch`

Open many URLs at once and return their tabIds; tabs open backgrounded by default. Pair with chrome_wait_for kind:"load_state" state:"complete" to drain sequentially. maxConcurrent blocks per batch. Example: {urls:["a.com","b.com"], maxConcurrent:2} → {tabIds:[101,102]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `urls` | array<string> | ✓ | URLs to open. Each becomes a new tab. |
| `windowId` | number |  | Target window for the new tabs. If omitted, uses the last-focused window (or creates one). |
| `background` | boolean |  | Open without stealing focus (default true). Set false to foreground each new tab as it opens. |
| `perTabDelayMs` | number |  | Delay between consecutive opens, in milliseconds. Default 0. Use a small value (50-200ms) on sites that flag burst opens. When maxConcurrent is also set, this delay applies WITHIN each worker (between consecutive opens by the same worker). |
| `maxConcurrent` | number |  | Cap the number of in-flight tab loads. When omitted (or <= 0), all URLs open in parallel (current behavior). When set to N, opens N tabs and waits for each to finish loading before starting the next — useful on anti-bot platforms (LinkedIn, Instagram) that flag concurrent opens. Each waited tab uses a 30s load timeout; on timeout the tab is still recorded and the worker continues. |
| `perUrlTimeoutMs` | number |  | Per-URL load timeout in ms when maxConcurrent is set. Default 30000. Ignored when maxConcurrent is not set. |

### `chrome_close_tab`

Close one or more tabs by tabIds[] or by matching url. Example: {tabIds:[3,5]} → {success:true, closed:[3,5]} Cross-ref: browser_close (MCP @playwright/mcp); page.close (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabIds` | array<number> |  | Array of tab IDs to close. If not provided, will close the active tab. |
| `url` | string |  | Close tabs matching this URL. Can be used instead of tabIds. |

### `chrome_close_tabs_matching`

Bulk close tabs by filters; at least one of urlMatches/titleMatches/olderThanMs required (no-filter rejected). URL/title accept substring or /regex/flags. Honors last-tab-in-window guard. Example: {urlMatches:"/example.com/", dryRun:true} → {closed:0, matched:3, tabIds:[...]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `urlMatches` | string |  | URL filter. Plain text → case-insensitive substring match against `tab.url`. Wrap in `/.../flags` (e.g. `/voyager\/api/i`) for regex match. Combined with other filters via AND. |
| `titleMatches` | string |  | Title filter. Same matching rules as `urlMatches` but applied against `tab.title`. Combined with other filters via AND. |
| `olderThanMs` | number |  | Close tabs whose creation time was more than N milliseconds ago. The check uses Chrome's wall-clock view of when the tab was created (via the existing tab-tracking record). Tabs with unknown creation time are NOT matched by this filter alone. |
| `exceptTabIds` | array<number> |  | Tab IDs to always preserve, even if they would otherwise match the filters. |
| `windowId` | number |  | Optional window scope. When provided, only tabs in this window are considered. Default: every window the extension can see. |
| `dryRun` | boolean |  | When true, returns the matched tab IDs without actually closing them. Useful as a pre-flight check before destructive bulk close. |

### `chrome_switch_tab`

Switch focus to a specific browser tab. Example: {tabId:7} → {activated:true, windowId} Cross-ref: browser_tabs (MCP @playwright/mcp); page.bringToFront (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number | ✓ | The ID of the tab to switch to. |
| `windowId` | number |  | The ID of the window where the tab is located. |

### `chrome_sessions`

Inspect and restore recently-closed tabs/windows via chrome.sessions. Lets an agent un-close a tab without re-navigating. Example: {action:"restore", sessionId:"abc"} → {restored:{sessionId, tab}}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `get_recently_closed` \| `restore` | ✓ | Operation to perform. |
| `sessionId` | string |  | Session id from `get_recently_closed`. Optional for `restore` — omit to restore the most recent closure. |
| `maxResults` | number |  | Max entries for `get_recently_closed`. Default 25, cap 25. |

### `chrome_tab_lifecycle`

Memory and audio controls: discard, mute, unmute, set_auto_discardable. Example: {action:"mute", tabId:3} → {id, mutedInfo, discarded, autoDiscardable}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `discard` \| `mute` \| `unmute` \| `set_auto_discardable` | ✓ | Operation to perform. |
| `tabId` | number | ✓ | Target tab. Required for all actions. Use chrome_get_windows_and_tabs to enumerate. |
| `autoDiscardable` | boolean |  | Required for `set_auto_discardable`. `false` pins the tab; `true` allows Chrome to discard it. |

### `chrome_window`

Manage Chrome windows via chrome.windows (create/focus/update/close). Useful for incognito sandboxes or popping a window to front. Example: {action:"create", url:"https://x.com", incognito:true} → {Window}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `create` \| `focus` \| `update` \| `close` | ✓ | Operation to perform. |
| `windowId` | number |  | Required for `focus`, `update`, and `close`. Ignored for `create`. |
| `url` | string |  | Initial URL for `create`. Optional — defaults to the new-tab page. |
| `type` | `normal` \| `popup` \| `panel` |  | Window type for `create`. Default: `normal`. |
| `incognito` | boolean |  | For `create`. Open the window in incognito mode. |
| `focused` | boolean |  | For `create` and `update`. Whether the window has focus. |
| `state` | `normal` \| `minimized` \| `maximized` \| `fullscreen` |  | Window state for `create` and `update`. |
| `left` | number |  | Left edge in screen pixels (create / update). |
| `top` | number |  | Top edge in screen pixels (create / update). |
| `width` | number |  | Window width in pixels (create / update). |
| `height` | number |  | Window height in pixels (create / update). |

### `browser_claim_tab`

Claim an unowned tab into the calling client's owned set so implicit tab-resolution can target it. Use force:true to seize a tab owned by another client (audit-logged). Example: {tabId:42} → {tabId:42, previousOwner:null}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number | ✓ | Tab ID to claim for the calling client. |
| `force` | boolean |  | When true, claim the tab even if another client currently owns it. The previous owner is reported in the response and audit-logged via `debugLog.warn`. Defaults to false — without `force`, claiming an owned-by-other tab returns TAB_NOT_OWNED. Only use when you know the previous owner is gone (stale session, crashed bridge) or when intentionally handing off between operator-driven sessions. |

### `chrome_queue_inspect`

Diagnostic snapshot of per-tab serialization queues with EWMA wait estimates. Returns {tabs:[{tabId, depth, holder, waiters:[{clientId, expectedWaitMs}]}]}. Read-only. Pass tabId to scope. Example: {tabId:42} → {tabs:[{tabId:42, depth:2}]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Optional tab to scope the snapshot to. Omit for every active queue. |

### `browser_close_my_tabs`

Close every tab owned by the calling client; optional keep[] preserves specific tabIds. beforeunload prompts are bypassed silently. Example: {keep:[7]} → {success:true, closed:[3,5], kept:[7], failed:[]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `keep` | array<number> |  | Tab IDs to preserve (kept owned by the calling client, not closed). Each id must be in the caller's owned set; non-owned ids are silently dropped from `kept`. |

### `chrome_owned_tabs`

Return tabs owned by the calling MCP client as {tabId, windowId, url, title, active, isPinnedActive}. Narrower than chrome_get_windows_and_tabs (whole browser). Optional tabId filters to one row. Example: {} → {clientId, count:2, ownedTabs:[]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Optional filter — return only the row matching this tabId, if owned. |

### `browser_alias_tab`

Bind a per-client alias to an owned tab so later calls can target it by name. Alias must match ^[a-z][a-z0-9_-]{0,31}$; tab must be in caller's owned set (else TAB_NOT_OWNED — claim it first). Example: {alias:"checkout", tabId:42} → {success:true, alias, tabId, previousTabId?}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `alias` | string | ✓ | Alias name. Must match ^[a-z][a-z0-9_-]{0,31}$ (lowercase, 1-32 chars, starts with a letter). |
| `tabId` | number |  | Tab to alias. Defaults to the caller's activeTabId. |

## Reading

### `chrome_read_page`

Return an accessibility-tree snapshot of viewport-visible elements; optionally filter to interactive-only or expand from a refId. If your target is missing, fall back to the computer tool's screenshot for coordinates. Example: {filter:"interactive"} → {nodes:[]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `filter` | string |  | Filter elements: "interactive" for such as buttons/links/inputs only (default: all visible elements) |
| `depth` | number |  | Maximum DOM depth to traverse (integer >= 0). Lower values reduce output size and can improve performance. |
| `refId` | string |  | Focus on the subtree rooted at this element refId (e.g., "ref_12"). The refId must come from a recent chrome_read_page response in the same tab (refs may expire). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `raw` | boolean |  | When the accessibility tree is too sparse and we fall back to the interactive-element scanner, results are capped at 150 elements by default and the response includes a `truncation` envelope indicating whether more were available. Set raw=true to skip the cap and return everything (response will be larger). |

### `chrome_list_frames`

List frames in a tab via chrome.webNavigation.getAllFrames as {frameId, parentFrameId, url, errorOccurred}; main doc is frameId:0. Use to discover stable frameIds for iframe targeting. Read-only. Example: {tabId:42} → {frames:[{frameId:0}]} Cross-ref: page.frames, page.frameLocator (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `urlContains` | string |  | Optional case-insensitive substring filter applied to each frame URL after the round-trip (handy for picking out a third-party iframe by domain without iterating all of them yourself). |

### `chrome_screenshot`

Take a screenshot of the page or element. Prefer chrome_read_page or chrome_computer action=screenshot for new code; use this only for advanced options. Example: {selector:"#hero", fullPage:false} → {savedPath, width, height} Cross-ref: browser_take_screenshot (MCP @playwright/mcp); page.screenshot, locator.screenshot (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string |  | Name for the screenshot, if saving as PNG |
| `selector` | string |  | CSS selector for element to screenshot |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Attempt capture without bringing tab/window to foreground. CDP-based capture is used for simple viewport captures. For element/full-page capture, the tab may still be made active in its window without focusing the window. Default: true. Pass false to foreground. |
| `width` | number |  | Width in pixels (default: 800) |
| `height` | number |  | Height in pixels (default: 600) |
| `storeBase64` | boolean |  | return screenshot in base64 format (default: false) if you want to see the page, recommend set this to be true |
| `fullPage` | boolean |  | Store screenshot of the entire page (default: true) |
| `savePng` | boolean |  | Save screenshot as PNG file (default: true)，if you want to see the page, recommend set this to be false, and set storeBase64 to be true |

### `chrome_get_web_content`

Fetch a page's raw HTML, plain text, or reader-mode Markdown. Optionally scoped by selector, saved to savePath, or fetched in a background tab. Example: {url:"https://example.com", markdownContent:true} → {markdown:"..."}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | URL to fetch content from. If not provided, uses the current active tab |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `htmlContent` | boolean |  | Get the visible HTML content of the page. If true, textContent and markdownContent are ignored (default: false) |
| `textContent` | boolean |  | Get the visible text content of the page with metadata. Ignored if htmlContent or markdownContent is true (default: true) |
| `markdownContent` | boolean |  | Run reader-mode extraction (Mozilla Readability) and return the article as Markdown (Turndown + GFM, supports tables/fenced code/task lists). Ignored if htmlContent is true; overrides textContent default. (default: false) |
| `selector` | string |  | CSS selector to get content from a specific element. If provided, only content from this element will be returned. Has no effect on markdownContent (reader-mode always extracts the main article). |
| `savePath` | string |  | Absolute file path to save the content to. When provided, content is written to disk via the native bridge instead of being returned in the response. Returns {saved: true, filePath, size} on success. |
| `raw` | boolean |  | When false, sanitize HTML by removing scripts, styles, and SVGs. Default: true (raw — preserves everything so the page opens and renders like the original). |

### `chrome_search_tabs_content`

Semantic vector search across content of currently open tabs. Returns matching tabs with relevance scores and snippets. Example: {query:"pricing page"} → {matches:[{tabId, score, snippet}]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | ✓ | The query to search for related content across open tabs. |

### `chrome_print_to_pdf`

Save a tab as PDF via CDP Page.printToPDF. Returns base64 by default; with savePath the bridge writes to disk and returns {path, bytes}. Common page/margin options exposed. Example: {savePath:"/tmp/out.pdf", landscape:true} → {path, bytes} Cross-ref: page.pdf (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab. Falls back to the active tab when omitted. |
| `savePath` | string |  | Optional bridge-side filesystem path. When provided the PDF is written to disk and the response returns `{path, bytes}` instead of base64. |
| `landscape` | boolean |  | Default false. |
| `printBackground` | boolean |  | Default true. |
| `scale` | number |  | CSS scale factor. Default 1. |
| `paperWidthIn` | number |  | Paper width in inches. Default 8.5. |
| `paperHeightIn` | number |  | Paper height in inches. Default 11. |
| `marginTopIn` | number |  | Top margin in inches. Default 0.4. |
| `marginRightIn` | number |  | Right margin in inches. Default 0.4. |
| `marginBottomIn` | number |  | Bottom margin in inches. Default 0.4. |
| `marginLeftIn` | number |  | Left margin in inches. Default 0.4. |
| `pageRanges` | string |  | Page ranges to print, e.g. `"1-5,8,11-13"`. Empty = all pages. |

### `chrome_aria_snapshot`

Token-efficient Playwright-style ARIA tree snapshot returning indented `- role "name" [ref=ref_N]` lines; refs round-trip into selectorType:"ref". 4-6x smaller than chrome_read_page; prefer this unless you need bounding boxes. Example: {interactiveOnly:true} → {snapshot:"...", refs} Cross-ref: browser_snapshot (MCP @playwright/mcp); page.accessibility.snapshot, locator.ariaSnapshot (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab. Defaults to caller's owned tab. |
| `windowId` | number |  | Optional window-id filter on the owned-tab pick. |
| `refId` | string |  | Snapshot a subtree rooted at this ref instead of the whole page. |
| `maxDepth` | number |  | Cap traversal depth. The helper enforces a hard ceiling regardless. |
| `interactiveOnly` | boolean |  | Include only interactive elements (default true). Set false for structure dumps. |
| `includeRefs` | boolean |  | Print `[ref=...]` markers so the LLM can pivot to ref-based selectors. Default true. |

### `chrome_get_attributes`

Read DOM attributes, properties, and computed CSS by selector or ref. Read-only; closes the gap between chrome_assert, chrome_read_page, and chrome_javascript. Use for data-* scraping, input.value after fill, computed style assertions. Example: {selector:"#x", attributes:["href"]} → {attributes:{href:"..."}} Cross-ref: locator.getAttribute, elementHandle.getAttribute (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  |  |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `text` \| `alt` \| `title` \| `testid` |  |  |
| `ref` | string |  |  |
| `index` | number |  |  |
| `multi` | boolean |  |  |
| `attributes` | array<string> |  |  |
| `properties` | array<string> |  |  |
| `computedStyles` | array<string> |  |  |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `frameId` | number |  |  |

## Interaction

### `chrome_computer`

Mouse/keyboard/screenshot omnibus tool driving the browser like a computer. Always read_page first to get refs for icon clicks; click cursor tip at element center. Example: {action:"screenshot"} → {image, width, height}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `action` | string | ✓ | Action to perform: left_click \| right_click \| double_click \| triple_click \| left_click_drag \| scroll \| scroll_to \| type \| key \| fill \| fill_form \| hover \| wait \| resize_page \| zoom \| screenshot |
| `ref` | string |  | Element ref from chrome_read_page. For click/scroll/scroll_to/key/type and drag end when provided; takes precedence over coordinates. |
| `coordinates` | object |  | Coordinates for actions (in screenshot space if a recent screenshot was taken, otherwise viewport). Required for click/scroll and as end point for drag. |
| `startCoordinates` | object |  | Starting coordinates for drag action |
| `startRef` | string |  | Drag start ref from chrome_read_page (alternative to startCoordinates). |
| `scrollDirection` | string |  | Scroll direction: up \| down \| left \| right |
| `scrollAmount` | number |  | Scroll ticks (1-10), default 3 |
| `text` | string |  | Text to type (for action=type) or keys/chords separated by space (for action=key, e.g. "Backspace Enter" or "cmd+a") |
| `repeat` | number |  | For action=key: number of times to repeat the key sequence (integer 1-100, default 1). |
| `modifiers` | object |  | Modifier keys for click actions (left_click/right_click/double_click/triple_click). |
| `region` | object |  | For action=zoom: rectangular region to capture (x0,y0)-(x1,y1) in viewport pixels (or screenshot-space if a recent screenshot context exists). |
| `selector` | string |  | Selector for fill (alternative to ref). Same kinds as chrome_click_element: CSS / XPath / Playwright-style `role:`/`label:`/`placeholder:`/`alt:`/`title:`/`testid:`/`text:`. |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `alt` \| `title` \| `testid` \| `text` |  | Selector kind. `css` (default) and `xpath` are the legacy options. Playwright-style values resolve via the matching strategy: `role` (implicit/explicit ARIA role + accessible name), `label` (form labels), `placeholder` (input/textarea placeholder), `alt` (img/area alt text), `title` (title attribute), `testid` (data-testid/cy/test/qa), `text` (visible text). When set to a non-css/xpath value, the `selector` field carries the strategy payload (e.g. `button[name="Submit",exact=true]` for `role`, or the search text for `label`/`placeholder`/etc.). |
| `index` | number |  | Zero-based index to pick when the selector matches multiple elements. Default behavior is strict mode — multi-match without `index` or `multi:true` errors with INVALID_ARGS + `details: {matchCount, samples}`. Use this when you intentionally want the N-th match. |
| `multi` | boolean |  | Disable strict mode — accept any matching element (first wins) instead of erroring on multi-match. Default false. Prefer `index` when you know which match to pick. |
| `value` | string \| boolean \| number |  | Value to set for action=fill (string \| boolean \| number) |
| `elements` | array<object> |  | For action=fill_form: list of elements to fill (ref + value) |
| `width` | number |  | For action=resize_page: viewport width |
| `height` | number |  | For action=resize_page: viewport height |
| `appear` | boolean |  | For action=wait with text: whether to wait for the text to appear (true, default) or disappear (false) |
| `timeoutMs` | number |  | Per-call timeout in ms, clamped to [1000, 120000]. For most actions this caps the underlying CDP command (default 10000) — raise it if a click/scroll/screenshot/etc. on a slow page errors with "did not return within ...". For action=wait with text it caps the wait deadline (default 10000). |
| `duration` | number |  | Seconds to wait for action=wait (max 30s) |
| `force` | boolean |  | IMP-0097: skip the actionability suite for click/dblclick/triple_click/drag/hover/fill/fill_form/key/type actions. scrollIntoView still runs. Default false. |
| `actionabilityTimeoutMs` | number |  | IMP-0097: per-call cap on the actionability wait, in milliseconds. Default 5000. |

### `chrome_click_element`

Click an element by CSS/XPath/Playwright locator, ref, or viewport coordinates. Strict mode: multi-match without explicit index or multi:true errors INVALID_ARGS with details.matchCount. Example: {selector:"#submit"} → {clicked:true, frameId:0} Cross-ref: browser_click (MCP @playwright/mcp); page.click, locator.click (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | Selector for the element. Default kind is CSS; Playwright-style prefixed strings are also accepted: `role:button[name="Submit"]`, `label:Email`, `placeholder:Search`, `alt:Logo`, `title:Close`, `testid:submit-btn`, `text:Login`. Composite (iframe traversal) still uses `\|>` between the frame selector and inner selector: `iframe#payment \|> role:button[name="Pay"]`. Set `selectorType` explicitly when you want to disambiguate. |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `alt` \| `title` \| `testid` \| `text` |  | Selector kind. `css` (default) and `xpath` are the legacy options. Playwright-style values resolve via the matching strategy: `role` (implicit/explicit ARIA role + accessible name), `label` (form labels), `placeholder` (input/textarea placeholder), `alt` (img/area alt text), `title` (title attribute), `testid` (data-testid/cy/test/qa), `text` (visible text). When set to a non-css/xpath value, the `selector` field carries the strategy payload (e.g. `button[name="Submit",exact=true]` for `role`, or the search text for `label`/`placeholder`/etc.). |
| `index` | number |  | Zero-based index to pick when the selector matches multiple elements. Default behavior is strict mode — multi-match without `index` or `multi:true` errors with INVALID_ARGS + `details: {matchCount, samples}`. Use this when you intentionally want the N-th match. |
| `multi` | boolean |  | Disable strict mode — accept any matching element (first wins) instead of erroring on multi-match. Default false. Prefer `index` when you know which match to pick. |
| `ref` | string |  | Element ref from chrome_read_page (takes precedence over selector). |
| `coordinates` | object |  | Viewport coordinates to click at. |
| `double` | boolean |  | Perform double click when true (default: false). |
| `button` | `left` \| `right` \| `middle` |  | Mouse button to click (default: "left"). |
| `modifiers` | object |  | Modifier keys to hold during click. |
| `waitForNavigation` | boolean |  | Wait for navigation to complete after click (default: false). |
| `timeoutMs` | number |  | Timeout in milliseconds for waiting (default: 5000). |
| `force` | boolean |  | IMP-0097: skip the actionability suite (visible/stable/enabled/hit-test). scrollIntoView still runs. Default false. Use sparingly — only when the suite is producing a false positive (e.g. pseudo-element targets the hit-test cannot resolve). |
| `actionabilityTimeoutMs` | number |  | IMP-0097: per-call cap on time spent waiting for actionability to pass, in milliseconds. Default 5000 (matches Playwright). Raise on pages with long settle (heavy SPA hydration), lower to fail fast on a known-bad target. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Target frame ID for iframe support. |

### `chrome_fill_or_select`

Fill or select an input/textarea/select/checkbox/radio by selector or ref. Supports Playwright-style locators. Strict-mode multi-match errors unless index or multi:true is passed. Example: {selector:"#email", value:"a@b.com"} → {filled:true} Cross-ref: browser_fill_form (MCP @playwright/mcp); locator.fill, page.selectOption (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | Selector for the element. Default kind is CSS; Playwright-style prefixed strings are also accepted: `role:button[name="Submit"]`, `label:Email`, `placeholder:Search`, `alt:Logo`, `title:Close`, `testid:submit-btn`, `text:Login`. Composite (iframe traversal) still uses `\|>` between the frame selector and inner selector: `iframe#payment \|> role:button[name="Pay"]`. Set `selectorType` explicitly when you want to disambiguate. |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `alt` \| `title` \| `testid` \| `text` |  | Selector kind. `css` (default) and `xpath` are the legacy options. Playwright-style values resolve via the matching strategy: `role` (implicit/explicit ARIA role + accessible name), `label` (form labels), `placeholder` (input/textarea placeholder), `alt` (img/area alt text), `title` (title attribute), `testid` (data-testid/cy/test/qa), `text` (visible text). When set to a non-css/xpath value, the `selector` field carries the strategy payload (e.g. `button[name="Submit",exact=true]` for `role`, or the search text for `label`/`placeholder`/etc.). |
| `index` | number |  | Zero-based index to pick when the selector matches multiple elements. Default behavior is strict mode — multi-match without `index` or `multi:true` errors with INVALID_ARGS + `details: {matchCount, samples}`. Use this when you intentionally want the N-th match. |
| `multi` | boolean |  | Disable strict mode — accept any matching element (first wins) instead of erroring on multi-match. Default false. Prefer `index` when you know which match to pick. |
| `ref` | string |  | Element ref from chrome_read_page (takes precedence over selector). |
| `value` | string \| number \| boolean | ✓ | Value to fill. For text inputs: string. For checkboxes/radios: boolean. For selects: option value or text. |
| `force` | boolean |  | IMP-0097: skip the actionability suite (visible/enabled/editable). scrollIntoView still runs. Default false. |
| `actionabilityTimeoutMs` | number |  | IMP-0097: per-call cap on the actionability wait, in milliseconds. Default 5000. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Target frame ID for iframe support. |

### `chrome_request_element_selection`

Request the user to manually select elements on the page as a human-in-the-loop fallback. Returns refs compatible with click/fill tools, including iframe frameId. Example: {requests:[{prompt:"pick login"}], timeoutMs:30000} → {refs:[{ref:"r1", frameId:0}]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `requests` | array<object> | ✓ | A list of element selection requests. Each request produces exactly one picked element. The user will see these requests in a panel and select each element by clicking on the page. |
| `timeoutMs` | number |  | Timeout in milliseconds for the user to complete all selections. Default: 180000 (3 minutes). Maximum: 600000 (10 minutes). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |

### `chrome_keyboard`

Simulate keyboard input — single keys, chords, text, or a high-level shortcut enum (copy/paste/undo/save/etc.) that maps to the platform-correct chord at dispatch. Targets a selector or the focused element. Example: {shortcut:"paste"} → {dispatched:true} Cross-ref: browser_press_key (MCP @playwright/mcp); page.keyboard.press, page.keyboard.type, keyboard.down, keyboard.up (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `keys` | string |  | Keys or key combinations to simulate. Examples: "Enter", "Tab", "Ctrl+C", "Shift+Tab", "Hello World". Optional when `shortcut` is supplied; when both are present, `shortcut` wins. |
| `shortcut` | `copy` \| `paste` \| `cut` \| `undo` \| `redo` \| `save` \| `select_all` \| `find` \| `refresh` \| `back` \| `forward` \| `new_tab` \| `close_tab` |  | High-level named shortcut. Resolves at dispatch time to the platform-correct key chord (e.g. `copy` → "Meta+c" on macOS, "Ctrl+c" elsewhere). Use this instead of `keys` to avoid hard-coding Ctrl-vs-Meta in prompts. |
| `selector` | string |  | Selector for the element. Default kind is CSS; Playwright-style prefixed strings are also accepted: `role:button[name="Submit"]`, `label:Email`, `placeholder:Search`, `alt:Logo`, `title:Close`, `testid:submit-btn`, `text:Login`. Composite (iframe traversal) still uses `\|>` between the frame selector and inner selector: `iframe#payment \|> role:button[name="Pay"]`. Set `selectorType` explicitly when you want to disambiguate. |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `alt` \| `title` \| `testid` \| `text` |  | Selector kind. `css` (default) and `xpath` are the legacy options. Playwright-style values resolve via the matching strategy: `role` (implicit/explicit ARIA role + accessible name), `label` (form labels), `placeholder` (input/textarea placeholder), `alt` (img/area alt text), `title` (title attribute), `testid` (data-testid/cy/test/qa), `text` (visible text). When set to a non-css/xpath value, the `selector` field carries the strategy payload (e.g. `button[name="Submit",exact=true]` for `role`, or the search text for `label`/`placeholder`/etc.). |
| `delay` | number |  | Delay between keystrokes in milliseconds (default: 50). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Target frame ID for iframe support. |

### `chrome_handle_dialog`

Handle JS alert/confirm/prompt dialogs via CDP. Actions: handle_dialog (one-shot accept/dismiss), register_default (per-tab auto-handler, holds persistent debugger attach), unregister_default, list_defaults. Example: {action:"handle_dialog", behavior:"accept"} → {handled:true} Cross-ref: browser_handle_dialog (MCP @playwright/mcp); page.on("dialog"), dialog.accept, dialog.dismiss (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `handle_dialog` \| `register_default` \| `unregister_default` \| `list_defaults` |  | Action to perform. Omit (or pass "handle_dialog") for the legacy one-shot behavior. |
| `behavior` | `accept` \| `dismiss` |  | For action="handle_dialog": "accept" or "dismiss" the currently open dialog. |
| `defaultBehavior` | `accept` \| `dismiss` \| `prompt_with_text` |  | For action="register_default": how to auto-answer future dialogs on this tab. "prompt_with_text" requires `promptText` and only differs from "accept" for prompt() calls. |
| `promptText` | string |  | Prompt input text. For action="handle_dialog" with behavior="accept", forwarded to prompt(). For action="register_default" with defaultBehavior="prompt_with_text", required — used as the auto-answer for every prompt() on this tab. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |

### `chrome_assert`

Run one or more predicates against the page and return structured pass/fail; ok is AND of all predicates. Use after a step to declaratively verify outcomes instead of inferring from tool returns. Example: {predicates:[{kind:"visible", selector:"#toast"}]} → {ok:true, results:[...]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `predicates` | array<object> | ✓ | List of assertions to run. All must pass for the overall ok=true. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |

### `chrome_wait_for`

Wait for one of: element, network idle, response, JS expression, load state, or URL pattern. Replaces JS spin-polls. Example: {kind:"network", quietMs:500} → {success:true, tookMs} Cross-ref: browser_wait_for (MCP @playwright/mcp); page.waitForSelector, page.waitForFunction, page.waitForLoadState (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `element` \| `network_idle` \| `response_match` \| `js` \| `load_state` \| `url` | ✓ | Which wait condition to use. Required. |
| `timeoutMs` | number |  | Wall-clock budget. Default 15000, max 120000. On timeout the tool returns a TIMEOUT error envelope. |
| `selector` | string |  | For kind="element": CSS selector, XPath, or Playwright-style locator. Either selector or ref must be provided. |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `alt` \| `title` \| `testid` \| `text` |  | Selector kind. `css` (default) and `xpath` are the legacy options. Playwright-style values resolve via the matching strategy: `role` (implicit/explicit ARIA role + accessible name), `label` (form labels), `placeholder` (input/textarea placeholder), `alt` (img/area alt text), `title` (title attribute), `testid` (data-testid/cy/test/qa), `text` (visible text). When set to a non-css/xpath value, the `selector` field carries the strategy payload (e.g. `button[name="Submit",exact=true]` for `role`, or the search text for `label`/`placeholder`/etc.). |
| `index` | number |  | Zero-based index to pick when the selector matches multiple elements. Default behavior is strict mode — multi-match without `index` or `multi:true` errors with INVALID_ARGS + `details: {matchCount, samples}`. Use this when you intentionally want the N-th match. |
| `multi` | boolean |  | Disable strict mode — accept any matching element (first wins) instead of erroring on multi-match. Default false. Prefer `index` when you know which match to pick. |
| `ref` | string |  | For kind="element": ref from chrome_read_page. |
| `state` | `present` \| `absent` \| `load` \| `domcontentloaded` \| `complete` |  | Dual-purpose field. For kind="element": "present" (default) or "absent". For kind="load_state": "load" (default) \| "domcontentloaded" \| "complete" — wait for the corresponding `chrome.webNavigation` event on the target tab+frame. "complete" is a Playwright synonym for "load" and maps to the same event. Pre-checked via `document.readyState` so already-loaded pages resolve synchronously. |
| `quietMs` | number |  | For kind="network_idle": consider the network idle once this many ms have elapsed without a new resource entry. Default 500. |
| `urlPattern` | string |  | For kind="response_match": substring or /regex/flags matched against the response URL. Reuses chrome_intercept_response's CDP wiring with returnBody=false (signal-only). Required for response_match. |
| `method` | string |  | For kind="response_match": optional HTTP method filter (GET/POST/etc). |
| `expression` | string |  | For kind="js": JavaScript expression evaluated in the page context. Re-evaluated on every DOM mutation plus a 250ms safety poll. Resolves on first truthy return. |
| `pattern` | string |  | For kind="url": substring or /regex/flags matched against the tab URL (same syntax as chrome_intercept_response). Subscribes to `chrome.webNavigation.onCommitted` + `onHistoryStateUpdated` so SPA pushState transitions are caught. Pre-checked against the current URL so an already-matching tab resolves synchronously. Required for kind="url". |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Target frame ID for iframe support. |

### `chrome_focus`

Focus an element by selector or ref before keyboard input (chrome_paste, chrome_keyboard). Reports focused:document.activeElement===el so callers detect disabled/unfocusable targets. Example: {selector:"#search"} → {focused:true, tagName:"INPUT"} Cross-ref: locator.focus, elementHandle.focus (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | Selector for the element. Default kind is CSS; Playwright-style prefixed strings are also accepted: `role:button[name="Submit"]`, `label:Email`, `placeholder:Search`, `alt:Logo`, `title:Close`, `testid:submit-btn`, `text:Login`. Composite (iframe traversal) still uses `\|>` between the frame selector and inner selector: `iframe#payment \|> role:button[name="Pay"]`. Set `selectorType` explicitly when you want to disambiguate. |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `alt` \| `title` \| `testid` \| `text` |  | Selector kind. `css` (default) and `xpath` are the legacy options. Playwright-style values resolve via the matching strategy: `role` (implicit/explicit ARIA role + accessible name), `label` (form labels), `placeholder` (input/textarea placeholder), `alt` (img/area alt text), `title` (title attribute), `testid` (data-testid/cy/test/qa), `text` (visible text). When set to a non-css/xpath value, the `selector` field carries the strategy payload (e.g. `button[name="Submit",exact=true]` for `role`, or the search text for `label`/`placeholder`/etc.). |
| `index` | number |  | Zero-based index to pick when the selector matches multiple elements. Default behavior is strict mode — multi-match without `index` or `multi:true` errors with INVALID_ARGS + `details: {matchCount, samples}`. Use this when you intentionally want the N-th match. |
| `multi` | boolean |  | Disable strict mode — accept any matching element (first wins) instead of erroring on multi-match. Default false. Prefer `index` when you know which match to pick. |
| `ref` | string |  | Element ref from chrome_read_page. Required if `selector` is omitted; mutually exclusive with `selector`. |
| `tabId` | number |  | Target tab. Falls back to the active tab when omitted. |
| `windowId` | number |  | Target window for active-tab lookup when `tabId` is omitted. |
| `frameId` | number |  | Optional frame to scope the lookup to. Defaults to the main frame. |
| `force` | boolean |  | IMP-0097: skip the visibility check. scrollIntoView still runs. Default false. |
| `actionabilityTimeoutMs` | number |  | IMP-0097: per-call cap on the actionability wait, in milliseconds. Default 5000. (Focus runs only the visibility check synchronously today; this field is reserved for the future async-friendly variant.) |

### `chrome_paste`

Focus an element by selector or ref and paste text — seeds the clipboard then dispatches BOTH a synthetic ClipboardEvent and execCommand(insertText) so rich editors and plain inputs both accept it. Example: {selector:"#msg", text:"hi"} → {focused:true, pasted:true, mode:"both"}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | CSS selector for the target. Mutually exclusive with `ref`. |
| `ref` | string |  | Element ref from chrome_read_page. Mutually exclusive with `selector`. |
| `text` | string |  | Optional text to seed the clipboard with before pasting. When omitted, whatever is currently on the OS clipboard is used. |
| `tabId` | number |  | Target tab. Falls back to the active tab when omitted. |
| `windowId` | number |  | Target window for active-tab lookup when `tabId` is omitted. |
| `frameId` | number |  | Optional frame to scope the paste to. Defaults to the main frame. |

### `chrome_select_text`

Select text inside an element via setSelectionRange (inputs) or DOM Range (everything else). Pass substring OR start+end. Pairs with chrome_clipboard/chrome_paste. Example: {selector:"#bio", substring:"hello"} → {start, end, mode:"dom-range"}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | CSS selector for the target. Mutually exclusive with `ref`. |
| `ref` | string |  | Element ref from chrome_read_page. Mutually exclusive with `selector`. |
| `substring` | string |  | Substring to find and select (first occurrence). Mutually exclusive with `start`+`end`. |
| `start` | number |  | Character offset where the selection starts. Required if `end` is set. |
| `end` | number |  | Character offset where the selection ends. Required if `start` is set. |
| `tabId` | number |  | Target tab. Falls back to the active tab when omitted. |
| `windowId` | number |  | Target window for active-tab lookup when `tabId` is omitted. |
| `frameId` | number |  | Optional frame. Defaults to the main frame. |

### `chrome_drag_drop`

Drag from one element to another by synthesizing the full HTML5 DnD + Pointer-Event chain (pointerdown→dragstart→N moves→drop→dragend). Hidden/not-found targets surface as INVALID_ARGS. Example: {fromSelector:"#card1", toSelector:"#col2", steps:10} → {steps, fromBox, toBox} Cross-ref: browser_drag, browser_drop (MCP @playwright/mcp); page.dragAndDrop, locator.dragTo (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `fromSelector` | string |  | Selector for the drag source. Accepts CSS, XPath (via `selectorType="xpath"`), or Playwright-style prefixed forms (`role:button[name="Card"]`, `label:Email`, etc.). Mutually exclusive with `fromRef`. |
| `fromSelectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `alt` \| `title` \| `testid` \| `text` |  | Optional selector kind for `fromSelector`. Defaults to `css`. See chrome_click_element for the full list. |
| `fromIndex` | number |  | Zero-based index to pick when the selector matches multiple elements. Default behavior is strict mode — multi-match without `index` or `multi:true` errors with INVALID_ARGS + `details: {matchCount, samples}`. Use this when you intentionally want the N-th match. |
| `fromRef` | string |  | Element ref (chrome_read_page) for the drag source. Mutually exclusive with `fromSelector`. |
| `toSelector` | string |  | Selector for the drop target — same kinds as `fromSelector`. Mutually exclusive with `toRef`. |
| `toSelectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `alt` \| `title` \| `testid` \| `text` |  | Optional selector kind for `toSelector`. Defaults to `css`. |
| `toIndex` | number |  | Zero-based index to pick when the selector matches multiple elements. Default behavior is strict mode — multi-match without `index` or `multi:true` errors with INVALID_ARGS + `details: {matchCount, samples}`. Use this when you intentionally want the N-th match. |
| `toRef` | string |  | Element ref for the drop target. Mutually exclusive with `toSelector`. |
| `multi` | boolean |  | Disable strict mode — accept any matching element (first wins) instead of erroring on multi-match. Default false. Prefer `index` when you know which match to pick. |
| `steps` | number |  | Number of intermediate pointermove + dragover events between the two centers. Clamped to [1, 50]. Default 5. |
| `tabId` | number |  | Target tab. Falls back to the active tab when omitted. |
| `windowId` | number |  | Target window for active-tab lookup when `tabId` is omitted. |
| `frameId` | number |  | Optional frame to scope the operation to. Defaults to the main frame. |
| `force` | boolean |  | IMP-0097: skip the actionability suite (visible/stable/hit-test) on both source and target. scrollIntoView still runs. Default false. |
| `actionabilityTimeoutMs` | number |  | IMP-0097: per-call cap on the actionability wait for each endpoint, in milliseconds. Default 5000. |

### `chrome_locator_handler`

Auto-dismiss sticky overlays (cookie banners, GDPR modals) that intercept clicks. Actions: register/list/remove/clear a {selector, dismissSelector} pair; dismissAction defaults to click, "press" needs a key. Example: {action:"register", selector:".cookie-banner", dismissSelector:".accept"} → {handlerId} Cross-ref: page.addLocatorHandler, page.removeLocatorHandler (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `register` \| `list` \| `remove` \| `clear` | ✓ | Operation to perform. |
| `selector` | string |  | CSS selector for the overlay element to watch. The handler fires the dismiss action whenever any element matching this selector becomes visible. Required for `register`. |
| `dismissSelector` | string |  | CSS selector for the element to click (or press a key on) once the trigger appears — typically the "Accept", "Close", or "Dismiss" button inside the overlay. Required for `register`. Re-queried on every fire so re-rendered overlays still match. |
| `dismissAction` | `click` \| `press` |  | How to dismiss the overlay. `click` (default) dispatches the full pointerdown→mousedown→pointerup→mouseup→click sequence on `dismissSelector`. `press` dispatches keydown→keypress→keyup with `key` (defaults to `Escape`) and requires `key` to be set. |
| `key` | string |  | Key name to dispatch when `dismissAction: "press"`. Standard KeyboardEvent.key values like `Escape`, `Enter`, `Tab`. Required when `dismissAction: "press"`. |
| `times` | number |  | Optional cap on total dismissals. Handler auto-removes once the limit is reached. Must be a positive integer. Default: unlimited. |
| `persistent` | boolean |  | When true (default false), re-arm the handler after page navigation via `chrome.webNavigation.onDOMContentLoaded`. Non-persistent handlers vanish on navigation — useful for one-shot dismissal during a single page session. |
| `handlerId` | string |  | Handler ID returned from `register`. Required for `remove`. |
| `tabId` | number |  | Target tab. Falls back to the active tab when omitted. |
| `windowId` | number |  | Target window for active-tab lookup when `tabId` is omitted. |

### `chrome_set_checked`

Idempotent checkbox/radio/switch state set — matches Playwright locator.setChecked. Non-checkable elements return INVALID_ARGS. Example: {selector:"#tos", checked:true} → {checked:true, changed:true, priorChecked:false} Cross-ref: locator.setChecked, locator.check, locator.uncheck (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  |  |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `text` \| `alt` \| `title` \| `testid` |  |  |
| `ref` | string |  |  |
| `index` | number |  |  |
| `multi` | boolean |  |  |
| `checked` | boolean | ✓ | Target state. Required. |
| `force` | boolean |  | Skip the visibility/disabled check. |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `frameId` | number |  |  |

### `chrome_type_into`

Char-by-char keystroke typing with realistic per-key delay to bypass anti-bot cadence heuristics. Max 1024 chars. Example: {selector:"#q", text:"hello", perKeyDelayMs:60, pressEnter:true} → {typed, finalValue, pressedEnter} Cross-ref: browser_type (MCP @playwright/mcp); locator.type, locator.pressSequentially, locator.fill (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  |  |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `text` \| `alt` \| `title` \| `testid` |  |  |
| `ref` | string |  |  |
| `index` | number |  |  |
| `multi` | boolean |  |  |
| `text` | string | ✓ | Text to type (≤1024 chars). |
| `perKeyDelayMs` | number |  | Base delay between keystrokes (ms). Default 60. |
| `jitterMs` | number |  | ± random jitter added to perKeyDelayMs. Default 30. Set 0 for fixed cadence. |
| `pressEnter` | boolean |  | Send Enter after the last char. |
| `clearFirst` | boolean |  | Select-all + Delete before typing. |
| `force` | boolean |  | Skip the focus visibility/disabled/readonly check. |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `frameId` | number |  |  |

### `chrome_hover`

Programmatic mouse hover to trigger tooltips and dropdown menus (mouseover→mouseenter→pointerenter chain with actionability). Pair with chrome_wait_for kind:"element" to wait for revealed UI. Example: {selector:".profile-card"} → {hovered:true, bbox, point, tagName} Cross-ref: browser_hover (MCP @playwright/mcp); page.hover, locator.hover (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  |  |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `text` \| `alt` \| `title` \| `testid` |  |  |
| `ref` | string |  |  |
| `index` | number |  |  |
| `multi` | boolean |  |  |
| `position` | object |  |  |
| `force` | boolean |  | Skip the visibility + hit-test check. |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `frameId` | number |  |  |

### `chrome_combobox_select`

Trusted keyboard commit of React/Ember combobox state: focus, type query, wait for [role=option], ArrowDown to match, Enter. Use where option-click silently no-ops (LinkedIn Skills, Open-to-Work). Example: {comboboxSelector:'input',query:'LangGraph'} → {selectedIndex,selectedText,optionCount} Cross-ref: browser_select_option (MCP @playwright/mcp); page.selectOption, locator.selectOption (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `comboboxSelector` | string |  | CSS (or other selectorType) for the combobox input. |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `text` \| `alt` \| `title` \| `testid` |  |  |
| `ref` | string |  | Element ref from chrome_read_page (alternative to comboboxSelector). |
| `query` | string | ✓ | Text to type into the input (≤256 chars). |
| `matchText` | string |  | Option innerText to commit. Defaults to query. Case-insensitive. |
| `matchMode` | `exact` \| `contains` \| `startsWith` |  | How to compare option text against matchText. Default "contains". |
| `clearFirst` | boolean |  | Select-all + Delete before typing. Default true. |
| `optionSelector` | string |  | CSS for the option elements. Default '[role="option"]'. |
| `waitForOptionsMs` | number |  | Max time to wait for options to render after typing. Default 5000. |
| `perKeyDelayMs` | number |  | Base delay between keystrokes. Default 60. |
| `jitterMs` | number |  | ± random jitter on perKeyDelayMs. Default 30. |
| `force` | boolean |  | Skip the combobox visibility/disabled/readonly check. |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `frameId` | number |  |  |

### `chrome_typeahead_probe`

Diagnostic: types a sample char into a typeahead, reports every event (with isTrusted), every fetch, and final listbox state in one envelope. Use when typeahead/autocomplete isn't firing — check summary.{keydownFired,inputFired,lookupFetchFired}. Example: {selector:'input',sample:'S'} → {events,fetches,listboxFound}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | CSS (or other selectorType) for the typeahead input. |
| `selectorType` | `css` \| `xpath` \| `role` \| `label` \| `placeholder` \| `text` \| `alt` \| `title` \| `testid` |  |  |
| `ref` | string |  | Element ref from chrome_read_page (alternative to selector). |
| `sample` | string |  | Char(s) to type (≤16). Default "a". |
| `watchMs` | number |  | How long to observe events + fetches after typing. Default 3500. |
| `clearFirst` | boolean |  | Select-all + Delete before typing. Default true. |
| `networkUrlPattern` | string |  | Regex (case-insensitive). When set, only fetches matching this pattern are returned. Default matches all. |
| `optionSelector` | string |  | CSS for the option elements (used for the listbox snapshot). Default '[role="option"]'. |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `frameId` | number |  |  |

## Scripting

### `chrome_userscript`

Unified userscript tool (create/list/get/enable/disable/update/remove/send_command/export). Auto-selects best strategy with CSP-aware fallbacks. Example: {action:"create", args:{code:"...", runAt:"document_end"}} → {id, strategy}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `create` \| `list` \| `get` \| `enable` \| `disable` \| `update` \| `remove` \| `send_command` \| `export` | ✓ | Operation to perform |
| `args` | object |  | Arguments for the specified action. - create: { script (required), name?, description?, matches?: string[], excludes?: string[], persist?: boolean (default true), runAt?: "document_start"\|"document_end"\|"document_idle"\|"auto", world?: "auto"\|"ISOLATED"\|"MAIN", allFrames?: boolean (default true), mode?: "auto"\|"css"\|"persistent"\|"once", dnrFallback?: boolean (default true), tags?: string[] } - list: { query?: string, status?: "enabled"\|"disabled", domain?: string } - get: { id (required) } - enable/disable: { id (required) } - update: { id (required), script?, name?, description?, matches?, excludes?, runAt?, world?, allFrames?, persist?, dnrFallback?, tags? } - remove: { id (required) } - send_command: { id (required), payload?: string, tabId?: number } - export: {} Tip: For a one-off execution that returns a value, use create with args.mode="once". The returned value is included as onceResult in the tool response. |

### `chrome_inject_script`

Inject a one-off content script into a tab (ISOLATED or MAIN world) with a custom event bridge. For persistent/CSP-aware injections use chrome_userscript instead. Example: {jsScript:"console.log('hi')", type:"MAIN"} → {injected:true, tabId} Cross-ref: page.addInitScript, page.evaluate (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | If a URL is specified, inject the script into the webpage corresponding to the URL. If no matching tab exists, a new tab is created. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `type` | `ISOLATED` \| `MAIN` | ✓ | The JavaScript world the script should execute in. Must be ISOLATED or MAIN. |
| `jsScript` | string | ✓ | The JavaScript source to inject. |

### `chrome_list_injected_scripts`

List user scripts currently injected via chrome_inject_script across tabs as {tabId, world, scriptLength, injectedAt}. Use for idempotent inject-once pre-flight checks. Read-only. Example: {} → {scripts:[{tabId:42, world:"MAIN"}]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | When provided, return only the entry for this tab id (or an empty array if no injection). Omit to list every injected tab. |

### `chrome_send_command_to_inject_script`

Dispatch a user-defined event to a script previously installed via chrome_inject_script. Example: {tabId:5, eventName:"refresh", payload:{id:42}} → {dispatched:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `eventName` | string | ✓ | The event name your injected content script listens for. |
| `payload` | string |  | The payload passed to the event. Must be a JSON string. |

### `chrome_javascript`

Execute JS in a tab via CDP Runtime.evaluate (awaitPromise, returnByValue) with chrome.scripting ISOLATED fallback. Wrapped in async IIFE so top-level await works; bare expressions auto-return. Output sanitized + capped at maxOutputBytes. Example: {code:"document.title"} → {success:true, result:"...", truncated:false} Cross-ref: browser_evaluate, browser_run_code_unsafe (MCP @playwright/mcp); page.evaluate, locator.evaluate (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | ✓ | JavaScript code to execute. Runs inside an async function body, so top-level await and "return ..." are supported. Bare trailing expressions are auto-returned. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `timeoutMs` | number |  | Execution timeout in milliseconds (default: 15000). |
| `maxOutputBytes` | number |  | Maximum output size in bytes after sanitization (default: 51200). Output exceeding this limit is truncated and `truncated:true` is set in the response — pass a larger value to opt into a fuller read. |
| `writeResultTo` | string |  | Absolute file path. If set, the bridge writes the JSON-serialized `result` to this path and returns a small ack ({writtenTo, bytes, sha256}) instead of the full payload — keeps large blobs (e.g. ~200KB JSON fetches) out of the LLM context. Parent directories are created if missing. Relative paths are rejected with INVALID_ARGS. |

### `chrome_remove_injected_script`

Tear down a user script previously installed via chrome_inject_script by sending humanchrome:cleanup and dropping the tab from the registry. Idempotent — removed:false when no injection existed. Example: {tabId:42} → {removed:true, tabId:42}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab. Falls back to the active tab in the focused window when omitted. |

## Network

### `chrome_network_request`

Send a network request from the browser carrying its cookies and origin context. Supports method, headers, body or formData, timeout. Example: {url:"https://api.example.com/me", method:"GET"} → {status:200, body:"..."} Cross-ref: browser_network_request (MCP @playwright/mcp); request.fetch, apiRequestContext.fetch (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | ✓ | URL to send the request to |
| `method` | string |  | HTTP method to use (default: GET) |
| `headers` | object |  | Headers to include in the request |
| `body` | string |  | Body of the request (for POST, PUT, etc.) |
| `timeout` | number |  | Timeout in milliseconds (default: 30000) |
| `formData` | object |  | Multipart/form-data descriptor. If provided, overrides body and builds FormData with optional file attachments. Shape: { fields?: Record<string,string\|number\|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }. Also supports a compact array form: [ [name, fileSpec, filename?], ... ] where fileSpec may be url:, file:, or base64:. |

### `chrome_network_capture`

Capture network traffic on a tab. action=start begins; stop returns the buffer; flush drains without stopping; status reads state. needResponseBody=true uses Debugger (may conflict with DevTools). Response bodies capped at 1 MiB. Example: {action:"start"} → {captureId, started:true} Cross-ref: browser_network_requests (MCP @playwright/mcp); page.on("request"), page.on("response") (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `start` \| `stop` \| `flush` \| `status` | ✓ | Action to perform: "start" begins capture, "stop" ends and returns results, "flush" returns the buffered results so far and clears them without ending the capture, "status" returns a side-effect-free snapshot of the current capture state. |
| `needResponseBody` | boolean |  | When true, captures response body using Debugger API (default: false). Only use when you need to inspect response content. |
| `url` | string |  | URL to capture network requests from. For action="start". If not provided, uses the current active tab. |
| `maxCaptureTime` | number |  | Maximum capture time in milliseconds (default: 180000) |
| `inactivityTimeout` | number |  | Stop after inactivity in milliseconds (default: 60000). Set 0 to disable. |
| `includeStatic` | boolean |  | Include static resources like images/scripts/styles (default: false) |
| `background` | boolean |  | Do not activate tab/focus window when starting capture (default: true). Only honored by the debugger backend (needResponseBody:true); the webRequest backend never activates. Pass false to bring the tab forward. |

### `chrome_intercept_response`

Wait for the next network response matching urlPattern on a tab and return its parsed JSON body. Attaches the debugger Network domain for the wait duration. count>1 batches matches into one call. Example: {urlPattern:"*/api/users*", count:1, timeoutMs:5000} → {ok:true, matched, responses:[...]} Cross-ref: page.route, route.continue, route.fulfill (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `urlPattern` | string | ✓ | Substring or regex (wrapped in / / for regex form, e.g. "/voyager/api/.*conversations/i") to match against the response URL. |
| `method` | string |  | Optional HTTP method filter (GET, POST, etc). When omitted, matches any method. |
| `timeoutMs` | number |  | Milliseconds to wait for a matching response before timing out (default 15000, max 120000). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `returnBody` | boolean |  | When false (default true), skip getResponseBody and return only headers + status. Useful when you only need to detect that the call fired. |
| `count` | number |  | How many matching responses to accumulate before detaching (default 1, max 100). When 1 (default), the tool resolves on the first match and returns the single-response shape (ok, tabId, requestId, url, method, status, ...). When >1, it accumulates up to N matches (or until timeoutMs fires) and returns { ok, tabId, count, matched, responses: [{...}, ...] } — matched may be less than count on timeout. On timeout with zero matches, the same TIMEOUT envelope is returned regardless of count. |

### `chrome_network_emulate`

Emulate network conditions on a tab via CDP Network.emulateNetworkConditions. Actions: set (offline | latencyMs | downloadKbps | uploadKbps), reset. State persists per-tab until reset or tab close. Example: {action:"set", offline:true} → {applied:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `set` \| `reset` | ✓ | Operation to perform. |
| `tabId` | number | ✓ | Target tab. Required for both actions. |
| `offline` | boolean |  | When true, force the tab offline. Default false. |
| `latencyMs` | number |  | Round-trip latency in milliseconds. 0 disables latency emulation. Used by `set`. |
| `downloadKbps` | number |  | Max download throughput in kbps. -1 disables (unbounded). Used by `set`. |
| `uploadKbps` | number |  | Max upload throughput in kbps. -1 disables. Used by `set`. |

### `chrome_block_or_redirect`

Block or redirect URLs via declarativeNetRequest session rules (cleared on Chrome restart). Actions: add, remove, list, clear. Example: {action:"add", urlFilter:"||tracker.com", ruleAction:"block"} → {ruleId:1, success:true} Cross-ref: page.route, browserContext.route (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `add` \| `remove` \| `list` \| `clear` | ✓ | Operation to perform. |
| `ruleId` | number |  | Required for `remove`. Optional for `add` — when omitted, the tool auto-assigns the next free id. |
| `urlFilter` | string |  | URL pattern (DNR `urlFilter` syntax — e.g. `\|\|example.com/api/*`). Required for `add`. |
| `ruleAction` | `block` \| `redirect` |  | What to do when the URL matches. Required for `add`. |
| `redirectUrl` | string |  | Required when `ruleAction` is `redirect`. Absolute URL the request is rewritten to. |
| `resourceTypes` | array<`main_frame` \| `sub_frame` \| `stylesheet` \| `script` \| `image` \| `font` \| `object` \| `xmlhttprequest` \| `ping` \| `csp_report` \| `media` \| `websocket` \| `webtransport` \| `webbundle` \| `other`> |  | Optional. Restrict the rule to specific resource types (e.g. `["xmlhttprequest","script"]`). |

### `chrome_proxy`

Set/clear/inspect proxy config via chrome.proxy.settings. Modes: direct | system | fixed_servers (needs singleProxy) | pac_script (needs pacUrl). Scope is always regular (incognito untouched). Example: {action:"set", mode:"fixed_servers", singleProxy:{host:"1.2.3.4", port:8080}} → {applied:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `set` \| `clear` \| `get` | ✓ | Operation to perform. |
| `mode` | `direct` \| `system` \| `fixed_servers` \| `pac_script` |  | For `set`. Required. |
| `singleProxy` | object |  | For `set` with mode="fixed_servers". `host` and `port` required; `scheme` defaults to "http". |
| `bypassList` | array<string> |  | For `set` with mode="fixed_servers". Optional list of host patterns the proxy is bypassed for. |
| `pacUrl` | string |  | For `set` with mode="pac_script". URL of the PAC script. |

### `chrome_basic_auth`

Autoresponder for HTTP Basic/Digest 401 prompts via CDP Fetch.continueWithAuth — chrome_handle_dialog cannot. In-memory only. Actions: register, unregister, list, clear. Example: {action:"register", origin:"https://api.example.com", username:"u", password:"p"} → {success:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `register` \| `unregister` \| `list` \| `clear` |  |  |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `origin` | string |  | Required for register/unregister. Origin like "https://api.example.com" or "*" wildcard. |
| `username` | string |  | Required for register. |
| `password` | string |  | Required for register. Never echoed back. |
| `scheme` | `basic` \| `digest` \| `any` |  |  |

### `chrome_mock_response`

Synthesize fake response bodies for matched URLs via CDP Fetch.fulfillRequest before the request leaves the browser. Actions: register/list_mocks/unregister_mock/clear. bodyJson auto-serializes. Example: {action:"register", urlPattern:"/api/me", status:200, bodyJson:{ok:true}} → {handlerId} Cross-ref: page.route, route.fulfill (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `register` \| `list_mocks` \| `unregister_mock` \| `clear` |  |  |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `urlPattern` | string |  | Required for action:"register". Substring or /regex/flags. |
| `method` | string |  | Optional HTTP method filter (case-insensitive). |
| `status` | number |  | Response status. Default 200. |
| `headers` | object |  |  |
| `body` | string |  | Response body. Mutex with bodyJson. |
| `bodyJson` |  |  | Response body — auto-serialized to JSON + sets Content-Type:application/json if absent. Mutex with body. |
| `delayMs` | number |  | Artificial latency before the fake response. |
| `once` | boolean |  | Auto-unregister after first match. Default true. |
| `handlerId` | string |  | Required for action:"unregister_mock". |

### `chrome_har_export`

Format chrome_network_capture buffers as HAR 1.2 JSON for DevTools/Charles/Playwright import. Read-only. Actions: export_from_active (inline, default), save_to_downloads (writes file to ~/Downloads). Response bodies capped at 1 MiB. Example: {action:"save_to_downloads", filename:"run.har"} → {downloadId, filename}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `export_from_active` \| `save_to_downloads` |  | Operation. Defaults to "export_from_active". |
| `tabId` | number |  |  |
| `windowId` | number |  |  |
| `filename` | string |  | Optional filename for save_to_downloads. Defaults to humanchrome-tab-<id>-<ts>.har. Non-filesystem-safe chars are stripped. |

### `chrome_set_extra_http_headers`

Inject extra HTTP headers on every request a tab makes via CDP, persistent until cleared. Forbidden headers (Host, etc.) rejected with INVALID_ARGS. Example: {action:"set", headers:{Authorization:"Bearer x"}} → {set:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `set` \| `get` \| `clear` \| `list_tabs` |  | Operation to perform. Defaults to "set". |
| `tabId` | number |  | Target tab. Required for set/get/clear (defaults to caller's owned tab); ignored for list_tabs. |
| `headers` | object |  | Map of {headerName: value}. Required when action="set". All values must be strings. |

## Files

### `chrome_handle_download`

Wait for the next browser download (optionally matching filenameContains) and return its details. Set waitForComplete to block until the file finishes writing. Example: {filenameContains:".csv", waitForComplete:true} → {id, filename, url, state, size}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `filenameContains` | string |  | Filter by substring in filename or URL |
| `timeoutMs` | number |  | Timeout in ms (default 60000, max 300000) |
| `waitForComplete` | boolean |  | Wait until completed (default true) |
| `tabId` | number |  | Optional source-tab filter. When provided, only downloads originating from this tab are matched. Programmatic downloads (anchor.click on detached element, fetch+blob) often lack a tabId and are matched regardless. |

### `chrome_upload_file`

Upload files to a form's file input via CDP. Accepts filePath, fileUrl, or base64Data. Example: {selector:"input[type=file]", filePath:"/tmp/a.png"} → {uploaded:true, count:1} Cross-ref: browser_file_upload (MCP @playwright/mcp); locator.setInputFiles, page.setInputFiles (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `selector` | string | ✓ | CSS selector for the file input element (input[type="file"]) |
| `filePath` | string |  | Local file path to upload |
| `fileUrl` | string |  | URL to download file from before uploading |
| `base64Data` | string |  | Base64 encoded file data to upload |
| `fileName` | string |  | Optional filename when using base64 or URL (default: "uploaded-file") |
| `multiple` | boolean |  | Whether the input accepts multiple files (default: false) |

### `chrome_gif_recorder`

Record a tab as an animated GIF. action=start uses fixed-FPS sampling; action=auto_start captures on chrome_computer/chrome_navigate success; action=stop finalises and saves. Example: {action:"start", fps:5, durationMs:10000} → {recordingId, started:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `start` \| `stop` \| `status` \| `auto_start` \| `capture` \| `clear` \| `export` | ✓ | Action to perform: - "start": Begin fixed-FPS recording (captures frames at regular intervals) - "auto_start": Begin auto-capture mode (frames captured on tool actions) - "stop": End recording and save GIF - "status": Get current recording state - "capture": Manually trigger a frame capture in auto mode - "clear": Clear all recording state and cached GIF without saving - "export": Export the last recorded GIF (download or drag&drop upload) |
| `tabId` | number |  | Target tab ID (default: active tab). Used with "start"/"auto_start" for recording, and with "export" (download=false) for drag&drop upload target. |
| `fps` | number |  | Frames per second for fixed-FPS mode (1-30, default: 5). Higher values = smoother but larger file. |
| `durationMs` | number |  | Maximum recording duration in milliseconds (default: 5000, max: 60000). Only for fixed-FPS mode. |
| `maxFrames` | number |  | Maximum number of frames to capture (default: 50 for fixed-FPS, 100 for auto mode, max: 300). |
| `width` | number |  | Output GIF width in pixels (default: 800, max: 1920). |
| `height` | number |  | Output GIF height in pixels (default: 600, max: 1080). |
| `maxColors` | number |  | Maximum colors in palette (default: 256). Lower values = smaller file size. |
| `filename` | string |  | Output filename (without extension). Defaults to timestamped name. |
| `captureDelayMs` | number |  | Auto-capture mode only: Delay in ms after action before capturing frame (default: 150). Allows UI to stabilize. |
| `frameDelayCs` | number |  | Auto-capture mode only: Display duration per frame in centiseconds (default: 20 = 200ms per frame). |
| `annotation` | string |  | Auto-capture mode only (action="capture"): Optional text label to render on the captured frame. |
| `download` | boolean |  | Export action only: Set to true (default) to download the GIF, or false to upload via drag&drop. |
| `coordinates` | object |  | Export action only (when download=false): Target coordinates for drag&drop upload. |
| `ref` | string |  | Export action only (when download=false): Element ref from chrome_read_page for drag&drop target. |
| `selector` | string |  | Export action only (when download=false): CSS selector for drag&drop target element. |
| `enhancedRendering` | object |  | Auto-capture mode only: Configure visual overlays for recorded actions (click indicators, drag paths, labels). Pass `true` to enable all defaults. |

### `chrome_download`

List or cancel downloads via chrome.downloads. Replaces chrome_download_list and chrome_download_cancel. For wait-for-next-download semantics, use chrome_handle_download (separate). Example: {action:"list", state:"in_progress"} → {count, items:[...]}; {action:"cancel", downloadId:42} → {cancelled:true, postState}.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `list` \| `cancel` | ✓ | list=enumerate, cancel=stop an in-progress download. |
| `state` | `in_progress` \| `complete` \| `interrupted` \| `all` |  | For action=list: filter by state (default all). |
| `filenameContains` | string |  | For action=list: case-insensitive substring on basename. |
| `limit` | number |  | For action=list: cap (1..100, default 25). |
| `downloadId` | number |  | For action=cancel: download id from list or chrome.downloads.onCreated. |

## State

### `chrome_storage`

Read/write/clear a tab's localStorage or sessionStorage via a MAIN-world shim. IndexedDB is out of scope. Example: {action:"get", scope:"local", key:"flag"} → {value:"on", exists:true} Cross-ref: browserContext.storageState, page.evaluate(() => localStorage) (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `get` \| `set` \| `remove` \| `clear` \| `keys` | ✓ | Operation to perform on the storage area. |
| `scope` | `local` \| `session` |  | Which web-app storage area to operate on: `local` (window.localStorage, persists across sessions) or `session` (window.sessionStorage, cleared when the tab closes). Default: `local`. |
| `key` | string |  | Storage key. Required for `get`, `set`, and `remove`. |
| `value` | string |  | Value to store. Required for `set`. Strings only — wrap structured data in JSON.stringify before passing. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Optional frame to scope the operation to. Defaults to the main frame. localStorage and sessionStorage are origin-keyed, so different iframes on different origins keep separate stores. |

### `chrome_history`

Search or delete browsing history via chrome.history. action:"search" (default) filters by text/time/maxResults; action:"delete" removes by url, startTime+endTime range, or all:true (requires confirmDeleteAll:true). Permanent. Example: {action:"search", text:"github"} → {items:[...]}; {action:"delete", url:"https://x.com"} → {deleted:true}.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `search` \| `delete` |  | search (default) or delete. Omit for search-mode. |
| `text` | string |  | For action=search: query against URLs/titles. Empty returns all in range. |
| `startTime` | string |  | For search: start of range (default 24h ago). For delete: required with endTime for range mode. Supports ISO, "1 day ago", "yesterday", etc. |
| `endTime` | string |  | End of range. Same date formats. Default current time. |
| `maxResults` | number |  | For action=search: max entries (default 100). |
| `excludeCurrentTabs` | boolean |  | For action=search: filter out URLs currently open in any tab. |
| `url` | string |  | For action=delete: remove visits to this exact URL. |
| `all` | boolean |  | For action=delete: wipe entire history. Requires confirmDeleteAll:true. |
| `confirmDeleteAll` | boolean |  | Safety ack for delete + all:true. |

### `chrome_bookmark`

Bookmarks CRUD via action enum. Replaces the four separate chrome_bookmark_search/add/update/delete tools. Example: {action:"search", query:"github"} → {bookmarks:[...]}; {action:"add", url, title, parentId} → {bookmarkId}; {action:"update", bookmarkId, newTitle} → {success:true}; {action:"delete", bookmarkId} → {success:true, deleted:1}.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `search` \| `add` \| `update` \| `delete` | ✓ | Which bookmark operation. search=query/list, add=create, update=rename/move/re-URL, delete=remove. |
| `query` | string |  | For action=search: match against bookmark titles/URLs. Empty returns all. |
| `maxResults` | number |  | For action=search: max results (default 50). |
| `folderPath` | string |  | For action=search: optional folder path/ID to scope (e.g. "Work/Projects"). |
| `url` | string |  | For action=add: URL to bookmark (defaults to active tab). For action=update/delete: lookup by URL when bookmarkId omitted. |
| `title` | string |  | For action=add: bookmark title (defaults to page title). For action=delete: optional title hint for disambiguation. |
| `parentId` | string |  | For action=add: parent folder path/ID (defaults to "Bookmarks Bar"). |
| `createFolder` | boolean |  | For action=add: auto-create missing parent folder (default false). |
| `bookmarkId` | string |  | For action=update/delete: ID of bookmark to operate on. Preferred over url-based lookup. |
| `matchTitle` | string |  | For action=update: optional title substring to disambiguate when matching by url. |
| `newUrl` | string |  | For action=update: new URL. |
| `newTitle` | string |  | For action=update: new title. |
| `newParentId` | string |  | For action=update: new parent folder path/ID. |

### `chrome_cookies`

Cookies CRUD via chrome.cookies. Replaces chrome_get_cookies/set_cookie/remove_cookie. Example: {action:"get", domain:".linkedin.com", name:"li_at"} → {cookies:[...]}; {action:"set", url:"https://x.com", name, value} → {cookie}; {action:"remove", url, name} → {removed:{...}}. Cross-ref: browserContext.cookies, browserContext.addCookies (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `get` \| `set` \| `remove` | ✓ | get=list, set=create/update single, remove=delete single. |
| `url` | string |  | For get: scope by URL. For set: required (derives default domain/path). For remove: required to identify cookie. |
| `domain` | string |  | For get: scope by domain (e.g. "linkedin.com"). For set: cookie domain (defaults to host-only). |
| `name` | string |  | For get: filter to this name. For set: cookie name. For remove: required to identify cookie. |
| `value` | string |  | For set: cookie value. |
| `path` | string |  | Cookie path (get filter or set value). |
| `secure` | boolean |  | Cookie Secure flag (get filter or set value). |
| `session` | boolean |  | For get: filter session vs persistent cookies. |
| `httpOnly` | boolean |  | For set: HttpOnly flag. |
| `sameSite` | `no_restriction` \| `lax` \| `strict` \| `unspecified` |  | For set: SameSite attribute (default "unspecified"). |
| `expirationDate` | number |  | For set: expiry in seconds since epoch. Omit for session cookie. |
| `storeId` | string |  | Optional cookie store ID (e.g. incognito). |

### `chrome_console`

Capture console output: snapshot mode (one-time ~2s wait) or buffer mode (persistent per-tab, instant read/clear). Response.truncation reports caps; retry with raw:true (snapshot only) if argsTruncated. Example: {mode:"buffer", onlyErrors:true} → {messages:[...], truncation} Cross-ref: browser_console_messages (MCP @playwright/mcp); page.on("console") (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | URL to navigate to and capture console from. If not provided, uses the current active tab |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `includeExceptions` | boolean |  | Include uncaught exceptions in the output (default: true) |
| `maxMessages` | number |  | Maximum number of console messages to capture in snapshot mode (default: 100). If limit is provided, it takes precedence. |
| `mode` | `snapshot` \| `buffer` |  | Console capture mode: snapshot (default; waits ~2s for messages) or buffer (persistent per-tab buffer; reads from memory instantly). |
| `buffer` | boolean |  | Alias for mode="buffer" (default: false). |
| `clear` | boolean |  | Buffer mode only: clear the buffered logs for this tab before reading (default: false). Use clearAfterRead instead to clear after reading (mcp-tools.js style). |
| `clearAfterRead` | boolean |  | Buffer mode only: clear the buffered logs for this tab AFTER reading, to avoid duplicate messages on subsequent calls (default: false). This matches mcp-tools.js behavior. |
| `pattern` | string |  | Optional regex filter applied to message/exception text. Supports /pattern/flags syntax. |
| `onlyErrors` | boolean |  | Only return error-level console messages (and exceptions when includeExceptions=true). Default: false. |
| `limit` | number |  | Limit returned console messages. In snapshot mode this is an alias for maxMessages; in buffer mode it limits returned messages from the buffer. |
| `raw` | boolean |  | Snapshot mode only: skip the per-arg serializer caps (maxDepth=3, maxProps=100) so deeply nested or large console arguments survive intact. Use when the previous response's `truncation.argsTruncated` was true. Buffer mode replays already-serialized args and ignores this flag. |

### `chrome_clear_browsing_data`

Wipe browsing-data stores via chrome.browsingData.remove. Required dataTypes[] subset of cookies/localStorage/indexedDB/cache/history/etc; unknown types reject as INVALID_ARGS. Optional since(epoch ms) and origins[] filter. Example: {dataTypes:["cookies","cache"], since:0} → {success:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `dataTypes` | array<string> | ✓ | Non-empty array of data-store names to wipe. Valid keys: cookies, localStorage, indexedDB, cache, cacheStorage, history, downloads, formData, passwords, serviceWorkers, webSQL, fileSystems, pluginData, appcache. |
| `since` | number |  | Epoch ms cutoff — only data created after this time is removed. Default 0 (all time). |
| `origins` | array<string> |  | Optional origin-scoped filter (e.g. ["https://example.com"]). When omitted, applies to all origins. |

### `chrome_emulate`

Per-tab CDP Emulation overrides (UA, locale, timezone, geolocation, device, color-scheme). Persistent until reset_all or tab close. Actions: set_device|set_ua|set_locale|set_timezone|set_geolocation|set_color_scheme|reset_all|get_state. Example: {action:"set_timezone", timezone:"Europe/London"} → {ok:true} Cross-ref: browser_resize (MCP @playwright/mcp); page.setViewportSize, page.emulateMedia, browser.newContext (Playwright API).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `set_device` \| `set_ua` \| `set_locale` \| `set_timezone` \| `set_geolocation` \| `set_color_scheme` \| `reset_all` \| `get_state` | ✓ |  |
| `tabId` | number |  |  |
| `preset` | string |  | Device preset name (set_device). |
| `width` | number |  |  |
| `height` | number |  |  |
| `deviceScaleFactor` | number |  |  |
| `mobile` | boolean |  |  |
| `hasTouch` | boolean |  |  |
| `userAgent` | string |  |  |
| `acceptLanguage` | string |  |  |
| `platform` | string |  |  |
| `locale` | string |  | BCP 47 tag, e.g. "en-US". |
| `timezone` | string |  | IANA timezone name, e.g. "America/New_York". |
| `latitude` | number |  |  |
| `longitude` | number |  |  |
| `accuracy` | number |  |  |
| `colorScheme` | `light` \| `dark` \| `no-preference` |  |  |
| `reducedMotion` | `reduce` \| `no-preference` |  |  |

## System

### `chrome_notifications`

Push native OS notifications via chrome.notifications. Actions: create (title+message required, up to 2 buttons), clear, clear_all, get_all. iconUrl must be a data URI or extension-relative path. Example: {action:"create", title:"Done", message:"Task finished"} → {notificationId}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `create` \| `clear` \| `clear_all` \| `get_all` | ✓ | Operation to perform. |
| `notificationId` | string |  | Required for `clear`. Optional for `create` (when set, replaces the existing notification with the same id; otherwise Chrome auto-generates). |
| `title` | string |  | Notification title. Required for `create`. |
| `message` | string |  | Notification body. Required for `create`. |
| `type` | `basic` \| `image` \| `list` \| `progress` |  | Notification template. Defaults to `basic`. |
| `iconUrl` | string |  | Icon as a data URI or extension-relative path. Defaults to the extension icon. |
| `priority` | number |  | Priority -2..2 (Chrome may ignore on some platforms). |
| `buttons` | array<object> |  | Up to 2 action buttons (for the `basic` type). Each: `{title}`. |

### `chrome_clipboard`

Read or write the system clipboard via the offscreen document (only context where navigator.clipboard works from a SW). Plain text only — no image/HTML. Example: {action:"write", text:"hello"} → {written:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `read` \| `write` | ✓ | Operation to perform. |
| `text` | string |  | Plain text to write. Required for `write`. |

### `chrome_action_badge`

Set or clear a small badge on the extension icon (text truncated to ~4 chars by Chrome). action=set takes text+optional color/tabId; action=clear empties it (per-tab if tabId set, else global). Example: {action:"set", text:"ERR", color:"#FF0000"} → {success:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `set` \| `clear` | ✓ | Operation to perform. |
| `text` | string |  | Badge text. Required for `set`. Truncated to ~4 chars by Chrome — keep it terse. |
| `color` | string |  | Optional badge background color, hex `#RRGGBB` or `#RRGGBBAA`. Default red on most platforms. |
| `tabId` | number |  | Optional. When set, the badge is scoped to this tab; without it, the badge is global. |

### `chrome_keep_awake`

Prevent system sleep during long runs via chrome.power.requestKeepAwake. Idempotent. Actions: enable (level=display keeps screen on, system lets screen sleep), disable. Released on extension reload. Example: {action:"enable", level:"system"} → {enabled:true, level:"system"}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `enable` \| `disable` | ✓ | Operation to perform. |
| `level` | `display` \| `system` |  | Required for `enable`. `display` is stricter (also blocks screen sleep). |

### `chrome_context_menu`

Register transient right-click menu items via chrome.contextMenus; clicks emit context_menu_clicked events over the bridge. Actions: add, update, remove, remove_all. Example: {action:"add", title:"Use as target", contexts:["page","selection"]} → {id:"menu_1"}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `add` \| `update` \| `remove` \| `remove_all` | ✓ | Operation to perform. |
| `id` | string |  | Menu item id. Optional for `add` (auto-generated). Required for `update`, `remove`. |
| `title` | string |  | Menu item label. Required for `add`. Optional for `update`. |
| `contexts` | array<`all` \| `page` \| `frame` \| `selection` \| `link` \| `editable` \| `image` \| `video` \| `audio` \| `launcher` \| `browser_action` \| `page_action` \| `action`> |  | Where the item appears. Defaults to `["page"]` for `add`. See chrome.contextMenus docs for which contexts each label applies in. |
| `documentUrlPatterns` | array<string> |  | Optional. Match patterns the URL must satisfy for the item to appear (e.g. `["https://example.com/*"]`). |

### `chrome_idle`

Query user idle state via chrome.idle.queryState (active|idle|locked) to back off intrusive ops or skip screenshots when locked. detectionIntervalSec accepts 15..14400 (default 60). Example: {detectionIntervalSec:120} → {state:"active", detectionIntervalSec:120}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `detectionIntervalSec` | number |  | Inactivity threshold in seconds (15..14400). Default 60. |

### `chrome_alarms`

Schedule one-shot or repeating chrome.alarms callbacks; fires broadcast as alarm_fired runtime messages. Actions: create, clear, clear_all, get, get_all. Example: {action:"create", name:"poll", delayInMinutes:5, periodInMinutes:5} → {success:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `create` \| `clear` \| `clear_all` \| `get` \| `get_all` | ✓ | Operation to perform. |
| `name` | string |  | Alarm name. Required for `create`, `clear`, `get`. |
| `when` | number |  | For `create`. Absolute fire time as a Unix epoch milliseconds value. Use this OR `delayInMinutes`. |
| `delayInMinutes` | number |  | For `create`. Minutes from now until first fire. Use this OR `when`. |
| `periodInMinutes` | number |  | For `create`. When set, the alarm refires every N minutes after the first fire. Omit for one-shot. |

### `chrome_identity`

OAuth2 + profile lookup via chrome.identity for calling Google APIs without browser consent flows. Requires oauth2.client_id in manifest. Actions: get_token, remove_token, get_profile. Example: {action:"get_token", scopes:["openid","email"], interactive:false} → {token, scopes}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `get_token` \| `remove_token` \| `get_profile` | ✓ | Operation to perform. |
| `scopes` | array<string> |  | For `get_token`. Optional OAuth2 scopes (e.g. `["https://www.googleapis.com/auth/calendar.readonly"]`). |
| `interactive` | boolean |  | For `get_token`. When true, Chrome shows a consent UI if needed; when false, the call fails fast if the user has not already consented. Default false. |
| `token` | string |  | For `remove_token`. The token previously returned by `get_token`. |

### `chrome_dev_reload`

Trigger chrome.runtime.reload() from the SW so unattended E2E rebuild→reload→re-test runs need no operator click. Reply returns immediately; reload fires ~50ms later, pause 1-2s before next call. Dev/test only. Example: {} → {ok:true}

No parameters.

### `chrome_runtime_info`

Return SW identity for E2E runners to verify bundle freshness. Output includes buildHash and toolNames so callers can detect stale SWs. Example: {} → {extensionVersion, buildHash, toolNames, toolCount, uptimeMs}

No parameters.

## Performance

### `chrome_performance_start_trace`

Start a performance trace recording on the selected page. Optionally reload first and/or auto-stop after a duration. Example: {reload:true, autoStop:true, durationMs:5000} → {started:true}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `reload` | boolean |  | Determines if, once tracing has started, the page should be automatically reloaded (ignore cache). |
| `autoStop` | boolean |  | Determines if the trace should be automatically stopped (default false). |
| `durationMs` | number |  | Auto-stop duration in milliseconds when autoStop is true (default 5000). |

### `chrome_performance_stop_trace`

Stop the active performance trace recording on the selected page. Optionally save the raw trace to Downloads. Example: {saveToDownloads:true, filenamePrefix:"home"} → {stopped:true, path}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `saveToDownloads` | boolean |  | Whether to save the trace as a JSON file in Downloads (default true). |
| `filenamePrefix` | string |  | Optional filename prefix for the downloaded trace JSON. |

### `chrome_performance_analyze_insight`

Lightweight summary of the last recorded performance trace. For deep insights (CWV, breakdowns) integrate the native-side DevTools trace engine. Example: {insightName:"LCP"} → {summary:{}}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `insightName` | string |  | Optional insight name for future deep analysis (e.g., "DocumentLatency"). Currently informational only. |
| `timeoutMs` | number |  | Timeout for deep analysis via native host (milliseconds). Default 60000. Increase for large traces. |

### `chrome_web_vitals`

Live Core Web Vitals collector via PerformanceObserver in MAIN world. Lighter than chrome_performance_*. Example: {action:"start", reload:true} → {installed:true, lcpMs, clsScore, inpMs, fcpMs, ttfbMs}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `start` \| `snapshot` \| `stop` | ✓ | Operation to perform. |
| `tabId` | number |  | Target tab. Falls back to the active tab when omitted. |
| `windowId` | number |  | Window scope for active-tab lookup when `tabId` is omitted. |
| `reload` | boolean |  | For `start` only. Reload the tab before installing the observer so cold-start LCP / FCP / TTFB are captured. Default false. |

## Diagnostics

### `chrome_debug_dump`

Return recent extension debug-log entries correlated by requestId to the MCP call that produced them; filters compose AND. Use to diagnose a failed call without re-running it. Example: {tool:"chrome_click_element", level:"error", limit:20} → {entries:[...]}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `requestId` | string |  | Only return entries with this correlation id. |
| `tool` | string |  | Only return entries for this tool name (e.g. "chrome_navigate"). |
| `tabId` | number |  | Only return entries scoped to this tabId. |
| `level` | `debug` \| `info` \| `warn` \| `error` |  | Filter by severity. |
| `sinceMs` | number |  | Absolute epoch milliseconds — only return entries newer than this. |
| `limit` | number |  | Maximum entries to return. Defaults to 200, max 1000. |
| `clear` | boolean |  | When true, wipe the buffer instead of returning entries. |
| `persist` | boolean |  | Toggle whether log entries are written through to chrome.storage.local across SW restarts. Off by default (steady-state SW CPU optimization, IMP-0059) — `true` enables persistence so future logs survive a service-worker restart, `false` disables it and clears the persisted blob, omitted leaves the current state unchanged. The response always includes `persistEnabled` so callers can check the current state. |

### `chrome_help`

Search or browse the tool catalog. Three modes: {} returns full index; {query} returns ranked matches (typos tolerated); {name} returns full description. Use {query} first when the canonical name is unknown. Example: {query:"click"} → {matches:[{name:"chrome_click_element",summary,score}...]}.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string |  | Optional canonical tool name. When set, returns {name, summary, description}. |
| `query` | string |  | Free-text search across tool names and descriptions. Tokens are matched against name parts (exact > substring) and descriptions; short queries also get a typo-tolerance bonus. Returns ranked matches. |
| `limit` | number |  | Optional cap on returned matches when `query` is set (default 10, max 50). |

## Pacing

### `chrome_pace`

Get or set per-MCP-client pacing. With profile, mutating tools sleep a profile-derived gap (anti-bot rhythm). With no args, returns current profile + resolved gap/jitter. Reads un-throttled. State resets on SW restart. Example: {profile:"careful"} → {profile, minGapMs, jitterMs}; {} → {profile:"off", minGapMs:0, jitterMs:0}.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `profile` | `off` \| `human` \| `careful` \| `fast` |  | Pacing preset. Omit to read current state. off=no throttle (default); human=600-1200ms gap with jitter; careful=1500-3000ms (LinkedIn-grade); fast=tab-lock-only serialization with no extra wait. |
| `minGapMs` | number |  | Optional override: inclusive lower bound on gap between mutating dispatches (ms). Stacks with the profile preset. |
| `jitterMs` | number |  | Optional override: random extra gap added in [0, jitterMs] (ms). Total gap = minGapMs + Math.random() * jitterMs. |

## Workflows

### `record_replay_list_published`

List recorded flows published as dynamic MCP tools. Discovery surface for record_replay_flow_run; pair with the auto-exposed flow.<slug> tools. Example: {} → {flows:[{id, slug, name, version, variables}]}

No parameters.

### `record_replay_flow_run`

Run a recorded flow by ID with per-step outcomes. Prefer the dynamic flow.<slug> tool when slug is known; this is the explicit fallback. Example: {flowId:"f1", args:{q:"hi"}} → {success, steps}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `flowId` | string | ✓ | ID of the flow to run. |
| `args` | object |  | Variable values for the flow (flat object of key/value). Variables are declared per-flow at recording time; see record_replay_list_published for the schema of each flow. |
| `tabTarget` | `current` \| `new` |  | Where to run the flow: in the current tab (default) or a new tab. |
| `refresh` | boolean |  | Refresh the target tab before running (default false). |
| `captureNetwork` | boolean |  | Capture network snippets during the run for debugging (default false). Adds latency. |
| `returnLogs` | boolean |  | Include per-step log entries in the run result (default false). |
| `timeoutMs` | number |  | Global timeout in milliseconds for the entire flow run. |
| `startUrl` | string |  | Optional URL to open before the flow runs. |

### `record_replay_flow_delete`

Delete a recorded flow by ID; always unpublishes first so the dynamic flow.<slug> MCP tool disappears. Example: {flowId:"f1"} → {deleted:true, unpublished:true, flowId:"f1"}

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `flowId` | string | ✓ | ID of the flow to delete (from `record_replay_list_published`). |


<!-- AUTO-GEN END -->

## 📋 Response Format

All tools return responses in the following format:

```json
{
  "content": [
    {
      "type": "text",
      "text": "JSON string containing the actual response data"
    }
  ],
  "isError": false
}
```

For errors:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error message describing what went wrong"
    }
  ],
  "isError": true
}
```

## 🔧 Usage Examples

### Complete Workflow Example

```javascript
// 1. Navigate to a page
await callTool('chrome_navigate', {
  url: 'https://example.com',
});

// 2. Take a screenshot
const screenshot = await callTool('chrome_screenshot', {
  fullPage: true,
  storeBase64: true,
});

// 3. Start network monitoring
await callTool('chrome_network_capture', {
  action: 'start',
  maxCaptureTime: 30000,
});

// 4. Interact with the page
await callTool('chrome_click_element', {
  selector: '#load-data-button',
});

// 5. Search content semantically
const searchResults = await callTool('search_tabs_content', {
  query: 'user data analysis',
});

// 6. Stop network capture
const networkData = await callTool('chrome_network_capture', { action: 'stop' });

// 7. Save bookmark
await callTool('chrome_bookmark_add', {
  title: 'Data Analysis Page',
  parentId: 'Work/Analytics',
});
```

This API provides comprehensive browser automation capabilities with AI-enhanced content analysis and semantic search features.
