/**
 * Single source of truth for the MCP tool catalog exposed by the bridge.
 *
 * Three append-only registries live here:
 *   - TOOL_NAMES     — frozen string identifiers; never rename (clients pin them).
 *   - TOOL_SCHEMAS   — the `Tool[]` advertised over MCP; one entry per name.
 *   - TOOL_CATEGORIES — name → category for docs grouping.
 *
 * Append-only is enforced by two coverage tests so a missing entry breaks CI
 * loudly instead of producing a silently undocumented tool:
 *   - app/chrome-extension/tests/lazy-tool-registry.test.ts
 *   - app/chrome-extension/tests/tool-categories-coverage.test.ts
 *
 * The shared fragments below (TAB_TARGETING, SELECTOR_PROP, ...) are spread
 * into individual schemas so cross-cutting wording lives in exactly one
 * place; per-tool overrides go inline after the spread.
 *
 * IMP-0021 plans to slice this file by category — keep additions in the
 * conventional category block until then.
 */
import { type Tool } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Shared schema fragments
//
// These are spread into individual tool inputSchemas so the canonical wording
// for cross-cutting concepts (tab targeting, generic timeouts, ref/selector)
// lives in exactly one place. Tools that need different semantics (e.g.
// chrome_wait_for_tab requiring tabId) override the field inline after the
// spread.
// ---------------------------------------------------------------------------

const TAB_ID_DESC =
  "Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs.";

const WINDOW_ID_DESC = 'Target window ID to pick the active tab when tabId is omitted.';

const BACKGROUND_DESC =
  'Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward.';

const TAB_ID_PROP = { type: 'number', description: TAB_ID_DESC } as const;
const WINDOW_ID_PROP = { type: 'number', description: WINDOW_ID_DESC } as const;
const BACKGROUND_PROP = {
  type: 'boolean',
  description: BACKGROUND_DESC,
  default: true,
} as const;

/** Standard tabId/windowId/background trio. Spread into properties. */
const TAB_TARGETING = {
  tabId: TAB_ID_PROP,
  windowId: WINDOW_ID_PROP,
  background: BACKGROUND_PROP,
};

/** tabId+windowId only (no background flag — for tools that don't focus). */
const TAB_TARGETING_NO_BG = {
  tabId: TAB_ID_PROP,
  windowId: WINDOW_ID_PROP,
};

const REF_PROP = {
  type: 'string',
  description: 'Element ref from chrome_read_page (takes precedence over selector).',
} as const;

const SELECTOR_PROP = {
  type: 'string',
  description: 'CSS selector or XPath for the element.',
} as const;

const SELECTOR_TYPE_PROP = {
  type: 'string',
  enum: ['css', 'xpath'],
  description: 'Type of selector (default: "css").',
} as const;

const FRAME_ID_PROP = {
  type: 'number',
  description: 'Target frame ID for iframe support.',
} as const;

export const TOOL_NAMES = {
  BROWSER: {
    GET_WINDOWS_AND_TABS: 'chrome_get_windows_and_tabs',
    SEARCH_TABS_CONTENT: 'chrome_search_tabs_content',
    NAVIGATE: 'chrome_navigate',
    NAVIGATE_BATCH: 'chrome_navigate_batch',
    WAIT_FOR_TAB: 'chrome_wait_for_tab',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TAB: 'chrome_close_tab',
    CLOSE_TABS_MATCHING: 'chrome_close_tabs_matching',
    SWITCH_TAB: 'chrome_switch_tab',
    TAB_GROUPS: 'chrome_tab_groups',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    REQUEST_ELEMENT_SELECTION: 'chrome_request_element_selection',
    GET_INTERACTIVE_ELEMENTS: 'chrome_get_interactive_elements',
    NETWORK_CAPTURE: 'chrome_network_capture',
    // Legacy tool names (kept for internal use, not exposed in TOOL_SCHEMAS)
    NETWORK_CAPTURE_START: 'chrome_network_capture_start',
    NETWORK_CAPTURE_STOP: 'chrome_network_capture_stop',
    NETWORK_REQUEST: 'chrome_network_request',
    NETWORK_DEBUGGER_START: 'chrome_network_debugger_start',
    NETWORK_DEBUGGER_STOP: 'chrome_network_debugger_stop',
    INTERCEPT_RESPONSE: 'chrome_intercept_response',
    KEYBOARD: 'chrome_keyboard',
    AWAIT_ELEMENT: 'chrome_await_element',
    HISTORY: 'chrome_history',
    HISTORY_DELETE: 'chrome_history_delete',
    BOOKMARK_SEARCH: 'chrome_bookmark_search',
    BOOKMARK_ADD: 'chrome_bookmark_add',
    BOOKMARK_UPDATE: 'chrome_bookmark_update',
    BOOKMARK_DELETE: 'chrome_bookmark_delete',
    GET_COOKIES: 'chrome_get_cookies',
    SET_COOKIE: 'chrome_set_cookie',
    REMOVE_COOKIE: 'chrome_remove_cookie',
    INJECT_SCRIPT: 'chrome_inject_script',
    LIST_INJECTED_SCRIPTS: 'chrome_list_injected_scripts',
    SEND_COMMAND_TO_INJECT_SCRIPT: 'chrome_send_command_to_inject_script',
    JAVASCRIPT: 'chrome_javascript',
    CONSOLE: 'chrome_console',
    CONSOLE_CLEAR: 'chrome_console_clear',
    FILE_UPLOAD: 'chrome_upload_file',
    READ_PAGE: 'chrome_read_page',
    STORAGE: 'chrome_storage',
    LIST_FRAMES: 'chrome_list_frames',
    COMPUTER: 'chrome_computer',
    HANDLE_DIALOG: 'chrome_handle_dialog',
    HANDLE_DOWNLOAD: 'chrome_handle_download',
    USERSCRIPT: 'chrome_userscript',
    PERFORMANCE_START_TRACE: 'chrome_performance_start_trace',
    PERFORMANCE_STOP_TRACE: 'chrome_performance_stop_trace',
    PERFORMANCE_ANALYZE_INSIGHT: 'chrome_performance_analyze_insight',
    GIF_RECORDER: 'chrome_gif_recorder',
    DEBUG_DUMP: 'chrome_debug_dump',
    ASSERT: 'chrome_assert',
    WAIT_FOR: 'chrome_wait_for',
    PACE: 'chrome_pace',
    NOTIFICATIONS: 'chrome_notifications',
    CLIPBOARD: 'chrome_clipboard',
    SESSIONS: 'chrome_sessions',
    TAB_LIFECYCLE: 'chrome_tab_lifecycle',
    NETWORK_EMULATE: 'chrome_network_emulate',
    PRINT_TO_PDF: 'chrome_print_to_pdf',
    BLOCK_OR_REDIRECT: 'chrome_block_or_redirect',
    ACTION_BADGE: 'chrome_action_badge',
    KEEP_AWAKE: 'chrome_keep_awake',
    CONTEXT_MENU: 'chrome_context_menu',
    FOCUS: 'chrome_focus',
    PASTE: 'chrome_paste',
    SELECT_TEXT: 'chrome_select_text',
    WINDOW_MANAGE: 'chrome_window',
    WEB_VITALS: 'chrome_web_vitals',
    IDLE: 'chrome_idle',
    ALARMS: 'chrome_alarms',
    CLEAR_BROWSING_DATA: 'chrome_clear_browsing_data',
    PROXY: 'chrome_proxy',
    IDENTITY: 'chrome_identity',
    DRAG_DROP: 'chrome_drag_drop',
    DOWNLOAD_LIST: 'chrome_download_list',
    DOWNLOAD_CANCEL: 'chrome_download_cancel',
    REMOVE_INJECTED_SCRIPT: 'chrome_remove_injected_script',
    PACE_GET: 'chrome_pace_get',
  },
  RECORD_REPLAY: {
    FLOW_RUN: 'record_replay_flow_run',
    LIST_PUBLISHED: 'record_replay_list_published',
    FLOW_DELETE: 'record_replay_flow_delete',
  },
};

