import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

/**
 * chrome_locator_handler (IMP-0101) — Playwright-style auto-dismiss of sticky
 * overlays (cookie banners, GDPR modals, newsletter popups). Once registered,
 * a per-tab MutationObserver fires the dismiss action automatically whenever
 * the trigger selector becomes visible — agent code doesn't have to babysit.
 *
 * Actions:
 *   - register: install a handler. Returns {handlerId, handler}.
 *   - list:     enumerate handlers on a tab.
 *   - remove:   delete one handler by id.
 *   - clear:    drop every handler on a tab.
 *
 * `persistent: true` re-injects the helper + replays handlers after the tab
 * commits a new document via chrome.webNavigation.onDOMContentLoaded so
 * navigation doesn't silently disarm the handler.
 *
 * State model:
 *   tabHandlers : Map<tabId, Map<handlerId, RegisteredHandler>>
 *   ownerByTab  : Map<tabId, clientId>
 *
 * Cleanup hooks:
 *   - chrome.tabs.onRemoved drops the tab's state.
 *   - persistent handlers replay automatically after navigation.
 *
 * Click dispatch path: MAIN-world / ISOLATED-world synthetic pointer + click
 * event sequence. TODO(IMP-0097): swap to the shared `awaitActionable`
 * primitive once it lands — current behaviour gates on the cheap visibility
 * triad (display / visibility / opacity / non-zero bbox) only.
 */

type LocatorHandlerAction = 'register' | 'list' | 'remove' | 'clear';

interface LocatorHandlerParams {
  action: LocatorHandlerAction;
  selector?: string;
  dismissSelector?: string;
  dismissAction?: 'click' | 'press';
  key?: string;
  times?: number;
  persistent?: boolean;
  handlerId?: string;
  tabId?: number;
  windowId?: number;
}

interface RegisteredHandler {
  handlerId: string;
  selector: string;
  dismissSelector: string;
  dismissAction: 'click' | 'press';
  key?: string;
  times?: number;
  persistent: boolean;
  createdAt: number;
}

interface InjectResult {
  success: boolean;
  handler?: SerializedHandler;
  handlers?: SerializedHandler[];
  count?: number;
  removed?: boolean;
  cleared?: number;
  error?: string;
}

interface SerializedHandler {
  handlerId: string;
  selector: string;
  dismissSelector: string;
  dismissAction: 'click' | 'press';
  key: string | null;
  times: number | null;
  timesRemaining: number | null;
  persistent: boolean;
  dismissedCount: number;
  lastDismissedAt: number | null;
  createdAt: number;
}

// Monotonic per-session counter. Wrapped in a closure-style helper so the
// reset hook below can zero it for tests without exposing the variable.
let handlerCounter = 0;
function nextHandlerId(): string {
  handlerCounter += 1;
  return `lh_${handlerCounter}`;
}

const tabHandlers: Map<number, Map<string, RegisteredHandler>> = new Map();

function getOrCreateTabBucket(tabId: number): Map<string, RegisteredHandler> {
  let bucket = tabHandlers.get(tabId);
  if (!bucket) {
    bucket = new Map();
    tabHandlers.set(tabId, bucket);
  }
  return bucket;
}

class LocatorHandlerTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.LOCATOR_HANDLER;
  static readonly mutates = true;

  async execute(args: LocatorHandlerParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'register' && action !== 'list' && action !== 'remove' && action !== 'clear') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: register, list, remove, clear.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

    let tabId: number | undefined =
      typeof args.tabId === 'number' && Number.isFinite(args.tabId) ? args.tabId : undefined;
    if (tabId === undefined) {
      try {
        const tab = await this.getActiveTabOrThrowInWindow(args.windowId);
        tabId = tab.id;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return createErrorResponse(msg, ToolErrorCode.TAB_NOT_FOUND);
      }
    }
    if (typeof tabId !== 'number') {
      return createErrorResponse('Active tab has no ID', ToolErrorCode.TAB_NOT_FOUND);
    }

    try {
      switch (action) {
        case 'register':
          return await this.actionRegister(tabId, args);
        case 'list':
          return await this.actionList(tabId);
        case 'remove':
          return await this.actionRemove(tabId, args);
        case 'clear':
          return await this.actionClear(tabId);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id|receiving end does not exist/i.test(msg)) {
        // Tab raced closure between our resolve and the injection — drop any
        // cached state for this tab and report TAB_CLOSED so callers can
        // either retry against a fresh tab or give up cleanly.
        tabHandlers.delete(tabId);
        return createErrorResponse(`Tab ${tabId} closed during call`, ToolErrorCode.TAB_CLOSED, {
          tabId,
        });
      }
      console.error('Error in LocatorHandlerTool.execute:', error);
      return createErrorResponse(`chrome_locator_handler failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
        tabId,
      });
    }
  }

  private async actionRegister(tabId: number, args: LocatorHandlerParams): Promise<ToolResult> {
    const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
    if (!selector) {
      return createErrorResponse(
        'Parameter [selector] is required for action="register".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'selector' },
      );
    }
    const dismissSelector =
      typeof args.dismissSelector === 'string' ? args.dismissSelector.trim() : '';
    if (!dismissSelector) {
      return createErrorResponse(
        'Parameter [dismissSelector] is required for action="register".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'dismissSelector' },
      );
    }
    const dismissAction: 'click' | 'press' = args.dismissAction === 'press' ? 'press' : 'click';
    const key = typeof args.key === 'string' && args.key.length > 0 ? args.key : undefined;
    if (dismissAction === 'press' && !key) {
      return createErrorResponse(
        'Parameter [key] is required when dismissAction="press" (e.g. "Escape").',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'key' },
      );
    }
    let times: number | undefined;
    if (args.times !== undefined) {
      if (
        typeof args.times !== 'number' ||
        !Number.isFinite(args.times) ||
        args.times <= 0 ||
        Math.floor(args.times) !== args.times
      ) {
        return createErrorResponse(
          'Parameter [times] must be a positive integer.',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'times' },
        );
      }
      times = args.times;
    }
    const persistent = args.persistent === true;

    const handlerId = nextHandlerId();
    const handler: RegisteredHandler = {
      handlerId,
      selector,
      dismissSelector,
      dismissAction,
      key,
      times,
      persistent,
      createdAt: Date.now(),
    };

    await this.installAndRegister(tabId, handler);

    const bucket = getOrCreateTabBucket(tabId);
    bucket.set(handlerId, handler);

    return jsonOk({
      ok: true,
      action: 'register',
      handlerId,
      handler: serializeForResponse(handler),
      tabId,
    });
  }

  private async actionList(tabId: number): Promise<ToolResult> {
    const bucket = tabHandlers.get(tabId);
    if (!bucket || bucket.size === 0) {
      // Don't bother injecting just to read an empty list — the background
      // map is the source of truth for `list`. Live dismissedCount only
      // becomes interesting after a register has happened (which always
      // injects), so this fast-path is safe.
      return jsonOk({ ok: true, action: 'list', handlers: [], count: 0, tabId });
    }

    // Ask the live in-page state for the current dismissed counts. If the
    // page has navigated and the helper is gone, we'll re-inject and replay
    // every handler so the response always reflects the truth.
    await this.injectContentScript(
      tabId,
      ['inject-scripts/locator-handler.js'],
      false,
      'ISOLATED',
      false,
    );
    let live: InjectResult;
    try {
      live = await this.sendMessageToTab(tabId, { action: 'locator_handler_list' });
    } catch {
      live = { success: false, handlers: [] };
    }
    if (
      !live ||
      live.success !== true ||
      !Array.isArray(live.handlers) ||
      live.handlers.length === 0
    ) {
      // Page lost state (likely fresh navigation) — replay every persistent
      // handler so the next list call reflects the desired set.
      for (const handler of bucket.values()) {
        try {
          await this.installAndRegister(tabId, handler);
        } catch {
          // best-effort; partial replays are fine
        }
      }
      try {
        live = await this.sendMessageToTab(tabId, { action: 'locator_handler_list' });
      } catch {
        live = { success: false, handlers: [] };
      }
    }

    // Index live entries by handlerId so we can attach dismissedCount /
    // lastDismissedAt to the background's truth.
    const liveById = new Map<string, SerializedHandler>();
    if (Array.isArray(live?.handlers)) {
      for (const h of live!.handlers) liveById.set(h.handlerId, h);
    }
    const handlers: SerializedHandler[] = [];
    for (const handler of bucket.values()) {
      const merged = liveById.get(handler.handlerId);
      handlers.push(merged ? merged : serializeForResponse(handler));
    }
    handlers.sort((a, b) => a.createdAt - b.createdAt);

    return jsonOk({
      ok: true,
      action: 'list',
      handlers,
      count: handlers.length,
      tabId,
    });
  }

  private async actionRemove(tabId: number, args: LocatorHandlerParams): Promise<ToolResult> {
    const handlerId = typeof args.handlerId === 'string' ? args.handlerId.trim() : '';
    if (!handlerId) {
      return createErrorResponse(
        'Parameter [handlerId] is required for action="remove".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'handlerId' },
      );
    }
    const bucket = tabHandlers.get(tabId);
    const wasInBg = !!bucket?.delete(handlerId);
    if (bucket && bucket.size === 0) tabHandlers.delete(tabId);

    // Best-effort tell the page to forget it too. If the page has navigated
    // away the message will fail; we already cleared the background entry
    // which is the canonical source for persistent replays.
    let removedInPage = false;
    try {
      await this.injectContentScript(
        tabId,
        ['inject-scripts/locator-handler.js'],
        false,
        'ISOLATED',
        false,
      );
      const resp: InjectResult = await this.sendMessageToTab(tabId, {
        action: 'locator_handler_remove',
        handlerId,
      });
      removedInPage = !!resp?.removed;
    } catch {
      // ignore — bg state already updated
    }

    return jsonOk({
      ok: true,
      action: 'remove',
      handlerId,
      removed: wasInBg || removedInPage,
      tabId,
    });
  }

  private async actionClear(tabId: number): Promise<ToolResult> {
    const bucket = tabHandlers.get(tabId);
    const clearedInBg = bucket ? bucket.size : 0;
    tabHandlers.delete(tabId);

    let clearedInPage = 0;
    try {
      await this.injectContentScript(
        tabId,
        ['inject-scripts/locator-handler.js'],
        false,
        'ISOLATED',
        false,
      );
      const resp: InjectResult = await this.sendMessageToTab(tabId, {
        action: 'locator_handler_clear',
      });
      clearedInPage = typeof resp?.cleared === 'number' ? resp.cleared : 0;
    } catch {
      // ignore — bg state already empty
    }

    return jsonOk({
      ok: true,
      action: 'clear',
      cleared: Math.max(clearedInBg, clearedInPage),
      tabId,
    });
  }

  /**
   * Inject the helper into the tab (idempotent — base class pings first)
   * and forward a register message. Used both by direct register calls and
   * by the persistent-replay path so behaviour stays identical.
   */
  private async installAndRegister(tabId: number, handler: RegisteredHandler): Promise<void> {
    await this.injectContentScript(
      tabId,
      ['inject-scripts/locator-handler.js'],
      false,
      'ISOLATED',
      false,
    );
    const resp: InjectResult = await this.sendMessageToTab(tabId, {
      action: 'locator_handler_register',
      handlerId: handler.handlerId,
      selector: handler.selector,
      dismissSelector: handler.dismissSelector,
      dismissAction: handler.dismissAction,
      key: handler.key,
      times: handler.times,
      persistent: handler.persistent,
    });
    if (!resp || resp.success !== true) {
      throw new Error(resp?.error || 'in-page register failed');
    }
  }
}

function serializeForResponse(handler: RegisteredHandler): SerializedHandler {
  return {
    handlerId: handler.handlerId,
    selector: handler.selector,
    dismissSelector: handler.dismissSelector,
    dismissAction: handler.dismissAction,
    key: handler.key || null,
    times: typeof handler.times === 'number' ? handler.times : null,
    timesRemaining: typeof handler.times === 'number' ? handler.times : null,
    persistent: handler.persistent,
    dismissedCount: 0,
    lastDismissedAt: null,
    createdAt: handler.createdAt,
  };
}

export const locatorHandlerTool = new LocatorHandlerTool();

/**
 * Test-only — drop the per-tab map and reset the id counter so each test
 * starts from a clean slate. Mirrors the `_resetXForTest` convention from
 * `keyboard.ts` and the `_seedXForTest` convention from `inject-script.ts`.
 */
export function _resetLocatorHandlersForTest(): void {
  tabHandlers.clear();
  handlerCounter = 0;
}

/**
 * Test-only — direct read of the in-memory state for assertions that don't
 * want to round-trip through the public list action (which also injects).
 */
export function _getLocatorHandlerStateForTest(): {
  tabs: Array<{ tabId: number; handlerIds: string[] }>;
} {
  const tabs: Array<{ tabId: number; handlerIds: string[] }> = [];
  for (const [tabId, bucket] of tabHandlers) {
    tabs.push({ tabId, handlerIds: [...bucket.keys()] });
  }
  return { tabs };
}

// --- Cleanup listeners ---
// Closed tabs lose every handler. Persistent handlers replay on the same tab
// after navigation, but a fully-removed tab has nothing to replay against.
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabHandlers.has(tabId)) {
      tabHandlers.delete(tabId);
    }
  });
}

// Persistent handlers re-arm after navigation via webNavigation.onDOMContentLoaded.
// Only the main frame triggers replay — we don't want to fire N times for sites
// with deep iframe trees.
if (typeof chrome !== 'undefined' && chrome.webNavigation?.onDOMContentLoaded?.addListener) {
  chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
    if (details.frameId !== 0) return;
    const bucket = tabHandlers.get(details.tabId);
    if (!bucket || bucket.size === 0) return;
    const persistent = [...bucket.values()].filter((h) => h.persistent);
    if (persistent.length === 0) return;
    for (const handler of persistent) {
      try {
        await locatorHandlerTool['installAndRegister'](details.tabId, handler);
      } catch {
        // Silent — the next tool call against this tab will surface the error.
      }
    }
    // Non-persistent handlers do not survive navigation by design — drop them
    // so list/remove don't surface stale entries.
    for (const handler of bucket.values()) {
      if (!handler.persistent) bucket.delete(handler.handlerId);
    }
    if (bucket.size === 0) tabHandlers.delete(details.tabId);
  });
}
