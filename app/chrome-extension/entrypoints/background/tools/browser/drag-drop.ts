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
  // IMP-0097: skip the visible+stable+hit-test suite on both source and
  // target. scrollIntoView still runs. Default false.
  force?: boolean;
  // IMP-0097: per-call cap on actionability wait. Default 5000ms.
  actionabilityTimeoutMs?: number;
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
  reason?:
    | 'from_not_found'
    | 'to_not_found'
    | 'from_hidden'
    | 'to_hidden'
    | 'from_not_actionable'
    | 'to_not_actionable'
    | 'other';
  /** IMP-0097: failure tokens when reason ends in `_not_actionable`. */
  failures?: string[];
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

    const force = args.force === true;
    const actionabilityTimeoutMs =
      typeof args.actionabilityTimeoutMs === 'number' ? args.actionabilityTimeoutMs : 5000;

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

      const [fromResolved, toResolved] = await Promise.all([
        resolveEndpoint(
          args.fromSelector,
          args.fromSelectorType,
          args.fromRef,
          args.fromIndex,
          'from',
        ),
        resolveEndpoint(args.toSelector, args.toSelectorType, args.toRef, args.toIndex, 'to'),
      ]);
      if (!fromResolved.ok) return fromResolved.error;
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
          force,
          actionabilityTimeoutMs,
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
        // Per-reason classification:
        //  - hidden / not-found targets    → INVALID_ARGS (caller fixes the locator)
        //  - actionability failures (suite) → NOT_ACTIONABLE (caller waits/scrolls/dismisses)
        //  - everything else                → UNKNOWN
        let code: ToolErrorCode;
        if (first.reason === 'from_not_actionable' || first.reason === 'to_not_actionable') {
          code = ToolErrorCode.NOT_ACTIONABLE;
        } else if (
          first.reason === 'from_not_found' ||
          first.reason === 'to_not_found' ||
          first.reason === 'from_hidden' ||
          first.reason === 'to_hidden'
        ) {
          code = ToolErrorCode.INVALID_ARGS;
        } else {
          code = ToolErrorCode.UNKNOWN;
        }
        return createErrorResponse(first.message, code, {
          tabId,
          frameId: args.frameId,
          reason: first.reason,
          ...(first.failures ? { failures: first.failures } : {}),
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
 * Both source and target run through an inlined actionability suite
 * (visible+stable+hit-test) before dispatch — see IMP-0097.
 */
async function dragDropShim(
  fromSelector: string | null,
  fromRef: string | null,
  toSelector: string | null,
  toRef: string | null,
  steps: number,
  force: boolean,
  actionabilityTimeoutMs: number,
): Promise<ShimResult> {
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

    // Inlined actionability suite. MAIN-world shims are serialized as
    // standalone functions (no closure capture), so we can't reach into
    // window.__actionability — duplicate the visible/stable/hit-test
    // logic here. Drag specifically runs visible+stable+hit-test on
    // BOTH endpoints (Playwright matches this).
    const scrollIfNeeded = (el: HTMLElement): void => {
      try {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {
          el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        }
      } catch {
        // ignore
      }
    };
    scrollIfNeeded(fromEl);
    scrollIfNeeded(toEl);

    const checkVisible = (el: HTMLElement): string | null => {
      if (!el.isConnected) return 'not_visible';
      const style = getComputedStyle(el);
      if (style.display === 'none') return 'not_visible';
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'not_visible';
      if (Number(style.opacity) === 0) return 'not_visible';
      if (style.pointerEvents === 'none') return 'not_visible';
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return 'not_visible';
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return 'not_visible';
      return null;
    };

    const checkStable = (el: HTMLElement): Promise<string | null> => {
      return new Promise((resolveStability) => {
        let frames = 0;
        let prev = el.getBoundingClientRect();
        const tick = () => {
          const cur = el.getBoundingClientRect();
          if (
            prev.x === cur.x &&
            prev.y === cur.y &&
            prev.width === cur.width &&
            prev.height === cur.height
          ) {
            resolveStability(null);
            return;
          }
          prev = cur;
          frames += 1;
          if (frames >= 6) {
            resolveStability('unstable_bbox');
            return;
          }
          const raf =
            typeof window.requestAnimationFrame === 'function'
              ? window.requestAnimationFrame
              : (cb: FrameRequestCallback) => window.setTimeout(cb, 16);
          raf(tick);
        };
        tick();
      });
    };

    const describeOccluder = (el: Element): string => {
      const tag = (el.tagName || 'unknown').toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      if (typeof el.className === 'string' && el.className.trim().length > 0) {
        const first = el.className.trim().split(/\s+/)[0];
        if (first) return `${tag}.${first}`;
      }
      return tag;
    };

    const checkHit = (el: HTMLElement): string | null => {
      if (typeof document.elementFromPoint !== 'function') return null;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const topmost = document.elementFromPoint(cx, cy);
      if (!topmost) return 'no_element_at_point';
      if (topmost === el) return null;
      if (el.contains(topmost)) return null;
      if (topmost.contains(el)) return null;
      return `occluded_by:${describeOccluder(topmost)}`;
    };

    const runActionability = async (
      el: HTMLElement,
      label: 'from' | 'to',
    ): Promise<{ ok: true } | { ok: false; failures: string[] }> => {
      if (force) return { ok: true };
      const deadline = Date.now() + Math.max(0, actionabilityTimeoutMs);
      let lastFailures: string[] = [];
      while (true) {
        const failures: string[] = [];
        const v = checkVisible(el);
        if (v) failures.push(v);
        if (failures.length === 0) {
          const s = await checkStable(el);
          if (s) failures.push(s);
        }
        if (failures.length === 0) {
          const h = checkHit(el);
          if (h) failures.push(h);
        }
        if (failures.length === 0) return { ok: true };
        lastFailures = failures;
        if (Date.now() >= deadline) return { ok: false, failures: lastFailures };
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    // Source first — failing here means the user shouldn't even try to
    // synthesize the chain.
    const fromAct = await runActionability(fromEl, 'from');
    if (!fromAct.ok) {
      return {
        ok: false,
        message: `from element is not actionable: ${fromAct.failures.join(', ')}`,
        reason: 'from_not_actionable',
        failures: fromAct.failures,
      };
    }
    const toAct = await runActionability(toEl, 'to');
    if (!toAct.ok) {
      return {
        ok: false,
        message: `to element is not actionable: ${toAct.failures.join(', ')}`,
        reason: 'to_not_actionable',
        failures: toAct.failures,
      };
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
