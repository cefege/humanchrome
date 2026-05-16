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

interface DragDropParams {
  tabId?: number;
  windowId?: number;
  fromSelector?: string;
  fromSelectorType?: SelectorType;
  fromIndex?: number;
  fromRef?: string;
  toSelector?: string;
  toSelectorType?: SelectorType;
  toIndex?: number;
  toRef?: string;
  multi?: boolean;
  frameId?: number;
  steps?: number;
}

interface ShimSuccess {
  ok: true;
  fromBox: { x: number; y: number; width: number; height: number };
  toBox: { x: number; y: number; width: number; height: number };
  steps: number;
}

interface ShimFailure {
  ok: false;
  message: string;
  reason?: 'from_not_found' | 'to_not_found' | 'from_hidden' | 'to_hidden' | 'other';
}

type ShimResult = ShimSuccess | ShimFailure;

/**
 * Synthesize a drag-and-drop sequence between two elements. The MAIN-world
 * shim resolves both targets, computes their bounding-rect centers, then
 * dispatches the full HTML5 DnD + pointer event chain along a linear
 * interpolation between the two centers.
 */
class DragDropTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DRAG_DROP;
  static readonly mutates = true;

  async execute(args: DragDropParams = {}): Promise<ToolResult> {
    const hasFromSelector = typeof args.fromSelector === 'string' && args.fromSelector.length > 0;
    const hasFromRef = typeof args.fromRef === 'string' && args.fromRef.length > 0;
    if (hasFromSelector === hasFromRef) {
      return createErrorResponse(
        'Exactly one of [fromSelector] or [fromRef] is required.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'fromSelector|fromRef' },
      );
    }
    const hasToSelector = typeof args.toSelector === 'string' && args.toSelector.length > 0;
    const hasToRef = typeof args.toRef === 'string' && args.toRef.length > 0;
    if (hasToSelector === hasToRef) {
      return createErrorResponse(
        'Exactly one of [toSelector] or [toRef] is required.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'toSelector|toRef' },
      );
    }
    const steps = typeof args.steps === 'number' ? Math.max(1, Math.min(50, args.steps)) : 5;

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
      // IMP-0098: Structured selectors (`role:`, `label:`, etc.) and prefixed
      // CSS strings can't run inside the MAIN-world shim because the
      // accessible-name compute lives in the accessibility-tree-helper which
      // is injected ISOLATED. We resolve structured/prefixed selectors via
      // RESOLVE_REF (ISOLATED → CSS selector string) and feed that back into
      // the MAIN shim's plain `document.querySelector` path.
      const resolveEndpoint = async (
        sel: string | undefined,
        kind: SelectorType | undefined,
        ref: string | undefined,
        index: number | undefined,
        label: 'from' | 'to',
      ): Promise<
        { ok: true; selector?: string; ref?: string } | { ok: false; error: ToolResult }
      > => {
        if (ref) return { ok: true, ref };
        if (!sel) return { ok: true };
        const needsResolve =
          kind === 'xpath' ||
          (kind && STRUCTURED_SELECTOR_KINDS.includes(kind)) ||
          parsePrefixedSelector(sel).kind !== 'css';
        if (!needsResolve) return { ok: true, selector: sel };

        const resolved = await resolveSelectorToRef(this, {
          tabId,
          frameId: args.frameId,
          selector: sel,
          selectorType: kind ?? 'css',
          index,
          multi: args.multi,
        });
        if (!resolved.ok) {
          return {
            ok: false,
            error: createErrorResponse(
              `drag-drop ${label}: ${(resolved.error.content[0] as { text: string }).text}`,
              ToolErrorCode.INVALID_ARGS,
              { side: label },
            ),
          };
        }
        // Ask the page-side helper to surface a CSS selector for the ref so
        // the MAIN-world shim can re-locate the element (refs across worlds
        // are unreliable).
        try {
          interface ResolveRefResp {
            success?: boolean;
            selector?: string;
          }
          const refDetails =
            typeof args.frameId === 'number'
              ? ((await chrome.tabs.sendMessage(
                  tabId,
                  { action: 'resolveRef', ref: resolved.ref },
                  { frameId: args.frameId },
                )) as ResolveRefResp)
              : ((await chrome.tabs.sendMessage(tabId, {
                  action: 'resolveRef',
                  ref: resolved.ref,
                })) as ResolveRefResp);
          if (refDetails && refDetails.success && refDetails.selector) {
            return { ok: true, selector: refDetails.selector };
          }
        } catch {
          /* ignore — fall through to ref attempt */
        }
        return { ok: true, ref: resolved.ref };
      };

      const fromResolved = await resolveEndpoint(
        args.fromSelector,
        args.fromSelectorType,
        args.fromRef,
        args.fromIndex,
        'from',
      );
      if (!fromResolved.ok) return fromResolved.error;
      const toResolved = await resolveEndpoint(
        args.toSelector,
        args.toSelectorType,
        args.toRef,
        args.toIndex,
        'to',
      );
      if (!toResolved.ok) return toResolved.error;

      const finalFromSelector = fromResolved.selector ?? args.fromSelector ?? null;
      const finalFromRef = fromResolved.ref ?? args.fromRef ?? null;
      const finalToSelector = toResolved.selector ?? args.toSelector ?? null;
      const finalToRef = toResolved.ref ?? args.toRef ?? null;

      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'MAIN',
        func: dragDropShim,
        args: [
          // Prefer the resolved CSS selector; fall back to the original
          // selector + ref pair so the existing shim contract is intact.
          finalFromSelector,
          finalFromRef,
          finalToSelector,
          finalToRef,
          steps,
        ],
      });
      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse(
          'drag-drop shim returned no result (frame missing or blocked?)',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }
      if (!first.ok) {
        // Hidden / not-visible / not-found errors are recoverable agent-level
        // signals — classify as INVALID_ARGS so callers can branch without
        // re-raising.
        const code =
          first.reason === 'from_not_found' ||
          first.reason === 'to_not_found' ||
          first.reason === 'from_hidden' ||
          first.reason === 'to_hidden'
            ? ToolErrorCode.INVALID_ARGS
            : ToolErrorCode.UNKNOWN;
        return createErrorResponse(first.message, code, {
          tabId,
          frameId: args.frameId,
          reason: first.reason,
        });
      }
      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        steps: first.steps,
        fromBox: first.fromBox,
        toBox: first.toBox,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, { tabId });
      }
      console.error('Error in DragDropTool.execute:', error);
      return createErrorResponse(`chrome_drag_drop failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
        frameId: args.frameId,
      });
    }
  }
}

/**
 * MAIN-world shim. Self-contained — no closure capture. Synthesizes the
 * full HTML5 drag-and-drop + Pointer-Events chain so both event-aware
 * pages (Trello, kanban) and HTML5-DnD-only pages get the right signals.
 */
function dragDropShim(
  fromSelector: string | null,
  fromRef: string | null,
  toSelector: string | null,
  toRef: string | null,
  steps: number,
): ShimResult {
  try {
    interface ElementMapWindow {
      __claudeElementMap?: Record<string, WeakRef<Element>>;
    }
    const elementMap = (window as unknown as ElementMapWindow).__claudeElementMap;

    const resolve = (
      selector: string | null,
      ref: string | null,
      label: 'from' | 'to',
    ): Element | { error: string; reason: ShimFailure['reason'] } => {
      if (ref) {
        if (!elementMap || !elementMap[ref]) {
          return {
            error: `${label} ref "${ref}" not found in element map`,
            reason: `${label}_not_found` as ShimFailure['reason'],
          };
        }
        const deref = elementMap[ref].deref?.();
        if (!deref) {
          return {
            error: `${label} ref "${ref}" element has been garbage-collected`,
            reason: `${label}_not_found` as ShimFailure['reason'],
          };
        }
        return deref;
      }
      if (selector) {
        const found = document.querySelector(selector);
        if (!found) {
          return {
            error: `${label} selector "${selector}" matched no element`,
            reason: `${label}_not_found` as ShimFailure['reason'],
          };
        }
        return found;
      }
      return { error: `${label}: neither selector nor ref provided`, reason: 'other' };
    };

    const fromResolved = resolve(fromSelector, fromRef, 'from');
    if (!(fromResolved instanceof Element)) {
      return { ok: false, message: fromResolved.error, reason: fromResolved.reason };
    }
    const toResolved = resolve(toSelector, toRef, 'to');
    if (!(toResolved instanceof Element)) {
      return { ok: false, message: toResolved.error, reason: toResolved.reason };
    }
    const fromEl = fromResolved as HTMLElement;
    const toEl = toResolved as HTMLElement;

    const isVisible = (el: HTMLElement): boolean => {
      if (el === document.body) return true;
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    if (!isVisible(fromEl)) {
      return { ok: false, message: 'from element is not visible', reason: 'from_hidden' };
    }
    if (!isVisible(toEl)) {
      return { ok: false, message: 'to element is not visible', reason: 'to_hidden' };
    }

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const fx = fromRect.left + fromRect.width / 2;
    const fy = fromRect.top + fromRect.height / 2;
    const tx = toRect.left + toRect.width / 2;
    const ty = toRect.top + toRect.height / 2;

    const dataTransfer = new DataTransfer();

    const fire = (
      el: Element,
      type: string,
      x: number,
      y: number,
      use: 'pointer' | 'drag',
    ): boolean => {
      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        button: 0,
      };
      let ev: Event;
      if (use === 'drag') {
        ev = new DragEvent(type, {
          ...init,
          dataTransfer,
        } as DragEventInit);
      } else {
        ev = new PointerEvent(type, init as PointerEventInit);
      }
      return el.dispatchEvent(ev);
    };

    fire(fromEl, 'pointerdown', fx, fy, 'pointer');
    fire(fromEl, 'mousedown', fx, fy, 'pointer');
    fire(fromEl, 'dragstart', fx, fy, 'drag');

    for (let i = 1; i <= steps; i++) {
      const mx = fx + ((tx - fx) * i) / (steps + 1);
      const my = fy + ((ty - fy) * i) / (steps + 1);
      fire(fromEl, 'pointermove', mx, my, 'pointer');
      // dragover fires on whatever element is currently under the cursor —
      // for the synthetic case we approximate with the to-element after the
      // first half so kanban / sortable libs see crossing.
      const intermediateTarget = i > steps / 2 ? toEl : fromEl;
      fire(intermediateTarget, 'dragover', mx, my, 'drag');
    }

    fire(toEl, 'dragenter', tx, ty, 'drag');
    fire(toEl, 'dragover', tx, ty, 'drag');
    fire(toEl, 'drop', tx, ty, 'drag');
    fire(fromEl, 'dragend', tx, ty, 'drag');
    fire(toEl, 'pointerup', tx, ty, 'pointer');
    fire(toEl, 'mouseup', tx, ty, 'pointer');

    return {
      ok: true,
      fromBox: {
        x: fromRect.left,
        y: fromRect.top,
        width: fromRect.width,
        height: fromRect.height,
      },
      toBox: { x: toRect.left, y: toRect.top, width: toRect.width, height: toRect.height },
      steps,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      reason: 'other',
    };
  }
}

export const dragDropTool = new DragDropTool();
