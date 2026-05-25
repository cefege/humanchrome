import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * chrome_set_extra_http_headers — IMP-0142.
 *
 * Inject extra HTTP headers on every request a tab makes, via CDP
 * `Network.setExtraHTTPHeaders`. Persistent across navigations within
 * the tab (CDP guarantee) until `clear` or tab close. The headers are
 * applied tab-wide — there's no per-frame or per-URL targeting at this
 * layer; for URL-conditioned overrides use `chrome_intercept_response`.
 *
 * Real-world use cases:
 *   - Authorization: Bearer <token>  for internal/Voyager APIs
 *   - X-Csrf-Token / X-Requested-With for impersonation in test fixtures
 *   - Custom session-bridge headers for proxy-fronted auth
 *
 * Multi-action enum (action: set|get|clear|list_tabs):
 *   - set:        { headers: Record<string,string>, tabId? } → installs CDP override
 *   - get:        { tabId? } → returns the currently-installed overrides for the tab
 *   - clear:      { tabId? } → sends Network.setExtraHTTPHeaders({}) + forgets the entry
 *   - list_tabs:  {} → returns every tab currently carrying overrides
 *
 * Forbidden headers (per Chrome / Fetch spec) are rejected with
 * INVALID_ARGS + `details.header` so callers can fix the one bad line
 * without resubmitting the whole map.
 */

type Action = 'set' | 'get' | 'clear' | 'list_tabs';

interface ExtraHttpHeadersParams {
  action?: Action;
  tabId?: number;
  headers?: Record<string, string>;
}

const OWNER = 'extra-http-headers' as const;

// Chrome / Fetch-spec "forbidden header names" + a few that
// `Network.setExtraHTTPHeaders` explicitly refuses or that would corrupt
// framing. Case-insensitive. Anything not on this list goes through; CDP
// itself will reject genuinely invalid values with a protocol error which
// we classify as UNKNOWN with the original message.
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set(
  [
    'host',
    'content-length',
    'connection',
    'transfer-encoding',
    'trailer',
    'upgrade',
    'te',
    'expect',
    'keep-alive',
    'proxy-connection',
  ].map((h) => h.toLowerCase()),
);

// Map<tabId, Record<headerName, value>>. Module-scope; reset via the
// _-prefixed helper in tests. Entries are evicted on chrome.tabs.onRemoved
// (installed lazily on first call).
const TAB_HEADERS = new Map<number, Record<string, string>>();

let tabRemovedListener: ((tabId: number) => void) | null = null;
function installTabRemovedListenerOnce(): void {
  if (tabRemovedListener) return;
  if (typeof chrome === 'undefined' || !chrome.tabs?.onRemoved?.addListener) return;
  tabRemovedListener = (tabId: number) => {
    TAB_HEADERS.delete(tabId);
  };
  chrome.tabs.onRemoved.addListener(tabRemovedListener);
}

/** Test-only: wipe per-tab state AND remove the onRemoved listener so the
 *  next call re-attaches against the test's fresh chrome mock (without
 *  leaking the previous listener against a now-gone mock). */
export function _resetExtraHeadersForTests(): void {
  TAB_HEADERS.clear();
  if (tabRemovedListener && chrome?.tabs?.onRemoved?.removeListener) {
    try {
      chrome.tabs.onRemoved.removeListener(tabRemovedListener);
    } catch {
      /* ignore — mock may already be gone */
    }
  }
  tabRemovedListener = null;
}

class ExtraHttpHeadersTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SET_EXTRA_HTTP_HEADERS;
  static readonly mutates = true;

  async execute(args: ExtraHttpHeadersParams = {}): Promise<ToolResult> {
    const action = args.action ?? 'set';
    if (!['set', 'get', 'clear', 'list_tabs'].includes(action)) {
      return createErrorResponse(
        `Invalid action "${action}": expected one of set|get|clear|list_tabs`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

    installTabRemovedListenerOnce();

    if (action === 'list_tabs') {
      const tabs = Array.from(TAB_HEADERS.entries()).map(([tabId, headers]) => ({
        tabId,
        headerCount: Object.keys(headers).length,
      }));
      return this.ok({ tabs, count: tabs.length });
    }

    // Other actions need a tab.
    let tab: chrome.tabs.Tab;
    try {
      tab = await this.getOwnedTab({ explicit: args.tabId });
    } catch (e) {
      return createErrorResponse(
        e instanceof Error ? e.message : String(e),
        ToolErrorCode.TAB_NOT_FOUND,
      );
    }
    const tabId = tab.id!;

    if (action === 'get') {
      const headers = TAB_HEADERS.get(tabId) ?? {};
      return this.ok({
        tabId,
        headers,
        headerCount: Object.keys(headers).length,
      });
    }

    if (action === 'clear') {
      const existed = TAB_HEADERS.has(tabId);
      TAB_HEADERS.delete(tabId);
      if (existed) {
        try {
          await cdpSessionManager.withSession(tabId, OWNER, async () => {
            // Empty map is the documented way to drop all overrides on a tab.
            await cdpSessionManager.sendCommand(tabId, 'Network.setExtraHTTPHeaders', {
              headers: {},
            });
          });
        } catch (e) {
          return createErrorResponse(
            `Failed to clear extra HTTP headers: ${e instanceof Error ? e.message : String(e)}`,
            ToolErrorCode.UNKNOWN,
            { tabId },
          );
        }
      }
      return this.ok({ tabId, cleared: existed });
    }

    // action === 'set'
    if (!args.headers || typeof args.headers !== 'object' || Array.isArray(args.headers)) {
      return createErrorResponse(
        'headers must be a non-null object of {name: value} pairs',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'headers' },
      );
    }
    const headerEntries = Object.entries(args.headers);
    if (headerEntries.length === 0) {
      return createErrorResponse(
        'headers cannot be empty — use action:"clear" to drop overrides',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'headers' },
      );
    }

    const normalized: Record<string, string> = {};
    for (const [name, value] of headerEntries) {
      if (typeof name !== 'string' || name.length === 0) {
        return createErrorResponse(
          `Header name must be a non-empty string (got ${JSON.stringify(name)})`,
          ToolErrorCode.INVALID_ARGS,
          { arg: 'headers' },
        );
      }
      if (typeof value !== 'string') {
        return createErrorResponse(
          `Header value for "${name}" must be a string (got ${typeof value})`,
          ToolErrorCode.INVALID_ARGS,
          { arg: 'headers', header: name },
        );
      }
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
        return createErrorResponse(
          `Header "${name}" is forbidden by Chrome's setExtraHTTPHeaders policy`,
          ToolErrorCode.INVALID_ARGS,
          { arg: 'headers', header: name },
        );
      }
      normalized[name] = value;
    }

    try {
      await cdpSessionManager.withSession(tabId, OWNER, async () => {
        await cdpSessionManager.sendCommand(tabId, 'Network.enable', {});
        await cdpSessionManager.sendCommand(tabId, 'Network.setExtraHTTPHeaders', {
          headers: normalized,
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/another debugger|already attached/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId });
      }
      return createErrorResponse(`Failed to set extra HTTP headers: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
      });
    }

    TAB_HEADERS.set(tabId, normalized);
    return this.ok({
      tabId,
      headers: normalized,
      headerCount: Object.keys(normalized).length,
    });
  }

  private ok(payload: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }) }],
      isError: false,
    };
  }
}

export const extraHttpHeadersTool = new ExtraHttpHeadersTool();
