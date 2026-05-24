import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { createOwnedRegistry } from '../../utils/owned-registry';

/**
 * chrome_locator_handler (IMP-0101) — Playwright-style auto-dismiss of sticky
 * overlays (cookie banners, GDPR modals, newsletter popups). Once registered,
 * a per-tab MutationObserver fires the dismiss action automatically whenever
 * the trigger selector becomes visible — agent code doesn't have to babysit.
 *
 * `persistent: true` re-injects the helper + replays handlers after the tab
 * commits a new document via chrome.webNavigation.onDOMContentLoaded so
 * navigation doesn't silently disarm the handler.
 *
 * TODO(IMP-0097): swap the in-page click dispatch to the shared
 * `awaitActionable` primitive once it lands — current behaviour gates on
 * the cheap visibility triad (display / visibility / opacity / bbox) only.
 */

const HELPER_FILE = 'inject-scripts/locator-handler.js';
const MSG = {
  REGISTER: 'locator_handler_register',
  LIST: 'locator_handler_list',
  REMOVE: 'locator_handler_remove',
  CLEAR: 'locator_handler_clear',
} as const;

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

// IMP-0164: backed by `OwnedRegistry` for auto-eviction on tab close
// (previously this map leaked entries — only the explicit
// `releaseLocatorHandlersForTabs` and a manual tabs.onRemoved listener
// kept it pruned). Per the plan, locator handlers are page-scoped
// (migrate policy on force-claim), so all entries route to the system
// bucket rather than being per-client. `releaseLocatorHandlersForTabs`
// stays as the explicit by-tab clear that the bridge calls on client
// disconnect.
const tabHandlers = createOwnedRegistry<Map<string, RegisteredHandler>>();

