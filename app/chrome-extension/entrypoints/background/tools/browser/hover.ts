import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import {
  resolveSelectorToRef,
  STRUCTURED_SELECTOR_KINDS,
  type SelectorType,
} from './_selector-resolve';
import { parsePrefixedSelector } from '@/shared/selector/prefixed-parser';

/**
 * chrome_hover — IMP-0125.
 *
 * Programmatic mouse hover to trigger tooltips and dropdown menus.
 * Hover-revealed UI (LinkedIn profile cards, Twitter quote-tweet
 * tooltip, GitHub commit hover, dropdown menus on nav bars) is
 * unreachable without dispatching a real mouseover chain. Today
 * agents fall back to `chrome_computer` with coordinate math (query
 * bbox → mouse_move) or `chrome_javascript` that fires synthetic
 * events but skips actionability.
 *
 * Single tool, no action enum. Resolves target via the same
 * `_selector-resolve` engine that click uses, runs a visibility check,
 * computes element-center (or position offset), then dispatches
 * `pointermove` → `mouseover` → `mouseenter` → `pointerenter` —
 * exactly the chain a real mouse generates. Returns `{hovered, bbox,
 * tabId}`. Pair with `chrome_await_element` after dispatch to wait
 * for the revealed UI before clicking it.
 */

interface HoverParams {
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  index?: number;
  multi?: boolean;
  /** {x,y} offset relative to top-left of bbox; defaults to center. */
  position?: { x: number; y: number };
  /** Skip the visibility check. Default false. */
  force?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

interface ShimSuccess {
  ok: true;
  hovered: true;
  resolution: 'ref' | 'selector';
  tagName: string;
  bbox: { x: number; y: number; width: number; height: number };
  point: { x: number; y: number };
}

interface ShimFailure {
  ok: false;
  message: string;
  notActionable?: boolean;
  failures?: string[];
}

type ShimResult = ShimSuccess | ShimFailure;

class HoverTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HOVER;
  static readonly mutates = true;

  async execute(args: HoverParams = {}): Promise<ToolResult> {
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

    // Resolve structured/prefixed selectors to a ref before the shim.
    let shimSelector: string | null = args.selector ?? null;
    let shimRef: string | null = args.ref ?? null;
    const wantStructuredResolve =
      !shimRef &&
      shimSelector &&
      (() => {
        if (args.selectorType && STRUCTURED_SELECTOR_KINDS.includes(args.selectorType)) return true;
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

    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: hoverShim,
        args: [shimSelector, shimRef, args.position ?? null, args.force === true],
      });
      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse(
          'Hover shim returned no result (frame missing or blocked?)',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }
      if (!first.ok) {
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
        hovered: true,
        tagName: first.tagName,
        bbox: first.bbox,
        point: first.point,
      });
    } catch (error) {
      return classifyTabError(error, {
        toolName: TOOL_NAMES.BROWSER.HOVER,
        tabId,
        extraDetails: { frameId: args.frameId },
      });
    }
  }
}

/**
 * ISOLATED-world hover shim. Dispatches the same event chain a real
 * mouse move into the element would trigger:
 *   pointermove → mouseover → mouseenter → pointerenter
 *
 * mouseover bubbles, mouseenter does not (per HTML spec). Both are
 * dispatched so frameworks that listen on either get notified. The
 * `relatedTarget` is set to the parent at hover-time so handlers that
 * inspect transition source see something plausible.
 */
function hoverShim(
  selector: string | null,
  ref: string | null,
  position: { x: number; y: number } | null,
  force: boolean,
): ShimResult {
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

    const target = el as HTMLElement;

    if (!force) {
      const failure = checkVisible(target);
      if (failure) {
        return {
          ok: false,
          message: `element is not actionable: ${failure}`,
          notActionable: true,
          failures: [failure],
        };
      }
    }

    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    const px = position && Number.isFinite(position.x) ? rect.x + position.x : rect.x + rect.width / 2;
    const py =
      position && Number.isFinite(position.y) ? rect.y + position.y : rect.y + rect.height / 2;

    // Hit-test: if elementFromPoint returns something other than `target`
    // (or one of its descendants/ancestors), report occluded_by:<tag>.
    if (!force) {
      const hit = document.elementFromPoint(px, py);
      if (hit && hit !== target && !target.contains(hit) && !hit.contains(target)) {
        const occluderTag =
          (hit as HTMLElement).tagName?.toLowerCase() +
          (hit.id ? `#${hit.id}` : hit.className ? `.${String(hit.className).trim().split(/\s+/)[0]}` : '');
        return {
          ok: false,
          message: `element is occluded by ${occluderTag}`,
          notActionable: true,
          failures: [`occluded_by:${occluderTag}`],
        };
      }
    }

    const parent = target.parentElement;
    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: px,
      clientY: py,
      relatedTarget: parent,
    };
    const pointerInit: PointerEventInit = {
      ...eventInit,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };

    // Order matches a real mouse: pointermove (bubbles) → mouseover
    // (bubbles) → mouseenter (no bubble, fires on each ancestor up the
    // chain). pointerenter mirrors mouseenter for pointer-event listeners.
    target.dispatchEvent(new PointerEvent('pointermove', pointerInit));
    target.dispatchEvent(new MouseEvent('mouseover', eventInit));
    target.dispatchEvent(new MouseEvent('mouseenter', { ...eventInit, bubbles: false }));
    target.dispatchEvent(new PointerEvent('pointerenter', { ...pointerInit, bubbles: false }));

    return {
      ok: true,
      hovered: true,
      resolution,
      tagName: target.tagName.toLowerCase(),
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      point: { x: px, y: py },
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  function checkVisible(t: HTMLElement): string | null {
    if (!t.isConnected) return 'not_visible';
    const style = getComputedStyle(t);
    if (style.display === 'none') return 'not_visible';
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'not_visible';
    if (Number(style.opacity) === 0) return 'not_visible';
    if (style.pointerEvents === 'none') return 'not_visible';
    const rect = t.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 'not_visible';
    return null;
  }
}

export const hoverTool = new HoverTool();
