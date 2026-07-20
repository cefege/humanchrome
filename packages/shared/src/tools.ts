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
// IMP-0021 slice 1: shared fragments now live in tool-schemas/fragments.ts so
// per-category schema files (extracted in subsequent slices) can spread them
// without depending on tools.ts.
import {
  TAB_ID_PROP,
  WINDOW_ID_PROP,
  TAB_TARGETING,
  TAB_TARGETING_NO_BG,
  REF_PROP,
  SELECTOR_PROP,
  SELECTOR_TYPE_PROP,
  SELECTOR_INDEX_PROP,
  SELECTOR_MULTI_PROP,
  FRAME_ID_PROP,
} from './tool-schemas/fragments';

export const TOOL_NAMES = {
  BROWSER: {
    GET_WINDOWS_AND_TABS: 'chrome_get_windows_and_tabs',
    SEARCH_TABS_CONTENT: 'chrome_search_tabs_content',
    NAVIGATE: 'chrome_navigate',
    NAVIGATE_BATCH: 'chrome_navigate_batch',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TABS: 'chrome_close_tabs',
    SWITCH_TAB: 'chrome_switch_tab',
    TAB_GROUPS: 'chrome_tab_groups',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    REQUEST_ELEMENT_SELECTION: 'chrome_request_element_selection',
    NETWORK_CAPTURE: 'chrome_network_capture',
    NETWORK_REQUEST: 'chrome_network_request',
    INTERCEPT_RESPONSE: 'chrome_intercept_response',
    KEYBOARD: 'chrome_keyboard',
    HISTORY: 'chrome_history',
    BOOKMARK: 'chrome_bookmark',
    COOKIES: 'chrome_cookies',
    INJECT_SCRIPT: 'chrome_inject_script',
    SEND_COMMAND_TO_INJECT_SCRIPT: 'chrome_send_command_to_inject_script',
    JAVASCRIPT: 'chrome_javascript',
    CONSOLE: 'chrome_console',
    FILE_UPLOAD: 'chrome_upload_file',
    READ_PAGE: 'chrome_read_page',
    STORAGE: 'chrome_storage',
    LIST_FRAMES: 'chrome_list_frames',
    COMPUTER: 'chrome_computer',
    HANDLE_DIALOG: 'chrome_handle_dialog',
    HANDLE_DOWNLOAD: 'chrome_handle_download',
    USERSCRIPT: 'chrome_userscript',
    PERFORMANCE_TRACE: 'chrome_performance_trace',
    GIF_RECORDER: 'chrome_gif_recorder',
    DIAGNOSTICS: 'chrome_diagnostics',
    ASSERT: 'chrome_assert',
    WAIT_FOR: 'chrome_wait_for',
    PACE: 'chrome_pace',
    NOTIFICATIONS: 'chrome_notifications',
    CLIPBOARD: 'chrome_clipboard',
    SESSIONS: 'chrome_sessions',
    TAB_LIFECYCLE: 'chrome_tab_lifecycle',
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
    DOWNLOAD: 'chrome_download',
    CLAIM_TAB: 'browser_claim_tab',
    LOCATOR_HANDLER: 'chrome_locator_handler',
    OWNED_TABS: 'chrome_owned_tabs',
    ALIAS_TAB: 'browser_alias_tab',
    SET_EXTRA_HTTP_HEADERS: 'chrome_set_extra_http_headers',
    EMULATE: 'chrome_emulate',
    GET_ATTRIBUTES: 'chrome_get_attributes',
    HOVER: 'chrome_hover',
    TYPE_INTO: 'chrome_type_into',
    HAR_EXPORT: 'chrome_har_export',
    MOCK_RESPONSE: 'chrome_mock_response',
    BASIC_AUTH: 'chrome_basic_auth',
    SET_CHECKED: 'chrome_set_checked',
    COMBOBOX_SELECT: 'chrome_combobox_select',
    FILL_LWC: 'chrome_fill_lwc',
    TYPEAHEAD_PROBE: 'chrome_typeahead_probe',
    HELP: 'chrome_help',
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
    description:
      'List every currently open browser window and its tabs. Use to resolve windowId/tabId before navigate, single-window enforcement, or session inspection. Example: {} → {windows:[{id, focused, tabs:[{id, url, title, active}]}]} Cross-ref: browser_tabs (MCP @playwright/mcp); context.pages, browser.contexts (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED,
    description:
      'List recorded flows published as dynamic MCP tools. Discovery surface for record_replay_flow_run; pair with the auto-exposed flow.<slug> tools. Example: {} → {flows:[{id, slug, name, version, variables}]}',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
    description:
      'Run a recorded flow by ID with per-step outcomes. Prefer the dynamic flow.<slug> tool when slug is known; this is the explicit fallback. Example: {flowId:"f1", args:{q:"hi"}} → {success, steps}',
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
    name: TOOL_NAMES.BROWSER.PERFORMANCE_TRACE,
    description:
      'Performance trace via action enum. Replaces chrome_performance_start_trace/stop_trace/analyze_insight. Example: {action:"start", reload:true, autoStop:true, durationMs:5000} → {started:true}; {action:"stop", saveToDownloads:true} → {stopped, path}; {action:"analyze", insightName:"LCP"} → {summary}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'analyze'],
          description:
            'start=begin trace, stop=end + optionally save, analyze=summary of last trace.',
        },
        reload: {
          type: 'boolean',
          description: 'For action=start: reload page after start (cache-ignored).',
        },
        autoStop: { type: 'boolean', description: 'For action=start: auto-stop after durationMs.' },
        durationMs: {
          type: 'number',
          description: 'For action=start: auto-stop after this many ms (default 5000).',
        },
        saveToDownloads: {
          type: 'boolean',
          description: 'For action=stop: save trace JSON to Downloads (default true).',
        },
        filenamePrefix: {
          type: 'string',
          description: 'For action=stop: filename prefix for the saved trace.',
        },
        insightName: {
          type: 'string',
          description: 'For action=analyze: optional insight key (e.g. "LCP").',
        },
        timeoutMs: {
          type: 'number',
          description: 'For action=analyze: native-host timeout (ms, default 60000).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.READ_PAGE,
    description:
      'Return an accessibility-tree snapshot. format:"tree" (default) is the viewport-visible interactive element tree; format:"aria" is a Playwright-style ARIA snapshot (4-6x smaller, ref-roundtripping with chrome_click_element) — replaces former chrome_aria_snapshot. If your target is missing, fall back to chrome_computer screenshot for coordinates. Example: {filter:"interactive"} → {nodes:[]}; {format:"aria"} → {snapshot:"...", refs}. Cross-ref: browser_snapshot (MCP @playwright/mcp); page.accessibility.snapshot, locator.ariaSnapshot (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['tree', 'aria'],
          description:
            'Snapshot format. "tree" (default) = viewport interactive tree; "aria" = Playwright-style ARIA snapshot (compact, ref-driven).',
        },
        interactiveOnly: {
          type: 'boolean',
          description:
            'For format=aria: include only interactive elements (default true). Ignored when format=tree.',
        },
        includeRefs: {
          type: 'boolean',
          description: 'For format=aria: print [ref=…] markers so callers can pivot to refs.',
        },
        maxDepth: {
          type: 'number',
          description: 'For format=aria: cap traversal depth.',
        },
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
      'Read/write/clear a tab\'s localStorage or sessionStorage via a MAIN-world shim. IndexedDB is out of scope. Example: {action:"get", scope:"local", key:"flag"} → {value:"on", exists:true} Cross-ref: browserContext.storageState, page.evaluate(() => localStorage) (Playwright API).',
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
      'List frames in a tab via chrome.webNavigation.getAllFrames as {frameId, parentFrameId, url, errorOccurred}; main doc is frameId:0. Use to discover stable frameIds for iframe targeting. Read-only. Example: {tabId:42} → {frames:[{frameId:0}]} Cross-ref: page.frames, page.frameLocator (Playwright API).',
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
      'Manage Chrome tab groups (create/update/query/get/add_tabs/remove_tabs/move) for partitioning agent tabs from user tabs. Colors from Chrome\'s fixed palette. Example: {action:"create", tabIds:[1,2], title:"agent", color:"blue"} → {groupId}',
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
      'Mouse/keyboard/screenshot omnibus by raw coordinates (Anthropic computer-use API contract). Niche: when you only have screen coordinates, not a selector or ref. For selector-driven actions prefer chrome_click_element / chrome_fill_or_select which have richer error envelopes. Example: {action:"screenshot"} → {image, width, height} Cross-ref: browser_take_screenshot (MCP @playwright/mcp); page.screenshot, locator.screenshot (Playwright API).',
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
          description:
            'Selector for fill (alternative to ref). Same kinds as chrome_click_element: CSS / XPath / Playwright-style `role:`/`label:`/`placeholder:`/`alt:`/`title:`/`testid:`/`text:`.',
        },
        selectorType: SELECTOR_TYPE_PROP,
        index: SELECTOR_INDEX_PROP,
        multi: SELECTOR_MULTI_PROP,
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
        force: {
          type: 'boolean',
          description:
            'IMP-0097: skip the actionability suite for click/dblclick/triple_click/drag/hover/fill/fill_form/key/type actions. scrollIntoView still runs. Default false.',
        },
        actionabilityTimeoutMs: {
          type: 'number',
          description:
            'IMP-0097: per-call cap on the actionability wait, in milliseconds. Default 5000.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.USERSCRIPT,
    description:
      'Persistent CSP-aware user scripts via chrome.userScripts. Actions: create/list/get/update/remove/send_command. mode:"once" matches chrome_inject_script semantics but with CSP safety. Niche: persistent or CSP-blocked sites. For one-shot CDP eval use chrome_javascript. Example: {action:"create", args:{code:"...", runAt:"document_end"}} → {id, strategy}',
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
      'Navigate to a URL, refresh, or go back/forward in history. Optionally open in a new window/tab with custom size. Example: {url:"https://example.com"} → {tabId, url, status:"complete"} Cross-ref: browser_navigate (MCP @playwright/mcp); page.goto (Playwright API).',
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
        newTab: {
          type: 'boolean',
          description:
            'Force a fresh tab even when a same-host tab is already open. Without this flag the navigate tool activates the existing tab instead — including when only the hash fragment differs, which is a no-op on the existing DOM. If you want a fresh DOM in the SAME tab use reload:true. Ignored when tabId is also set. Defaults to false.',
        },
        reload: {
          type: 'boolean',
          description:
            'When the target URL matches an already-open tab, force a real reload of that tab instead of just activating it. Use this whenever your task requires a fresh DOM (form state cleared, scripts re-run, counters reset) — without it, navigating to the same URL (or only a different hash fragment) silently returns the previous page state. Defaults to false.',
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
      'Open many URLs at once and return their tabIds; tabs open backgrounded by default. Pair with chrome_wait_for kind:"load_state" state:"complete" to drain sequentially. maxConcurrent blocks per batch. Example: {urls:["a.com","b.com"], maxConcurrent:2} → {tabIds:[101,102]}',
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
    name: TOOL_NAMES.BROWSER.CLOSE_TABS,
    description:
      'Close tabs via action enum. Replaces chrome_close_tab + chrome_close_tabs_matching + browser_close_my_tabs. Example: {action:"ids", tabIds:[3,5]} → {closed:[3,5]}; {action:"matching", urlMatches:"/example/", dryRun:true} → {matched, tabIds}; {action:"mine"} → close all caller-owned tabs. Cross-ref: browser_close (MCP @playwright/mcp); page.close (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['ids', 'matching', 'mine'],
          description:
            'ids=close specific tabIds; matching=bulk close by url/title/age filter; mine=close all tabs owned by the calling client.',
        },
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'For action=ids: tab IDs to close. Omit for active tab.',
        },
        url: {
          type: 'string',
          description: 'For action=ids: alternative to tabIds — close tabs matching this URL.',
        },
        urlMatches: {
          type: 'string',
          description:
            'For action=matching: URL filter. Plain text → case-insensitive substring; wrap in /…/flags for regex.',
        },
        titleMatches: {
          type: 'string',
          description: 'For action=matching: title filter, same syntax as urlMatches.',
        },
        olderThanMs: {
          type: 'number',
          description: 'For action=matching: tabs older than N ms.',
        },
        exceptTabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'For action=matching/mine: tab IDs to always preserve.',
        },
        windowId: {
          type: 'number',
          description: 'For action=matching: optional window scope.',
        },
        dryRun: {
          type: 'boolean',
          description: 'For action=matching/mine: report matched tabs without closing.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SWITCH_TAB,
    description:
      'Switch focus to a specific browser tab. Example: {tabId:7} → {activated:true, windowId} Cross-ref: browser_tabs (MCP @playwright/mcp); page.bringToFront (Playwright API).',
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
    description:
      'Fetch a page\'s raw HTML, plain text, or reader-mode Markdown. Optionally scoped by selector, saved to savePath, or fetched in a background tab. Example: {url:"https://example.com", markdownContent:true} → {markdown:"..."}',
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
            'Get the visible HTML content of the page. If true, textContent and markdownContent are ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description:
            'Get the visible text content of the page with metadata. Ignored if htmlContent or markdownContent is true (default: true)',
        },
        markdownContent: {
          type: 'boolean',
          description:
            'Run reader-mode extraction (Mozilla Readability) and return the article as Markdown (Turndown + GFM, supports tables/fenced code/task lists). Ignored if htmlContent is true; overrides textContent default. (default: false)',
        },

        selector: {
          type: 'string',
          description:
            'CSS selector to get content from a specific element. If provided, only content from this element will be returned. Has no effect on markdownContent (reader-mode always extracts the main article).',
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
    description:
      'Send a network request from the browser carrying its cookies and origin context. Supports method, headers, body or formData, timeout. Example: {url:"https://api.example.com/me", method:"GET"} → {status:200, body:"..."} Cross-ref: browser_network_request (MCP @playwright/mcp); request.fetch, apiRequestContext.fetch (Playwright API).',
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
      'Capture network traffic on a tab. action=start begins; stop returns the buffer; flush drains without stopping; status reads state. needResponseBody=true uses Debugger (may conflict with DevTools). Response bodies capped at 1 MiB. Example: {action:"start"} → {captureId, started:true} Cross-ref: browser_network_requests (MCP @playwright/mcp); page.on("request"), page.on("response") (Playwright API).',
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
      'Wait for the next network response matching urlPattern on a tab and return its parsed JSON body. Attaches the debugger Network domain for the wait duration. count>1 batches matches into one call. Example: {urlPattern:"*/api/users*", count:1, timeoutMs:5000} → {ok:true, matched, responses:[...]} Cross-ref: page.route, route.continue, route.fulfill (Playwright API).',
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
    description:
      'Wait for the next browser download (optionally matching filenameContains) and return its details. Set waitForComplete to block until the file finishes writing. Example: {filenameContains:".csv", waitForComplete:true} → {id, filename, url, state, size}',
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
    description:
      'Search or delete browsing history via chrome.history. action:"search" (default) filters by text/time/maxResults; action:"delete" removes by url, startTime+endTime range, or all:true (requires confirmDeleteAll:true). Permanent. Example: {action:"search", text:"github"} → {items:[...]}; {action:"delete", url:"https://x.com"} → {deleted:true}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'delete'],
          description: 'search (default) or delete. Omit for search-mode.',
        },
        text: {
          type: 'string',
          description: 'For action=search: query against URLs/titles. Empty returns all in range.',
        },
        startTime: {
          type: 'string',
          description:
            'For search: start of range (default 24h ago). For delete: required with endTime for range mode. Supports ISO, "1 day ago", "yesterday", etc.',
        },
        endTime: {
          type: 'string',
          description: 'End of range. Same date formats. Default current time.',
        },
        maxResults: {
          type: 'number',
          description: 'For action=search: max entries (default 100).',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description: 'For action=search: filter out URLs currently open in any tab.',
        },
        url: {
          type: 'string',
          description: 'For action=delete: remove visits to this exact URL.',
        },
        all: {
          type: 'boolean',
          description: 'For action=delete: wipe entire history. Requires confirmDeleteAll:true.',
        },
        confirmDeleteAll: {
          type: 'boolean',
          description: 'Safety ack for delete + all:true.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK,
    description:
      'Bookmarks CRUD via action enum. Replaces the four separate chrome_bookmark_search/add/update/delete tools. Example: {action:"search", query:"github"} → {bookmarks:[...]}; {action:"add", url, title, parentId} → {bookmarkId}; {action:"update", bookmarkId, newTitle} → {success:true}; {action:"delete", bookmarkId} → {success:true, deleted:1}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'add', 'update', 'delete'],
          description:
            'Which bookmark operation. search=query/list, add=create, update=rename/move/re-URL, delete=remove.',
        },
        query: {
          type: 'string',
          description: 'For action=search: match against bookmark titles/URLs. Empty returns all.',
        },
        maxResults: {
          type: 'number',
          description: 'For action=search: max results (default 50).',
        },
        folderPath: {
          type: 'string',
          description:
            'For action=search: optional folder path/ID to scope (e.g. "Work/Projects").',
        },
        url: {
          type: 'string',
          description:
            'For action=add: URL to bookmark (defaults to active tab). For action=update/delete: lookup by URL when bookmarkId omitted.',
        },
        title: {
          type: 'string',
          description:
            'For action=add: bookmark title (defaults to page title). For action=delete: optional title hint for disambiguation.',
        },
        parentId: {
          type: 'string',
          description: 'For action=add: parent folder path/ID (defaults to "Bookmarks Bar").',
        },
        createFolder: {
          type: 'boolean',
          description: 'For action=add: auto-create missing parent folder (default false).',
        },
        bookmarkId: {
          type: 'string',
          description:
            'For action=update/delete: ID of bookmark to operate on. Preferred over url-based lookup.',
        },
        matchTitle: {
          type: 'string',
          description:
            'For action=update: optional title substring to disambiguate when matching by url.',
        },
        newUrl: {
          type: 'string',
          description: 'For action=update: new URL.',
        },
        newTitle: {
          type: 'string',
          description: 'For action=update: new title.',
        },
        newParentId: {
          type: 'string',
          description: 'For action=update: new parent folder path/ID.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.COOKIES,
    description:
      'Cookies CRUD via chrome.cookies. Replaces chrome_get_cookies/set_cookie/remove_cookie. Example: {action:"get", domain:".linkedin.com", name:"li_at"} → {cookies:[...]}; {action:"set", url:"https://x.com", name, value} → {cookie}; {action:"remove", url, name} → {removed:{...}}. Cross-ref: browserContext.cookies, browserContext.addCookies (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'remove'],
          description: 'get=list, set=create/update single, remove=delete single.',
        },
        url: {
          type: 'string',
          description:
            'For get: scope by URL. For set: required (derives default domain/path). For remove: required to identify cookie.',
        },
        domain: {
          type: 'string',
          description:
            'For get: scope by domain (e.g. "linkedin.com"). For set: cookie domain (defaults to host-only).',
        },
        name: {
          type: 'string',
          description:
            'For get: filter to this name. For set: cookie name. For remove: required to identify cookie.',
        },
        value: { type: 'string', description: 'For set: cookie value.' },
        path: { type: 'string', description: 'Cookie path (get filter or set value).' },
        secure: { type: 'boolean', description: 'Cookie Secure flag (get filter or set value).' },
        session: { type: 'boolean', description: 'For get: filter session vs persistent cookies.' },
        httpOnly: { type: 'boolean', description: 'For set: HttpOnly flag.' },
        sameSite: {
          type: 'string',
          enum: ['no_restriction', 'lax', 'strict', 'unspecified'],
          description: 'For set: SameSite attribute (default "unspecified").',
        },
        expirationDate: {
          type: 'number',
          description: 'For set: expiry in seconds since epoch. Omit for session cookie.',
        },
        storeId: { type: 'string', description: 'Optional cookie store ID (e.g. incognito).' },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT,
    description:
      'Semantic vector search across content of currently open tabs. Returns matching tabs with relevance scores and snippets. Example: {query:"pricing page"} → {matches:[{tabId, score, snippet}]}',
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
    name: TOOL_NAMES.BROWSER.JAVASCRIPT,
    description:
      'Execute JS via CDP Runtime.evaluate in a tab (one-shot, CSP-bypassing). For persistent injection use chrome_userscript; for chrome.scripting.executeScript with event bridge use chrome_inject_script. Example: {code:"document.title"} → {success:true, result:"...", truncated:false} Cross-ref: browser_evaluate, browser_run_code_unsafe (MCP @playwright/mcp); page.evaluate, locator.evaluate (Playwright API).',
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
        writeResultTo: {
          type: 'string',
          description:
            'Absolute file path. If set, the bridge writes the JSON-serialized `result` to this path and returns a small ack ({writtenTo, bytes, sha256}) instead of the full payload — keeps large blobs (e.g. ~200KB JSON fetches) out of the LLM context. Parent directories are created if missing. Relative paths are rejected with INVALID_ARGS.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLICK,
    description:
      'Click by selector / ref / coordinates via CDP Input.dispatchMouseEvent (trusted event, fires React onClick + dnd-kit). Niche: the canonical click. For idempotent checkbox/radio use chrome_set_checked; for coordinate-only mouse work without a selector use chrome_computer.left_click. Example: {selector:"#submit"} → {clicked:true, frameId:0} Cross-ref: browser_click (MCP @playwright/mcp); page.click, locator.click (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_PROP,
        selectorType: SELECTOR_TYPE_PROP,
        index: SELECTOR_INDEX_PROP,
        multi: SELECTOR_MULTI_PROP,
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
        force: {
          type: 'boolean',
          description:
            'IMP-0097: skip the actionability suite (visible/stable/enabled/hit-test). scrollIntoView still runs. Default false. Use sparingly — only when the suite is producing a false positive (e.g. pseudo-element targets the hit-test cannot resolve).',
        },
        actionabilityTimeoutMs: {
          type: 'number',
          description:
            'IMP-0097: per-call cap on time spent waiting for actionability to pass, in milliseconds. Default 5000 (matches Playwright). Raise on pages with long settle (heavy SPA hydration), lower to fail fast on a known-bad target.',
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
      'Set value of plain text inputs or <select> options via DOM .value + input/change events. Niche: when the page only listens for input/change. For React onChange that requires keystroke-by-keystroke handling, use chrome_type_into; for combobox autocomplete (Headless UI / Radix), use chrome_combobox_select; for rich editors (contenteditable), use chrome_paste. Example: {selector:"#email", value:"a@b.com"} → {filled:true} Cross-ref: browser_fill_form (MCP @playwright/mcp); locator.fill, page.selectOption (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_PROP,
        selectorType: SELECTOR_TYPE_PROP,
        index: SELECTOR_INDEX_PROP,
        multi: SELECTOR_MULTI_PROP,
        ref: REF_PROP,
        value: {
          type: ['string', 'number', 'boolean'],
          description:
            'Value to fill. For text inputs: string. For checkboxes/radios: boolean. For selects: option value or text.',
        },
        force: {
          type: 'boolean',
          description:
            'IMP-0097: skip the actionability suite (visible/enabled/editable). scrollIntoView still runs. Default false.',
        },
        actionabilityTimeoutMs: {
          type: 'number',
          description:
            'IMP-0097: per-call cap on the actionability wait, in milliseconds. Default 5000.',
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
      'Request the user to manually select elements on the page as a human-in-the-loop fallback. Returns refs compatible with click/fill tools, including iframe frameId. Example: {requests:[{prompt:"pick login"}], timeoutMs:30000} → {refs:[{ref:"r1", frameId:0}]}',
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
      'Simulate keyboard input — single keys, chord (Cmd+S), or shortcut sequences via CDP Input.dispatchKeyEvent. Niche: keyboard-only flows (shortcuts, navigation). For typing text into a field use chrome_type_into or chrome_fill_or_select. Example: {shortcut:"paste"} → {dispatched:true} Cross-ref: browser_press_key (MCP @playwright/mcp); page.keyboard.press, page.keyboard.type, keyboard.down, keyboard.up (Playwright API).',
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
      // "exactly one of keys/shortcut" used to live here as `anyOf:
      // [{required:['keys']},{required:['shortcut']}]`, but the Anthropic
      // /v1/messages API rejects tools whose input_schema has anyOf/oneOf/allOf
      // at the top level. The constraint is enforced at dispatch time in
      // keyboard.ts's KeyboardTool.execute instead (returns INVALID_ARGS with
      // arg:"keys|shortcut" when neither is provided). See issue #202.
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    description:
      'Capture console output: snapshot mode (one-time ~2s wait) or buffer mode (persistent per-tab, instant read/clear). Response.truncation reports caps; retry with raw:true (snapshot only) if argsTruncated. Example: {mode:"buffer", onlyErrors:true} → {messages:[...], truncation} Cross-ref: browser_console_messages (MCP @playwright/mcp); page.on("console") (Playwright API).',
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
    name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
    description:
      'Upload files to a form\'s file input via CDP. Accepts filePath, fileUrl, or base64Data. Example: {selector:"input[type=file]", filePath:"/tmp/a.png"} → {uploaded:true, count:1} Cross-ref: browser_file_upload (MCP @playwright/mcp); locator.setInputFiles, page.setInputFiles (Playwright API).',
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
    description:
      'Handle JS alert/confirm/prompt dialogs via CDP. Actions: handle_dialog (one-shot accept/dismiss), register_default (per-tab auto-handler, holds persistent debugger attach), unregister_default, list_defaults. Example: {action:"handle_dialog", behavior:"accept"} → {handled:true} Cross-ref: browser_handle_dialog (MCP @playwright/mcp); page.on("dialog"), dialog.accept, dialog.dismiss (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['handle_dialog', 'register_default', 'unregister_default', 'list_defaults'],
          description:
            'Action to perform. Omit (or pass "handle_dialog") for the legacy one-shot behavior.',
        },
        behavior: {
          type: 'string',
          enum: ['accept', 'dismiss'],
          description:
            'For action="handle_dialog": "accept" or "dismiss" the currently open dialog.',
        },
        defaultBehavior: {
          type: 'string',
          enum: ['accept', 'dismiss', 'prompt_with_text'],
          description:
            'For action="register_default": how to auto-answer future dialogs on this tab. "prompt_with_text" requires `promptText` and only differs from "accept" for prompt() calls.',
        },
        promptText: {
          type: 'string',
          description:
            'Prompt input text. For action="handle_dialog" with behavior="accept", forwarded to prompt(). For action="register_default" with defaultBehavior="prompt_with_text", required — used as the auto-answer for every prompt() on this tab.',
        },
        ...TAB_TARGETING_NO_BG,
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GIF_RECORDER,
    description:
      'Record a tab as an animated GIF. action=start uses fixed-FPS sampling; action=auto_start captures on chrome_computer/chrome_navigate success; action=stop finalises and saves. Example: {action:"start", fps:5, durationMs:10000} → {recordingId, started:true}',
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
    name: TOOL_NAMES.BROWSER.DIAGNOSTICS,
    description:
      'Extension diagnostics via action enum. Replaces chrome_debug_dump + chrome_queue_inspect + chrome_runtime_info + chrome_dev_reload. Example: {action:"dump_logs", level:"error", limit:20} → {entries:[...]}; {action:"queue"} → {pending, owned}; {action:"runtime_info"} → {clientId, buildHash, toolNames}; {action:"dev_reload"} → triggers chrome.runtime.reload().',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['dump_logs', 'queue', 'runtime_info', 'dev_reload'],
          description:
            'dump_logs=recent debug entries; queue=per-tab queue snapshot; runtime_info=SW identity / buildHash / toolNames; dev_reload=trigger chrome.runtime.reload() (dev only).',
        },
        requestId: {
          type: 'string',
          description: 'For action=dump_logs: correlation id filter.',
        },
        tool: {
          type: 'string',
          description: 'For action=dump_logs: only entries for this tool name.',
        },
        tabId: {
          type: 'number',
          description: 'For action=dump_logs/queue: scope to this tabId.',
        },
        level: {
          type: 'string',
          enum: ['debug', 'info', 'warn', 'error'],
          description: 'For action=dump_logs: severity filter.',
        },
        sinceMs: {
          type: 'number',
          description: 'For action=dump_logs: only entries newer than this epoch-ms.',
        },
        limit: {
          type: 'number',
          description: 'For action=dump_logs: max entries (default 200, max 1000).',
        },
        clear: {
          type: 'boolean',
          description: 'For action=dump_logs: wipe buffer instead of returning entries.',
        },
        persist: {
          type: 'boolean',
          description: 'For action=dump_logs: toggle persist-through-SW-restart (default off).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.ASSERT,
    description:
      'Run one or more predicates against the page and return structured pass/fail; ok is AND of all predicates. Use after a step to declaratively verify outcomes instead of inferring from tool returns. Example: {predicates:[{kind:"visible", selector:"#toast"}]} → {ok:true, results:[...]}',
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
      'Wait for one of: element, network idle, response, JS expression, load state, or URL pattern. Replaces JS spin-polls. Example: {kind:"network", quietMs:500} → {success:true, tookMs} Cross-ref: browser_wait_for (MCP @playwright/mcp); page.waitForSelector, page.waitForFunction, page.waitForLoadState (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['element', 'network_idle', 'response_match', 'js', 'load_state', 'url'],
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
            'For kind="element": CSS selector, XPath, or Playwright-style locator. Either selector or ref must be provided.',
        },
        selectorType: SELECTOR_TYPE_PROP,
        index: SELECTOR_INDEX_PROP,
        multi: SELECTOR_MULTI_PROP,
        ref: {
          type: 'string',
          description: 'For kind="element": ref from chrome_read_page.',
        },
        state: {
          type: 'string',
          enum: ['present', 'absent', 'load', 'domcontentloaded', 'complete'],
          description:
            'Dual-purpose field. For kind="element": "present" (default) or "absent". For kind="load_state": "load" (default) | "domcontentloaded" | "complete" — wait for the corresponding `chrome.webNavigation` event on the target tab+frame. "complete" is a Playwright synonym for "load" and maps to the same event. Pre-checked via `document.readyState` so already-loaded pages resolve synchronously.',
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
        pattern: {
          type: 'string',
          description:
            'For kind="url": substring or /regex/flags matched against the tab URL (same syntax as chrome_intercept_response). Subscribes to `chrome.webNavigation.onCommitted` + `onHistoryStateUpdated` so SPA pushState transitions are caught. Pre-checked against the current URL so an already-matching tab resolves synchronously. Required for kind="url".',
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
      'Get or set per-MCP-client pacing. With profile, mutating tools sleep a profile-derived gap (anti-bot rhythm). With no args, returns current profile + resolved gap/jitter. Reads un-throttled. State resets on SW restart. Example: {profile:"careful"} → {profile, minGapMs, jitterMs}; {} → {profile:"off", minGapMs:0, jitterMs:0}.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['off', 'human', 'careful', 'fast'],
          description:
            'Pacing preset. Omit to read current state. off=no throttle (default); human=600-1200ms gap with jitter; careful=1500-3000ms (LinkedIn-grade); fast=tab-lock-only serialization with no extra wait.',
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
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NOTIFICATIONS,
    description:
      'Push native OS notifications via chrome.notifications. Actions: create (title+message required, up to 2 buttons), clear, clear_all, get_all. iconUrl must be a data URI or extension-relative path. Example: {action:"create", title:"Done", message:"Task finished"} → {notificationId}',
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
      'Read or write the system clipboard via the offscreen document (only context where navigator.clipboard works from a SW). Plain text only — no image/HTML. Example: {action:"write", text:"hello"} → {written:true}',
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
      'Inspect and restore recently-closed tabs/windows via chrome.sessions. Lets an agent un-close a tab without re-navigating. Example: {action:"restore", sessionId:"abc"} → {restored:{sessionId, tab}}',
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
      'Memory and audio controls: discard, mute, unmute, set_auto_discardable. Example: {action:"mute", tabId:3} → {id, mutedInfo, discarded, autoDiscardable}',
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
    name: TOOL_NAMES.BROWSER.PRINT_TO_PDF,
    description:
      'Save a tab as PDF via CDP Page.printToPDF. Returns base64 by default; with savePath the bridge writes to disk and returns {path, bytes}. Common page/margin options exposed. Example: {savePath:"/tmp/out.pdf", landscape:true} → {path, bytes} Cross-ref: page.pdf (Playwright API).',
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
      'Block or redirect requests via declarativeNetRequest session rules (request-side). Niche: cancel/302 a URL pattern before the network sees it. For response-body replacement use chrome_mock_response (CDP Fetch.fulfillRequest); for header injection use chrome_set_extra_http_headers (CDP). Example: {action:"add", urlFilter:"||tracker.com", ruleAction:"block"} → {ruleId:1, success:true} Cross-ref: page.route, browserContext.route (Playwright API).',
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
      'Set or clear a small badge on the extension icon (text truncated to ~4 chars by Chrome). action=set takes text+optional color/tabId; action=clear empties it (per-tab if tabId set, else global). Example: {action:"set", text:"ERR", color:"#FF0000"} → {success:true}',
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
      'Prevent system sleep during long runs via chrome.power.requestKeepAwake. Idempotent. Actions: enable (level=display keeps screen on, system lets screen sleep), disable. Released on extension reload. Example: {action:"enable", level:"system"} → {enabled:true, level:"system"}',
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
      'Register transient right-click menu items via chrome.contextMenus; clicks emit context_menu_clicked events over the bridge. Actions: add, update, remove, remove_all. Example: {action:"add", title:"Use as target", contexts:["page","selection"]} → {id:"menu_1"}',
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
      'Focus an element by selector or ref before keyboard input (chrome_paste, chrome_keyboard). Reports focused:document.activeElement===el so callers detect disabled/unfocusable targets. Example: {selector:"#search"} → {focused:true, tagName:"INPUT"} Cross-ref: locator.focus, elementHandle.focus (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_PROP,
        selectorType: SELECTOR_TYPE_PROP,
        index: SELECTOR_INDEX_PROP,
        multi: SELECTOR_MULTI_PROP,
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page. Required if `selector` is omitted; mutually exclusive with `selector`.',
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
        force: {
          type: 'boolean',
          description:
            'IMP-0097: skip the visibility check. scrollIntoView still runs. Default false.',
        },
        actionabilityTimeoutMs: {
          type: 'number',
          description:
            'IMP-0097: per-call cap on the actionability wait, in milliseconds. Default 5000. (Focus runs only the visibility check synchronously today; this field is reserved for the future async-friendly variant.)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PASTE,
    description:
      'Focus element + dispatch ClipboardEvent + execCommand("paste") to land text into rich-text editors (CKEditor, TinyMCE, Slate, contenteditable). Niche: editors that ignore plain .value or keystrokes. For plain inputs use chrome_fill_or_select. Example: {selector:"#msg", text:"hi"} → {focused:true, pasted:true, mode:"both"}',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the target. Mutually exclusive with `ref`.',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page. Mutually exclusive with `selector`.',
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
      'Select text inside an element via setSelectionRange (inputs) or DOM Range (everything else). Pass substring OR start+end. Pairs with chrome_clipboard/chrome_paste. Example: {selector:"#bio", substring:"hello"} → {start, end, mode:"dom-range"}',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the target. Mutually exclusive with `ref`.',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page. Mutually exclusive with `selector`.',
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
      'Manage Chrome windows via chrome.windows (create/focus/update/close). Useful for incognito sandboxes or popping a window to front. Example: {action:"create", url:"https://x.com", incognito:true} → {Window}',
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
      'Live Core Web Vitals collector via PerformanceObserver in MAIN world. Lighter than chrome_performance_*. Example: {action:"start", reload:true} → {installed:true, lcpMs, clsScore, inpMs, fcpMs, ttfbMs}',
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
      'Query user idle state via chrome.idle.queryState (active|idle|locked) to back off intrusive ops or skip screenshots when locked. detectionIntervalSec accepts 15..14400 (default 60). Example: {detectionIntervalSec:120} → {state:"active", detectionIntervalSec:120}',
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
      'Schedule one-shot or repeating chrome.alarms callbacks; fires broadcast as alarm_fired runtime messages. Actions: create, clear, clear_all, get, get_all. Example: {action:"create", name:"poll", delayInMinutes:5, periodInMinutes:5} → {success:true}',
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
      'Wipe browsingData stores (cookies, cache, localStorage, history, etc.) via chrome.browsingData.remove. Niche: bulk multi-store wipe. For single-cookie removal use chrome_cookies({action:"remove"}); for single-URL history deletion use chrome_history({action:"delete"}). Example: {dataTypes:["cookies","cache"], since:0} → {success:true}',
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
      'Set/clear/inspect proxy config via chrome.proxy.settings. Modes: direct | system | fixed_servers (needs singleProxy) | pac_script (needs pacUrl). Scope is always regular (incognito untouched). Example: {action:"set", mode:"fixed_servers", singleProxy:{host:"1.2.3.4", port:8080}} → {applied:true}',
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
      'OAuth2 + profile lookup via chrome.identity for calling Google APIs without browser consent flows. Requires oauth2.client_id in manifest. Actions: get_token, remove_token, get_profile. Example: {action:"get_token", scopes:["openid","email"], interactive:false} → {token, scopes}',
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
      'Drag from one element to another by synthesizing the full HTML5 DnD + Pointer-Event chain (pointerdown→dragstart→N moves→drop→dragend). Hidden/not-found targets surface as INVALID_ARGS. Example: {fromSelector:"#card1", toSelector:"#col2", steps:10} → {steps, fromBox, toBox} Cross-ref: browser_drag, browser_drop (MCP @playwright/mcp); page.dragAndDrop, locator.dragTo (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        fromSelector: {
          type: 'string',
          description:
            'Selector for the drag source. Accepts CSS, XPath (via `selectorType="xpath"`), or Playwright-style prefixed forms (`role:button[name="Card"]`, `label:Email`, etc.). Mutually exclusive with `fromRef`.',
        },
        fromSelectorType: {
          ...SELECTOR_TYPE_PROP,
          description:
            'Optional selector kind for `fromSelector`. Defaults to `css`. See chrome_click_element for the full list.',
        },
        fromIndex: SELECTOR_INDEX_PROP,
        fromRef: {
          type: 'string',
          description:
            'Element ref (chrome_read_page) for the drag source. Mutually exclusive with `fromSelector`.',
        },
        toSelector: {
          type: 'string',
          description:
            'Selector for the drop target — same kinds as `fromSelector`. Mutually exclusive with `toRef`.',
        },
        toSelectorType: {
          ...SELECTOR_TYPE_PROP,
          description: 'Optional selector kind for `toSelector`. Defaults to `css`.',
        },
        toIndex: SELECTOR_INDEX_PROP,
        toRef: {
          type: 'string',
          description: 'Element ref for the drop target. Mutually exclusive with `toSelector`.',
        },
        multi: SELECTOR_MULTI_PROP,
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
        force: {
          type: 'boolean',
          description:
            'IMP-0097: skip the actionability suite (visible/stable/hit-test) on both source and target. scrollIntoView still runs. Default false.',
        },
        actionabilityTimeoutMs: {
          type: 'number',
          description:
            'IMP-0097: per-call cap on the actionability wait for each endpoint, in milliseconds. Default 5000.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.DOWNLOAD,
    description:
      'List or cancel downloads via chrome.downloads. Replaces chrome_download_list and chrome_download_cancel. For wait-for-next-download semantics, use chrome_handle_download (separate). Example: {action:"list", state:"in_progress"} → {count, items:[...]}; {action:"cancel", downloadId:42} → {cancelled:true, postState}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'cancel'],
          description: 'list=enumerate, cancel=stop an in-progress download.',
        },
        state: {
          type: 'string',
          enum: ['in_progress', 'complete', 'interrupted', 'all'],
          description: 'For action=list: filter by state (default all).',
        },
        filenameContains: {
          type: 'string',
          description: 'For action=list: case-insensitive substring on basename.',
        },
        limit: {
          type: 'number',
          description: 'For action=list: cap (1..100, default 25).',
        },
        downloadId: {
          type: 'number',
          description: 'For action=cancel: download id from list or chrome.downloads.onCreated.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLAIM_TAB,
    description:
      "Claim an unowned tab into the calling client's owned set so implicit tab-resolution can target it. Use force:true to seize a tab owned by another client (audit-logged). Example: {tabId:42} → {tabId:42, previousOwner:null}",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to claim for the calling client.',
        },
        force: {
          type: 'boolean',
          description:
            'When true, claim the tab even if another client currently owns it. The previous owner is reported in the response and audit-logged via `debugLog.warn`. Defaults to false — without `force`, claiming an owned-by-other tab returns TAB_NOT_OWNED. Only use when you know the previous owner is gone (stale session, crashed bridge) or when intentionally handing off between operator-driven sessions.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: TOOL_NAMES.RECORD_REPLAY.FLOW_DELETE,
    description:
      'Delete a recorded flow by ID; always unpublishes first so the dynamic flow.<slug> MCP tool disappears. Example: {flowId:"f1"} → {deleted:true, unpublished:true, flowId:"f1"}',
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
  {
    name: TOOL_NAMES.BROWSER.LOCATOR_HANDLER,
    description:
      'Auto-dismiss sticky overlays (cookie banners, GDPR modals) that intercept clicks. Actions: register/list/remove/clear a {selector, dismissSelector} pair; dismissAction defaults to click, "press" needs a key. Example: {action:"register", selector:".cookie-banner", dismissSelector:".accept"} → {handlerId} Cross-ref: page.addLocatorHandler, page.removeLocatorHandler (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'list', 'remove', 'clear'],
          description: 'Operation to perform.',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector for the overlay element to watch. The handler fires the dismiss action whenever any element matching this selector becomes visible. Required for `register`.',
        },
        dismissSelector: {
          type: 'string',
          description:
            'CSS selector for the element to click (or press a key on) once the trigger appears — typically the "Accept", "Close", or "Dismiss" button inside the overlay. Required for `register`. Re-queried on every fire so re-rendered overlays still match.',
        },
        dismissAction: {
          type: 'string',
          enum: ['click', 'press'],
          description:
            'How to dismiss the overlay. `click` (default) dispatches the full pointerdown→mousedown→pointerup→mouseup→click sequence on `dismissSelector`. `press` dispatches keydown→keypress→keyup with `key` (defaults to `Escape`) and requires `key` to be set.',
        },
        key: {
          type: 'string',
          description:
            'Key name to dispatch when `dismissAction: "press"`. Standard KeyboardEvent.key values like `Escape`, `Enter`, `Tab`. Required when `dismissAction: "press"`.',
        },
        times: {
          type: 'number',
          description:
            'Optional cap on total dismissals. Handler auto-removes once the limit is reached. Must be a positive integer. Default: unlimited.',
        },
        persistent: {
          type: 'boolean',
          description:
            'When true (default false), re-arm the handler after page navigation via `chrome.webNavigation.onDOMContentLoaded`. Non-persistent handlers vanish on navigation — useful for one-shot dismissal during a single page session.',
        },
        handlerId: {
          type: 'string',
          description: 'Handler ID returned from `register`. Required for `remove`.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab. Falls back to the active tab when omitted.',
        },
        windowId: {
          type: 'number',
          description: 'Target window for active-tab lookup when `tabId` is omitted.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.OWNED_TABS,
    description:
      'Return tabs owned by the calling MCP client as {tabId, windowId, url, title, active, isPinnedActive}. Narrower than chrome_get_windows_and_tabs (whole browser). Optional tabId filters to one row. Example: {} → {clientId, count:2, ownedTabs:[]}',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Optional filter — return only the row matching this tabId, if owned.',
        },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.ALIAS_TAB,
    description:
      'Bind a per-client alias to an owned tab so later calls can target it by name. Alias must match ^[a-z][a-z0-9_-]{0,31}$; tab must be in caller\'s owned set (else TAB_NOT_OWNED — claim it first). Example: {alias:"checkout", tabId:42} → {success:true, alias, tabId, previousTabId?}',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description:
            'Alias name. Must match ^[a-z][a-z0-9_-]{0,31}$ (lowercase, 1-32 chars, starts with a letter).',
        },
        tabId: {
          type: 'number',
          description: "Tab to alias. Defaults to the caller's activeTabId.",
        },
      },
      required: ['alias'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SET_CHECKED,
    description:
      'Idempotently set a checkbox or radio to a desired boolean state — re-clicks only if current state differs. Niche: idempotent toggle. For unconditional click use chrome_click_element. Example: {selector:"#tos", checked:true} → {checked:true, changed:true, priorChecked:false} Cross-ref: locator.setChecked, locator.check, locator.uncheck (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'testid'],
        },
        ref: { type: 'string' },
        index: { type: 'number' },
        multi: { type: 'boolean' },
        checked: { type: 'boolean', description: 'Target state. Required.' },
        force: { type: 'boolean', description: 'Skip the visibility/disabled check.' },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        frameId: { type: 'number' },
      },
      required: ['checked'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BASIC_AUTH,
    description:
      'Autoresponder for HTTP Basic/Digest 401 prompts via CDP Fetch.continueWithAuth — chrome_handle_dialog cannot. In-memory only. Actions: register, unregister, list, clear. Example: {action:"register", origin:"https://api.example.com", username:"u", password:"p"} → {success:true}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'unregister', 'list', 'clear'],
        },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        origin: {
          type: 'string',
          description:
            'Required for register/unregister. Origin like "https://api.example.com" or "*" wildcard.',
        },
        username: { type: 'string', description: 'Required for register.' },
        password: { type: 'string', description: 'Required for register. Never echoed back.' },
        scheme: { type: 'string', enum: ['basic', 'digest', 'any'] },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.MOCK_RESPONSE,
    description:
      'Replace response bodies for matching URLs via CDP Fetch.fulfillRequest (response-side mock). Niche: fake what the page receives. For block/redirect by URL pattern use chrome_block_or_redirect (DNR session rules — request-side); for header injection use chrome_set_extra_http_headers (CDP setExtraHTTPHeaders). Example: {action:"register", urlPattern:"/api/me", status:200, bodyJson:{ok:true}} → {handlerId} Cross-ref: page.route, route.fulfill (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'list_mocks', 'unregister_mock', 'clear'],
        },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        urlPattern: {
          type: 'string',
          description: 'Required for action:"register". Substring or /regex/flags.',
        },
        method: { type: 'string', description: 'Optional HTTP method filter (case-insensitive).' },
        status: { type: 'number', description: 'Response status. Default 200.' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'Response body. Mutex with bodyJson.' },
        bodyJson: {
          description:
            'Response body — auto-serialized to JSON + sets Content-Type:application/json if absent. Mutex with body.',
        },
        delayMs: { type: 'number', description: 'Artificial latency before the fake response.' },
        once: {
          type: 'boolean',
          description: 'Auto-unregister after first match. Default true.',
        },
        handlerId: { type: 'string', description: 'Required for action:"unregister_mock".' },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HAR_EXPORT,
    description:
      'Format chrome_network_capture buffers as HAR 1.2 JSON for DevTools/Charles/Playwright import. Read-only. Actions: export_from_active (inline, default), save_to_downloads (writes file to ~/Downloads). Response bodies capped at 1 MiB. Example: {action:"save_to_downloads", filename:"run.har"} → {downloadId, filename}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['export_from_active', 'save_to_downloads'],
          description: 'Operation. Defaults to "export_from_active".',
        },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        filename: {
          type: 'string',
          description:
            'Optional filename for save_to_downloads. Defaults to humanchrome-tab-<id>-<ts>.har. Non-filesystem-safe chars are stripped.',
        },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TYPE_INTO,
    description:
      'Type text into a focused element char-by-char with cadence, generating keypress/keydown/keyup events. Niche: anti-bot platforms or React/Vue onChange that require real keystrokes. For instant value-set, use chrome_fill_or_select. Example: {selector:"#q", text:"hello", perKeyDelayMs:60, pressEnter:true} → {typed, finalValue, pressedEnter} Cross-ref: browser_type (MCP @playwright/mcp); locator.type, locator.pressSequentially, locator.fill (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'testid'],
        },
        ref: { type: 'string' },
        index: { type: 'number' },
        multi: { type: 'boolean' },
        text: { type: 'string', description: 'Text to type (≤1024 chars).' },
        perKeyDelayMs: {
          type: 'number',
          description: 'Base delay between keystrokes (ms). Default 60.',
        },
        jitterMs: {
          type: 'number',
          description:
            '± random jitter added to perKeyDelayMs. Default 30. Set 0 for fixed cadence.',
        },
        pressEnter: { type: 'boolean', description: 'Send Enter after the last char.' },
        clearFirst: { type: 'boolean', description: 'Select-all + Delete before typing.' },
        force: {
          type: 'boolean',
          description: 'Skip the focus visibility/disabled/readonly check.',
        },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        frameId: { type: 'number' },
      },
      required: ['text'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HOVER,
    description:
      'Programmatic mouse hover to trigger tooltips and dropdown menus (mouseover→mouseenter→pointerenter chain with actionability). Pair with chrome_wait_for kind:"element" to wait for revealed UI. Example: {selector:".profile-card"} → {hovered:true, bbox, point, tagName} Cross-ref: browser_hover (MCP @playwright/mcp); page.hover, locator.hover (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'testid'],
        },
        ref: { type: 'string' },
        index: { type: 'number' },
        multi: { type: 'boolean' },
        position: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        force: { type: 'boolean', description: 'Skip the visibility + hit-test check.' },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        frameId: { type: 'number' },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_ATTRIBUTES,
    description:
      'Read DOM attributes, properties, and computed CSS by selector or ref. Read-only; closes the gap between chrome_assert, chrome_read_page, and chrome_javascript. Use for data-* scraping, input.value after fill, computed style assertions. Example: {selector:"#x", attributes:["href"]} → {attributes:{href:"..."}} Cross-ref: locator.getAttribute, elementHandle.getAttribute (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'testid'],
        },
        ref: { type: 'string' },
        index: { type: 'number' },
        multi: { type: 'boolean' },
        attributes: { type: 'array', items: { type: 'string' } },
        properties: { type: 'array', items: { type: 'string' } },
        computedStyles: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        frameId: { type: 'number' },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.EMULATE,
    description:
      'Per-tab CDP Emulation overrides AND network throttling. Actions: set_device, set_ua, set_locale, set_timezone, set_geolocation, set_color_scheme (CDP Emulation domain); set_network, reset_network (CDP Network domain, replaces former chrome_network_emulate). Example: {action:"set_timezone", timezone:"Europe/London"} → {ok:true}; {action:"set_network", offline:true} → {applied:true}. Cross-ref: browser_resize (MCP @playwright/mcp); page.setViewportSize, page.emulateMedia, browser.newContext (Playwright API).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'set_device',
            'set_ua',
            'set_locale',
            'set_timezone',
            'set_geolocation',
            'set_color_scheme',
            'set_network',
            'reset_network',
            'reset_all',
            'get_state',
          ],
        },
        offline: { type: 'boolean', description: 'For set_network: force offline.' },
        latencyMs: { type: 'number', description: 'For set_network: round-trip latency ms.' },
        downloadKbps: {
          type: 'number',
          description: 'For set_network: max download throughput kbps (-1 unbounded).',
        },
        uploadKbps: {
          type: 'number',
          description: 'For set_network: max upload throughput kbps (-1 unbounded).',
        },
        tabId: { type: 'number' },
        preset: { type: 'string', description: 'Device preset name (set_device).' },
        width: { type: 'number' },
        height: { type: 'number' },
        deviceScaleFactor: { type: 'number' },
        mobile: { type: 'boolean' },
        hasTouch: { type: 'boolean' },
        userAgent: { type: 'string' },
        acceptLanguage: { type: 'string' },
        platform: { type: 'string' },
        locale: { type: 'string', description: 'BCP 47 tag, e.g. "en-US".' },
        timezone: { type: 'string', description: 'IANA timezone name, e.g. "America/New_York".' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        accuracy: { type: 'number' },
        colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'] },
        reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'] },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SET_EXTRA_HTTP_HEADERS,
    description:
      'Inject extra HTTP request headers per tab via CDP Network.setExtraHTTPHeaders. Niche: add Authorization, X-Token, custom headers. For body replacement use chrome_mock_response; for block/redirect use chrome_block_or_redirect. Example: {action:"set", headers:{Authorization:"Bearer x"}} → {set:true}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'get', 'clear', 'list_tabs'],
          description: 'Operation to perform. Defaults to "set".',
        },
        tabId: {
          type: 'number',
          description:
            "Target tab. Required for set/get/clear (defaults to caller's owned tab); ignored for list_tabs.",
        },
        headers: {
          type: 'object',
          description:
            'Map of {headerName: value}. Required when action="set". All values must be strings.',
          additionalProperties: { type: 'string' },
        },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.COMBOBOX_SELECT,
    description:
      "Trusted keyboard commit for React/Ember/Headless UI combobox: focus, type query, wait for [role=option], ArrowDown, Enter. Niche: comboboxes that wire selection through option-keyboard events. For plain <select> use chrome_fill_or_select. Example: {comboboxSelector:'input',query:'LangGraph'} → {selectedIndex,selectedText,optionCount} Cross-ref: browser_select_option (MCP @playwright/mcp); page.selectOption, locator.selectOption (Playwright API).",
    inputSchema: {
      type: 'object',
      properties: {
        comboboxSelector: {
          type: 'string',
          description: 'CSS (or other selectorType) for the combobox input.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'testid'],
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page (alternative to comboboxSelector).',
        },
        query: { type: 'string', description: 'Text to type into the input (≤256 chars).' },
        matchText: {
          type: 'string',
          description: 'Option innerText to commit. Defaults to query. Case-insensitive.',
        },
        matchMode: {
          type: 'string',
          enum: ['exact', 'contains', 'startsWith'],
          description: 'How to compare option text against matchText. Default "contains".',
        },
        clearFirst: {
          type: 'boolean',
          description: 'Select-all + Delete before typing. Default true.',
        },
        optionSelector: {
          type: 'string',
          description: 'CSS for the option elements. Default \'[role="option"]\'.',
        },
        waitForOptionsMs: {
          type: 'number',
          description: 'Max time to wait for options to render after typing. Default 5000.',
        },
        perKeyDelayMs: {
          type: 'number',
          description: 'Base delay between keystrokes. Default 60.',
        },
        jitterMs: { type: 'number', description: '± random jitter on perKeyDelayMs. Default 30.' },
        force: {
          type: 'boolean',
          description: 'Skip the combobox visibility/disabled/readonly check.',
        },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        frameId: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILL_LWC,
    description:
      "Fill a Salesforce Lightning Web Component (LWC) control where chrome_fill_or_select / chrome_type_into don't persist. Sets the component's own @api value plus a native change event — the only path Salesforce Save honors. Deep shadow-DOM selector resolution. mode 'auto' picks by tag: lightning-input-rich-text→richtext (value = HTML string), lightning-combobox→combobox (value = option value e.g. 'C2'), else native input/textarea. Example: {selector:'lightning-combobox',index:0,value:'C2'} → {mode,valueAfter}",
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector for the target, resolved with a shadow-piercing deep query (NOT plain document.querySelector). Omit to default to any lightning-input-rich-text/lightning-combobox/input/textarea.',
        },
        index: {
          type: 'number',
          description: 'Which match to fill when the selector matches several. Default 0.',
        },
        value: {
          type: 'string',
          description:
            'Value to commit: an HTML string for richtext, the option value for combobox, or plain text for input/textarea.',
        },
        mode: {
          type: 'string',
          enum: ['richtext', 'combobox', 'input', 'auto'],
          description:
            "Force a fill strategy. 'auto' (default) picks by the resolved element's tagName.",
        },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        frameId: { type: 'number' },
      },
      required: ['value'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TYPEAHEAD_PROBE,
    description:
      "Diagnostic: types a sample char into a typeahead, reports every event (with isTrusted), every fetch, and final listbox state in one envelope. Use when typeahead/autocomplete isn't firing — check summary.{keydownFired,inputFired,lookupFetchFired}. Example: {selector:'input',sample:'S'} → {events,fetches,listboxFound}",
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS (or other selectorType) for the typeahead input.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'testid'],
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page (alternative to selector).',
        },
        sample: {
          type: 'string',
          description: 'Char(s) to type (≤16). Default "a".',
        },
        watchMs: {
          type: 'number',
          description: 'How long to observe events + fetches after typing. Default 3500.',
        },
        clearFirst: {
          type: 'boolean',
          description: 'Select-all + Delete before typing. Default true.',
        },
        networkUrlPattern: {
          type: 'string',
          description:
            'Regex (case-insensitive). When set, only fetches matching this pattern are returned. Default matches all.',
        },
        optionSelector: {
          type: 'string',
          description:
            'CSS for the option elements (used for the listbox snapshot). Default \'[role="option"]\'.',
        },
        tabId: { type: 'number' },
        windowId: { type: 'number' },
        frameId: { type: 'number' },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HELP,
    description:
      'Search or browse the tool catalog. Three modes: {} returns full index; {query} returns ranked matches (typos tolerated); {name} returns full description. Use {query} first when the canonical name is unknown. Example: {query:"click"} → {matches:[{name:"chrome_click_element",summary,score}...]}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Optional canonical tool name. When set, returns {name, summary, description}.',
        },
        query: {
          type: 'string',
          description:
            'Free-text search across tool names and descriptions. Tokens are matched against name parts (exact > substring) and descriptions; short queries also get a typo-tolerance bonus. Returns ranked matches.',
        },
        limit: {
          type: 'number',
          description: 'Optional cap on returned matches when `query` is set (default 10, max 50).',
        },
      },
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
  [TOOL_NAMES.BROWSER.CLOSE_TABS]: 'Browser management',
  [TOOL_NAMES.BROWSER.SWITCH_TAB]: 'Browser management',
  [TOOL_NAMES.BROWSER.TAB_GROUPS]: 'Browser management',

  [TOOL_NAMES.BROWSER.READ_PAGE]: 'Reading',
  [TOOL_NAMES.BROWSER.STORAGE]: 'State',
  [TOOL_NAMES.BROWSER.LIST_FRAMES]: 'Reading',
  [TOOL_NAMES.BROWSER.WEB_FETCHER]: 'Reading',
  [TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT]: 'Reading',

  [TOOL_NAMES.BROWSER.CLICK]: 'Interaction',
  [TOOL_NAMES.BROWSER.FILL]: 'Interaction',
  [TOOL_NAMES.BROWSER.KEYBOARD]: 'Interaction',
  [TOOL_NAMES.BROWSER.COMPUTER]: 'Interaction',
  [TOOL_NAMES.BROWSER.REQUEST_ELEMENT_SELECTION]: 'Interaction',
  [TOOL_NAMES.BROWSER.HANDLE_DIALOG]: 'Interaction',
  [TOOL_NAMES.BROWSER.ASSERT]: 'Interaction',
  [TOOL_NAMES.BROWSER.WAIT_FOR]: 'Interaction',

  [TOOL_NAMES.BROWSER.JAVASCRIPT]: 'Scripting',
  [TOOL_NAMES.BROWSER.USERSCRIPT]: 'Scripting',

  [TOOL_NAMES.BROWSER.NETWORK_REQUEST]: 'Network',
  [TOOL_NAMES.BROWSER.NETWORK_CAPTURE]: 'Network',
  [TOOL_NAMES.BROWSER.INTERCEPT_RESPONSE]: 'Network',

  [TOOL_NAMES.BROWSER.FILE_UPLOAD]: 'Files',
  [TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD]: 'Files',
  [TOOL_NAMES.BROWSER.GIF_RECORDER]: 'Files',

  [TOOL_NAMES.BROWSER.CONSOLE]: 'State',
  [TOOL_NAMES.BROWSER.HISTORY]: 'State',
  [TOOL_NAMES.BROWSER.BOOKMARK]: 'State',
  [TOOL_NAMES.BROWSER.COOKIES]: 'State',

  [TOOL_NAMES.BROWSER.PERFORMANCE_TRACE]: 'Performance',

  [TOOL_NAMES.BROWSER.DIAGNOSTICS]: 'Diagnostics',

  [TOOL_NAMES.BROWSER.PACE]: 'Pacing',

  [TOOL_NAMES.BROWSER.NOTIFICATIONS]: 'System',
  [TOOL_NAMES.BROWSER.CLIPBOARD]: 'System',
  [TOOL_NAMES.BROWSER.SESSIONS]: 'Browser management',
  [TOOL_NAMES.BROWSER.TAB_LIFECYCLE]: 'Browser management',
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
  [TOOL_NAMES.BROWSER.DOWNLOAD]: 'Files',
  [TOOL_NAMES.BROWSER.CLAIM_TAB]: 'Browser management',
  [TOOL_NAMES.BROWSER.LOCATOR_HANDLER]: 'Interaction',
  [TOOL_NAMES.BROWSER.OWNED_TABS]: 'Browser management',
  [TOOL_NAMES.BROWSER.ALIAS_TAB]: 'Browser management',
  [TOOL_NAMES.BROWSER.SET_EXTRA_HTTP_HEADERS]: 'Network',
  [TOOL_NAMES.BROWSER.EMULATE]: 'State',
  [TOOL_NAMES.BROWSER.GET_ATTRIBUTES]: 'Reading',
  [TOOL_NAMES.BROWSER.HOVER]: 'Interaction',
  [TOOL_NAMES.BROWSER.TYPE_INTO]: 'Interaction',
  [TOOL_NAMES.BROWSER.HAR_EXPORT]: 'Network',
  [TOOL_NAMES.BROWSER.MOCK_RESPONSE]: 'Network',
  [TOOL_NAMES.BROWSER.BASIC_AUTH]: 'Network',
  [TOOL_NAMES.BROWSER.SET_CHECKED]: 'Interaction',
  [TOOL_NAMES.BROWSER.COMBOBOX_SELECT]: 'Interaction',
  [TOOL_NAMES.BROWSER.FILL_LWC]: 'Interaction',
  [TOOL_NAMES.BROWSER.TYPEAHEAD_PROBE]: 'Interaction',
  [TOOL_NAMES.BROWSER.HELP]: 'Diagnostics',

  [TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED]: 'Workflows',
  [TOOL_NAMES.RECORD_REPLAY.FLOW_RUN]: 'Workflows',
  [TOOL_NAMES.RECORD_REPLAY.FLOW_DELETE]: 'Workflows',
};
