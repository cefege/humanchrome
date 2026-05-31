import { classifyTabError, createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { resolveToShimInputs, type SelectorType } from './_selector-resolve';
import { sendNativeRequest } from '../../native-host';

/**
 * chrome_native_type — Bug-008 workaround.
 *
 * Delivers REAL OS-level keystrokes via the native-messaging host process.
 * Chrome receives them through its accessibility / global-input pipeline,
 * so the resulting DOM `keydown` event has `isTrusted: true`. This is the
 * only path that drives keydown-gated typeaheads on stable Chrome 145
 * (LinkedIn Open to Work, some Ember-routed autocompletes) — CDP
 * `Input.dispatchKeyEvent` keyDown is silently suppressed in that build.
 *
 * Trade-offs vs `chrome_type_into` (the CDP path):
 *   - macOS only at the moment. Linux/Windows return `not_supported`.
 *   - Requires Accessibility permission for the host process (osascript or
 *     its parent). One-time grant via System Settings → Privacy & Security
 *     → Accessibility. Surfaces `PERMISSION_DENIED` on first use with a
 *     human-readable hint.
 *   - Brings the Chrome window to the foreground. macOS's
 *     `tell application "System Events" to keystroke` delivers to the
 *     frontmost app — we can't target a background window without a
 *     custom CGEvent helper (future work). Brief flicker is the cost.
 *   - Cannot run in headless / e2e:isolated environments — no UI app to
 *     receive the keystroke. CFT e2e doesn't exercise this row.
 *
 * Use it for the surfaces that need it. Stay on `chrome_type_into` for
 * everything else.
 */

const DEFAULT_FOCUS_SETTLE_MS = 180;
const MAX_TEXT = 1024;

interface NativeTypeParams {
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  text: string;
  /** Press Return after the text. Default false. */
  pressEnter?: boolean;
  /** Wait N ms after window/tab focus before sending keystrokes. Default 180. */
  focusSettleMs?: number;
  /** Skip the focus shim's visibility check. Default false. */
  force?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

interface FocusShimSuccess {
  ok: true;
  focused: boolean;
  tagName: string;
  inputValue: string;
}
interface FocusShimFailure {
  ok: false;
  message: string;
  notActionable?: boolean;
  failures?: string[];
}
type FocusShimResult = FocusShimSuccess | FocusShimFailure;

class NativeTypeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NATIVE_TYPE;
  static readonly mutates = true;

  async execute(args: NativeTypeParams): Promise<ToolResult> {
    if (typeof args?.text !== 'string') {
      return createErrorResponse('text is required (string)', ToolErrorCode.INVALID_ARGS, {
        arg: 'text',
      });
    }
    if (args.text.length === 0) {
      return createErrorResponse('text must not be empty', ToolErrorCode.INVALID_ARGS, {
        arg: 'text',
      });
    }
    if (args.text.length > MAX_TEXT) {
      return createErrorResponse(
        `text too long (${args.text.length} > ${MAX_TEXT})`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'text', limit: MAX_TEXT },
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
    const focusSettleMs =
      typeof args.focusSettleMs === 'number' && args.focusSettleMs >= 0
        ? Math.min(args.focusSettleMs, 5000)
        : DEFAULT_FOCUS_SETTLE_MS;

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
      tabId,
      frameId: args.frameId,
    });
    if (!resolved.ok) return resolved.error;
    const { shimSelector, shimRef } = resolved;

    try {
      // Activate the Chrome window + tab so System Events sends keystrokes
      // there. The frontmost-app requirement is a macOS Accessibility-API
      // constraint, not a humanchrome choice.
      const tabInfo = await chrome.tabs.get(tabId);
      if (typeof tabInfo.windowId === 'number') {
        try {
          await chrome.windows.update(tabInfo.windowId, { focused: true });
        } catch (e) {
          // non-fatal — window may already be focused
        }
      }
      if (tabInfo.active !== true) {
        try {
          await chrome.tabs.update(tabId, { active: true });
        } catch (e) {
          // non-fatal — tab may already be active
        }
      }

      // Focus the target input via ISOLATED-world shim. Caveat: even the
      // .focus() here gets called BEFORE the window-activation events
      // fully land in macOS. We then settle for `focusSettleMs` so the OS
      // focus, Chrome focus, and DOM activeElement all align before the
      // keystrokes start flying.
      const focusTarget: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') focusTarget.frameIds = [args.frameId];
      const focusInjected = await chrome.scripting.executeScript({
        target: focusTarget,
        world: 'ISOLATED',
        func: focusForNativeKeystroke,
        args: [shimSelector, shimRef, args.force === true],
      });
      const focusResult = focusInjected?.[0]?.result as FocusShimResult | undefined;
      if (!focusResult) {
        return createErrorResponse(
          'native-type focus shim returned no result',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }
      if (!focusResult.ok) {
        if (focusResult.notActionable === true) {
          return createErrorResponse(focusResult.message, ToolErrorCode.NOT_ACTIONABLE, {
            tabId,
            frameId: args.frameId,
            failures: Array.isArray(focusResult.failures) ? focusResult.failures : [],
          });
        }
        return createErrorResponse(focusResult.message, ToolErrorCode.UNKNOWN, { tabId });
      }

      await sleep(focusSettleMs);

      // Send to the native host. It'll spawn osascript and dispatch.
      type NativeResult =
        | { success: true; platform: string; charsTyped: number; durationMs: number }
        | {
            success: false;
            platform: string;
            error: string;
            code:
              | 'not_supported'
              | 'permission_denied'
              | 'osascript_failed'
              | 'invalid_args'
              | 'timeout';
          };
      let nativeRes: NativeResult;
      try {
        nativeRes = await sendNativeRequest<NativeResult>(
          'native_keystroke',
          { text: args.text, withReturn: args.pressEnter === true },
          15_000,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not connected/i.test(msg)) {
          return createErrorResponse(
            `native host not connected: ${msg}`,
            ToolErrorCode.UNKNOWN,
            { tabId },
          );
        }
        return createErrorResponse(
          `native_keystroke RPC failed: ${msg}`,
          ToolErrorCode.UNKNOWN,
          { tabId },
        );
      }

      if (!nativeRes.success) {
        // Map host-side codes to humanchrome error envelopes.
        if (nativeRes.code === 'permission_denied') {
          return createErrorResponse(nativeRes.error, ToolErrorCode.PERMISSION_DENIED, {
            tabId,
            platform: nativeRes.platform,
          });
        }
        if (nativeRes.code === 'not_supported') {
          return createErrorResponse(nativeRes.error, ToolErrorCode.UNKNOWN, {
            tabId,
            platform: nativeRes.platform,
            hint: 'chrome_native_type currently supports macOS only. Use chrome_type_into for CDP-driven typing on other platforms.',
          });
        }
        if (nativeRes.code === 'timeout') {
          return createErrorResponse(nativeRes.error, ToolErrorCode.TIMEOUT, { tabId });
        }
        return createErrorResponse(nativeRes.error, ToolErrorCode.UNKNOWN, {
          tabId,
          code: nativeRes.code,
          platform: nativeRes.platform,
        });
      }

      // Read back the final input value so callers can verify what landed.
      const finalInjected = await chrome.scripting.executeScript({
        target: focusTarget,
        world: 'ISOLATED',
        func: readFinalValue,
        args: [shimSelector, shimRef],
      });
      const finalValue = finalInjected?.[0]?.result;

      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        text: args.text,
        charsTyped: nativeRes.charsTyped,
        pressedEnter: args.pressEnter === true,
        platform: nativeRes.platform,
        durationMs: nativeRes.durationMs,
        finalValue: typeof finalValue === 'string' ? finalValue : null,
      });
    } catch (error) {
      return classifyTabError(error, {
        toolName: TOOL_NAMES.BROWSER.NATIVE_TYPE,
        tabId,
        extraDetails: { frameId: args.frameId },
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function focusForNativeKeystroke(
  selector: string | null,
  ref: string | null,
  force: boolean,
): FocusShimResult {
  try {
    let el: Element | null = null;
    if (ref) {
      const map = (window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> })
        .__claudeElementMap;
      if (!map || !map[ref]) {
        return { ok: false, message: `ref "${ref}" not found in element map` };
      }
      el = map[ref].deref?.() ?? null;
      if (!el) {
        return { ok: false, message: `ref "${ref}" element has been garbage-collected` };
      }
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
      const failure = checkVisibleSync(target);
      if (failure) {
        return {
          ok: false,
          message: `element is not actionable: ${failure}`,
          notActionable: true,
          failures: [failure],
        };
      }
      const input = target as HTMLInputElement;
      if (input.disabled === true) {
        return {
          ok: false,
          message: 'element is disabled',
          notActionable: true,
          failures: ['disabled'],
        };
      }
      if (input.readOnly === true) {
        return {
          ok: false,
          message: 'element is readonly',
          notActionable: true,
          failures: ['not_editable'],
        };
      }
    }

    target.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
    const input = target as HTMLInputElement;
    return {
      ok: true,
      focused: document.activeElement === target,
      tagName: target.tagName.toLowerCase(),
      inputValue: typeof input.value === 'string' ? input.value : '',
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
    const r = t.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 'not_visible';
    return null;
  }
}

function readFinalValue(selector: string | null, ref: string | null): string | undefined {
  try {
    let el: Element | null = null;
    if (ref) {
      const map = (window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> })
        .__claudeElementMap;
      el = map?.[ref]?.deref?.() ?? null;
    } else if (selector) {
      el = document.querySelector(selector);
    }
    if (!el) return undefined;
    const input = el as HTMLInputElement;
    return typeof input.value === 'string' ? input.value : (el as HTMLElement).innerText;
  } catch {
    return undefined;
  }
}

export const nativeTypeTool = new NativeTypeTool();