function getOrCreateTabBucket(tabId: number): Map<string, RegisteredHandler> {
  let bucket = tabHandlers.get(undefined, tabId);
  if (!bucket) {
    bucket = new Map();
    tabHandlers.set(undefined, tabId, bucket);
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
        tabHandlers.delete(undefined, tabId);
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

    await this.sendRegister(tabId, handler);

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
    const bucket = tabHandlers.get(undefined, tabId);
    if (!bucket || bucket.size === 0) {
      // Don't bother injecting just to read an empty list — the background
      // map is the source of truth for `list`. Live dismissedCount only
      // becomes interesting after a register has happened (which always
      // injects), so this fast-path is safe.
      return jsonOk({ ok: true, action: 'list', handlers: [], count: 0, tabId });
    }

    // Ask the live in-page state for the current dismissed counts.
    await this.ensureHelperInjected(tabId);
    let live = await this.tryListInPage(tabId);
    const helperGone =
      !live || live.success !== true || !Array.isArray(live.handlers) || live.handlers.length === 0;
    if (helperGone) {
      // Page lost state (likely fresh navigation). Inject once, then replay
      // every handler in this tab so the next list reflects the desired set.
      // Replaying issues N register messages but only one injection — the
      // base class pings first and short-circuits when the helper is live.
      for (const handler of bucket.values()) {
        try {
          await this.sendRegister(tabId, handler);
        } catch {
          // best-effort; partial replays are fine
        }
      }
      live = await this.tryListInPage(tabId);
    }

    const liveById = new Map<string, SerializedHandler>();
    if (Array.isArray(live?.handlers)) {
      for (const h of live!.handlers) liveById.set(h.handlerId, h);
    }
    const handlers: SerializedHandler[] = [];
    for (const handler of bucket.values()) {
      handlers.push(liveById.get(handler.handlerId) ?? serializeForResponse(handler));
    }
    handlers.sort((a, b) => a.createdAt - b.createdAt);

    return jsonOk({ ok: true, action: 'list', handlers, count: handlers.length, tabId });
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
    const bucket = tabHandlers.get(undefined, tabId);
    const wasInBg = !!bucket?.delete(handlerId);
    if (bucket && bucket.size === 0) tabHandlers.delete(undefined, tabId);
    // Note: the second .delete is the post-remove cleanup; the helper
    // returns false if the entry was already gone, which is fine.

    // Best-effort tell the page to forget it too. If the page has navigated
    // away the message will fail; the background entry is the canonical
    // source for persistent replays so a missed in-page remove is harmless.
    let removedInPage = false;
    try {
      await this.ensureHelperInjected(tabId);
      const resp = await this.sendHelperMessage(tabId, { action: MSG.REMOVE, handlerId });
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
    const bucket = tabHandlers.get(undefined, tabId);
    const clearedInBg = bucket ? bucket.size : 0;
    tabHandlers.delete(undefined, tabId);

    let clearedInPage = 0;
    try {
      await this.ensureHelperInjected(tabId);
      const resp = await this.sendHelperMessage(tabId, { action: MSG.CLEAR });
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
   * Inject the helper file (idempotent — the base class pings before
   * re-injecting). Same 5-arg shape every call site needs.
   */
  private async ensureHelperInjected(tabId: number): Promise<void> {
    await this.injectContentScript(tabId, [HELPER_FILE], false, 'ISOLATED', false);
  }

  /** Wrap sendMessageToTab so the call sites stay declarative. */
  private async sendHelperMessage(
    tabId: number,
    payload: Record<string, unknown>,
  ): Promise<InjectResult> {
    return (await this.sendMessageToTab(tabId, payload)) as InjectResult;
  }

  /** Forward a register payload; throw on `success:false` so callers branch on it. */
  async sendRegister(tabId: number, handler: RegisteredHandler): Promise<void> {
    await this.ensureHelperInjected(tabId);
    const resp = await this.sendHelperMessage(tabId, {
      action: MSG.REGISTER,
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

  /** Best-effort live list read — swallows transport errors. */
  private async tryListInPage(tabId: number): Promise<InjectResult> {
    try {
      return await this.sendHelperMessage(tabId, { action: MSG.LIST });
    } catch {
      return { success: false, handlers: [] };
    }
  }
}

function serializeForResponse(handler: RegisteredHandler): SerializedHandler {
  const times = typeof handler.times === 'number' ? handler.times : null;
  return {
    handlerId: handler.handlerId,
    selector: handler.selector,
    dismissSelector: handler.dismissSelector,
    dismissAction: handler.dismissAction,
    key: handler.key ?? null,
    times,
    timesRemaining: times,
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
  // OwnedRegistry doesn't expose `clear()` — iterate evict per known tab.
  for (const { tabId } of [...tabHandlers.entries()]) {
    tabHandlers.delete(undefined, tabId);
  }
  handlerCounter = 0;
}

/**
 * Drop every locator handler registered for any tab in `tabIds`. Mirrors
 * the dialog tool's `releaseDialogDefaultsForTabs` so the bridge's
 * client-disconnect hook can prevent orphan handlers from continuing to
 * fire forever against tabs whose owning client is gone.
 *
 * Returns the subset of `tabIds` that actually had handlers cleared.
 */
export function releaseLocatorHandlersForTabs(tabIds: Iterable<number>): number[] {
  const released: number[] = [];
  for (const tabId of tabIds) {
    if (tabHandlers.delete(undefined, tabId)) released.push(tabId);
  }
  return released;
}

/**
 * Test-only — direct read of the in-memory state for assertions that don't
 * want to round-trip through the public list action (which also injects).
 */
export function _getLocatorHandlerStateForTest(): {
  tabs: Array<{ tabId: number; handlerIds: string[] }>;
} {
  const tabs: Array<{ tabId: number; handlerIds: string[] }> = [];
  for (const { tabId, value: bucket } of tabHandlers.entries()) {
    tabs.push({ tabId, handlerIds: [...bucket.keys()] });
  }
  return { tabs };
}

// IMP-0164: `tabHandlers` (OwnedRegistry) self-subscribes to
// chrome.tabs.onRemoved internally, so the standalone tab-close
// listener that lived here is no longer needed.

// Persistent handlers re-arm after navigation via webNavigation.onDOMContentLoaded.
// Only the main frame triggers replay — we don't want to fire N times for sites
// with deep iframe trees.
if (typeof chrome !== 'undefined' && chrome.webNavigation?.onDOMContentLoaded?.addListener) {
  chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
    if (details.frameId !== 0) return;
    const bucket = tabHandlers.get(undefined, details.tabId);
    if (!bucket || bucket.size === 0) return;
    // Partition in one pass so non-persistent handlers drop on navigation
    // (by design — list/remove must not surface stale entries) regardless
    // of whether there are persistent handlers to replay.
    const persistent: RegisteredHandler[] = [];
    for (const handler of [...bucket.values()]) {
      if (handler.persistent) persistent.push(handler);
      else bucket.delete(handler.handlerId);
    }
    if (bucket.size === 0) tabHandlers.delete(undefined, details.tabId);
    // Replay in parallel — handlers are independent.
    await Promise.all(
      persistent.map((handler) =>
        locatorHandlerTool.sendRegister(details.tabId, handler).catch(() => {
          // Silent — the next tool call against this tab will surface the error.
        }),
      ),
    );
  });
}
