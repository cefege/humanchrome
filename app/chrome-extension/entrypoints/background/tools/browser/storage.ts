import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type StorageAction = 'get' | 'set' | 'remove' | 'clear' | 'keys';
type StorageScope = 'local' | 'session';

interface StorageToolParams {
  action: StorageAction;
  scope?: StorageScope;
  key?: string;
  value?: string;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

interface ShimSuccess {
  ok: true;
  data: unknown;
}

interface ShimFailure {
  ok: false;
  message: string;
}

type ShimResult = ShimSuccess | ShimFailure;

/**
 * Wrapper around localStorage / sessionStorage so prompts don't need to
 * embed raw JS into chrome_javascript. The MAIN-world shim runs once
 * per call via chrome.scripting.executeScript and returns a discriminated
 * union — failures inside the storage API (Safari-private-mode-style
 * `QuotaExceededError`, sandbox iframes that disable storage, etc.)
 * surface as `ShimFailure` rather than throwing out of the bridge.
 */
class StorageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.STORAGE;
  static readonly mutates = true;

  async execute(args: StorageToolParams): Promise<ToolResult> {
    const action = args?.action;
    if (
      action !== 'get' &&
      action !== 'set' &&
      action !== 'remove' &&
      action !== 'clear' &&
      action !== 'keys'
    ) {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: get, set, remove, clear, keys.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

    const scope: StorageScope = args.scope === 'session' ? 'session' : 'local';

    if ((action === 'get' || action === 'set' || action === 'remove') && !args.key) {
      return createErrorResponse(
        `Parameter [key] is required for action="${action}".`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'key' },
      );
    }
    if (action === 'set' && typeof args.value !== 'string') {
      return createErrorResponse(
        'Parameter [value] is required for action="set" and must be a string. Wrap structured data via JSON.stringify before passing.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'value' },
      );
    }

    let tabId: number | undefined = typeof args.tabId === 'number' ? args.tabId : undefined;
    if (tabId === undefined) {
      const tab = await this.getActiveTabInWindow(args.windowId);
      if (!tab || typeof tab.id !== 'number') {
        return createErrorResponse(
          'No active tab found',
          ToolErrorCode.TAB_NOT_FOUND,
          typeof args.windowId === 'number' ? { windowId: args.windowId } : undefined,
        );
      }
      tabId = tab.id;
    }

    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') {
        target.frameIds = [args.frameId];
      }
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'MAIN',
        func: storageShim,
        args: [scope, action, args.key ?? null, action === 'set' ? args.value! : null],
      });

      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse(
          'Storage shim returned no result (frame missing or blocked?)',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }
      if (!first.ok) {
        return createErrorResponse(first.message, ToolErrorCode.UNKNOWN, {
          tabId,
          frameId: args.frameId,
          scope,
          action,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              tabId,
              ...(typeof args.frameId === 'number' ? { frameId: args.frameId } : {}),
              scope,
              action,
              ...(first.data as Record<string, unknown>),
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Tab gone mid-call: classify distinctly so callers can retry.
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, {
          tabId,
        });
      }
      // Frame mismatch surfaces with a specific Chrome message.
      if (/frame|frameid/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.INVALID_ARGS, {
          tabId,
          frameId: args.frameId,
        });
      }
      console.error('Error in StorageTool.execute:', error);
      return createErrorResponse(`chrome_storage failed: ${msg}`);
    }
  }
}

/**
 * MAIN-world shim. Runs inside the page so it can read window.localStorage
 * / window.sessionStorage. Must be self-contained — chrome.scripting.func
 * serializes only the function body, not the surrounding scope.
 *
 * Returns a discriminated union so the orchestrator can branch without
 * try/catching across the bridge boundary.
 */
function storageShim(
  scope: StorageScope,
  action: StorageAction,
  key: string | null,
  value: string | null,
): ShimResult {
  try {
    const store: Storage = scope === 'session' ? window.sessionStorage : window.localStorage;
    if (!store) {
      return { ok: false, message: `${scope}Storage is not available on this origin` };
    }
    switch (action) {
      case 'get': {
        const k = key as string;
        const exists = Object.prototype.hasOwnProperty.call(store, k) || store.getItem(k) !== null;
        const v = store.getItem(k);
        return { ok: true, data: { value: v, exists: v !== null || exists } };
      }
      case 'set': {
        store.setItem(key as string, value as string);
        return { ok: true, data: { stored: true } };
      }
      case 'remove': {
        const had = store.getItem(key as string) !== null;
        store.removeItem(key as string);
        return { ok: true, data: { removed: had } };
      }
      case 'clear': {
        const count = store.length;
        store.clear();
        return { ok: true, data: { cleared: count } };
      }
      case 'keys': {
        const keys: string[] = [];
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (typeof k === 'string') keys.push(k);
        }
        return { ok: true, data: { keys } };
      }
      default: {
        return { ok: false, message: `unsupported action: ${action}` };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

export const storageTool = new StorageTool();
