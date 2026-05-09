import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

interface FocusParams {
  tabId?: number;
  windowId?: number;
  selector?: string;
  ref?: string;
  frameId?: number;
}

interface ShimSuccess {
  ok: true;
  focused: boolean;
  resolution: 'ref' | 'selector';
  tagName: string;
}

interface ShimFailure {
  ok: false;
  message: string;
}

type ShimResult = ShimSuccess | ShimFailure;

/**
 * Focus an element by selector or ref. Several flows (chrome_paste,
 * chrome_keyboard, chrome_fill_or_select on some sites) need a focused
 * target before keyboard input lands. Today there is no first-class way
 * to focus an element — agents synthesize a click and hope it sticks.
 *
 * Refs come from `window.__claudeElementMap` (populated by inject-scripts/
 * accessibility-tree-helper, wait-helper, etc.) and live in ISOLATED world,
 * which is also where this shim runs.
 */
class FocusTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FOCUS;
  static readonly mutates = true;

  async execute(args: FocusParams = {}): Promise<ToolResult> {
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
      return createErrorResponse(
        'Exactly one of [selector] or [ref] is required.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'selector|ref' },
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
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: focusShim,
        args: [args.selector ?? null, args.ref ?? null],
      });
      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse(
          'Focus shim returned no result (frame missing or blocked?)',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }
      if (!first.ok) {
        return createErrorResponse(first.message, ToolErrorCode.UNKNOWN, {
          tabId,
          frameId: args.frameId,
        });
      }
      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        resolution: first.resolution,
        focused: first.focused,
        tagName: first.tagName,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, { tabId });
      }
      console.error('Error in FocusTool.execute:', error);
      return createErrorResponse(`chrome_focus failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
        frameId: args.frameId,
      });
    }
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

/**
 * ISOLATED-world shim. Self-contained — chrome.scripting.func only
 * serializes the function body, not the surrounding scope.
 */
function focusShim(selector: string | null, ref: string | null): ShimResult {
  try {
    let el: Element | null = null;
    let resolution: 'ref' | 'selector' = 'selector';

    if (ref) {
      resolution = 'ref';
      const map = (window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> })
        .__claudeElementMap;
      if (!map || !map[ref]) {
        return { ok: false, message: `ref "${ref}" not found in element map` };
      }
      const deref = map[ref].deref?.();
      if (!deref) {
        return { ok: false, message: `ref "${ref}" element has been garbage-collected` };
      }
      el = deref;
    } else if (selector) {
      el = document.querySelector(selector);
      if (!el) {
        return { ok: false, message: `selector "${selector}" matched no element` };
      }
    } else {
      return { ok: false, message: 'neither selector nor ref provided' };
    }

    const focusable = el as HTMLElement;
    if (typeof focusable.focus !== 'function') {
      return { ok: false, message: 'element does not support focus()' };
    }
    focusable.focus({ preventScroll: false });
    return {
      ok: true,
      focused: document.activeElement === el,
      resolution,
      tagName: el.tagName.toLowerCase(),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const focusTool = new FocusTool();
