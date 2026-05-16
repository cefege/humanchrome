/**
 * Shared schema fragments spread into tool inputSchemas (IMP-0021 slice 1).
 *
 * Keeps the canonical wording for cross-cutting concepts (tab targeting,
 * generic timeouts, ref/selector) in one place. Tools that need different
 * semantics (e.g. chrome_wait_for_tab requiring tabId) override the field
 * inline after the spread.
 */

const TAB_ID_DESC =
  "Target tab ID. If omitted, the bridge uses this MCP client's preferred tab (last successfully acted on) before falling back to the active tab. Pass an explicit tabId when running parallel work across tabs.";

const WINDOW_ID_DESC = 'Target window ID to pick the active tab when tabId is omitted.';

const BACKGROUND_DESC =
  'Do not activate tab/focus window during the operation (default: true). Pass false to bring the tab forward.';

export const TAB_ID_PROP = { type: 'number', description: TAB_ID_DESC } as const;
export const WINDOW_ID_PROP = { type: 'number', description: WINDOW_ID_DESC } as const;
export const BACKGROUND_PROP = {
  type: 'boolean',
  description: BACKGROUND_DESC,
  default: true,
} as const;

/** Standard tabId/windowId/background trio. Spread into properties. */
export const TAB_TARGETING = {
  tabId: TAB_ID_PROP,
  windowId: WINDOW_ID_PROP,
  background: BACKGROUND_PROP,
};

/** tabId+windowId only (no background flag — for tools that don't focus). */
export const TAB_TARGETING_NO_BG = {
  tabId: TAB_ID_PROP,
  windowId: WINDOW_ID_PROP,
};

export const REF_PROP = {
  type: 'string',
  description: 'Element ref from chrome_read_page (takes precedence over selector).',
} as const;

export const SELECTOR_PROP = {
  type: 'string',
  description:
    'Selector for the element. Default kind is CSS; Playwright-style prefixed strings are also accepted: `role:button[name="Submit"]`, `label:Email`, `placeholder:Search`, `alt:Logo`, `title:Close`, `testid:submit-btn`, `text:Login`. Composite (iframe traversal) still uses `|>` between the frame selector and inner selector: `iframe#payment |> role:button[name="Pay"]`. Set `selectorType` explicitly when you want to disambiguate.',
} as const;

export const SELECTOR_TYPE_PROP = {
  type: 'string',
  enum: ['css', 'xpath', 'role', 'label', 'placeholder', 'alt', 'title', 'testid', 'text'],
  description:
    'Selector kind. `css` (default) and `xpath` are the legacy options. Playwright-style values resolve via the matching strategy: `role` (implicit/explicit ARIA role + accessible name), `label` (form labels), `placeholder` (input/textarea placeholder), `alt` (img/area alt text), `title` (title attribute), `testid` (data-testid/cy/test/qa), `text` (visible text). When set to a non-css/xpath value, the `selector` field carries the strategy payload (e.g. `button[name="Submit",exact=true]` for `role`, or the search text for `label`/`placeholder`/etc.).',
} as const;

/**
 * Strict-mode index hint (IMP-0098). When omitted and the selector matches
 * multiple elements, the tool errors with INVALID_ARGS +
 * `details: {matchCount, samples: [...]}` instead of silently picking one.
 */
export const SELECTOR_INDEX_PROP = {
  type: 'number',
  description:
    'Zero-based index to pick when the selector matches multiple elements. Default behavior is strict mode — multi-match without `index` or `multi:true` errors with INVALID_ARGS + `details: {matchCount, samples}`. Use this when you intentionally want the N-th match.',
  minimum: 0,
} as const;

/**
 * Opt-out of strict mode. When true, the first match wins and multi-match is
 * not an error. Most callers should leave this off — strict mode is the safer
 * default for LLM-authored automation.
 */
export const SELECTOR_MULTI_PROP = {
  type: 'boolean',
  description:
    'Disable strict mode — accept any matching element (first wins) instead of erroring on multi-match. Default false. Prefer `index` when you know which match to pick.',
} as const;

export const FRAME_ID_PROP = {
  type: 'number',
  description: 'Target frame ID for iframe support.',
} as const;
