import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import {
  resolveSelectorToRef,
  STRUCTURED_SELECTOR_KINDS,
  type SelectorType,
} from './_selector-resolve';
import { parsePrefixedSelector } from '@/shared/selector/prefixed-parser';

interface FocusParams {
  tabId?: number;
  windowId?: number;
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  frameId?: number;
  index?: number;
  multi?: boolean;
  /** Skip the visibility check. Default false. */
  force?: boolean;
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
  /** IMP-0097: failures list when the visibility check blocks focus. */
  notActionable?: boolean;
  failures?: string[];
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
      const tab = await this.getOwnedTab({ windowId: args.windowId, required: false });
      if (!tab || typeof tab.id !== 'number') {
        return createErrorResponse(
          'No active tab found',
          ToolErrorCode.TAB_NOT_FOUND,
          typeof args.windowId === 'number' ? { windowId: args.windowId } : undefined,
        );
      }
      tabId = tab.id;
    }

    const force = args.force === true;

    try {
      // IMP-0098: structured selectors (`role`, `label`, …) and prefixed CSS
      // strings (`role:button[name="X"]`) get resolved to a ref via the
      // accessibility-tree-helper before the focus shim runs. The shim only
      // knows raw CSS / ref.
      let shimSelector: string | null = args.selector ?? null;
      let shimRef: string | null = args.ref ?? null;
      const wantStructuredResolve =
        !shimRef &&
        shimSelector &&
        (() => {
          if (args.selectorType && STRUCTURED_SELECTOR_KINDS.includes(args.selectorType))
            return true;
          if (args.selectorType === 'xpath') return true;
          if (!args.selectorType || args.selectorType === 'css') {
            const parsed = parsePrefixedSelector(shimSelector);
            return parsed.kind !== 'css';
          }
          return false;
        })();

      if (wantStructuredResolve) {
        const resolved = await resolveSelectorToRef(this, {
          tabId,
          frameId: args.frameId,
          selector: shimSelector!,
          selectorType: (args.selectorType ?? 'css') as SelectorType,
          index: args.index,
          multi: args.multi,
        });
        if (!resolved.ok) return resolved.error;
        shimRef = resolved.ref;
        shimSelector = null;
      }

      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: focusShim,
        args: [shimSelector, shimRef, force],
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
        // IMP-0097: visibility-failure → NOT_ACTIONABLE so callers can
        // wait/dismiss the blocker; everything else stays UNKNOWN.
        if (first.notActionable === true) {
          return createErrorResponse(first.message, ToolErrorCode.NOT_ACTIONABLE, {
            tabId,
            frameId: args.frameId,
            failures: Array.isArray(first.failures) ? first.failures : [],
          });
        }
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

/**
 * ISOLATED-world shim. Self-contained — chrome.scripting.func only
 * serializes the function body, not the surrounding scope. Runs the
 * shared actionability primitive's `visible` check before focusing —
 * dispatching focus on a hidden control yields no visible behaviour
 * (`document.activeElement` may still update, but the agent gets no
 * actionable state).
 */
function focusShim(selector: string | null, ref: string | null, force: boolean): ShimResult {
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

    // Sync visibility check — focusShim must return synchronously, and
    // stability/hit-test/enabled aren't relevant to programmatic focus.
    if (!force) {
      const failure = checkVisibleSync(focusable);
      if (failure) {
        return {
          ok: false,
          message: `element is not actionable: ${failure}`,
          notActionable: true,
          failures: [failure],
        };
      }
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

  function checkVisibleSync(target: HTMLElement): string | null {
    if (!target.isConnected) return 'not_visible';
    const style = getComputedStyle(target);
    if (style.display === 'none') return 'not_visible';
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'not_visible';
    if (Number(style.opacity) === 0) return 'not_visible';
    if (style.pointerEvents === 'none') return 'not_visible';
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 'not_visible';
    return null;
  }
}

export const focusTool = new FocusTool();
