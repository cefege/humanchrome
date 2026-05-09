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

Get all currently open browser windows and tabs

No parameters.

### `chrome_navigate`

Navigate to a URL, refresh the current tab, or navigate browser history (back/forward)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | URL to navigate to. Special values: "back" or "forward" to navigate browser history in the target tab. |
| `newWindow` | boolean |  | Create a new window to navigate to the URL or not. Defaults to false |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `width` | number |  | Window width in pixels (default: 1280). When width or height is provided, a new window will be created. |
| `height` | number |  | Window height in pixels (default: 720). When width or height is provided, a new window will be created. |
| `refresh` | boolean |  | Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false |

### `chrome_navigate_batch`

Open many URLs at once and return their tabIds. Tabs open in the background by default so the user's foreground tab keeps focus. Pair with chrome_wait_for_tab + chrome_get_web_content to drain results sequentially. Returns immediately after issuing the opens unless maxConcurrent is set — in which case it blocks until each batch finishes loading before opening the next.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `urls` | array<string> | ✓ | URLs to open. Each becomes a new tab. |
| `windowId` | number |  | Target window for the new tabs. If omitted, uses the last-focused window (or creates one). |
| `background` | boolean |  | Open without stealing focus (default true). Set false to foreground each new tab as it opens. |
| `perTabDelayMs` | number |  | Delay between consecutive opens, in milliseconds. Default 0. Use a small value (50-200ms) on sites that flag burst opens. When maxConcurrent is also set, this delay applies WITHIN each worker (between consecutive opens by the same worker). |
| `maxConcurrent` | number |  | Cap the number of in-flight tab loads. When omitted (or <= 0), all URLs open in parallel (current behavior). When set to N, opens N tabs and waits for each to finish loading before starting the next — useful on anti-bot platforms (LinkedIn, Instagram) that flag concurrent opens. Each waited tab uses a 30s load timeout; on timeout the tab is still recorded and the worker continues. |
| `perUrlTimeoutMs` | number |  | Per-URL load timeout in ms when maxConcurrent is set. Default 30000. Ignored when maxConcurrent is not set. |

### `chrome_wait_for_tab`

Block until the given tab transitions to status:"complete". Event-driven via chrome.tabs.onUpdated — does not poll. Use after chrome_navigate or chrome_navigate_batch to drain a fan-out workflow before reading from each tab. Throws TAB_CLOSED if the tab is closed during the wait, TIMEOUT if the deadline elapses.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number | ✓ | Tab to wait on. Required (no implicit active-tab fallback). Pass the tabId returned by chrome_navigate or chrome_navigate_batch. |
| `timeoutMs` | number |  | Maximum wait in milliseconds (default 30000). |

### `chrome_close_tab`

