import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { resolveToShimInputs, type SelectorType } from './_selector-resolve';

/**
 * chrome_set_checked — IMP-0146.
 *
 * Idempotent checkbox / radio state set. Caller says "I want this
 * checked:true" and the runtime makes it so, returning whether it
 * had to do anything (`changed`) and what the prior state was.
 *
 * Saves a read-then-click round-trip and removes the "what if I
 * clicked it twice" ambiguity that plagues every flow built on top
 * of `chrome_click_element` against toggles. Matches Playwright's
 * `locator.setChecked(boolean)` semantics.
 *
 * Read-only on the no-op path; mutating on the toggle path. Shim
 * accepts:
 *   - `<input type="checkbox">`, `<input type="radio">`
 *   - `[role="checkbox"]`, `[role="radio"]`, `[role="switch"]` —
 *     reads `aria-checked` for current state, dispatches a click
 *     to mutate (framework `onChange` handler runs)
 *
 * Non-checkable elements return `INVALID_ARGS` with `details.tagName`
 * / `details.role` for diagnostics.
 */

interface SetCheckedParams {
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  index?: number;
  multi?: boolean;
  checked: boolean;
  /** Skip the visibility check. Default false. */
  force?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

interface ShimSuccess {
  ok: true;
  changed: boolean;
  priorChecked: boolean;
  checked: boolean;
  tagName: string;
  role: string | null;
  resolution: 'ref' | 'selector';
}

interface ShimFailure {
  ok: false;
  message: string;
  notActionable?: boolean;
  failures?: string[];
  /** For INVALID_ARGS — surfaces tagName/role so the caller can pick a different selector. */
  invalidTarget?: { tagName: string; role: string | null };
}

type ShimResult = ShimSuccess | ShimFailure;

class SetCheckedTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SET_CHECKED;
  static readonly mutates = true;

  async execute(args: SetCheckedParams): Promise<ToolResult> {
    if (typeof args?.checked !== 'boolean') {
      return createErrorResponse(
        '`checked` is required (boolean)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'checked' },
      );
    }
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

    const resolved = await resolveToShimInputs(this, {
      selector: args.selector,
      selectorType: args.selectorType,
      ref: args.ref,
      index: args.index,
      multi: args.multi,
      tabId,
      frameId: args.frameId,
    });
    if (!resolved.ok) return resolved.error;
    const { shimSelector, shimRef } = resolved;

    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: setCheckedShim,
        args: [shimSelector, shimRef, args.checked, args.force === true],
      });
      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse(
          'set-checked shim returned no result (frame missing or blocked?)',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }
      if (!first.ok) {
        if (first.invalidTarget) {
          return createErrorResponse(first.message, ToolErrorCode.INVALID_ARGS, {
            tabId,
            frameId: args.frameId,
            tagName: first.invalidTarget.tagName,
            role: first.invalidTarget.role,
          });
        }
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
        checked: first.checked,
        changed: first.changed,
        priorChecked: first.priorChecked,
        tagName: first.tagName,
        role: first.role,
      });
    } catch (error) {
      return classifyTabError(error, {
        toolName: TOOL_NAMES.BROWSER.SET_CHECKED,
        tabId,
        extraDetails: { frameId: args.frameId },
      });
    }
  }
}

/**
 * ISOLATED-world shim. Resolves target, validates it's checkable,
 * reads current state, no-ops if already correct, otherwise clicks
 * (so framework onChange handlers fire and controlled components
 * reconcile). Verifies post-click state.
 *
 * Native checkbox/radio: reads `.checked`.
 * ARIA role=checkbox|radio|switch: reads `aria-checked === 'true'`.
 */
function setCheckedShim(
  selector: string | null,
  ref: string | null,
  wantChecked: boolean,
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
    const tagName = target.tagName.toLowerCase();
    const inputEl = target as HTMLInputElement;
    const role = target.getAttribute('role');

    const isNativeCheckable =
      tagName === 'input' && (inputEl.type === 'checkbox' || inputEl.type === 'radio');
    const isAriaCheckable =
      role === 'checkbox' || role === 'radio' || role === 'switch';

    if (!isNativeCheckable && !isAriaCheckable) {
      return {
        ok: false,
        message: `element <${tagName}${role ? ` role="${role}"` : ''}> is not checkable (need input[type=checkbox|radio] or role=checkbox|radio|switch)`,
        invalidTarget: { tagName, role },
      };
    }

    if (!force) {
      const failure = checkVisibleSync(target);
      if (failure) {
        return {
          ok: false,
          message: `element is not actionable: ${failure}`,
          notActionable: true,
          failures: [failure],
        };
      }
      if (isNativeCheckable && inputEl.disabled) {
        return {
          ok: false,
          message: 'element is disabled',
          notActionable: true,
          failures: ['disabled'],
        };
      }
      if (isAriaCheckable && target.getAttribute('aria-disabled') === 'true') {
        return {
          ok: false,
          message: 'element is aria-disabled',
          notActionable: true,
          failures: ['disabled'],
        };
      }
    }

    const priorChecked = isNativeCheckable
      ? inputEl.checked === true
      : target.getAttribute('aria-checked') === 'true';

    if (priorChecked === wantChecked) {
      return {
        ok: true,
        changed: false,
        priorChecked,
        checked: priorChecked,
        tagName,
        role,
        resolution,
      };
    }

    // Mutate by dispatching a native click. Native checkbox/radio
    // browsers will flip `.checked` + fire `change`; framework-bound
    // ARIA toggles run their click handler which usually calls
    // setState/setAttribute. Both paths are correct without us
    // setting `.checked` directly (which would skip onChange).
    target.click();

    const afterChecked = isNativeCheckable
      ? inputEl.checked === true
      : target.getAttribute('aria-checked') === 'true';

    if (afterChecked !== wantChecked) {
      return {
        ok: false,
        message: `click did not flip state — element is checked:${afterChecked}, wanted ${wantChecked}. Framework may be intercepting onChange or the element is read-only.`,
      };
    }

    return {
      ok: true,
      changed: true,
      priorChecked,
      checked: afterChecked,
      tagName,
      role,
      resolution,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  function checkVisibleSync(t: HTMLElement): string | null {
    if (!t.isConnected) return 'not_visible';
    const style = getComputedStyle(t);
    if (style.display === 'none') return 'not_visible';
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'not_visible';
    if (Number(style.opacity) === 0) return 'not_visible';
    // pointer-events:none would mean a real mouse click wouldn't land,
    // but `.click()` is programmatic and bypasses the mouse path —
    // treat the same way as focus (IMP-0153): don't block on it.
    const rect = t.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 'not_visible';
    return null;
  }
}

export const setCheckedTool = new SetCheckedTool();
