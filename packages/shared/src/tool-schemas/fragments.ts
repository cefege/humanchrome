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
  description: 'CSS selector or XPath for the element.',
} as const;

export const SELECTOR_TYPE_PROP = {
  type: 'string',
  enum: ['css', 'xpath'],
  description: 'Type of selector (default: "css").',
} as const;

export const FRAME_ID_PROP = {
  type: 'number',
  description: 'Target frame ID for iframe support.',
} as const;
