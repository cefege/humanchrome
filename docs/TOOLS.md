# HumanChrome API Reference 📚

Complete reference for all available tools and their parameters.

## 📋 Table of Contents

- [Browser Management](#browser-management)
- [Screenshots & Visual](#screenshots--visual)
- [Network Monitoring](#network-monitoring)
- [Content Analysis](#content-analysis)
- [Interaction](#interaction)
- [Scripting](#scripting)
- [Data Management](#data-management)
- [Response Format](#response-format)

## 📊 Browser Management

### Multi-tab fan-out workflow

Mirror the natural human pattern of opening a batch of tabs and processing
them one at a time. The tabs all load in the background while the agent
works through them sequentially:

```text
chrome_navigate_batch({ urls: [...] })  → returns tabIds for all tabs
for each tabId:
  chrome_wait_for_tab({ tabId })        → block until that tab is loaded
  chrome_get_web_content({ tabId })     → read in background
```

Per-tab locks (keyed on tabId) keep mutating ops on the same tab serialized
without forcing different tabs to wait on each other. The tools that touch
content (`chrome_get_web_content`, `chrome_screenshot`, `chrome_inject_script`,
`chrome_console`, `chrome_network_capture` debugger backend) all default
`background: true`, so the drain loop doesn't yank focus away from whatever
tab the user is actually looking at.

### `chrome_get_windows_and_tabs`

List all currently open browser windows and tabs.

**Parameters**: None

**Response**:

```json
{
  "windowCount": 2,
  "tabCount": 5,
  "windows": [
    {
      "windowId": 123,
      "tabs": [
        {
          "tabId": 456,
          "url": "https://example.com",
          "title": "Example Page",
          "active": true,
          "status": "complete"
        }
      ]
    }
  ]
}
```

`status` is `"loading"`, `"complete"`, or `"unloaded"`. Useful for peeking
at load state without a dedicated `chrome_wait_for_tab` call.

### `chrome_navigate`

Navigate to a URL with optional viewport control.

**Parameters**:

- `url` (string, optional): URL to navigate to (omit when `refresh=true`)
- `newWindow` (boolean, optional): Create new window (default: false)
- `tabId` (number, optional): Target an existing tab by ID (navigate/refresh that tab)
- `background` (boolean, optional): Do not activate the tab or focus the window (default: true). Pass false to bring the tab forward.
- `width` (number, optional): Viewport width in pixels (default: 1280)
- `height` (number, optional): Viewport height in pixels (default: 720)

**Example**:

```json
{
  "url": "https://example.com",
  "newWindow": true,
  "width": 1920,
  "height": 1080
}
```

### `chrome_navigate_batch`

Open many URLs at once and return their tabIds. Tabs open in the background
by default so the user's foreground tab keeps focus. Returns immediately
after issuing the opens — pair with `chrome_wait_for_tab` to drain.

**Parameters**:

- `urls` (string[], required): URLs to open. Each becomes a new tab.
- `windowId` (number, optional): Target window. Defaults to the last-focused window.
- `background` (boolean, optional): Open without stealing focus (default: true).
- `perTabDelayMs` (number, optional): Delay between consecutive opens, in ms. Default 0. Use 50–200 ms on sites that flag burst opens.

**Response**:

```json
{
  "tabs": [
    { "tabId": 101, "url": "https://example.com/a" },
    { "tabId": 102, "url": "https://example.com/b" }
  ],
  "windowId": 7,
  "count": 2
}
```

If individual opens fail, the response includes an `errors` array (`[{ url, message }]`).

### `chrome_wait_for_tab`

Block until the given tab transitions to `status: "complete"`. Event-driven
via `chrome.tabs.onUpdated` — does not poll.

**Parameters**:

- `tabId` (number, required): Tab to wait on. No implicit active-tab fallback. Pass the tabId returned by `chrome_navigate` or `chrome_navigate_batch`.
- `timeoutMs` (number, optional): Maximum wait in ms (default: 30000).

**Response**:

```json
{
  "tabId": 101,
  "status": "complete",
  "url": "https://example.com/a",
  "title": "Example A",
  "durationMs": 842
}
```

**Errors**:

- `TAB_NOT_FOUND` — no such tabId.
- `TAB_CLOSED` — the tab was closed during the wait.
- `TIMEOUT` — the deadline elapsed before the tab finished loading.

### `chrome_close_tab`

Close specific tabs or windows.

**Parameters**:

- `tabIds` (array, optional): Array of tab IDs to close
- `windowIds` (array, optional): Array of window IDs to close

**Example**:

```json
{
  "tabIds": [123, 456],
  "windowIds": [789]
}
```

### `chrome_switch_tab`

Switch to a specific browser tab.

**Parameters**:

- `tabId` (number, required): The ID of the tab to switch to.
- `windowId` (number, optional): The ID of the window where the tab is located.

**Example**:

```json
{
  "tabId": 456,
  "windowId": 123
}
```

> **History navigation**: Use `chrome_navigate` with `url: "back"` or `url: "forward"` (and optional `tabId`) to navigate the tab's history. There is no separate `chrome_go_back_or_forward` tool.

## 📸 Screenshots & Visual

### `chrome_screenshot`

Take advanced screenshots with various options.

**Parameters**:

- `name` (string, optional): Screenshot filename
- `selector` (string, optional): CSS selector for element screenshot
- `tabId` (number, optional): Target tab to capture (default: active tab)
- `background` (boolean, optional): Attempt capture without bringing tab/window to foreground (viewport-only uses CDP)
- `width` (number, optional): Width in pixels (default: 800)
- `height` (number, optional): Height in pixels (default: 600)
- `storeBase64` (boolean, optional): Return base64 data (default: false)
- `fullPage` (boolean, optional): Capture full page (default: true)

**Example**:

```json
{
  "selector": ".main-content",
  "fullPage": true,
  "storeBase64": true,
  "width": 1920,
  "height": 1080
}
```

**Response**:

```json
{
  "success": true,
  "base64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "dimensions": {
    "width": 1920,
    "height": 1080
  }
}
```

## 🌐 Network Monitoring

### `chrome_network_capture`

Unified network capture tool. Use `action: "start"` to begin capturing and `action: "stop"` to end and retrieve results. By default, uses the lightweight webRequest API (no debugger conflict, no response bodies). Set `needResponseBody: true` to switch to the Debugger API and capture response bodies (note: may conflict with an open DevTools session).

**Parameters**:

- `action` (string, required): `"start"` or `"stop"`
- `needResponseBody` (boolean, optional): Capture response bodies via Debugger API (default: false)
- `url` (string, optional): URL to navigate to and capture (for `action: "start"`)
- `maxCaptureTime` (number, optional): Maximum capture time in ms (default: 180000)
- `inactivityTimeout` (number, optional): Stop after inactivity in ms (default: 60000; set 0 to disable)
- `includeStatic` (boolean, optional): Include static resources like images/scripts/styles (default: false)

**Example**:

```json
{
  "action": "start",
  "url": "https://api.example.com",
  "maxCaptureTime": 60000,
  "needResponseBody": true
}
```

**Response (after `action: "stop"`)**:

```json
{
  "success": true,
  "capturedRequests": [
    {
      "url": "https://api.example.com/data",
      "method": "GET",
      "status": 200,
      "requestHeaders": {...},
      "responseHeaders": {...},
      "responseTime": 150
    }
  ],
  "summary": {
    "totalRequests": 15,
    "captureTime": 5000
  }
}
```

> Response bodies are capped at 1 MiB. If a body exceeds the cap, the request entry includes `responseBodyTruncation` so callers can detect partial reads.

### `chrome_network_request`

Send custom HTTP requests.

**Parameters**:

- `url` (string, required): Request URL
- `method` (string, optional): HTTP method (default: "GET")
- `headers` (object, optional): Request headers
- `body` (string, optional): Request body

**Example**:

```json
{
  "url": "https://api.example.com/data",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": "{\"key\": \"value\"}"
}
```

## 🔍 Content Analysis

### `chrome_read_page`

Build an accessibility-like tree of the current page (visible viewport by default) with stable `ref_*` identifiers and viewport info. Useful for semantic element discovery or agent planning.

Parameters:

- `filter` (string, optional): `interactive` to only include interactive elements; default includes structural and labeled nodes.
- `tabId` (number, optional): Target an existing tab by ID (default: active tab).

Example:

```json
{
  "filter": "interactive"
}
```

Response contains `pageContent` (text tree), `viewport`, and a `refMapCount` summary. Use `chrome_get_interactive_elements` or your own logic to act on returned refs.

### `chrome_search_tabs_content`

AI-powered semantic search across browser tabs.

**Parameters**:

- `query` (string, required): Search query

**Example**:

```json
{
  "query": "machine learning tutorials"
}
```

**Response**:

```json
{
  "success": true,
  "totalTabsSearched": 10,
  "matchedTabsCount": 3,
  "vectorSearchEnabled": true,
  "indexStats": {
    "totalDocuments": 150,
    "totalTabs": 10,
    "semanticEngineReady": true
  },
  "matchedTabs": [
    {
      "tabId": 123,
      "url": "https://example.com/ml-tutorial",
      "title": "Machine Learning Tutorial",
      "semanticScore": 0.85,
      "matchedSnippets": ["Introduction to machine learning..."],
      "chunkSource": "content"
    }
  ]
}
```

### `chrome_get_web_content`

Extract HTML or text content from web pages.

**Parameters**:

- `format` (string, optional): "html" or "text" (default: "text")
- `selector` (string, optional): CSS selector for specific elements
- `tabId` (number, optional): Specific tab ID (default: active tab)
- `background` (boolean, optional): Do not activate tab/focus window while fetching (default: false)

**Example**:

```json
{
  "format": "text",
  "selector": ".article-content"
}
```

### `chrome_get_interactive_elements` (deprecated)

Replaced by `chrome_read_page` as the primary discovery tool. The `read_page` implementation will automatically fallback to the interactive-elements logic when the accessibility tree is unavailable or too sparse. This tool is no longer listed via ListTools and is kept only for backward compatibility.

## 🎯 Interaction

### `chrome_computer`

Unified advanced interaction tool that prioritizes high-level DOM actions with CDP fallback. Supports hover, click, drag, scroll, typing, key chords, fill, wait and screenshot. If a recent screenshot was taken via `chrome_screenshot`, coordinates are auto-scaled from screenshot space to viewport space.

Parameters:

- `action` (string, required): `left_click` | `right_click` | `double_click` | `triple_click` | `left_click_drag` | `scroll` | `type` | `key` | `fill` | `hover` | `wait` | `screenshot`
- `tabId` (number, optional): Target an existing tab by ID (default: active tab)
- `background` (boolean, optional): Avoid focusing/activating tab/window for certain operations (best-effort)
- `ref` (string, optional): element ref from `chrome_read_page` (preferred). Used for click/scroll/type/key and as drag end when provided
- `coordinates` (object, optional): `{ "x": 100, "y": 200 }` for click/scroll or drag end
- `startRef` (string, optional): element ref for drag start
- `startCoordinates` (object, optional): for `left_click_drag` when no `startRef`
- `scrollDirection` (string, optional): `up` | `down` | `left` | `right`
- `scrollAmount` (number, optional): ticks 1–10 (default 3)
- `text` (string, optional): for `type` (raw text) or `key` (space-separated chords/keys like `"cmd+a Enter"`)
- `duration` (number, optional): seconds for `wait` (max 30)
- `selector` (string, optional): for `fill` when no `ref`
- `value` (string, optional): for `fill` value

Examples:

```json
{ "action": "left_click", "coordinates": { "x": 420, "y": 260 } }
```

```json
{ "action": "key", "text": "cmd+a Backspace" }
```

````json
{ "action": "fill", "ref": "ref_7", "value": "user@example.com" }

```json
{ "action": "hover", "ref": "ref_12", "duration": 0.6 }
````

````

```json
{ "action": "left_click_drag", "startRef": "ref_10", "ref": "ref_15" }
````

### `chrome_click_element`

Click elements using a ref, selector, or coordinates.

**Parameters**:

- `ref` (string, optional): Element ref from `chrome_read_page` (preferred when available)
- `selector` (string, optional): CSS selector for target element
- `coordinates` (object, optional): `{ "x": 120, "y": 240 }` viewport coordinates

At least one of `ref`, `selector`, or `coordinates` must be provided.

**Example**:

```json
{
  "ref": "ref_42"
}
```

### `chrome_fill_or_select`

Fill form fields or select options.

**Parameters**:

- `ref` (string, optional): Element ref from `chrome_read_page`
- `selector` (string, optional): CSS selector for target element
- `value` (string, required): Value to fill or select

Provide `ref` or `selector` to identify the element.

**Example**:

```json
{
  "ref": "ref_7",
  "value": "user@example.com"
}
```

### `chrome_keyboard`

Simulate keyboard input and shortcuts.

**Parameters**:

- `keys` (string, required): Key combination (e.g., "Ctrl+C", "Enter")
- `selector` (string, optional): Target element selector
- `delay` (number, optional): Delay between keystrokes in ms (default: 0)

**Example**:

```json
{
  "keys": "Ctrl+A",
  "selector": "#text-input",
  "delay": 100
}
```

## 🧩 Scripting

### `chrome_userscript`

Unified userscript tool: create, list, get, enable, disable, update, remove, send commands to, or export userscripts. Paste JS / CSS / Tampermonkey-style scripts and the system auto-selects the best injection strategy (`insertCSS`, persistent script in ISOLATED or MAIN world, or `once` evaluation via CDP) with CSP-aware fallbacks.

**Parameters**:

- `action` (string, required): One of `"create" | "list" | "get" | "enable" | "disable" | "update" | "remove" | "send_command" | "export"`
- `args` (object, optional): Action-specific arguments. Common shapes:
  - `create`: `{ script (required), name?, description?, matches?, excludes?, persist?, runAt?, world?, allFrames?, mode?: "auto"|"css"|"persistent"|"once", dnrFallback?, tags? }`
  - `list`: `{ query?, status?: "enabled"|"disabled", domain? }`
  - `get` / `enable` / `disable` / `remove`: `{ id (required) }`
  - `update`: `{ id (required), ...partial create fields }`
  - `send_command`: `{ id (required), payload?: string, tabId?: number }`
  - `export`: `{}`

> Tip: For one-off execution that returns a value, use `create` with `args.mode: "once"`. The return value is included as `onceResult` in the response.

**Example** (create + run a simple highlighter):

```json
{
  "action": "create",
  "args": {
    "name": "Highlight links",
    "matches": ["https://example.com/*"],
    "script": "document.querySelectorAll('a').forEach(a => a.style.outline='2px solid red');",
    "runAt": "document_idle"
  }
}
```

### `chrome_inject_script`

Inject a one-off content script into a webpage. Defaults to the active tab. Use this when you need ISOLATED- or MAIN-world execution with a custom event bridge for `chrome_send_command_to_inject_script`. For persistent / CSP-aware injections, prefer `chrome_userscript`.

**Parameters**:

- `type` (string, required): `"ISOLATED"` or `"MAIN"` — the JavaScript world to execute in
- `jsScript` (string, required): The JavaScript source to inject
- `url` (string, optional): If specified, inject into the tab matching this URL (creates a new tab if none matches)
- `tabId` (number, optional): Target an existing tab by ID; overrides `url`/active-tab selection
- `windowId` (number, optional): Window ID for picking the active tab or creating a new tab when `url` is provided
- `background` (boolean, optional): Do not activate the tab or focus the window during injection (default: false)

**Example**:

```json
{
  "type": "ISOLATED",
  "jsScript": "window.addEventListener('humanchrome:ping', e => console.log('pong', e.detail));"
}
```

### `chrome_send_command_to_inject_script`

Dispatch a custom event to a script previously injected with `chrome_inject_script`. The injected script must register a listener for the event name.

**Parameters**:

- `eventName` (string, required): The event name your injected script listens for
- `payload` (string, optional): Payload passed with the event. Must be a JSON string.
- `tabId` (number, optional): Target tab. Defaults to the currently active tab.

**Example**:

```json
{
  "eventName": "humanchrome:ping",
  "payload": "{\"value\":42}"
}
```

## 📚 Data Management

### `chrome_history`

Search browser history with filters.

**Parameters**:

- `text` (string, optional): Search text in URL/title
- `startTime` (string, optional): Start date (ISO format)
- `endTime` (string, optional): End date (ISO format)
- `maxResults` (number, optional): Maximum results (default: 100)
- `excludeCurrentTabs` (boolean, optional): Exclude current tabs (default: true)

**Example**:

```json
{
  "text": "github",
  "startTime": "2024-01-01",
  "maxResults": 50
}
```

### `chrome_bookmark_search`

Search bookmarks by keywords.

**Parameters**:

- `query` (string, optional): Search keywords
- `maxResults` (number, optional): Maximum results (default: 100)
- `folderPath` (string, optional): Search within specific folder

**Example**:

```json
{
  "query": "documentation",
  "maxResults": 20,
  "folderPath": "Work/Resources"
}
```

### `chrome_bookmark_add`

Add new bookmarks with folder support.

**Parameters**:

- `url` (string, optional): URL to bookmark (default: current tab)
- `title` (string, optional): Bookmark title (default: page title)
- `parentId` (string, optional): Parent folder ID or path
- `createFolder` (boolean, optional): Create folder if not exists (default: false)

**Example**:

```json
{
  "url": "https://example.com",
  "title": "Example Site",
  "parentId": "Work/Resources",
  "createFolder": true
}
```

### `chrome_bookmark_delete`

Delete bookmarks by ID or URL.

**Parameters**:

- `bookmarkId` (string, optional): Bookmark ID to delete
- `url` (string, optional): URL to find and delete

**Example**:

```json
{
  "url": "https://example.com"
}
```

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
const searchResults = await callTool('chrome_search_tabs_content', {
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