export const TOOL_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
    description: 'Get all currently open browser windows and tabs',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED,
    description:
      'List recorded flows that have been published as dynamic MCP tools. Each entry includes id, slug, name, version, declared variables (used for `args`), and metadata. Discovery surface for `record_replay_flow_run` — pair with the dynamic `flow.<slug>` tools the bridge auto-exposes for callable flows.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
    description:
      'Run a recorded flow by ID. Recorded flows are step sequences captured via the extension UI (web-editor / record-replay-v3) and replayed deterministically by the runner. Returns a standardized run result with per-step outcomes. Prefer the dynamic `flow.<slug>` tool surface (each published flow gets one) when you know the slug — `record_replay_flow_run` is the explicit fallback when the slug is unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'ID of the flow to run.' },
        args: {
          type: 'object',
          description:
            'Variable values for the flow (flat object of key/value). Variables are declared per-flow at recording time; see record_replay_list_published for the schema of each flow.',
        },
        tabTarget: {
          type: 'string',
          enum: ['current', 'new'],
          description: 'Where to run the flow: in the current tab (default) or a new tab.',
        },
        refresh: {
          type: 'boolean',
          description: 'Refresh the target tab before running (default false).',
        },
        captureNetwork: {
          type: 'boolean',
          description:
            'Capture network snippets during the run for debugging (default false). Adds latency.',
        },
        returnLogs: {
          type: 'boolean',
          description: 'Include per-step log entries in the run result (default false).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Global timeout in milliseconds for the entire flow run.',
        },
        startUrl: {
          type: 'string',
          description: 'Optional URL to open before the flow runs.',
        },
      },
      required: ['flowId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE,
    description:
      'Starts a performance trace recording on the selected page. Optionally reloads the page and/or auto-stops after a short duration.',
    inputSchema: {
      type: 'object',
      properties: {
        reload: {
          type: 'boolean',
          description:
            'Determines if, once tracing has started, the page should be automatically reloaded (ignore cache).',
        },
        autoStop: {
          type: 'boolean',
          description: 'Determines if the trace should be automatically stopped (default false).',
        },
        durationMs: {
          type: 'number',
          description: 'Auto-stop duration in milliseconds when autoStop is true (default 5000).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE,
    description: 'Stops the active performance trace recording on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        saveToDownloads: {
          type: 'boolean',
          description: 'Whether to save the trace as a JSON file in Downloads (default true).',
        },
        filenamePrefix: {
          type: 'string',
          description: 'Optional filename prefix for the downloaded trace JSON.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT,
    description:
      'Provides a lightweight summary of the last recorded trace. For deep insights (CWV, breakdowns), integrate native-side DevTools trace engine.',
    inputSchema: {
      type: 'object',
      properties: {
        insightName: {
          type: 'string',
          description:
            'Optional insight name for future deep analysis (e.g., "DocumentLatency"). Currently informational only.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Timeout for deep analysis via native host (milliseconds). Default 60000. Increase for large traces.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.READ_PAGE,
    description:
      'Get an accessibility tree representation of visible elements on the page. Only returns elements that are visible in the viewport. Optionally filter for only interactive elements.\nTip: If the returned elements do not include the specific element you need, use the computer tool\'s screenshot (action="screenshot") to capture the element\'s on-screen coordinates, then operate by coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Filter elements: "interactive" for such as  buttons/links/inputs only (default: all visible elements)',
        },
        depth: {
          type: 'number',
          description:
            'Maximum DOM depth to traverse (integer >= 0). Lower values reduce output size and can improve performance.',
        },
        refId: {
          type: 'string',
          description:
            'Focus on the subtree rooted at this element refId (e.g., "ref_12"). The refId must come from a recent chrome_read_page response in the same tab (refs may expire).',
        },
        ...TAB_TARGETING_NO_BG,
        raw: {
          type: 'boolean',
          description:
            'When the accessibility tree is too sparse and we fall back to the interactive-element scanner, results are capped at 150 elements by default and the response includes a `truncation` envelope indicating whether more were available. Set raw=true to skip the cap and return everything (response will be larger).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.STORAGE,
    description:
      'Read, write, and clear a tab\'s `localStorage` or `sessionStorage`. Wraps a MAIN-world `chrome.scripting.executeScript` shim so prompts don\'t need to embed JS payloads. Actions: `get` (returns `{value, exists}` — `value` is null when the key is absent), `set` (returns `{stored: true}`), `remove` (returns `{removed: boolean}` — false if the key did not exist), `clear` (returns `{cleared: count}` — number of keys wiped), `keys` (returns `{keys: string[]}`). `scope` defaults to `"local"`. Useful for clearing auth state between test runs, pre-seeding feature flags, or asserting that an SPA wrote a specific session marker — without opening DevTools or quoting JS into chrome_javascript. IndexedDB is intentionally out of scope; cookies are handled by chrome_get_cookies / chrome_set_cookie / chrome_remove_cookie.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'remove', 'clear', 'keys'],
          description: 'Operation to perform on the storage area.',
        },
        scope: {
          type: 'string',
          enum: ['local', 'session'],
          description:
            'Which web-app storage area to operate on: `local` (window.localStorage, persists across sessions) or `session` (window.sessionStorage, cleared when the tab closes). Default: `local`.',
        },
        key: {
          type: 'string',
          description: 'Storage key. Required for `get`, `set`, and `remove`.',
        },
        value: {
          type: 'string',
          description:
            'Value to store. Required for `set`. Strings only — wrap structured data in JSON.stringify before passing.',
        },
        ...TAB_TARGETING_NO_BG,
        frameId: {
          type: 'number',
          description:
            'Optional frame to scope the operation to. Defaults to the main frame. localStorage and sessionStorage are origin-keyed, so different iframes on different origins keep separate stores.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.LIST_FRAMES,
    description:
      'List the frames in a tab via chrome.webNavigation.getAllFrames. Returns one entry per frame as `{ frameId, parentFrameId, url, errorOccurred }` (the main document is included with `frameId: 0` and `parentFrameId: -1`). Use this to discover stable frameId values to pass to chrome_click_element / chrome_fill_or_select / chrome_await_element when targeting an iframe — walking `window.frames` from injected JS is cross-origin-blocked for sandboxed iframes and returns unstable indexes. Read-only; no DOM access.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TAB_TARGETING_NO_BG,
        urlContains: {
          type: 'string',
          description:
            'Optional case-insensitive substring filter applied to each frame URL after the round-trip (handy for picking out a third-party iframe by domain without iterating all of them yourself).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TAB_GROUPS,
    description:
      "Manage Chrome tab groups (the colored, named clusters in the tab strip). Single tool with an `action` enum that wraps `chrome.tabs.group` / `chrome.tabs.ungroup` / `chrome.tabGroups.*`. Useful for partitioning agent-managed tabs from the user's own tabs (create a labelled group at session start, add new tabs as the agent opens them, ungroup or close-all when the session ends). Actions: `create` (group one or more tabIds — returns `{groupId}`; pair with `update` to set title/color), `update` (rename, recolor, or collapse an existing group; pass any of `title`, `color`, `collapsed`), `query` (filter groups by `title`, `color`, `collapsed`, `windowId` — returns matching groups), `get` (one group plus the list of tabIds currently in it), `add_tabs` (move tabIds into an existing groupId), `remove_tabs` (ungroup tabIds — they keep existing in their window, just leave the group), `move` (reorder a group within its window by `index`). Colors: grey | blue | red | yellow | green | pink | purple | cyan | orange (Chrome's fixed palette).",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'query', 'get', 'add_tabs', 'remove_tabs', 'move'],
          description: 'Operation to perform.',
        },
        groupId: {
          type: 'number',
          description:
            'Existing group ID. Required for `update`, `get`, `add_tabs`, `move`. Optional for `create` (when set, the new tabs are added to this group instead of creating a new one — same shape as `add_tabs`).',
        },
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description:
            "Tab IDs to operate on. Required for `create`, `add_tabs`, `remove_tabs`. The first tab's window decides the group's window for `create` (Chrome rejects mixing windows).",
        },
        title: {
          type: 'string',
          description:
            'Group label shown in the tab strip. Optional for `create` (set via `update` after) and `update`. For `query`, exact-match filter.',
        },
        color: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
          description:
            'Group color. Optional for `update` and as a `query` filter. Chrome auto-assigns one if omitted at create time.',
        },
        collapsed: {
          type: 'boolean',
          description:
            'Collapse / expand the group in the tab strip. Optional for `update` and as a `query` filter.',
        },
        windowId: {
          type: 'number',
          description:
            'Window scope for `query` (only return groups in this window) and `create` (when no tabIds are supplied — rare, prefer `tabIds`).',
        },
        index: {
          type: 'number',
          description:
            'Target index for `move`. -1 places the group at the end. Group moves within its current window only; cross-window moves require a separate flow.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.COMPUTER,
    description:
      "Use a mouse and keyboard to interact with a web browser, and take screenshots.\n* Whenever you intend to click on an element like an icon, you should consult a read_page to determine the ref of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try screenshot and then adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
    inputSchema: {
      type: 'object',
      properties: {
        ...TAB_TARGETING,
        action: {
          type: 'string',
          description:
            'Action to perform: left_click | right_click | double_click | triple_click | left_click_drag | scroll | scroll_to | type | key | fill | fill_form | hover | wait | resize_page | zoom | screenshot',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page. For click/scroll/scroll_to/key/type and drag end when provided; takes precedence over coordinates.',
        },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
          },
          description:
            'Coordinates for actions (in screenshot space if a recent screenshot was taken, otherwise viewport). Required for click/scroll and as end point for drag.',
        },
        startCoordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description: 'Starting coordinates for drag action',
        },
        startRef: {
          type: 'string',
          description: 'Drag start ref from chrome_read_page (alternative to startCoordinates).',
        },
        scrollDirection: {
          type: 'string',
          description: 'Scroll direction: up | down | left | right',
        },
        scrollAmount: {
          type: 'number',
          description: 'Scroll ticks (1-10), default 3',
        },
        text: {
          type: 'string',
          description:
            'Text to type (for action=type) or keys/chords separated by space (for action=key, e.g. "Backspace Enter" or "cmd+a")',
        },
        repeat: {
          type: 'number',
          description:
            'For action=key: number of times to repeat the key sequence (integer 1-100, default 1).',
        },
        modifiers: {
          type: 'object',
          description:
            'Modifier keys for click actions (left_click/right_click/double_click/triple_click).',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        region: {
          type: 'object',
          description:
            'For action=zoom: rectangular region to capture (x0,y0)-(x1,y1) in viewport pixels (or screenshot-space if a recent screenshot context exists).',
          properties: {
            x0: { type: 'number' },
            y0: { type: 'number' },
            x1: { type: 'number' },
            y1: { type: 'number' },
          },
          required: ['x0', 'y0', 'x1', 'y1'],
        },
        // For action=fill
        selector: {
          type: 'string',
          description: 'CSS selector for fill (alternative to ref).',
        },
        value: {
          oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
          description: 'Value to set for action=fill (string | boolean | number)',
        },
        elements: {
          type: 'array',
          description: 'For action=fill_form: list of elements to fill (ref + value)',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Element ref from chrome_read_page' },
              value: { type: 'string', description: 'Value to set (stringified if non-string)' },
            },
            required: ['ref', 'value'],
          },
        },
        width: { type: 'number', description: 'For action=resize_page: viewport width' },
        height: { type: 'number', description: 'For action=resize_page: viewport height' },
        appear: {
          type: 'boolean',
          description:
            'For action=wait with text: whether to wait for the text to appear (true, default) or disappear (false)',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Per-call timeout in ms, clamped to [1000, 120000]. For most actions this caps the underlying CDP command (default 10000) — raise it if a click/scroll/screenshot/etc. on a slow page errors with "did not return within ...". For action=wait with text it caps the wait deadline (default 10000).',
        },
        duration: {
          type: 'number',
          description: 'Seconds to wait for action=wait (max 30s)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.USERSCRIPT,
    description:
      'Unified userscript tool (create/list/get/enable/disable/update/remove/send_command/export). Paste JS/CSS/Tampermonkey script and the system will auto-select the best strategy (insertCSS / persistent script in ISOLATED or MAIN world / once by CDP) with CSP-aware fallbacks.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Operation to perform',
          enum: [
            'create',
            'list',
            'get',
            'enable',
            'disable',
            'update',
            'remove',
            'send_command',
            'export',
          ],
        },
        args: {
          type: 'object',
          description:
            'Arguments for the specified action.\n- create: { script (required), name?, description?, matches?: string[], excludes?: string[], persist?: boolean (default true), runAt?: "document_start"|"document_end"|"document_idle"|"auto", world?: "auto"|"ISOLATED"|"MAIN", allFrames?: boolean (default true), mode?: "auto"|"css"|"persistent"|"once", dnrFallback?: boolean (default true), tags?: string[] }\n- list: { query?: string, status?: "enabled"|"disabled", domain?: string }\n- get: { id (required) }\n- enable/disable: { id (required) }\n- update: { id (required), script?, name?, description?, matches?, excludes?, runAt?, world?, allFrames?, persist?, dnrFallback?, tags? }\n- remove: { id (required) }\n- send_command: { id (required), payload?: string, tabId?: number }\n- export: {}\nTip: For a one-off execution that returns a value, use create with args.mode="once". The returned value is included as onceResult in the tool response.',
          properties: {
            // Common identifiers
            id: {
              type: 'string',
              description: 'Userscript id (for get/enable/disable/update/remove/send_command)',
            },
            // Create / Update fields
            script: {
              type: 'string',
              description: 'JS/CSS/Tampermonkey script source (required for create)',
            },
            name: { type: 'string', description: 'Userscript name (optional)' },
            description: { type: 'string', description: 'Userscript description (optional)' },
            matches: {
              type: 'array',
              items: { type: 'string' },
              description: 'Match patterns for pages to apply to (e.g., https://*.example.com/*)',
            },
            excludes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Exclude patterns',
            },
            persist: {
              type: 'boolean',
              description: 'Persist userscript for matched pages (default true)',
            },
            runAt: {
              type: 'string',
              description: 'Injection timing',
              enum: ['document_start', 'document_end', 'document_idle', 'auto'],
            },
            world: {
              type: 'string',
              description: 'Execution world',
              enum: ['auto', 'ISOLATED', 'MAIN'],
            },
            allFrames: { type: 'boolean', description: 'Inject into all frames (default true)' },
            mode: {
              type: 'string',
              description:
                'Injection strategy: auto | css | persistent | once. Use once to evaluate immediately (no persistence) and include the return value in onceResult.',
              enum: ['auto', 'css', 'persistent', 'once'],
            },
            dnrFallback: {
              type: 'boolean',
              description: 'Use DNR fallback when needed (default true)',
            },
            tags: { type: 'array', items: { type: 'string' }, description: 'Custom tags' },
            // List filters
            query: { type: 'string', description: 'Search by name/description (list action)' },
            status: {
              type: 'string',
              enum: ['enabled', 'disabled'],
              description: 'Filter by status (list action)',
            },
            domain: { type: 'string', description: 'Filter by domain (list action)' },
            // Send command
            payload: {
              type: 'string',
              description: 'Arbitrary payload (stringified) for send_command',
            },
            tabId: {
              type: 'number',
              description: 'Target tab for send_command (default active tab)',
            },
          },
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NAVIGATE,
    description:
      'Navigate to a URL, refresh the current tab, or navigate browser history (back/forward)',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to. Special values: "back" or "forward" to navigate browser history in the target tab.',
        },
        newWindow: {
          type: 'boolean',
          description: 'Create a new window to navigate to the URL or not. Defaults to false',
        },
        ...TAB_TARGETING,
        width: {
          type: 'number',
          description:
            'Window width in pixels (default: 1280). When width or height is provided, a new window will be created.',
        },
        height: {
          type: 'number',
          description:
            'Window height in pixels (default: 720). When width or height is provided, a new window will be created.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NAVIGATE_BATCH,
    description:
      "Open many URLs at once and return their tabIds. Tabs open in the background by default so the user's foreground tab keeps focus. Pair with chrome_wait_for_tab + chrome_get_web_content to drain results sequentially. Returns immediately after issuing the opens unless maxConcurrent is set — in which case it blocks until each batch finishes loading before opening the next.",
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'URLs to open. Each becomes a new tab.',
        },
        windowId: {
          type: 'number',
          description:
            'Target window for the new tabs. If omitted, uses the last-focused window (or creates one).',
        },
        background: {
          type: 'boolean',
          description:
            'Open without stealing focus (default true). Set false to foreground each new tab as it opens.',
        },
        perTabDelayMs: {
          type: 'number',
          description:
            'Delay between consecutive opens, in milliseconds. Default 0. Use a small value (50-200ms) on sites that flag burst opens. When maxConcurrent is also set, this delay applies WITHIN each worker (between consecutive opens by the same worker).',
        },
        maxConcurrent: {
          type: 'number',
          description:
            'Cap the number of in-flight tab loads. When omitted (or <= 0), all URLs open in parallel (current behavior). When set to N, opens N tabs and waits for each to finish loading before starting the next — useful on anti-bot platforms (LinkedIn, Instagram) that flag concurrent opens. Each waited tab uses a 30s load timeout; on timeout the tab is still recorded and the worker continues.',
        },
        perUrlTimeoutMs: {
          type: 'number',
          description:
            'Per-URL load timeout in ms when maxConcurrent is set. Default 30000. Ignored when maxConcurrent is not set.',
        },
      },
      required: ['urls'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WAIT_FOR_TAB,
    description:
      'Block until the given tab transitions to status:"complete". Event-driven via chrome.tabs.onUpdated — does not poll. Use after chrome_navigate or chrome_navigate_batch to drain a fan-out workflow before reading from each tab. Throws TAB_CLOSED if the tab is closed during the wait, TIMEOUT if the deadline elapses.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Tab to wait on. Required (no implicit active-tab fallback). Pass the tabId returned by chrome_navigate or chrome_navigate_batch.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum wait in milliseconds (default 30000).',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCREENSHOT,
    description:
      '[Prefer read_page over taking a screenshot and Prefer chrome_computer] Take a screenshot of the current page or a specific element. For new usage, use chrome_computer with action="screenshot". Use this tool if you need advanced options.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the screenshot, if saving as PNG' },
        selector: { type: 'string', description: 'CSS selector for element to screenshot' },
        ...TAB_TARGETING_NO_BG,
        background: {
          type: 'boolean',
          description:
            'Attempt capture without bringing tab/window to foreground. CDP-based capture is used for simple viewport captures. For element/full-page capture, the tab may still be made active in its window without focusing the window. Default: true. Pass false to foreground.',
          default: true,
        },
        width: { type: 'number', description: 'Width in pixels (default: 800)' },
        height: { type: 'number', description: 'Height in pixels (default: 600)' },
        storeBase64: {
          type: 'boolean',
          description:
            'return screenshot in base64 format (default: false) if you want to see the page, recommend set this to be true',
        },
        fullPage: {
          type: 'boolean',
          description: 'Store screenshot of the entire page (default: true)',
        },
        savePng: {
          type: 'boolean',
          description:
            'Save screenshot as PNG file (default: true)，if you want to see the page, recommend set this to be false, and set storeBase64 to be true',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLOSE_TAB,
    description: 'Close one or more browser tabs',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of tab IDs to close. If not provided, will close the active tab.',
        },
        url: {
          type: 'string',
          description: 'Close tabs matching this URL. Can be used instead of tabIds.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLOSE_TABS_MATCHING,
    description:
      'Bulk close tabs matching one or more filters. Designed for post-`chrome_navigate_batch` cleanup so an agent does not have to round-trip through `chrome_get_windows_and_tabs` plus N × `chrome_close_tab`. At least one of `urlMatches`, `titleMatches`, or `olderThanMs` must be provided — calling without filters is rejected to prevent accidental "close everything" calls. URL/title matching accepts a plain substring (case-insensitive) or `/regex/flags` form. `windowId` scopes the search to one window (defaults to all windows). `exceptTabIds` always preserves the listed tabs. The last-tab-in-window guard from IMP-0062 (`safeRemoveTabs`) is honored — closing all tabs in a window opens a placeholder so the window does not disappear. Returns `{ closed, tabIds, scanned, matched }`.',
    inputSchema: {
      type: 'object',
      properties: {
        urlMatches: {
          type: 'string',
          description:
            'URL filter. Plain text → case-insensitive substring match against `tab.url`. Wrap in `/.../flags` (e.g. `/voyager\\/api/i`) for regex match. Combined with other filters via AND.',
        },
        titleMatches: {
          type: 'string',
          description:
            'Title filter. Same matching rules as `urlMatches` but applied against `tab.title`. Combined with other filters via AND.',
        },
        olderThanMs: {
          type: 'number',
          description:
            "Close tabs whose creation time was more than N milliseconds ago. The check uses Chrome's wall-clock view of when the tab was created (via the existing tab-tracking record). Tabs with unknown creation time are NOT matched by this filter alone.",
        },
        exceptTabIds: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Tab IDs to always preserve, even if they would otherwise match the filters.',
        },
        windowId: {
          type: 'number',
          description:
            'Optional window scope. When provided, only tabs in this window are considered. Default: every window the extension can see.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'When true, returns the matched tab IDs without actually closing them. Useful as a pre-flight check before destructive bulk close.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SWITCH_TAB,
    description: 'Switch to a specific browser tab',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to switch to.',
        },
        windowId: {
          type: 'number',
          description: 'The ID of the window where the tab is located.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WEB_FETCHER,
    description: 'Fetch content from a web page',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch content from. If not provided, uses the current active tab',
        },
        ...TAB_TARGETING,
        htmlContent: {
          type: 'boolean',
          description:
            'Get the visible HTML content of the page. If true, textContent will be ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description:
            'Get the visible text content of the page with metadata. Ignored if htmlContent is true (default: true)',
        },

        selector: {
          type: 'string',
          description:
            'CSS selector to get content from a specific element. If provided, only content from this element will be returned',
        },
        savePath: {
          type: 'string',
          description:
            'Absolute file path to save the content to. When provided, content is written to disk via the native bridge instead of being returned in the response. Returns {saved: true, filePath, size} on success.',
        },
        raw: {
          type: 'boolean',
          description:
            'When false, sanitize HTML by removing scripts, styles, and SVGs. Default: true (raw — preserves everything so the page opens and renders like the original).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    description: 'Send a network request from the browser with cookies and other browser context',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to send the request to',
        },
        method: {
          type: 'string',
          description: 'HTTP method to use (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Headers to include in the request',
        },
        body: {
          type: 'string',
          description: 'Body of the request (for POST, PUT, etc.)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        formData: {
          type: 'object',
          description:
            'Multipart/form-data descriptor. If provided, overrides body and builds FormData with optional file attachments. Shape: { fields?: Record<string,string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }. Also supports a compact array form: [ [name, fileSpec, filename?], ... ] where fileSpec may be url:, file:, or base64:.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE,
    description:
      'Unified network capture tool. Use action="start" to begin capturing, action="stop" to end and retrieve results, action="flush" to drain the buffer mid-session without stopping, action="status" for a side-effect-free read of the current capture state (active backend, buffered request count, capture age). Set needResponseBody=true to capture response bodies (uses Debugger API, may conflict with DevTools). Default mode uses webRequest API (lightweight, no debugger conflict, but no response body).\n\nResponse bodies are capped at 1 MiB; when a body exceeds the cap the request entry includes `responseBodyTruncation: {truncated, originalSize, limit, unit:"bytes"}` so callers can detect the partial read without parsing the inline `[Response truncated …]` sentinel.\n\n`flush` returns the same envelope as `stop` (with `flushed:true` and `stillActive:true`) and clears the in-memory buffer while keeping listeners and timers attached — use it for long-running scrape sessions where you need to drain accumulated requests every few minutes to stay within context limits without losing the requests that arrive during a stop/restart gap.\n\n`status` returns `{active, backend: "debugger" | "webRequest" | null, sinceMs, bufferedCount, tabIds}` — use it to check whether a capture is already running before calling `start` (which fails if one is active) or to gate a `flush` on the buffer being non-empty.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'flush', 'status'],
          description:
            'Action to perform: "start" begins capture, "stop" ends and returns results, "flush" returns the buffered results so far and clears them without ending the capture, "status" returns a side-effect-free snapshot of the current capture state.',
        },
        needResponseBody: {
          type: 'boolean',
          description:
            'When true, captures response body using Debugger API (default: false). Only use when you need to inspect response content.',
        },
        url: {
          type: 'string',
          description:
            'URL to capture network requests from. For action="start". If not provided, uses the current active tab.',
        },
        maxCaptureTime: {
          type: 'number',
          description: 'Maximum capture time in milliseconds (default: 180000)',
        },
        inactivityTimeout: {
          type: 'number',
          description: 'Stop after inactivity in milliseconds (default: 60000). Set 0 to disable.',
        },
        includeStatic: {
          type: 'boolean',
          description: 'Include static resources like images/scripts/styles (default: false)',
        },
        background: {
          type: 'boolean',
          description:
            'Do not activate tab/focus window when starting capture (default: true). Only honored by the debugger backend (needResponseBody:true); the webRequest backend never activates. Pass false to bring the tab forward.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.INTERCEPT_RESPONSE,
    description:
      'Wait for the next network response on a tab whose URL matches the given pattern, then return the parsed JSON body (or raw body if non-JSON). Use this to grab API responses (e.g. LinkedIn Voyager, GraphQL endpoints) without DOM walking. Attaches the Chrome Debugger Network domain only for the duration of the wait. Returns within timeoutMs. When count > 1, accumulates that many matches before detaching and returns them as { ok, tabId, count, matched, responses: [...] } — useful for paginated SPA flows (e.g. inbox pages, message history loads) to cut N round-trips down to 1.',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: {
          type: 'string',
          description:
            'Substring or regex (wrapped in / / for regex form, e.g. "/voyager/api/.*conversations/i") to match against the response URL.',
        },
        method: {
          type: 'string',
          description:
            'Optional HTTP method filter (GET, POST, etc). When omitted, matches any method.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Milliseconds to wait for a matching response before timing out (default 15000, max 120000).',
        },
        tabId: TAB_ID_PROP,
        returnBody: {
          type: 'boolean',
          description:
            'When false (default true), skip getResponseBody and return only headers + status. Useful when you only need to detect that the call fired.',
        },
        count: {
          type: 'number',
          description:
            'How many matching responses to accumulate before detaching (default 1, max 100). When 1 (default), the tool resolves on the first match and returns the single-response shape (ok, tabId, requestId, url, method, status, ...). When >1, it accumulates up to N matches (or until timeoutMs fires) and returns { ok, tabId, count, matched, responses: [{...}, ...] } — matched may be less than count on timeout. On timeout with zero matches, the same TIMEOUT envelope is returned regardless of count.',
        },
      },
      required: ['urlPattern'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD,
    description: 'Wait for a browser download and return details (id, filename, url, state, size)',
    inputSchema: {
      type: 'object',
      properties: {
        filenameContains: { type: 'string', description: 'Filter by substring in filename or URL' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 60000, max 300000)' },
        waitForComplete: { type: 'boolean', description: 'Wait until completed (default true)' },
        tabId: {
          type: 'number',
          description:
            'Optional source-tab filter. When provided, only downloads originating from this tab are matched. Programmatic downloads (anchor.click on detached element, fetch+blob) often lack a tabId and are matched regardless.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HISTORY,
    description: 'Retrieve and search browsing history from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to search for in history URLs and titles. Leave empty to retrieve all history entries within the time range.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time as a date string. Supports ISO format (e.g., "2023-10-01", "2023-10-01T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: 24 hours ago',
        },
        endTime: {
          type: 'string',
          description:
            'End time as a date string. Supports ISO format (e.g., "2023-10-31", "2023-10-31T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: current time',
        },
        maxResults: {
          type: 'number',
          description:
            'Maximum number of history entries to return. Use this to limit results for performance or to focus on the most relevant entries. (default: 100)',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description:
            "When set to true, filters out URLs that are currently open in any browser tab. Useful for finding pages you've visited but don't have open anymore. (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HISTORY_DELETE,
    description:
      "Delete entries from Chrome browsing history. Wraps chrome.history.deleteUrl / deleteRange / deleteAll. Choose exactly one mode: pass `url` to remove a single URL's visit history; pass `startTime` AND `endTime` to delete every visit in a window; pass `all: true` to wipe history entirely. The deletion is permanent — `chrome.history.search` will not return removed entries afterwards. Useful for cleaning up after automated runs (e.g. removing test visits before asserting on history state) or honoring privacy intent. Set `confirmDeleteAll: true` together with `all: true` as an explicit safety check for the wipe-all mode.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'When provided, removes all visits to this exact URL (chrome.history.deleteUrl). Mutually exclusive with the time-range and `all` modes.',
        },
        startTime: {
          type: 'string',
          description:
            'Start of the deletion window. Same date formats as chrome_history (ISO, "1 day ago", "yesterday", etc.). Required together with `endTime`. Mutually exclusive with `url` and `all`.',
        },
        endTime: {
          type: 'string',
          description:
            'End of the deletion window. Same date formats as chrome_history. Required together with `startTime`. Mutually exclusive with `url` and `all`.',
        },
        all: {
          type: 'boolean',
          description:
            'When true, deletes the entire browsing history (chrome.history.deleteAll). Must be combined with `confirmDeleteAll: true`. Mutually exclusive with `url` and the time-range mode.',
        },
        confirmDeleteAll: {
          type: 'boolean',
          description:
            'Required safety acknowledgement when `all` is true. Has no effect for url or range mode.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    description: 'Search Chrome bookmarks by title and URL',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query to match against bookmark titles and URLs. Leave empty to retrieve all bookmarks.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of bookmarks to return (default: 50)',
        },
        folderPath: {
          type: 'string',
          description:
            'Optional folder path or ID to limit search to a specific bookmark folder. Can be a path string (e.g., "Work/Projects") or a folder ID.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_ADD,
    description: 'Add a new bookmark to Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to bookmark. If not provided, uses the current active tab URL.',
        },
        title: {
          type: 'string',
          description: 'Title for the bookmark. If not provided, uses the page title from the URL.',
        },
        parentId: {
          type: 'string',
          description:
            'Parent folder path or ID to add the bookmark to. Can be a path string (e.g., "Work/Projects") or a folder ID. If not provided, adds to the "Bookmarks Bar" folder.',
        },
        createFolder: {
          type: 'boolean',
          description: 'Whether to create the parent folder if it does not exist (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_UPDATE,
    description:
      'Update a Chrome bookmark: rename, change its URL, and/or move it to a different parent folder. Identify the bookmark by id (preferred) or by url.',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description:
            'ID of the bookmark to update. Either bookmarkId or url must be provided. When url matches multiple bookmarks, all matches are updated; pass bookmarkId to disambiguate.',
        },
        url: {
          type: 'string',
          description:
            'URL of the bookmark to update. Used to look up the bookmark when bookmarkId is omitted.',
        },
        matchTitle: {
          type: 'string',
          description:
            'Optional title substring used to disambiguate when looking up by url. Case-sensitive substring match.',
        },
        newUrl: {
          type: 'string',
          description: 'New URL to set on the bookmark.',
        },
        newTitle: {
          type: 'string',
          description: 'New title to set on the bookmark.',
        },
        newParentId: {
          type: 'string',
          description:
            'New parent folder path or ID to move the bookmark into (e.g., "Work/Projects" or a folder ID). The parent must exist.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    description: 'Delete a bookmark from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description: 'ID of the bookmark to delete. Either bookmarkId or url must be provided.',
        },
        url: {
          type: 'string',
          description: 'URL of the bookmark to delete. Used if bookmarkId is not provided.',
        },
        title: {
          type: 'string',
          description: 'Title of the bookmark to help with matching when deleting by URL.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_COOKIES,
    description:
      "Read browser cookies for a URL or domain. Wraps chrome.cookies.getAll. At least one of `url` or `domain` is required to keep the response bounded. Returns an array of cookie objects with shape { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, session, expirationDate?, storeId }. Use this to inspect a site's session/auth state before driving a page (e.g. to confirm a LinkedIn `li_at` cookie exists, or to debug why a request 401'd).",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Restrict to cookies that would be sent to this URL (matches scheme, host, and path). Either `url` or `domain` is required.',
        },
        domain: {
          type: 'string',
          description:
            'Restrict to cookies whose domain matches (or is a subdomain of) this domain (e.g. "linkedin.com"). Either `url` or `domain` is required.',
        },
        name: {
          type: 'string',
          description: 'Optional: only return cookies with this exact name.',
        },
        path: {
          type: 'string',
          description: 'Optional: restrict to cookies with this path.',
        },
        secure: {
          type: 'boolean',
          description: 'Optional: when set, filter by the Secure flag.',
        },
        session: {
          type: 'boolean',
          description:
            'Optional: when true, only session cookies; when false, only persistent cookies.',
        },
        storeId: {
          type: 'string',
          description:
            "Optional: cookie store ID (e.g. for incognito). When omitted, the current execution context's store is used.",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SET_COOKIE,
    description:
      'Set a single cookie. Wraps chrome.cookies.set. The `url` argument is required — Chrome uses it to derive default values for `domain` and `path` and to validate the Secure attribute. Other fields are optional pass-throughs. Returns the resulting Cookie object on success. Use this to seed an auth cookie before navigation (e.g. restore a saved `li_at` to skip the LinkedIn sign-in UI).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL associated with the cookie (required). Determines default domain/path and is used to validate Secure cookies.',
        },
        name: {
          type: 'string',
          description: 'Name of the cookie. Empty string by default.',
        },
        value: {
          type: 'string',
          description: 'Value of the cookie. Empty string by default.',
        },
        domain: {
          type: 'string',
          description:
            'Domain of the cookie. If omitted, the cookie becomes a host-only cookie for the URL.',
        },
        path: {
          type: 'string',
          description: 'Path of the cookie. Defaults to the path portion of `url`.',
        },
        secure: {
          type: 'boolean',
          description: 'Whether the cookie should be marked Secure. Default: false.',
        },
        httpOnly: {
          type: 'boolean',
          description: 'Whether the cookie should be marked HttpOnly. Default: false.',
        },
        sameSite: {
          type: 'string',
          enum: ['no_restriction', 'lax', 'strict', 'unspecified'],
          description: 'SameSite attribute. Default: "unspecified".',
        },
        expirationDate: {
          type: 'number',
          description:
            'Expiration date in seconds since the Unix epoch. If omitted, the cookie becomes a session cookie.',
        },
        storeId: {
          type: 'string',
          description:
            "The ID of the cookie store. By default the cookie is set in the current execution context's store.",
        },
      },
      required: ['url'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.REMOVE_COOKIE,
    description:
      'Delete a single cookie by URL + name. Wraps chrome.cookies.remove. Returns { url, name, storeId } on success, or null if no matching cookie was found. Use this to clear an auth cookie (e.g. force a LinkedIn re-login) without driving a logout flow.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL associated with the cookie to delete. Combined with `name` to identify a unique cookie.',
        },
        name: {
          type: 'string',
          description: 'Name of the cookie to delete.',
        },
        storeId: {
          type: 'string',
          description:
            "Optional: cookie store ID. When omitted, the current execution context's store is used.",
        },
      },
      required: ['url', 'name'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT,
    description:
      'Semantic vector search across the content of currently open tabs. Returns matching tabs with relevance scores and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The query to search for related content across open tabs.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
    description:
      'Inject a user-specified content script into a webpage. By default, injects into the currently active tab. Use chrome_userscript for persistent/CSP-aware injections; use this for one-off ISOLATED/MAIN-world script execution with a custom event bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'If a URL is specified, inject the script into the webpage corresponding to the URL. If no matching tab exists, a new tab is created.',
        },
        ...TAB_TARGETING,
        type: {
          type: 'string',
          enum: ['ISOLATED', 'MAIN'],
          description:
            'The JavaScript world the script should execute in. Must be ISOLATED or MAIN.',
        },
        jsScript: {
          type: 'string',
          description: 'The JavaScript source to inject.',
        },
      },
      required: ['type', 'jsScript'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.LIST_INJECTED_SCRIPTS,
    description:
      'List the user scripts currently injected via chrome_inject_script across all tabs. Returns one entry per injected tab with `{ tabId, world, scriptLength, injectedAt }`. Use this for safe pre-flight checks before chrome_inject_script (idempotent inject-once patterns) and to confirm a tab still carries an active bridge before chrome_send_command_to_inject_script. Read-only — never modifies extension state.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'When provided, return only the entry for this tab id (or an empty array if no injection). Omit to list every injected tab.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
    description:
      'If the script injected via chrome_inject_script listens for user-defined events, this tool dispatches those events to the injected script.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID_PROP,
        eventName: {
          type: 'string',
          description: 'The event name your injected content script listens for.',
        },
        payload: {
          type: 'string',
          description: 'The payload passed to the event. Must be a JSON string.',
        },
      },
      required: ['eventName'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.JAVASCRIPT,
    description: [
      'Execute JavaScript code in a browser tab and return the result.',
      '',
      'Engine: CDP Runtime.evaluate with awaitPromise + returnByValue. Falls back to chrome.scripting.executeScript (ISOLATED world) when the debugger is busy — note that fallback runs without page-context globals.',
      '',
      'Wrapping: Code runs inside `(async () => { ... })()` so top-level `await` works. A bare expression (e.g. `1+2`, `document.title`) is auto-`return`ed; a multi-statement body must `return` explicitly.',
      '',
      'Output: Result is sanitized (sensitive keys redacted unless raw mode is enabled) and capped at `maxOutputBytes` (default 51200). The response carries `{success, engine, result, truncated, redacted, metrics}` — branch on `truncated` to decide whether to retry with a larger `maxOutputBytes`.',
      '',
      'Examples:',
      '  • Read a value: `chrome_javascript({ code: "document.title" })`',
      '  • Async fetch: `chrome_javascript({ code: "await (await fetch(\'/api/me\')).json()" })`',
      '  • Multi-line: `chrome_javascript({ code: "const xs = [...document.querySelectorAll(\'a\')]; return xs.map(a => a.href).slice(0,5);" })`',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code to execute. Runs inside an async function body, so top-level await and "return ..." are supported. Bare trailing expressions are auto-returned.',
        },
        tabId: TAB_ID_PROP,
        timeoutMs: {
          type: 'number',
          description: 'Execution timeout in milliseconds (default: 15000).',
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Maximum output size in bytes after sanitization (default: 51200). Output exceeding this limit is truncated and `truncated:true` is set in the response — pass a larger value to opt into a fuller read.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLICK,
    description:
      'Click on an element in a web page. Supports multiple targeting methods: CSS selector, XPath, element ref (from chrome_read_page), or viewport coordinates. More focused than chrome_computer for simple click operations.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_PROP,
        selectorType: SELECTOR_TYPE_PROP,
        ref: REF_PROP,
        coordinates: {
          type: 'object',
          description: 'Viewport coordinates to click at.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        double: {
          type: 'boolean',
          description: 'Perform double click when true (default: false).',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to click (default: "left").',
        },
        modifiers: {
          type: 'object',
          description: 'Modifier keys to hold during click.',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        waitForNavigation: {
          type: 'boolean',
          description: 'Wait for navigation to complete after click (default: false).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds for waiting (default: 5000).',
        },
        ...TAB_TARGETING_NO_BG,
        frameId: FRAME_ID_PROP,
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILL,
    description:
      'Fill or select a form element on a web page. Supports input, textarea, select, checkbox, and radio elements. Use CSS selector, XPath, or element ref to target the element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_PROP,
        selectorType: SELECTOR_TYPE_PROP,
        ref: REF_PROP,
        value: {
          type: ['string', 'number', 'boolean'],
          description:
            'Value to fill. For text inputs: string. For checkboxes/radios: boolean. For selects: option value or text.',
        },
        ...TAB_TARGETING_NO_BG,
        frameId: FRAME_ID_PROP,
      },
      required: ['value'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.REQUEST_ELEMENT_SELECTION,
    description:
      'Request the user to manually select one or more elements on the current page. Use this as a human-in-the-loop fallback when you cannot reliably locate the target element after approximately 3 attempts using chrome_read_page combined with chrome_click_element/chrome_fill_or_select/chrome_computer. The user will see a panel with instructions and can click on the requested elements. Returns element refs compatible with chrome_click_element/chrome_fill_or_select (including iframe frameId for cross-frame support).',
    inputSchema: {
      type: 'object',
      properties: {
        requests: {
          type: 'array',
          description:
            'A list of element selection requests. Each request produces exactly one picked element. The user will see these requests in a panel and select each element by clicking on the page.',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description:
                  'Optional stable request id for correlation. If omitted, an id is auto-generated (e.g., "req_1").',
              },
              name: {
                type: 'string',
                description:
                  'Short label shown to the user describing what element to select (e.g., "Login button", "Email input field").',
              },
              description: {
                type: 'string',
                description:
                  'Optional longer instruction shown to the user with more context (e.g., "Click on the primary login button in the top-right corner").',
              },
            },
            required: ['name'],
          },
        },
        timeoutMs: {
          type: 'number',
          description:
            'Timeout in milliseconds for the user to complete all selections. Default: 180000 (3 minutes). Maximum: 600000 (10 minutes).',
        },
        ...TAB_TARGETING_NO_BG,
      },
      required: ['requests'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.KEYBOARD,
    description:
      'Simulate keyboard input on a web page. Supports single keys (Enter, Tab, Escape), key combinations (Ctrl+C, Ctrl+V), text input, and a high-level `shortcut` enum (copy/paste/undo/redo/save/select_all/find/cut/refresh/back/forward/new_tab/close_tab) that maps to the platform-correct chord at dispatch time (Meta on macOS, Ctrl elsewhere). Can target a specific element or send to the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          description:
            'Keys or key combinations to simulate. Examples: "Enter", "Tab", "Ctrl+C", "Shift+Tab", "Hello World". Optional when `shortcut` is supplied; when both are present, `shortcut` wins.',
        },
        shortcut: {
          type: 'string',
          enum: [
            'copy',
            'paste',
            'cut',
            'undo',
            'redo',
            'save',
            'select_all',
            'find',
            'refresh',
            'back',
            'forward',
            'new_tab',
            'close_tab',
          ],
          description:
            'High-level named shortcut. Resolves at dispatch time to the platform-correct key chord (e.g. `copy` → "Meta+c" on macOS, "Ctrl+c" elsewhere). Use this instead of `keys` to avoid hard-coding Ctrl-vs-Meta in prompts.',
        },
        selector: SELECTOR_PROP,
        selectorType: SELECTOR_TYPE_PROP,
        delay: {
          type: 'number',
          description: 'Delay between keystrokes in milliseconds (default: 50).',
        },
        ...TAB_TARGETING_NO_BG,
        frameId: FRAME_ID_PROP,
      },
      required: [],
      anyOf: [{ required: ['keys'] }, { required: ['shortcut'] }],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.AWAIT_ELEMENT,
    description:
      'Wait for a DOM element to be present or absent on the page using a MutationObserver. Use this instead of polling chrome_javascript when waiting for UI state changes (e.g. a modal closing, a skeleton loader being replaced, a "Sent" indicator appearing). Targeting: provide either selector (CSS or XPath) or ref (from chrome_read_page). Returns immediately when the goal state is already true. Returns {found:true, elapsedMs} on success, or a TIMEOUT error with {selector, state, timeoutMs, elapsedMs} after timeoutMs.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_PROP,
        selectorType: SELECTOR_TYPE_PROP,
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page. Takes precedence over selector. For state="absent", waits until the referenced element is detached or the ref no longer resolves.',
        },
        state: {
          type: 'string',
          enum: ['present', 'absent'],
          description:
            'Target state to wait for: "present" (default) waits for a matching element to appear, "absent" waits for it to disappear.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Timeout in milliseconds (default: 15000, max: 120000). Returns a TIMEOUT error when the goal state is not reached in time.',
        },
        ...TAB_TARGETING,
        frameId: FRAME_ID_PROP,
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    description:
      "Capture console output from a browser tab. Supports snapshot mode (default; one-time capture with ~2s wait) and buffer mode (persistent per-tab buffer you can read/clear instantly without waiting).\n\nResponse includes a `truncation` field of shape `{truncated, originalSize?, limit, rawAvailable, unit:'messages', argsTruncated}` so callers can detect whether the message cap or the per-arg serializer caps were hit. When `argsTruncated:true` and `rawAvailable:true`, retry with `raw:true` to skip per-arg caps (snapshot mode only).",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to and capture console from. If not provided, uses the current active tab',
        },
        ...TAB_TARGETING,
        includeExceptions: {
          type: 'boolean',
          description: 'Include uncaught exceptions in the output (default: true)',
        },
        maxMessages: {
          type: 'number',
          description:
            'Maximum number of console messages to capture in snapshot mode (default: 100). If limit is provided, it takes precedence.',
        },
        mode: {
          type: 'string',
          enum: ['snapshot', 'buffer'],
          description:
            'Console capture mode: snapshot (default; waits ~2s for messages) or buffer (persistent per-tab buffer; reads from memory instantly).',
        },
        buffer: {
          type: 'boolean',
          description: 'Alias for mode="buffer" (default: false).',
        },
        clear: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab before reading (default: false). Use clearAfterRead instead to clear after reading (mcp-tools.js style).',
        },
        clearAfterRead: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab AFTER reading, to avoid duplicate messages on subsequent calls (default: false). This matches mcp-tools.js behavior.',
        },
        pattern: {
          type: 'string',
          description:
            'Optional regex filter applied to message/exception text. Supports /pattern/flags syntax.',
        },
        onlyErrors: {
          type: 'boolean',
          description:
            'Only return error-level console messages (and exceptions when includeExceptions=true). Default: false.',
        },
        limit: {
          type: 'number',
          description:
            'Limit returned console messages. In snapshot mode this is an alias for maxMessages; in buffer mode it limits returned messages from the buffer.',
        },
        raw: {
          type: 'boolean',
          description:
            "Snapshot mode only: skip the per-arg serializer caps (maxDepth=3, maxProps=100) so deeply nested or large console arguments survive intact. Use when the previous response's `truncation.argsTruncated` was true. Buffer mode replays already-serialized args and ignores this flag.",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE_CLEAR,
    description:
      'Reset the per-tab console buffer used by `chrome_console` (mode="buffer") and the `console_clean` predicate of `chrome_assert`. Use between steps of a multi-step flow so subsequent console reads are scoped to messages that arrived after the clear — the same reset pattern test frameworks use between assertions. Returns `{ success, tabId, cleared, clearedMessages, clearedExceptions, bufferActive }` where `cleared` is the total number of buffered entries dropped. No-op (cleared:0, bufferActive:false) when buffer capture has not yet started for the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID_PROP,
        windowId: WINDOW_ID_PROP,
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
    description:
      'Upload files to web forms with file input elements using Chrome DevTools Protocol',
    inputSchema: {
      type: 'object',
      properties: {
        ...TAB_TARGETING_NO_BG,
        selector: {
          type: 'string',
          description: 'CSS selector for the file input element (input[type="file"])',
        },
        filePath: {
          type: 'string',
          description: 'Local file path to upload',
        },
        fileUrl: {
          type: 'string',
          description: 'URL to download file from before uploading',
        },
        base64Data: {
          type: 'string',
          description: 'Base64 encoded file data to upload',
        },
        fileName: {
          type: 'string',
          description: 'Optional filename when using base64 or URL (default: "uploaded-file")',
        },
        multiple: {
          type: 'boolean',
          description: 'Whether the input accepts multiple files (default: false)',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DIALOG,
    description: 'Handle JavaScript dialogs (alert/confirm/prompt) via CDP',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'accept | dismiss' },
        promptText: {
          type: 'string',
          description: 'Optional prompt text when accepting a prompt',
        },
        ...TAB_TARGETING_NO_BG,
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GIF_RECORDER,
    description:
      'Record browser tab activity as an animated GIF.\n\nModes:\n- Fixed FPS mode (action="start"): Captures frames at regular intervals. Good for animations/videos.\n- Auto-capture mode (action="auto_start"): Captures frames automatically when chrome_computer or chrome_navigate actions succeed. Better for interaction recordings with natural pacing.\n\nUse "stop" to end recording and save the GIF.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'auto_start', 'capture', 'clear', 'export'],
          description:
            'Action to perform:\n- "start": Begin fixed-FPS recording (captures frames at regular intervals)\n- "auto_start": Begin auto-capture mode (frames captured on tool actions)\n- "stop": End recording and save GIF\n- "status": Get current recording state\n- "capture": Manually trigger a frame capture in auto mode\n- "clear": Clear all recording state and cached GIF without saving\n- "export": Export the last recorded GIF (download or drag&drop upload)',
        },
        tabId: {
          type: 'number',
          description:
            'Target tab ID (default: active tab). Used with "start"/"auto_start" for recording, and with "export" (download=false) for drag&drop upload target.',
        },
        fps: {
          type: 'number',
          description:
            'Frames per second for fixed-FPS mode (1-30, default: 5). Higher values = smoother but larger file.',
        },
        durationMs: {
          type: 'number',
          description:
            'Maximum recording duration in milliseconds (default: 5000, max: 60000). Only for fixed-FPS mode.',
        },
        maxFrames: {
          type: 'number',
          description:
            'Maximum number of frames to capture (default: 50 for fixed-FPS, 100 for auto mode, max: 300).',
        },
        width: {
          type: 'number',
          description: 'Output GIF width in pixels (default: 800, max: 1920).',
        },
        height: {
          type: 'number',
          description: 'Output GIF height in pixels (default: 600, max: 1080).',
        },
        maxColors: {
          type: 'number',
          description:
            'Maximum colors in palette (default: 256). Lower values = smaller file size.',
        },
        filename: {
          type: 'string',
          description: 'Output filename (without extension). Defaults to timestamped name.',
        },
        captureDelayMs: {
          type: 'number',
          description:
            'Auto-capture mode only: Delay in ms after action before capturing frame (default: 150). Allows UI to stabilize.',
        },
        frameDelayCs: {
          type: 'number',
          description:
            'Auto-capture mode only: Display duration per frame in centiseconds (default: 20 = 200ms per frame).',
        },
        annotation: {
          type: 'string',
          description:
            'Auto-capture mode only (action="capture"): Optional text label to render on the captured frame.',
        },
        download: {
          type: 'boolean',
          description:
            'Export action only: Set to true (default) to download the GIF, or false to upload via drag&drop.',
        },
        coordinates: {
          type: 'object',
          description:
            'Export action only (when download=false): Target coordinates for drag&drop upload.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        ref: {
          type: 'string',
          description:
            'Export action only (when download=false): Element ref from chrome_read_page for drag&drop target.',
        },
        selector: {
          type: 'string',
          description:
            'Export action only (when download=false): CSS selector for drag&drop target element.',
        },
        enhancedRendering: {
          type: 'object',
          description:
            'Auto-capture mode only: Configure visual overlays for recorded actions (click indicators, drag paths, labels). Pass `true` to enable all defaults.',
          properties: {
            clickIndicators: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: {
                      type: 'boolean',
                      description: 'Enable click indicators (default: true)',
                    },
                    color: {
                      type: 'string',
                      description:
                        'CSS color for click indicator (default: "rgba(255, 87, 34, 0.8)")',
                    },
                    radius: { type: 'number', description: 'Initial radius in px (default: 20)' },
                    animationDurationMs: {
                      type: 'number',
                      description: 'Animation duration in ms (default: 400)',
                    },
                    animationFrames: {
                      type: 'number',
                      description: 'Number of animation frames (default: 3)',
                    },
                    animationIntervalMs: {
                      type: 'number',
                      description: 'Interval between animation frames in ms (default: 80)',
                    },
                  },
                },
              ],
              description:
                'Click indicator overlay config (true for defaults, or object for custom).',
            },
            dragPaths: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: {
                      type: 'boolean',
                      description: 'Enable drag path rendering (default: true)',
                    },
                    color: {
                      type: 'string',
                      description: 'CSS color for drag path (default: "rgba(33, 150, 243, 0.7)")',
                    },
                    lineWidth: { type: 'number', description: 'Line width in px (default: 3)' },
                    lineDash: {
                      type: 'array',
                      items: { type: 'number' },
                      description: 'Dash pattern (default: [6, 4])',
                    },
                    arrowSize: {
                      type: 'number',
                      description: 'Arrow head size in px (default: 10)',
                    },
                  },
                },
              ],
              description: 'Drag path overlay config (true for defaults, or object for custom).',
            },
            labels: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: {
                      type: 'boolean',
                      description: 'Enable action labels (default: true)',
                    },
                    font: {
                      type: 'string',
                      description: 'Font for labels (default: "bold 12px sans-serif")',
                    },
                    textColor: { type: 'string', description: 'Text color (default: "#fff")' },
                    bgColor: {
                      type: 'string',
                      description: 'Background color (default: "rgba(0,0,0,0.7)")',
                    },
                    padding: { type: 'number', description: 'Padding in px (default: 4)' },
                    borderRadius: {
                      type: 'number',
                      description: 'Border radius in px (default: 4)',
                    },
                    offset: {
                      type: 'object',
                      properties: { x: { type: 'number' }, y: { type: 'number' } },
                      description: 'Offset from action position (default: {x: 10, y: -20})',
                    },
                  },
                },
              ],
              description: 'Action label overlay config (true for defaults, or object for custom).',
            },
            durationMs: {
              type: 'number',
              description: 'How long overlays remain visible in ms (default: 1500).',
            },
          },
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.DEBUG_DUMP,
    description:
      'Return recent debug-log entries from the extension. Each entry includes a `requestId` correlating to the MCP tool call that produced it, plus tool name, optional tabId, level, message, and structured data. Use this to diagnose why a previous tool call failed without re-running it. Filters compose (AND).',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'Only return entries with this correlation id.',
        },
        tool: {
          type: 'string',
          description: 'Only return entries for this tool name (e.g. "chrome_navigate").',
        },
        tabId: {
          type: 'number',
          description: 'Only return entries scoped to this tabId.',
        },
        level: {
          type: 'string',
          enum: ['debug', 'info', 'warn', 'error'],
          description: 'Filter by severity.',
        },
        sinceMs: {
          type: 'number',
          description: 'Absolute epoch milliseconds — only return entries newer than this.',
        },
        limit: {
          type: 'number',
          description: 'Maximum entries to return. Defaults to 200, max 1000.',
        },
        clear: {
          type: 'boolean',
          description: 'When true, wipe the buffer instead of returning entries.',
        },
        persist: {
          type: 'boolean',
          description:
            'Toggle whether log entries are written through to chrome.storage.local across SW restarts. Off by default (steady-state SW CPU optimization, IMP-0059) — `true` enables persistence so future logs survive a service-worker restart, `false` disables it and clears the persisted blob, omitted leaves the current state unchanged. The response always includes `persistEnabled` so callers can check the current state.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.ASSERT,
    description:
      'Run one or more predicates against the page and return a structured pass/fail result. Use after a flow step to declaratively confirm "did the click work? did the page navigate? is the toast visible? was the API call successful?" instead of inferring success from individual tool returns. Returns `{ ok: boolean, results: [{ predicate, ok, detail }] }` — `ok` is the AND of every predicate. Tools fan out to existing primitives (querySelector, console-buffer, performance.getEntriesByType, page eval); no new infrastructure.',
    inputSchema: {
      type: 'object',
      properties: {
        predicates: {
          type: 'array',
          minItems: 1,
          description: 'List of assertions to run. All must pass for the overall ok=true.',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'url_matches',
                  'title_matches',
                  'element_present',
                  'element_absent',
                  'console_clean',
                  'network_succeeded',
                  'js',
                ],
                description: 'Which predicate to run.',
              },
              pattern: {
                type: 'string',
                description:
                  'For url_matches, title_matches, and console_clean: substring or /regex/flags pattern. Required for url_matches and title_matches; optional for console_clean (filters which console errors count). title_matches matches against document.title and is the preferred way to confirm SPA navigations that update the title without changing the URL path (e.g. LinkedIn messaging, Gmail, WhatsApp).',
              },
              type: {
                type: 'string',
                enum: ['substring', 'regex'],
                description:
                  'For url_matches and title_matches: how to interpret pattern. Default: regex.',
              },
              selector: {
                type: 'string',
                description:
                  'For element_present / element_absent: CSS selector or XPath. Either selector or ref must be provided.',
              },
              selectorType: SELECTOR_TYPE_PROP,
              ref: {
                type: 'string',
                description: 'For element_present / element_absent: ref from chrome_read_page.',
              },
              sinceMs: {
                type: 'number',
                description:
                  'For console_clean: epoch milliseconds. Only console errors at or after this timestamp count. Default 0 (whole capture buffer).',
              },
              urlPattern: {
                type: 'string',
                description:
                  'For network_succeeded: substring or /regex/flags matched against entries from performance.getEntriesByType("resource"). Most-recent matching entry is checked. Note: cross-origin responses without Timing-Allow-Origin report status 0; in that case predicate succeeds on "fetch completed without error".',
              },
              expression: {
                type: 'string',
                description:
                  'For js: a JavaScript expression evaluated in the page context. Predicate passes if the expression returns truthy.',
              },
            },
            required: ['kind'],
          },
        },
        ...TAB_TARGETING_NO_BG,
      },
      required: ['predicates'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WAIT_FOR,
    description:
      'Wait for one of: a DOM element to appear/disappear, the network to go idle, a specific response to fire, or an arbitrary JS expression to return truthy. Single primitive that replaces the chrome_javascript spin-poll pattern. Pick `kind` and provide the matching parameters; `timeoutMs` is shared across all kinds. `kind: "element"` is functionally identical to chrome_await_element and is the preferred entry point for new code. Returns `{ success: boolean, kind, tookMs, ...kind-specific-detail }` on completion or a TIMEOUT envelope on miss.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['element', 'network_idle', 'response_match', 'js'],
          description: 'Which wait condition to use. Required.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Wall-clock budget. Default 15000, max 120000. On timeout the tool returns a TIMEOUT error envelope.',
        },
        selector: {
          type: 'string',
          description:
            'For kind="element": CSS selector or XPath. Either selector or ref must be provided.',
        },
        selectorType: SELECTOR_TYPE_PROP,
        ref: {
          type: 'string',
          description: 'For kind="element": ref from chrome_read_page.',
        },
        state: {
          type: 'string',
          enum: ['present', 'absent'],
          description: 'For kind="element": "present" (default) or "absent".',
        },
        quietMs: {
          type: 'number',
          description:
            'For kind="network_idle": consider the network idle once this many ms have elapsed without a new resource entry. Default 500.',
        },
        urlPattern: {
          type: 'string',
          description:
            'For kind="response_match": substring or /regex/flags matched against the response URL. Reuses chrome_intercept_response\'s CDP wiring with returnBody=false (signal-only). Required for response_match.',
        },
        method: {
          type: 'string',
          description: 'For kind="response_match": optional HTTP method filter (GET/POST/etc).',
        },
        expression: {
          type: 'string',
          description:
            'For kind="js": JavaScript expression evaluated in the page context. Re-evaluated on every DOM mutation plus a 250ms safety poll. Resolves on first truthy return.',
        },
        ...TAB_TARGETING_NO_BG,
        frameId: FRAME_ID_PROP,
      },
      required: ['kind'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PACE,
    description:
      'Set a per-MCP-client pacing profile. Mutating tool dispatches (anything that clicks/types/navigates/uploads) sleep for a profile-derived gap before firing, so anti-bot platforms (LinkedIn, Instagram, WhatsApp) see human-like rhythm. Reads stay un-throttled. State is per-client and lives in the extension service worker; service-worker restart resets to off. Returns the active profile + computed gap parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['off', 'human', 'careful', 'fast'],
          description:
            'Pacing preset. off=no throttle (default); human=600-1200ms gap with jitter; careful=1500-3000ms (LinkedIn-grade); fast=tab-lock-only serialization with no extra wait.',
        },
        minGapMs: {
          type: 'number',
          description:
            'Optional override: inclusive lower bound on gap between mutating dispatches (ms). Stacks with the profile preset.',
        },
        jitterMs: {
          type: 'number',
          description:
            'Optional override: random extra gap added in [0, jitterMs] (ms). Total gap = minGapMs + Math.random() * jitterMs.',
        },
      },
      required: ['profile'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NOTIFICATIONS,
    description:
      'Push native OS notifications via `chrome.notifications`. Lets a long-running agent surface "task done" / "needs attention" pings outside the browser. Actions: `create` (returns `{notificationId}`; `title` and `message` required, `iconUrl` optional — defaults to the extension icon, `type` defaults to `basic`, optional `buttons[]` of `{title}` up to 2), `clear` (by `notificationId`), `clear_all` (close every notification this extension owns), `get_all` (list ids currently visible). The `notifications` permission is granted at install time. iconUrls must be data URIs or extension-relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'clear', 'clear_all', 'get_all'],
          description: 'Operation to perform.',
        },
        notificationId: {
          type: 'string',
          description:
            'Required for `clear`. Optional for `create` (when set, replaces the existing notification with the same id; otherwise Chrome auto-generates).',
        },
        title: { type: 'string', description: 'Notification title. Required for `create`.' },
        message: {
          type: 'string',
          description: 'Notification body. Required for `create`.',
        },
        type: {
          type: 'string',
          enum: ['basic', 'image', 'list', 'progress'],
          description: 'Notification template. Defaults to `basic`.',
        },
        iconUrl: {
          type: 'string',
          description:
            'Icon as a data URI or extension-relative path. Defaults to the extension icon.',
        },
        priority: {
          type: 'number',
          description: 'Priority -2..2 (Chrome may ignore on some platforms).',
        },
        buttons: {
          type: 'array',
          items: { type: 'object', properties: { title: { type: 'string' } } },
          description: 'Up to 2 action buttons (for the `basic` type). Each: `{title}`.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLIPBOARD,
    description:
      'Read and write the system clipboard via the offscreen document (the only DOM context where `navigator.clipboard.readText` / `writeText` works from a service-worker extension). Actions: `read` (returns `{text}`), `write` (takes `text`, returns `{written: true}`). Useful for copying a table from one page and pasting into another, capturing an OTP from an email tab, or pre-seeding clipboard contents before triggering a paste shortcut. Plain text only — image / HTML clipboards are out of scope.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'Operation to perform.',
        },
        text: {
          type: 'string',
          description: 'Plain text to write. Required for `write`.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SESSIONS,
    description:
      'Inspect and restore recently-closed tabs/windows via `chrome.sessions`. Actions: `get_recently_closed` (returns up to `maxResults` entries, each `{lastModified, tab|window}` — tabs include `sessionId, url, title, windowId`, windows include `sessionId, tabs[]`), `restore` (restores by `sessionId`; without one, restores the most recent closure). Lets an agent un-close a tab it killed by mistake without re-navigating. The `sessions` permission is required (granted at install time).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_recently_closed', 'restore'],
          description: 'Operation to perform.',
        },
        sessionId: {
          type: 'string',
          description:
            'Session id from `get_recently_closed`. Optional for `restore` — omit to restore the most recent closure.',
        },
        maxResults: {
          type: 'number',
          description: 'Max entries for `get_recently_closed`. Default 25, cap 25.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TAB_LIFECYCLE,
    description:
      "Memory-management and audio-state controls on tabs. Actions: `discard` (free the tab's in-memory state — Chrome reloads on next focus; takes `tabId`), `mute` / `unmute` (set the audio mute state via `chrome.tabs.update({muted}`), `set_auto_discardable` (allow / forbid Chrome to auto-discard this tab under memory pressure — useful to pin a tab the agent depends on). All actions return the updated tab's `{id, url, mutedInfo, discarded, autoDiscardable}`.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['discard', 'mute', 'unmute', 'set_auto_discardable'],
          description: 'Operation to perform.',
        },
        tabId: {
          type: 'number',
          description:
            'Target tab. Required for all actions. Use chrome_get_windows_and_tabs to enumerate.',
        },
        autoDiscardable: {
          type: 'boolean',
          description:
            'Required for `set_auto_discardable`. `false` pins the tab; `true` allows Chrome to discard it.',
        },
      },
      required: ['action', 'tabId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_EMULATE,
    description:
      'Emulate network conditions on a tab via the Chrome DevTools Protocol (`Network.emulateNetworkConditions`). Useful for testing behavior under slow / offline connections without touching system network settings. Actions: `set` (apply offline | latencyMs | downloadKbps | uploadKbps to the tab), `reset` (restore default network conditions). Requires the `debugger` permission (already granted). Each call attaches the debugger if not already attached; the `reset` action also detaches when no other debugger consumers are active. State is per-tab and persists until reset or the tab is closed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'reset'],
          description: 'Operation to perform.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab. Required for both actions.',
        },
        offline: {
          type: 'boolean',
          description: 'When true, force the tab offline. Default false.',
        },
        latencyMs: {
          type: 'number',
          description:
            'Round-trip latency in milliseconds. 0 disables latency emulation. Used by `set`.',
        },
        downloadKbps: {
          type: 'number',
          description: 'Max download throughput in kbps. -1 disables (unbounded). Used by `set`.',
        },
        uploadKbps: {
          type: 'number',
          description: 'Max upload throughput in kbps. -1 disables. Used by `set`.',
        },
      },
      required: ['action', 'tabId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PRINT_TO_PDF,
    description:
      'Save a tab as PDF via the Chrome DevTools Protocol (`Page.printToPDF`). Returns the PDF as a base64 string by default. When `savePath` is provided, the bridge writes the file to disk and returns `{path, bytes}` instead. Common formatting options exposed: `landscape`, `printBackground`, `scale`, `paperWidthIn` / `paperHeightIn`, `marginTopIn` / `marginRightIn` / `marginBottomIn` / `marginLeftIn`, `pageRanges`. Requires the `debugger` permission. The CDP attach window is short — the tool detaches before returning.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Target tab. Falls back to the active tab when omitted.',
        },
        savePath: {
          type: 'string',
          description:
            'Optional bridge-side filesystem path. When provided the PDF is written to disk and the response returns `{path, bytes}` instead of base64.',
        },
        landscape: { type: 'boolean', description: 'Default false.' },
        printBackground: { type: 'boolean', description: 'Default true.' },
        scale: { type: 'number', description: 'CSS scale factor. Default 1.' },
        paperWidthIn: { type: 'number', description: 'Paper width in inches. Default 8.5.' },
        paperHeightIn: { type: 'number', description: 'Paper height in inches. Default 11.' },
        marginTopIn: { type: 'number', description: 'Top margin in inches. Default 0.4.' },
        marginRightIn: { type: 'number', description: 'Right margin in inches. Default 0.4.' },
        marginBottomIn: { type: 'number', description: 'Bottom margin in inches. Default 0.4.' },
        marginLeftIn: { type: 'number', description: 'Left margin in inches. Default 0.4.' },
        pageRanges: {
          type: 'string',
          description: 'Page ranges to print, e.g. `"1-5,8,11-13"`. Empty = all pages.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BLOCK_OR_REDIRECT,
    description:
      'Block or redirect URLs at the network layer via `chrome.declarativeNetRequest` *session* rules (no DNR ruleset reload, no manifest declaration — rules clear when Chrome restarts). Actions: `add` (one rule: `urlFilter` + `action` = `block` | `redirect`; for redirect, `redirectUrl` is required; optional `resourceTypes` filter), `remove` (by `ruleId`), `list` (all session rules registered by this extension), `clear` (drop every session rule). Use it to mock APIs during a test flow, block trackers for a session, or simulate a 404 on a specific URL. Requires `declarativeNetRequestWithHostAccess` (already granted) — host_permissions are honored.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'list', 'clear'],
          description: 'Operation to perform.',
        },
        ruleId: {
          type: 'number',
          description:
            'Required for `remove`. Optional for `add` — when omitted, the tool auto-assigns the next free id.',
        },
        urlFilter: {
          type: 'string',
          description:
            'URL pattern (DNR `urlFilter` syntax — e.g. `||example.com/api/*`). Required for `add`.',
        },
        ruleAction: {
          type: 'string',
          enum: ['block', 'redirect'],
          description: 'What to do when the URL matches. Required for `add`.',
        },
        redirectUrl: {
          type: 'string',
          description:
            'Required when `ruleAction` is `redirect`. Absolute URL the request is rewritten to.',
        },
        resourceTypes: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'main_frame',
              'sub_frame',
              'stylesheet',
              'script',
              'image',
              'font',
              'object',
              'xmlhttprequest',
              'ping',
              'csp_report',
              'media',
              'websocket',
              'webtransport',
              'webbundle',
              'other',
            ],
          },
          description:
            'Optional. Restrict the rule to specific resource types (e.g. `["xmlhttprequest","script"]`).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.ACTION_BADGE,
    description:
      'Show a small badge on the extension icon — useful for live status during a long-running agent ("3 tabs", "ERR"). Actions: `set` (takes `text`, optional `color` as a hex string `#RRGGBB[AA]`, optional `tabId` for per-tab scope), `clear` (empties the badge text; per-tab when `tabId` is set, otherwise global). Badge text is truncated to ~4 characters by Chrome.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'clear'],
          description: 'Operation to perform.',
        },
        text: {
          type: 'string',
          description:
            'Badge text. Required for `set`. Truncated to ~4 chars by Chrome — keep it terse.',
        },
        color: {
          type: 'string',
          description:
            'Optional badge background color, hex `#RRGGBB` or `#RRGGBBAA`. Default red on most platforms.',
        },
        tabId: {
          type: 'number',
          description:
            'Optional. When set, the badge is scoped to this tab; without it, the badge is global.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.KEEP_AWAKE,
    description:
      'Prevent the system from sleeping during long agent runs via `chrome.power.requestKeepAwake`. Actions: `enable` (with `level` = `display` | `system` — `display` keeps the screen awake too, `system` lets the screen sleep but keeps the OS active), `disable` (release the lock). Idempotent — repeated `enable` calls just refresh the existing lock. The lock is released when the extension reloads.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['enable', 'disable'],
          description: 'Operation to perform.',
        },
        level: {
          type: 'string',
          enum: ['display', 'system'],
          description: 'Required for `enable`. `display` is stricter (also blocks screen sleep).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONTEXT_MENU,
    description:
      'Register transient right-click menu items via `chrome.contextMenus`. Use it to let the user manually inject input mid-session ("treat this element as the next target"). Actions: `add` (returns `{id}`; takes `title`, optional `id`, optional `contexts[]` like `["page","selection"]`), `update` (modify title/contexts of an existing id), `remove` (by id), `remove_all` (drop every menu item this extension registered). Click events are surfaced via the bridge\'s native-message channel as `context_menu_clicked` events with `{menuItemId, info, tab}`.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'update', 'remove', 'remove_all'],
          description: 'Operation to perform.',
        },
        id: {
          type: 'string',
          description:
            'Menu item id. Optional for `add` (auto-generated). Required for `update`, `remove`.',
        },
        title: {
          type: 'string',
          description: 'Menu item label. Required for `add`. Optional for `update`.',
        },
        contexts: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'all',
              'page',
              'frame',
              'selection',
              'link',
              'editable',
              'image',
              'video',
              'audio',
              'launcher',
              'browser_action',
              'page_action',
              'action',
            ],
          },
          description:
            'Where the item appears. Defaults to `["page"]` for `add`. See chrome.contextMenus docs for which contexts each label applies in.',
        },
        documentUrlPatterns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional. Match patterns the URL must satisfy for the item to appear (e.g. `["https://example.com/*"]`).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FOCUS,
    description:
      'Focus an element programmatically by `selector` or `ref`. Several flows (chrome_paste, chrome_keyboard, some chrome_fill_or_select sites) need a focused target before keyboard input lands. Today there is no first-class way — agents synthesize a click and hope it sticks. The shim runs in ISOLATED world (where `window.__claudeElementMap` lives, populated by chrome_read_page / chrome_await_element) and calls `el.focus({ preventScroll: false })`, then reports `focused: document.activeElement === el` so callers can detect "element exists but does not accept focus" cases (e.g. disabled inputs, offscreen-with-tabindex=-1).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector for the target element. Required if `ref` is omitted; mutually exclusive with `ref`.',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page / chrome_await_element. Required if `selector` is omitted; mutually exclusive with `selector`.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab. Falls back to the active tab when omitted.',
        },
        windowId: {
          type: 'number',
          description: 'Target window for active-tab lookup when `tabId` is omitted.',
        },
        frameId: {
          type: 'number',
          description: 'Optional frame to scope the lookup to. Defaults to the main frame.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PASTE,
    description:
      'Focus an element (by `selector` or `ref`) and paste text into it. If `text` is supplied, the tool seeds the system clipboard via the offscreen document first, then dispatches BOTH a synthetic `ClipboardEvent("paste")` carrying a `text/plain` DataTransfer (so pages with paste-event handlers like rich editors see it) AND a `document.execCommand("insertText", false, text)` (so plain inputs / textareas that don\'t handle paste events still receive the value). Returns `{ focused, pasted, mode: "event" | "execCommand" | "both" }` so callers can detect whether the page accepted the paste. Without `text`, the page sees whatever is currently on the clipboard. Saves the chain of `chrome_clipboard write → chrome_focus → chrome_keyboard ctrl+v` agents otherwise have to glue together.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the target. Mutually exclusive with `ref`.',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page / chrome_await_element. Mutually exclusive with `selector`.',
        },
        text: {
          type: 'string',
          description:
            'Optional text to seed the clipboard with before pasting. When omitted, whatever is currently on the OS clipboard is used.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab. Falls back to the active tab when omitted.',
        },
        windowId: {
          type: 'number',
          description: 'Target window for active-tab lookup when `tabId` is omitted.',
        },
        frameId: {
          type: 'number',
          description: 'Optional frame to scope the paste to. Defaults to the main frame.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SELECT_TEXT,
    description:
      'Select text inside an element. For `<input>` / `<textarea>`, calls `setSelectionRange(start, end)`. For everything else, walks text nodes to map character offsets into a `Range` and applies via `window.getSelection().addRange(range)`. Two ways to specify what to select: pass a `substring` (first occurrence inside the element\'s value/textContent wins) OR pass `start` AND `end` character indexes. Returns `{ start, end, selected, mode: "input-range" | "dom-range" }`. Pair with chrome_clipboard or chrome_paste for "copy this exact field" flows.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the target. Mutually exclusive with `ref`.',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page / chrome_await_element. Mutually exclusive with `selector`.',
        },
        substring: {
          type: 'string',
          description:
            'Substring to find and select (first occurrence). Mutually exclusive with `start`+`end`.',
        },
        start: {
          type: 'number',
          description: 'Character offset where the selection starts. Required if `end` is set.',
        },
        end: {
          type: 'number',
          description: 'Character offset where the selection ends. Required if `start` is set.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab. Falls back to the active tab when omitted.',
        },
        windowId: {
          type: 'number',
          description: 'Target window for active-tab lookup when `tabId` is omitted.',
        },
        frameId: {
          type: 'number',
          description: 'Optional frame. Defaults to the main frame.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WINDOW_MANAGE,
    description:
      'Manage Chrome browser windows. Wraps `chrome.windows.{create,update,remove}`. Actions: `create` (open a new window — `url`, `type` = normal | popup | panel, `incognito`, `focused`, `state` = normal | minimized | maximized | fullscreen, `left`/`top`/`width`/`height`), `focus` (bring `windowId` to front via update({focused:true})), `update` (generic update — needs at least one of focused/state/left/top/width/height), `close` (chrome.windows.remove). Returns the updated `Window` object as `{id, type, state, focused, incognito, top, left, width, height, tabsCount}`. Useful for spawning isolated incognito windows for sandboxed flows, popping a popup window for a workflow, or just bringing a window to front before a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'focus', 'update', 'close'],
          description: 'Operation to perform.',
        },
        windowId: {
          type: 'number',
          description: 'Required for `focus`, `update`, and `close`. Ignored for `create`.',
        },
        url: {
          type: 'string',
          description: 'Initial URL for `create`. Optional — defaults to the new-tab page.',
        },
        type: {
          type: 'string',
          enum: ['normal', 'popup', 'panel'],
          description: 'Window type for `create`. Default: `normal`.',
        },
        incognito: {
          type: 'boolean',
          description: 'For `create`. Open the window in incognito mode.',
        },
        focused: {
          type: 'boolean',
          description: 'For `create` and `update`. Whether the window has focus.',
        },
        state: {
          type: 'string',
          enum: ['normal', 'minimized', 'maximized', 'fullscreen'],
          description: 'Window state for `create` and `update`.',
        },
        left: { type: 'number', description: 'Left edge in screen pixels (create / update).' },
        top: { type: 'number', description: 'Top edge in screen pixels (create / update).' },
        width: { type: 'number', description: 'Window width in pixels (create / update).' },
        height: { type: 'number', description: 'Window height in pixels (create / update).' },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WEB_VITALS,
    description:
      'Live Core Web Vitals collector via `PerformanceObserver` in the page MAIN world. Different shape from chrome_performance_* (those record full DevTools traces — heavyweight, post-hoc). This is "what does the user actually feel?" measurement, available live and cheap. Actions: `start` (idempotently install per-tab observers on `window.__hcWebVitals`; `reload: true` reloads the tab first so cold-start LCP/FCP/TTFB get captured), `snapshot` (read current values without disturbing the observer), `stop` (read final values + disconnect observers + clear the global). Returns `{ lcpMs, clsScore, inpMs, fcpMs, ttfbMs, fidMs }` with `null` for any metric not yet observed and `installed` reflecting the observer state. No new permissions needed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'snapshot', 'stop'],
          description: 'Operation to perform.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab. Falls back to the active tab when omitted.',
        },
        windowId: {
          type: 'number',
          description: 'Window scope for active-tab lookup when `tabId` is omitted.',
        },
        reload: {
          type: 'boolean',
          description:
            'For `start` only. Reload the tab before installing the observer so cold-start LCP / FCP / TTFB are captured. Default false.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.IDLE,
    description:
      'Query the user\'s idle state via `chrome.idle.queryState`. Returns `{ state: "active" | "idle" | "locked", detectionIntervalSec }`. Pair with the pacing throttle to back off intrusive operations while the user is at the keyboard, or skip a screenshot when the system is locked. The `idle` permission is required (granted at install time). `detectionIntervalSec` is the threshold of inactivity that flips state from active → idle; Chrome accepts 15..14400 seconds. Default 60.',
    inputSchema: {
      type: 'object',
      properties: {
        detectionIntervalSec: {
          type: 'number',
          description: 'Inactivity threshold in seconds (15..14400). Default 60.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.ALARMS,
    description:
      'Schedule one-shot or repeating callbacks via `chrome.alarms`. Actions: `create` (`name` plus at least one of `when` (epoch ms), `delayInMinutes`, optional `periodInMinutes` for repeating fires), `clear` (by name; returns `cleared` boolean), `clear_all` (drops every alarm this extension owns), `get` (returns `{name, scheduledTime, periodInMinutes}` or null), `get_all`. Each alarm fire broadcasts `{type:"alarm_fired", name, scheduledTime}` over `chrome.runtime.sendMessage` so flows polling for the event can correlate. The `alarms` permission is already in the manifest (used internally elsewhere).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'clear', 'clear_all', 'get', 'get_all'],
          description: 'Operation to perform.',
        },
        name: {
          type: 'string',
          description: 'Alarm name. Required for `create`, `clear`, `get`.',
        },
        when: {
          type: 'number',
          description:
            'For `create`. Absolute fire time as a Unix epoch milliseconds value. Use this OR `delayInMinutes`.',
        },
        delayInMinutes: {
          type: 'number',
          description: 'For `create`. Minutes from now until first fire. Use this OR `when`.',
        },
        periodInMinutes: {
          type: 'number',
          description:
            'For `create`. When set, the alarm refires every N minutes after the first fire. Omit for one-shot.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLEAR_BROWSING_DATA,
    description:
      'Wipe browsing-data stores via `chrome.browsingData.remove`. Useful for sanitizing state between agent runs without walking each store individually. Single tool, no action enum. Required: `dataTypes` — non-empty array of any of `cookies`, `localStorage`, `indexedDB`, `cache`, `cacheStorage`, `history`, `downloads`, `formData`, `passwords`, `serviceWorkers`, `webSQL`, `fileSystems`, `pluginData`, `appcache`. Optional: `since` (epoch ms; default 0 = all time), `origins` (origin-scoped filter — only data from these origins is removed). Unknown dataTypes are rejected with INVALID_ARGS naming the offender. The `browsingData` permission is granted at install time.',
    inputSchema: {
      type: 'object',
      properties: {
        dataTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Non-empty array of data-store names to wipe. Valid keys: cookies, localStorage, indexedDB, cache, cacheStorage, history, downloads, formData, passwords, serviceWorkers, webSQL, fileSystems, pluginData, appcache.',
        },
        since: {
          type: 'number',
          description:
            'Epoch ms cutoff — only data created after this time is removed. Default 0 (all time).',
        },
        origins: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional origin-scoped filter (e.g. ["https://example.com"]). When omitted, applies to all origins.',
        },
      },
      required: ['dataTypes'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PROXY,
    description:
      'Set / clear / inspect the proxy configuration via `chrome.proxy.settings`. Useful for scraping, regional testing, and anonymity flows. Actions: `set` (mode = `direct` | `system` | `fixed_servers` | `pac_script`; for `fixed_servers` provide `singleProxy: {scheme?, host, port}` plus optional `bypassList[]`; for `pac_script` provide `pacUrl`), `clear` (revert to default), `get` (returns the current `{value, levelOfControl, incognitoSpecific}`). Scope is always `regular` (incognito is left untouched). The `proxy` permission is required.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'clear', 'get'],
          description: 'Operation to perform.',
        },
        mode: {
          type: 'string',
          enum: ['direct', 'system', 'fixed_servers', 'pac_script'],
          description: 'For `set`. Required.',
        },
        singleProxy: {
          type: 'object',
          description:
            'For `set` with mode="fixed_servers". `host` and `port` required; `scheme` defaults to "http".',
          properties: {
            scheme: {
              type: 'string',
              enum: ['http', 'https', 'quic', 'socks4', 'socks5'],
            },
            host: { type: 'string' },
            port: { type: 'number' },
          },
          required: ['host', 'port'],
        },
        bypassList: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For `set` with mode="fixed_servers". Optional list of host patterns the proxy is bypassed for.',
        },
        pacUrl: {
          type: 'string',
          description: 'For `set` with mode="pac_script". URL of the PAC script.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.IDENTITY,
    description:
      "OAuth2 + profile lookup via `chrome.identity`. Lets agents call Google APIs (Gmail, Calendar, Drive, GSC, etc.) without bouncing through a browser-based consent flow each run — Chrome handles consent + caching + refresh natively. Actions: `get_token` (`scopes`, `interactive`; returns `{token, scopes, interactive}`), `remove_token` (`token`; clears Chrome's cache for that token), `get_profile` (returns `{email, id}`). Requires `oauth2.client_id` to be set in the manifest — until `HUMANCHROME_OAUTH_CLIENT_ID` is provided at build time, the placeholder is detected and an INVALID_ARGS error explains how to set it up rather than surfacing an opaque OAuth failure. The `identity` permission is granted at install time.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_token', 'remove_token', 'get_profile'],
          description: 'Operation to perform.',
        },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For `get_token`. Optional OAuth2 scopes (e.g. `["https://www.googleapis.com/auth/calendar.readonly"]`).',
        },
        interactive: {
          type: 'boolean',
          description:
            'For `get_token`. When true, Chrome shows a consent UI if needed; when false, the call fails fast if the user has not already consented. Default false.',
        },
        token: {
          type: 'string',
          description: 'For `remove_token`. The token previously returned by `get_token`.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.DRAG_DROP,
    description:
      'Drag from one element to another by synthesizing the full HTML5 Drag-and-Drop + Pointer-Event chain. Single tool (no action enum). The MAIN-world shim resolves both targets (selector or ref), computes their bounding-rect centers, then dispatches `pointerdown` → `mousedown` → `dragstart` on FROM, N intermediate `pointermove` + `dragover` events along a linear interpolation, then `dragenter` → `dragover` → `drop` on TO and `dragend` on FROM and `pointerup` / `mouseup` on TO. Returns `{ steps, fromBox, toBox }`. Hidden / not-visible / not-found targets surface as INVALID_ARGS so callers can branch without re-raising. Useful for Trello cards, kanban boards, file-upload drop zones, sortable lists.',
    inputSchema: {
      type: 'object',
      properties: {
        fromSelector: {
          type: 'string',
          description: 'CSS selector for the drag source. Mutually exclusive with `fromRef`.',
        },
        fromRef: {
          type: 'string',
          description:
            'Element ref (chrome_read_page / chrome_await_element) for the drag source. Mutually exclusive with `fromSelector`.',
        },
        toSelector: {
          type: 'string',
          description: 'CSS selector for the drop target. Mutually exclusive with `toRef`.',
        },
        toRef: {
          type: 'string',
          description: 'Element ref for the drop target. Mutually exclusive with `toSelector`.',
        },
        steps: {
          type: 'number',
          description:
            'Number of intermediate pointermove + dragover events between the two centers. Clamped to [1, 50]. Default 5.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab. Falls back to the active tab when omitted.',
        },
        windowId: {
          type: 'number',
          description: 'Target window for active-tab lookup when `tabId` is omitted.',
        },
        frameId: {
          type: 'number',
          description: 'Optional frame to scope the operation to. Defaults to the main frame.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.DOWNLOAD_LIST,
    description:
      'Enumerate downloads via `chrome.downloads.search`. Use to check whether a previous download is still running, find the id of an in-progress download for `chrome_download_cancel`, or list completed downloads with their saved paths. Returns `{count, items: [{id, url, filename, state, totalBytes, bytesReceived, startTime, endTime, mime, error?}]}`. Pre-existing downloads matching the filter are returned even if they were started outside the agent session.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['in_progress', 'complete', 'interrupted', 'all'],
          description: 'Filter by download state. `all` skips the state filter. Default: `all`.',
        },
        filenameContains: {
          type: 'string',
          description:
            'Case-insensitive substring filter on the saved filename (post-`/`-split basename). Empty string matches all.',
        },
        limit: {
          type: 'number',
          description:
            'Cap on returned items. Clamped to [1, 100]. Default 25. The full result set is fetched from Chrome and truncated client-side; Chrome itself returns up to ~1000 entries.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.DOWNLOAD_CANCEL,
    description:
      'Cancel an in-progress download by id via `chrome.downloads.cancel`. Already-completed or already-cancelled downloads are a no-op (Chrome silently succeeds). Returns `{cancelled: true, downloadId, postState}` where `postState` is the download state immediately after the cancel attempt (typically `interrupted` for active cancels, the prior terminal state for already-finished ones).',
    inputSchema: {
      type: 'object',
      properties: {
        downloadId: {
          type: 'number',
          description:
            'The download id from `chrome_download_list` or `chrome.downloads.onCreated`.',
        },
      },
      required: ['downloadId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.REMOVE_INJECTED_SCRIPT,
    description:
      "Explicitly tear down a user script previously installed via `chrome_inject_script` on a tab. Sends the existing `humanchrome:cleanup` teardown signal and drops the tab from the internal `injectedTabs` registry. Useful for monitoring bridges (mutation observers, WebSocket proxies) that an agent wants to remove before handing the tab back to the user — without this, the only way to unload was to navigate the tab away. Returns `{removed, tabId}`. Idempotent: `removed:false` when the tab had no injection (callers that don't track state can call freely without checking first).",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target tab. Falls back to the active tab in the focused window when omitted.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PACE_GET,
    description:
      'Read-only counterpart of `chrome_pace`. Returns the current per-MCP-client pacing profile and the resolved gap/jitter that would be applied on the next mutating call. Use to verify pacing was set as intended, or to discover whether a previous `chrome_pace` call (in this session or another) is still in effect. When no profile is set, returns `{profile: "off", minGapMs: 0, jitterMs: 0}`. No mutation, no side effects on client state.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.RECORD_REPLAY.FLOW_DELETE,
    description:
      'Delete a recorded flow by ID. Closes the lifecycle gap left by `record_replay_list_published` + `record_replay_flow_run` so iterative record-test-refine sessions can clean up stale versions without opening the extension UI. Always unpublishes first (idempotent — `unpublishFlow` no-ops on unpublished flows) so the dynamic `flow.<slug>` MCP tool the bridge exposes disappears even when the underlying flow record is being deleted in the same call. Returns `{deleted: true, unpublished, flowId}` on success — `unpublished` reports whether the flow was published before deletion. Errors with `INVALID_ARGS` if `flowId` is missing or the flow does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: {
          type: 'string',
          description: 'ID of the flow to delete (from `record_replay_list_published`).',
        },
      },
      required: ['flowId'],
    },
  },
];

/**
 * Order in which categories appear in the generated docs. Acts as the
 * source of truth for the category-label string set — `TOOL_CATEGORIES`
 * derives its value type from this array, so renaming a label here without
 * fixing the map is a TypeScript error.
 */
export const TOOL_CATEGORY_ORDER = [
  'Browser management',
  'Reading',
  'Interaction',
  'Scripting',
  'Network',
  'Files',
  'State',
  'System',
  'Performance',
  'Diagnostics',
  'Pacing',
  'Workflows',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORY_ORDER)[number];

/**
 * Maps each MCP tool name (the string value in TOOL_SCHEMAS) to its category.
 * Drives the grouping in `docs/TOOLS.md`'s auto-generated section via
 * `app/native-server/scripts/generate-tools-doc.mjs`.
 *
 * Lives next to `TOOL_SCHEMAS` rather than as `_meta` on each Tool — keeps
 * category labels off the MCP wire and avoids 40+ inline edits.
 *
 * Coverage invariant: every tool in `TOOL_SCHEMAS` must have an entry here.
 * Asserted by `tool-categories-coverage.test.ts` and re-checked by the doc
 * generator at run time, so adding a new tool without a category fails CI.
 */
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  [TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS]: 'Browser management',
  [TOOL_NAMES.BROWSER.NAVIGATE]: 'Browser management',
  [TOOL_NAMES.BROWSER.NAVIGATE_BATCH]: 'Browser management',
  [TOOL_NAMES.BROWSER.WAIT_FOR_TAB]: 'Browser management',
  [TOOL_NAMES.BROWSER.CLOSE_TAB]: 'Browser management',
  [TOOL_NAMES.BROWSER.CLOSE_TABS_MATCHING]: 'Browser management',
  [TOOL_NAMES.BROWSER.SWITCH_TAB]: 'Browser management',
  [TOOL_NAMES.BROWSER.TAB_GROUPS]: 'Browser management',

  [TOOL_NAMES.BROWSER.READ_PAGE]: 'Reading',
  [TOOL_NAMES.BROWSER.STORAGE]: 'State',
  [TOOL_NAMES.BROWSER.LIST_FRAMES]: 'Reading',
  [TOOL_NAMES.BROWSER.WEB_FETCHER]: 'Reading',
  // TOOL_NAMES.BROWSER.GET_INTERACTIVE_ELEMENTS has a handler but no
  // TOOL_SCHEMAS entry (reserved name, not yet published). Add here under
  // "Reading" if/when its schema lands.
  [TOOL_NAMES.BROWSER.SCREENSHOT]: 'Reading',
  [TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT]: 'Reading',
  [TOOL_NAMES.BROWSER.CONSOLE_CLEAR]: 'Reading',

  [TOOL_NAMES.BROWSER.CLICK]: 'Interaction',
  [TOOL_NAMES.BROWSER.FILL]: 'Interaction',
  [TOOL_NAMES.BROWSER.KEYBOARD]: 'Interaction',
  [TOOL_NAMES.BROWSER.COMPUTER]: 'Interaction',
  [TOOL_NAMES.BROWSER.REQUEST_ELEMENT_SELECTION]: 'Interaction',
  [TOOL_NAMES.BROWSER.HANDLE_DIALOG]: 'Interaction',
  [TOOL_NAMES.BROWSER.AWAIT_ELEMENT]: 'Interaction',
  [TOOL_NAMES.BROWSER.ASSERT]: 'Interaction',
  [TOOL_NAMES.BROWSER.WAIT_FOR]: 'Interaction',

  [TOOL_NAMES.BROWSER.JAVASCRIPT]: 'Scripting',
  [TOOL_NAMES.BROWSER.INJECT_SCRIPT]: 'Scripting',
  [TOOL_NAMES.BROWSER.LIST_INJECTED_SCRIPTS]: 'Scripting',
  [TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT]: 'Scripting',
  [TOOL_NAMES.BROWSER.USERSCRIPT]: 'Scripting',

  [TOOL_NAMES.BROWSER.NETWORK_REQUEST]: 'Network',
  [TOOL_NAMES.BROWSER.NETWORK_CAPTURE]: 'Network',
  [TOOL_NAMES.BROWSER.INTERCEPT_RESPONSE]: 'Network',

  [TOOL_NAMES.BROWSER.FILE_UPLOAD]: 'Files',
  [TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD]: 'Files',
  [TOOL_NAMES.BROWSER.GIF_RECORDER]: 'Files',

  [TOOL_NAMES.BROWSER.CONSOLE]: 'State',
  [TOOL_NAMES.BROWSER.HISTORY]: 'State',
  [TOOL_NAMES.BROWSER.HISTORY_DELETE]: 'State',
  [TOOL_NAMES.BROWSER.BOOKMARK_SEARCH]: 'State',
  [TOOL_NAMES.BROWSER.BOOKMARK_ADD]: 'State',
  [TOOL_NAMES.BROWSER.BOOKMARK_UPDATE]: 'State',
  [TOOL_NAMES.BROWSER.BOOKMARK_DELETE]: 'State',
  [TOOL_NAMES.BROWSER.GET_COOKIES]: 'State',
  [TOOL_NAMES.BROWSER.SET_COOKIE]: 'State',
  [TOOL_NAMES.BROWSER.REMOVE_COOKIE]: 'State',

  [TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE]: 'Performance',
  [TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE]: 'Performance',
  [TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT]: 'Performance',

  [TOOL_NAMES.BROWSER.DEBUG_DUMP]: 'Diagnostics',

  [TOOL_NAMES.BROWSER.PACE]: 'Pacing',

  [TOOL_NAMES.BROWSER.NOTIFICATIONS]: 'System',
  [TOOL_NAMES.BROWSER.CLIPBOARD]: 'System',
  [TOOL_NAMES.BROWSER.SESSIONS]: 'Browser management',
  [TOOL_NAMES.BROWSER.TAB_LIFECYCLE]: 'Browser management',
  [TOOL_NAMES.BROWSER.NETWORK_EMULATE]: 'Network',
  [TOOL_NAMES.BROWSER.PRINT_TO_PDF]: 'Reading',
  [TOOL_NAMES.BROWSER.BLOCK_OR_REDIRECT]: 'Network',
  [TOOL_NAMES.BROWSER.ACTION_BADGE]: 'System',
  [TOOL_NAMES.BROWSER.KEEP_AWAKE]: 'System',
  [TOOL_NAMES.BROWSER.CONTEXT_MENU]: 'System',
  [TOOL_NAMES.BROWSER.FOCUS]: 'Interaction',
  [TOOL_NAMES.BROWSER.PASTE]: 'Interaction',
  [TOOL_NAMES.BROWSER.SELECT_TEXT]: 'Interaction',
  [TOOL_NAMES.BROWSER.WINDOW_MANAGE]: 'Browser management',
  [TOOL_NAMES.BROWSER.WEB_VITALS]: 'Performance',
  [TOOL_NAMES.BROWSER.IDLE]: 'System',
  [TOOL_NAMES.BROWSER.ALARMS]: 'System',
  [TOOL_NAMES.BROWSER.CLEAR_BROWSING_DATA]: 'State',
  [TOOL_NAMES.BROWSER.PROXY]: 'Network',
  [TOOL_NAMES.BROWSER.IDENTITY]: 'System',
  [TOOL_NAMES.BROWSER.DRAG_DROP]: 'Interaction',
  [TOOL_NAMES.BROWSER.DOWNLOAD_LIST]: 'Files',
  [TOOL_NAMES.BROWSER.DOWNLOAD_CANCEL]: 'Files',
  [TOOL_NAMES.BROWSER.REMOVE_INJECTED_SCRIPT]: 'Scripting',
  [TOOL_NAMES.BROWSER.PACE_GET]: 'Pacing',

  [TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED]: 'Workflows',
  [TOOL_NAMES.RECORD_REPLAY.FLOW_RUN]: 'Workflows',
  [TOOL_NAMES.RECORD_REPLAY.FLOW_DELETE]: 'Workflows',
};