Close one or more browser tabs

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabIds` | array<number> |  | Array of tab IDs to close. If not provided, will close the active tab. |
| `url` | string |  | Close tabs matching this URL. Can be used instead of tabIds. |

### `chrome_switch_tab`

Switch to a specific browser tab

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number | ✓ | The ID of the tab to switch to. |
| `windowId` | number |  | The ID of the window where the tab is located. |

## Reading

### `chrome_read_page`

Get an accessibility tree representation of visible elements on the page. Only returns elements that are visible in the viewport. Optionally filter for only interactive elements.
Tip: If the returned elements do not include the specific element you need, use the computer tool's screenshot (action="screenshot") to capture the element's on-screen coordinates, then operate by coordinates.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `filter` | string |  | Filter elements: "interactive" for such as buttons/links/inputs only (default: all visible elements) |
| `depth` | number |  | Maximum DOM depth to traverse (integer >= 0). Lower values reduce output size and can improve performance. |
| `refId` | string |  | Focus on the subtree rooted at this element refId (e.g., "ref_12"). The refId must come from a recent chrome_read_page response in the same tab (refs may expire). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `raw` | boolean |  | When the accessibility tree is too sparse and we fall back to the interactive-element scanner, results are capped at 150 elements by default and the response includes a `truncation` envelope indicating whether more were available. Set raw=true to skip the cap and return everything (response will be larger). |

### `chrome_list_frames`

List the frames in a tab via chrome.webNavigation.getAllFrames. Returns one entry per frame as `{ frameId, parentFrameId, url, errorOccurred }` (the main document is included with `frameId: 0` and `parentFrameId: -1`). Use this to discover stable frameId values to pass to chrome_click_element / chrome_fill_or_select / chrome_await_element when targeting an iframe — walking `window.frames` from injected JS is cross-origin-blocked for sandboxed iframes and returns unstable indexes. Read-only; no DOM access.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `urlContains` | string |  | Optional case-insensitive substring filter applied to each frame URL after the round-trip (handy for picking out a third-party iframe by domain without iterating all of them yourself). |

### `chrome_screenshot`

[Prefer read_page over taking a screenshot and Prefer chrome_computer] Take a screenshot of the current page or a specific element. For new usage, use chrome_computer with action="screenshot". Use this tool if you need advanced options.

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

Fetch content from a web page

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | URL to fetch content from. If not provided, uses the current active tab |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `htmlContent` | boolean |  | Get the visible HTML content of the page. If true, textContent will be ignored (default: false) |
| `textContent` | boolean |  | Get the visible text content of the page with metadata. Ignored if htmlContent is true (default: true) |
| `selector` | string |  | CSS selector to get content from a specific element. If provided, only content from this element will be returned |
| `savePath` | string |  | Absolute file path to save the content to. When provided, content is written to disk via the native bridge instead of being returned in the response. Returns {saved: true, filePath, size} on success. |
| `raw` | boolean |  | When false, sanitize HTML by removing scripts, styles, and SVGs. Default: true (raw — preserves everything so the page opens and renders like the original). |

### `chrome_search_tabs_content`

Semantic vector search across the content of currently open tabs. Returns matching tabs with relevance scores and snippets.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | ✓ | The query to search for related content across open tabs. |

### `chrome_console_clear`

Reset the per-tab console buffer used by `chrome_console` (mode="buffer") and the `console_clean` predicate of `chrome_assert`. Use between steps of a multi-step flow so subsequent console reads are scoped to messages that arrived after the clear — the same reset pattern test frameworks use between assertions. Returns `{ success, tabId, cleared, clearedMessages, clearedExceptions, bufferActive }` where `cleared` is the total number of buffered entries dropped. No-op (cleared:0, bufferActive:false) when buffer capture has not yet started for the tab.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |

## Interaction

### `chrome_computer`

Use a mouse and keyboard to interact with a web browser, and take screenshots.
* Whenever you intend to click on an element like an icon, you should consult a read_page to determine the ref of the element before moving the cursor.
* If you tried clicking on a program or link but it failed to load, even after waiting, try screenshot and then adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.

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
| `selector` | string |  | CSS selector for fill (alternative to ref). |
| `value` | string \| boolean \| number |  | Value to set for action=fill (string \| boolean \| number) |
| `elements` | array<object> |  | For action=fill_form: list of elements to fill (ref + value) |
| `width` | number |  | For action=resize_page: viewport width |
| `height` | number |  | For action=resize_page: viewport height |
| `appear` | boolean |  | For action=wait with text: whether to wait for the text to appear (true, default) or disappear (false) |
| `timeoutMs` | number |  | Per-call timeout in ms, clamped to [1000, 120000]. For most actions this caps the underlying CDP command (default 10000) — raise it if a click/scroll/screenshot/etc. on a slow page errors with "did not return within ...". For action=wait with text it caps the wait deadline (default 10000). |
| `duration` | number |  | Seconds to wait for action=wait (max 30s) |

### `chrome_click_element`

Click on an element in a web page. Supports multiple targeting methods: CSS selector, XPath, element ref (from chrome_read_page), or viewport coordinates. More focused than chrome_computer for simple click operations.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | CSS selector or XPath for the element. |
| `selectorType` | `css` \| `xpath` |  | Type of selector (default: "css"). |
| `ref` | string |  | Element ref from chrome_read_page (takes precedence over selector). |
| `coordinates` | object |  | Viewport coordinates to click at. |
| `double` | boolean |  | Perform double click when true (default: false). |
| `button` | `left` \| `right` \| `middle` |  | Mouse button to click (default: "left"). |
| `modifiers` | object |  | Modifier keys to hold during click. |
| `waitForNavigation` | boolean |  | Wait for navigation to complete after click (default: false). |
| `timeoutMs` | number |  | Timeout in milliseconds for waiting (default: 5000). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Target frame ID for iframe support. |

### `chrome_fill_or_select`

Fill or select a form element on a web page. Supports input, textarea, select, checkbox, and radio elements. Use CSS selector, XPath, or element ref to target the element.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | CSS selector or XPath for the element. |
| `selectorType` | `css` \| `xpath` |  | Type of selector (default: "css"). |
| `ref` | string |  | Element ref from chrome_read_page (takes precedence over selector). |
| `value` | string \| number \| boolean | ✓ | Value to fill. For text inputs: string. For checkboxes/radios: boolean. For selects: option value or text. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Target frame ID for iframe support. |

### `chrome_request_element_selection`

Request the user to manually select one or more elements on the current page. Use this as a human-in-the-loop fallback when you cannot reliably locate the target element after approximately 3 attempts using chrome_read_page combined with chrome_click_element/chrome_fill_or_select/chrome_computer. The user will see a panel with instructions and can click on the requested elements. Returns element refs compatible with chrome_click_element/chrome_fill_or_select (including iframe frameId for cross-frame support).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `requests` | array<object> | ✓ | A list of element selection requests. Each request produces exactly one picked element. The user will see these requests in a panel and select each element by clicking on the page. |
| `timeoutMs` | number |  | Timeout in milliseconds for the user to complete all selections. Default: 180000 (3 minutes). Maximum: 600000 (10 minutes). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |

### `chrome_keyboard`

Simulate keyboard input on a web page. Supports single keys (Enter, Tab, Escape), key combinations (Ctrl+C, Ctrl+V), and text input. Can target a specific element or send to the focused element.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `keys` | string | ✓ | Keys or key combinations to simulate. Examples: "Enter", "Tab", "Ctrl+C", "Shift+Tab", "Hello World". |
| `selector` | string |  | CSS selector or XPath for the element. |
| `selectorType` | `css` \| `xpath` |  | Type of selector (default: "css"). |
| `delay` | number |  | Delay between keystrokes in milliseconds (default: 50). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Target frame ID for iframe support. |

### `chrome_await_element`

Wait for a DOM element to be present or absent on the page using a MutationObserver. Use this instead of polling chrome_javascript when waiting for UI state changes (e.g. a modal closing, a skeleton loader being replaced, a "Sent" indicator appearing). Targeting: provide either selector (CSS or XPath) or ref (from chrome_read_page). Returns immediately when the goal state is already true. Returns {found:true, elapsedMs} on success, or a TIMEOUT error with {selector, state, timeoutMs, elapsedMs} after timeoutMs.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | string |  | CSS selector or XPath for the element. |
| `selectorType` | `css` \| `xpath` |  | Type of selector (default: "css"). |
| `ref` | string |  | Element ref from chrome_read_page. Takes precedence over selector. For state="absent", waits until the referenced element is detached or the ref no longer resolves. |
| `state` | `present` \| `absent` |  | Target state to wait for: "present" (default) waits for a matching element to appear, "absent" waits for it to disappear. |
| `timeoutMs` | number |  | Timeout in milliseconds (default: 15000, max: 120000). Returns a TIMEOUT error when the goal state is not reached in time. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `frameId` | number |  | Target frame ID for iframe support. |

### `chrome_handle_dialog`

Handle JavaScript dialogs (alert/confirm/prompt) via CDP

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | ✓ | accept \| dismiss |
| `promptText` | string |  | Optional prompt text when accepting a prompt |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |

### `chrome_assert`

Run one or more predicates against the page and return a structured pass/fail result. Use after a flow step to declaratively confirm "did the click work? did the page navigate? is the toast visible? was the API call successful?" instead of inferring success from individual tool returns. Returns `{ ok: boolean, results: [{ predicate, ok, detail }] }` — `ok` is the AND of every predicate. Tools fan out to existing primitives (querySelector, console-buffer, performance.getEntriesByType, page eval); no new infrastructure.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `predicates` | array<object> | ✓ | List of assertions to run. All must pass for the overall ok=true. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |

### `chrome_wait_for`

Wait for one of: a DOM element to appear/disappear, the network to go idle, a specific response to fire, or an arbitrary JS expression to return truthy. Single primitive that replaces the chrome_javascript spin-poll pattern. Pick `kind` and provide the matching parameters; `timeoutMs` is shared across all kinds. `kind: "element"` is functionally identical to chrome_await_element and is the preferred entry point for new code. Returns `{ success: boolean, kind, tookMs, ...kind-specific-detail }` on completion or a TIMEOUT envelope on miss.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `element` \| `network_idle` \| `response_match` \| `js` | ✓ | Which wait condition to use. Required. |
| `timeoutMs` | number |  | Wall-clock budget. Default 15000, max 120000. On timeout the tool returns a TIMEOUT error envelope. |
| `selector` | string |  | For kind="element": CSS selector or XPath. Either selector or ref must be provided. |
| `selectorType` | `css` \| `xpath` |  | Type of selector (default: "css"). |
| `ref` | string |  | For kind="element": ref from chrome_read_page. |
| `state` | `present` \| `absent` |  | For kind="element": "present" (default) or "absent". |
| `quietMs` | number |  | For kind="network_idle": consider the network idle once this many ms have elapsed without a new resource entry. Default 500. |
| `urlPattern` | string |  | For kind="response_match": substring or /regex/flags matched against the response URL. Reuses chrome_intercept_response's CDP wiring with returnBody=false (signal-only). Required for response_match. |
| `method` | string |  | For kind="response_match": optional HTTP method filter (GET/POST/etc). |
| `expression` | string |  | For kind="js": JavaScript expression evaluated in the page context. Re-evaluated on every DOM mutation plus a 250ms safety poll. Resolves on first truthy return. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `frameId` | number |  | Target frame ID for iframe support. |

## Scripting

### `chrome_userscript`

Unified userscript tool (create/list/get/enable/disable/update/remove/send_command/export). Paste JS/CSS/Tampermonkey script and the system will auto-select the best strategy (insertCSS / persistent script in ISOLATED or MAIN world / once by CDP) with CSP-aware fallbacks.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `create` \| `list` \| `get` \| `enable` \| `disable` \| `update` \| `remove` \| `send_command` \| `export` | ✓ | Operation to perform |
| `args` | object |  | Arguments for the specified action. - create: { script (required), name?, description?, matches?: string[], excludes?: string[], persist?: boolean (default true), runAt?: "document_start"\|"document_end"\|"document_idle"\|"auto", world?: "auto"\|"ISOLATED"\|"MAIN", allFrames?: boolean (default true), mode?: "auto"\|"css"\|"persistent"\|"once", dnrFallback?: boolean (default true), tags?: string[] } - list: { query?: string, status?: "enabled"\|"disabled", domain?: string } - get: { id (required) } - enable/disable: { id (required) } - update: { id (required), script?, name?, description?, matches?, excludes?, runAt?, world?, allFrames?, persist?, dnrFallback?, tags? } - remove: { id (required) } - send_command: { id (required), payload?: string, tabId?: number } - export: {} Tip: For a one-off execution that returns a value, use create with args.mode="once". The returned value is included as onceResult in the tool response. |

### `chrome_inject_script`

Inject a user-specified content script into a webpage. By default, injects into the currently active tab. Use chrome_userscript for persistent/CSP-aware injections; use this for one-off ISOLATED/MAIN-world script execution with a custom event bridge.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | If a URL is specified, inject the script into the webpage corresponding to the URL. If no matching tab exists, a new tab is created. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `windowId` | number |  | Target window ID to pick the active tab when tabId is omitted. |
| `background` | boolean |  | Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward. |
| `type` | `ISOLATED` \| `MAIN` | ✓ | The JavaScript world the script should execute in. Must be ISOLATED or MAIN. |
| `jsScript` | string | ✓ | The JavaScript source to inject. |

### `chrome_list_injected_scripts`

List the user scripts currently injected via chrome_inject_script across all tabs. Returns one entry per injected tab with `{ tabId, world, scriptLength, injectedAt }`. Use this for safe pre-flight checks before chrome_inject_script (idempotent inject-once patterns) and to confirm a tab still carries an active bridge before chrome_send_command_to_inject_script. Read-only — never modifies extension state.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | When provided, return only the entry for this tab id (or an empty array if no injection). Omit to list every injected tab. |

### `chrome_send_command_to_inject_script`

If the script injected via chrome_inject_script listens for user-defined events, this tool dispatches those events to the injected script.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `eventName` | string | ✓ | The event name your injected content script listens for. |
| `payload` | string |  | The payload passed to the event. Must be a JSON string. |

### `chrome_javascript`

Execute JavaScript code in a browser tab and return the result.

Engine: CDP Runtime.evaluate with awaitPromise + returnByValue. Falls back to chrome.scripting.executeScript (ISOLATED world) when the debugger is busy — note that fallback runs without page-context globals.

Wrapping: Code runs inside `(async () => { ... })()` so top-level `await` works. A bare expression (e.g. `1+2`, `document.title`) is auto-`return`ed; a multi-statement body must `return` explicitly.

Output: Result is sanitized (sensitive keys redacted unless raw mode is enabled) and capped at `maxOutputBytes` (default 51200). The response carries `{success, engine, result, truncated, redacted, metrics}` — branch on `truncated` to decide whether to retry with a larger `maxOutputBytes`.

Examples:
  • Read a value: `chrome_javascript({ code: "document.title" })`
  • Async fetch: `chrome_javascript({ code: "await (await fetch('/api/me')).json()" })`
  • Multi-line: `chrome_javascript({ code: "const xs = [...document.querySelectorAll('a')]; return xs.map(a => a.href).slice(0,5);" })`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | ✓ | JavaScript code to execute. Runs inside an async function body, so top-level await and "return ..." are supported. Bare trailing expressions are auto-returned. |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `timeoutMs` | number |  | Execution timeout in milliseconds (default: 15000). |
| `maxOutputBytes` | number |  | Maximum output size in bytes after sanitization (default: 51200). Output exceeding this limit is truncated and `truncated:true` is set in the response — pass a larger value to opt into a fuller read. |

## Network

### `chrome_network_request`

Send a network request from the browser with cookies and other browser context

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | ✓ | URL to send the request to |
| `method` | string |  | HTTP method to use (default: GET) |
| `headers` | object |  | Headers to include in the request |
| `body` | string |  | Body of the request (for POST, PUT, etc.) |
| `timeout` | number |  | Timeout in milliseconds (default: 30000) |
| `formData` | object |  | Multipart/form-data descriptor. If provided, overrides body and builds FormData with optional file attachments. Shape: { fields?: Record<string,string\|number\|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }. Also supports a compact array form: [ [name, fileSpec, filename?], ... ] where fileSpec may be url:, file:, or base64:. |

### `chrome_network_capture`

Unified network capture tool. Use action="start" to begin capturing, action="stop" to end and retrieve results, action="flush" to drain the buffer mid-session without stopping. Set needResponseBody=true to capture response bodies (uses Debugger API, may conflict with DevTools). Default mode uses webRequest API (lightweight, no debugger conflict, but no response body).

Response bodies are capped at 1 MiB; when a body exceeds the cap the request entry includes `responseBodyTruncation: {truncated, originalSize, limit, unit:"bytes"}` so callers can detect the partial read without parsing the inline `[Response truncated …]` sentinel.

`flush` returns the same envelope as `stop` (with `flushed:true` and `stillActive:true`) and clears the in-memory buffer while keeping listeners and timers attached — use it for long-running scrape sessions where you need to drain accumulated requests every few minutes to stay within context limits without losing the requests that arrive during a stop/restart gap.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `start` \| `stop` \| `flush` | ✓ | Action to perform: "start" begins capture, "stop" ends and returns results, "flush" returns the buffered results so far and clears them without ending the capture. |
| `needResponseBody` | boolean |  | When true, captures response body using Debugger API (default: false). Only use when you need to inspect response content. |
| `url` | string |  | URL to capture network requests from. For action="start". If not provided, uses the current active tab. |
| `maxCaptureTime` | number |  | Maximum capture time in milliseconds (default: 180000) |
| `inactivityTimeout` | number |  | Stop after inactivity in milliseconds (default: 60000). Set 0 to disable. |
| `includeStatic` | boolean |  | Include static resources like images/scripts/styles (default: false) |
| `background` | boolean |  | Do not activate tab/focus window when starting capture (default: true). Only honored by the debugger backend (needResponseBody:true); the webRequest backend never activates. Pass false to bring the tab forward. |

### `chrome_intercept_response`

Wait for the next network response on a tab whose URL matches the given pattern, then return the parsed JSON body (or raw body if non-JSON). Use this to grab API responses (e.g. LinkedIn Voyager, GraphQL endpoints) without DOM walking. Attaches the Chrome Debugger Network domain only for the duration of the wait. Returns within timeoutMs. When count > 1, accumulates that many matches before detaching and returns them as { ok, tabId, count, matched, responses: [...] } — useful for paginated SPA flows (e.g. inbox pages, message history loads) to cut N round-trips down to 1.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `urlPattern` | string | ✓ | Substring or regex (wrapped in / / for regex form, e.g. "/voyager/api/.*conversations/i") to match against the response URL. |
| `method` | string |  | Optional HTTP method filter (GET, POST, etc). When omitted, matches any method. |
| `timeoutMs` | number |  | Milliseconds to wait for a matching response before timing out (default 15000, max 120000). |
| `tabId` | number |  | Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs. |
| `returnBody` | boolean |  | When false (default true), skip getResponseBody and return only headers + status. Useful when you only need to detect that the call fired. |
| `count` | number |  | How many matching responses to accumulate before detaching (default 1, max 100). When 1 (default), the tool resolves on the first match and returns the single-response shape (ok, tabId, requestId, url, method, status, ...). When >1, it accumulates up to N matches (or until timeoutMs fires) and returns { ok, tabId, count, matched, responses: [{...}, ...] } — matched may be less than count on timeout. On timeout with zero matches, the same TIMEOUT envelope is returned regardless of count. |

## Files

### `chrome_handle_download`

Wait for a browser download and return details (id, filename, url, state, size)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `filenameContains` | string |  | Filter by substring in filename or URL |
| `timeoutMs` | number |  | Timeout in ms (default 60000, max 300000) |
| `waitForComplete` | boolean |  | Wait until completed (default true) |
| `tabId` | number |  | Optional source-tab filter. When provided, only downloads originating from this tab are matched. Programmatic downloads (anchor.click on detached element, fetch+blob) often lack a tabId and are matched regardless. |

### `chrome_upload_file`

Upload files to web forms with file input elements using Chrome DevTools Protocol

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

Record browser tab activity as an animated GIF.

Modes:
- Fixed FPS mode (action="start"): Captures frames at regular intervals. Good for animations/videos.
- Auto-capture mode (action="auto_start"): Captures frames automatically when chrome_computer or chrome_navigate actions succeed. Better for interaction recordings with natural pacing.

Use "stop" to end recording and save the GIF.

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

## State

### `chrome_history`

Retrieve and search browsing history from Chrome

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string |  | Text to search for in history URLs and titles. Leave empty to retrieve all history entries within the time range. |
| `startTime` | string |  | Start time as a date string. Supports ISO format (e.g., "2023-10-01", "2023-10-01T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: 24 hours ago |
| `endTime` | string |  | End time as a date string. Supports ISO format (e.g., "2023-10-31", "2023-10-31T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: current time |
| `maxResults` | number |  | Maximum number of history entries to return. Use this to limit results for performance or to focus on the most relevant entries. (default: 100) |
| `excludeCurrentTabs` | boolean |  | When set to true, filters out URLs that are currently open in any browser tab. Useful for finding pages you've visited but don't have open anymore. (default: false) |

### `chrome_history_delete`

Delete entries from Chrome browsing history. Wraps chrome.history.deleteUrl / deleteRange / deleteAll. Choose exactly one mode: pass `url` to remove a single URL's visit history; pass `startTime` AND `endTime` to delete every visit in a window; pass `all: true` to wipe history entirely. The deletion is permanent — `chrome.history.search` will not return removed entries afterwards. Useful for cleaning up after automated runs (e.g. removing test visits before asserting on history state) or honoring privacy intent. Set `confirmDeleteAll: true` together with `all: true` as an explicit safety check for the wipe-all mode.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | When provided, removes all visits to this exact URL (chrome.history.deleteUrl). Mutually exclusive with the time-range and `all` modes. |
| `startTime` | string |  | Start of the deletion window. Same date formats as chrome_history (ISO, "1 day ago", "yesterday", etc.). Required together with `endTime`. Mutually exclusive with `url` and `all`. |
| `endTime` | string |  | End of the deletion window. Same date formats as chrome_history. Required together with `startTime`. Mutually exclusive with `url` and `all`. |
| `all` | boolean |  | When true, deletes the entire browsing history (chrome.history.deleteAll). Must be combined with `confirmDeleteAll: true`. Mutually exclusive with `url` and the time-range mode. |
| `confirmDeleteAll` | boolean |  | Required safety acknowledgement when `all` is true. Has no effect for url or range mode. |

### `chrome_bookmark_search`

Search Chrome bookmarks by title and URL

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string |  | Search query to match against bookmark titles and URLs. Leave empty to retrieve all bookmarks. |
| `maxResults` | number |  | Maximum number of bookmarks to return (default: 50) |
| `folderPath` | string |  | Optional folder path or ID to limit search to a specific bookmark folder. Can be a path string (e.g., "Work/Projects") or a folder ID. |

### `chrome_bookmark_add`

Add a new bookmark to Chrome

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | URL to bookmark. If not provided, uses the current active tab URL. |
| `title` | string |  | Title for the bookmark. If not provided, uses the page title from the URL. |
| `parentId` | string |  | Parent folder path or ID to add the bookmark to. Can be a path string (e.g., "Work/Projects") or a folder ID. If not provided, adds to the "Bookmarks Bar" folder. |
| `createFolder` | boolean |  | Whether to create the parent folder if it does not exist (default: false) |

### `chrome_bookmark_update`

Update a Chrome bookmark: rename, change its URL, and/or move it to a different parent folder. Identify the bookmark by id (preferred) or by url.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `bookmarkId` | string |  | ID of the bookmark to update. Either bookmarkId or url must be provided. When url matches multiple bookmarks, all matches are updated; pass bookmarkId to disambiguate. |
| `url` | string |  | URL of the bookmark to update. Used to look up the bookmark when bookmarkId is omitted. |
| `matchTitle` | string |  | Optional title substring used to disambiguate when looking up by url. Case-sensitive substring match. |
| `newUrl` | string |  | New URL to set on the bookmark. |
| `newTitle` | string |  | New title to set on the bookmark. |
| `newParentId` | string |  | New parent folder path or ID to move the bookmark into (e.g., "Work/Projects" or a folder ID). The parent must exist. |

### `chrome_bookmark_delete`

Delete a bookmark from Chrome

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `bookmarkId` | string |  | ID of the bookmark to delete. Either bookmarkId or url must be provided. |
| `url` | string |  | URL of the bookmark to delete. Used if bookmarkId is not provided. |
| `title` | string |  | Title of the bookmark to help with matching when deleting by URL. |

### `chrome_get_cookies`

Read browser cookies for a URL or domain. Wraps chrome.cookies.getAll. At least one of `url` or `domain` is required to keep the response bounded. Returns an array of cookie objects with shape { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, session, expirationDate?, storeId }. Use this to inspect a site's session/auth state before driving a page (e.g. to confirm a LinkedIn `li_at` cookie exists, or to debug why a request 401'd).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string |  | Restrict to cookies that would be sent to this URL (matches scheme, host, and path). Either `url` or `domain` is required. |
| `domain` | string |  | Restrict to cookies whose domain matches (or is a subdomain of) this domain (e.g. "linkedin.com"). Either `url` or `domain` is required. |
| `name` | string |  | Optional: only return cookies with this exact name. |
| `path` | string |  | Optional: restrict to cookies with this path. |
| `secure` | boolean |  | Optional: when set, filter by the Secure flag. |
| `session` | boolean |  | Optional: when true, only session cookies; when false, only persistent cookies. |
| `storeId` | string |  | Optional: cookie store ID (e.g. for incognito). When omitted, the current execution context's store is used. |

### `chrome_set_cookie`

Set a single cookie. Wraps chrome.cookies.set. The `url` argument is required — Chrome uses it to derive default values for `domain` and `path` and to validate the Secure attribute. Other fields are optional pass-throughs. Returns the resulting Cookie object on success. Use this to seed an auth cookie before navigation (e.g. restore a saved `li_at` to skip the LinkedIn sign-in UI).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | ✓ | URL associated with the cookie (required). Determines default domain/path and is used to validate Secure cookies. |
| `name` | string |  | Name of the cookie. Empty string by default. |
| `value` | string |  | Value of the cookie. Empty string by default. |
| `domain` | string |  | Domain of the cookie. If omitted, the cookie becomes a host-only cookie for the URL. |
| `path` | string |  | Path of the cookie. Defaults to the path portion of `url`. |
| `secure` | boolean |  | Whether the cookie should be marked Secure. Default: false. |
| `httpOnly` | boolean |  | Whether the cookie should be marked HttpOnly. Default: false. |
| `sameSite` | `no_restriction` \| `lax` \| `strict` \| `unspecified` |  | SameSite attribute. Default: "unspecified". |
| `expirationDate` | number |  | Expiration date in seconds since the Unix epoch. If omitted, the cookie becomes a session cookie. |
| `storeId` | string |  | The ID of the cookie store. By default the cookie is set in the current execution context's store. |

### `chrome_remove_cookie`

Delete a single cookie by URL + name. Wraps chrome.cookies.remove. Returns { url, name, storeId } on success, or null if no matching cookie was found. Use this to clear an auth cookie (e.g. force a LinkedIn re-login) without driving a logout flow.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | ✓ | URL associated with the cookie to delete. Combined with `name` to identify a unique cookie. |
| `name` | string | ✓ | Name of the cookie to delete. |
| `storeId` | string |  | Optional: cookie store ID. When omitted, the current execution context's store is used. |

### `chrome_console`

Capture console output from a browser tab. Supports snapshot mode (default; one-time capture with ~2s wait) and buffer mode (persistent per-tab buffer you can read/clear instantly without waiting).

Response includes a `truncation` field of shape `{truncated, originalSize?, limit, rawAvailable, unit:'messages', argsTruncated}` so callers can detect whether the message cap or the per-arg serializer caps were hit. When `argsTruncated:true` and `rawAvailable:true`, retry with `raw:true` to skip per-arg caps (snapshot mode only).

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

## Performance

### `chrome_performance_start_trace`

Starts a performance trace recording on the selected page. Optionally reloads the page and/or auto-stops after a short duration.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `reload` | boolean |  | Determines if, once tracing has started, the page should be automatically reloaded (ignore cache). |
| `autoStop` | boolean |  | Determines if the trace should be automatically stopped (default false). |
| `durationMs` | number |  | Auto-stop duration in milliseconds when autoStop is true (default 5000). |

### `chrome_performance_stop_trace`

Stops the active performance trace recording on the selected page.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `saveToDownloads` | boolean |  | Whether to save the trace as a JSON file in Downloads (default true). |
| `filenamePrefix` | string |  | Optional filename prefix for the downloaded trace JSON. |

### `chrome_performance_analyze_insight`

Provides a lightweight summary of the last recorded trace. For deep insights (CWV, breakdowns), integrate native-side DevTools trace engine.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `insightName` | string |  | Optional insight name for future deep analysis (e.g., "DocumentLatency"). Currently informational only. |
| `timeoutMs` | number |  | Timeout for deep analysis via native host (milliseconds). Default 60000. Increase for large traces. |

## Diagnostics

### `chrome_debug_dump`

Return recent debug-log entries from the extension. Each entry includes a `requestId` correlating to the MCP tool call that produced it, plus tool name, optional tabId, level, message, and structured data. Use this to diagnose why a previous tool call failed without re-running it. Filters compose (AND).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `requestId` | string |  | Only return entries with this correlation id. |
| `tool` | string |  | Only return entries for this tool name (e.g. "chrome_navigate"). |
| `tabId` | number |  | Only return entries scoped to this tabId. |
| `level` | `debug` \| `info` \| `warn` \| `error` |  | Filter by severity. |
| `sinceMs` | number |  | Absolute epoch milliseconds — only return entries newer than this. |
| `limit` | number |  | Maximum entries to return. Defaults to 200, max 1000. |
| `clear` | boolean |  | When true, wipe the buffer instead of returning entries. |

## Pacing

### `chrome_pace`

Set a per-MCP-client pacing profile. Mutating tool dispatches (anything that clicks/types/navigates/uploads) sleep for a profile-derived gap before firing, so anti-bot platforms (LinkedIn, Instagram, WhatsApp) see human-like rhythm. Reads stay un-throttled. State is per-client and lives in the extension service worker; service-worker restart resets to off. Returns the active profile + computed gap parameters.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `profile` | `off` \| `human` \| `careful` \| `fast` | ✓ | Pacing preset. off=no throttle (default); human=600-1200ms gap with jitter; careful=1500-3000ms (LinkedIn-grade); fast=tab-lock-only serialization with no extra wait. |
| `minGapMs` | number |  | Optional override: inclusive lower bound on gap between mutating dispatches (ms). Stacks with the profile preset. |
| `jitterMs` | number |  | Optional override: random extra gap added in [0, jitterMs] (ms). Total gap = minGapMs + Math.random() * jitterMs. |

## Workflows

### `record_replay_list_published`

List recorded flows that have been published as dynamic MCP tools. Each entry includes id, slug, name, version, declared variables (used for `args`), and metadata. Discovery surface for `record_replay_flow_run` — pair with the dynamic `flow.<slug>` tools the bridge auto-exposes for callable flows.

No parameters.

### `record_replay_flow_run`

Run a recorded flow by ID. Recorded flows are step sequences captured via the extension UI (web-editor / record-replay-v3) and replayed deterministically by the runner. Returns a standardized run result with per-step outcomes. Prefer the dynamic `flow.<slug>` tool surface (each published flow gets one) when you know the slug — `record_replay_flow_run` is the explicit fallback when the slug is unknown.

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
