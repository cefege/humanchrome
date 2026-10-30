/**
 * Declarative sunset → consolidated tool map.
 *
 * Keep entries that map cleanly to a single `{tool, action}` call. Don't add
 * names that need multi-arg translation — the hint stays advisory and callers
 * issue the corrected call themselves.
 */
export interface SunsetReplacement {
  /** Canonical tool name to use instead. */
  name: string;
  /** Action enum value on the replacement tool, if applicable. */
  action?: string;
}

export const SUNSET_TOOL_REPLACEMENTS: Readonly<Record<string, SunsetReplacement>> = Object.freeze({
  // chrome_cookies (action enum)
  chrome_get_cookies: { name: 'chrome_cookies', action: 'get' },
  chrome_set_cookie: { name: 'chrome_cookies', action: 'set' },
  chrome_remove_cookie: { name: 'chrome_cookies', action: 'remove' },
  // chrome_diagnostics (action enum)
  chrome_debug_dump: { name: 'chrome_diagnostics', action: 'dump_logs' },
  chrome_queue_inspect: { name: 'chrome_diagnostics', action: 'queue' },
  chrome_runtime_info: { name: 'chrome_diagnostics', action: 'runtime_info' },
  chrome_dev_reload: { name: 'chrome_diagnostics', action: 'dev_reload' },
  // chrome_performance_trace (action enum)
  chrome_performance_start_trace: { name: 'chrome_performance_trace', action: 'start' },
  chrome_performance_stop_trace: { name: 'chrome_performance_trace', action: 'stop' },
  chrome_performance_analyze_insight: { name: 'chrome_performance_trace', action: 'analyze' },
  // chrome_close_tabs (action enum)
  chrome_close_tab: { name: 'chrome_close_tabs', action: 'ids' },
  chrome_close_tabs_matching: { name: 'chrome_close_tabs', action: 'matching' },
  browser_close_my_tabs: { name: 'chrome_close_tabs', action: 'mine' },
  // chrome_bookmark (action enum)
  chrome_bookmark_search: { name: 'chrome_bookmark', action: 'search' },
  chrome_bookmark_add: { name: 'chrome_bookmark', action: 'add' },
  chrome_bookmark_update: { name: 'chrome_bookmark', action: 'update' },
  chrome_bookmark_delete: { name: 'chrome_bookmark', action: 'delete' },
  // chrome_download (action enum) — chrome_handle_download is a separate live tool.
  chrome_download_list: { name: 'chrome_download', action: 'list' },
  chrome_download_cancel: { name: 'chrome_download', action: 'cancel' },
});
