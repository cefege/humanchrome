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
  /**
   * 'paste' (default, fast) — single Cmd+V keystroke; saves/restores user
   * clipboard. 'keystroke' types char-by-char; slower, longer focus window,
   * useful when the page debounces by per-key cadence.
   */
  mode?: 'paste' | 'keystroke';
  /**
   * Post-keystroke verification: re-read input.value and check it contains
   * `text`. On mismatch, return an error envelope so the caller knows the
   * keystroke didn't land where expected (e.g. focus got stolen).
   * Default true. Set false to opt out for unusual inputs.
   */
  verify?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

/**
 * Chrome variants we're willing to fire keystrokes into. macOS frontmost-app
 * verify rejects anything else with `wrong_frontmost_app` — keystrokes do
 * NOT land in the user's VS Code / Slack / terminal if focus shifted during
 * our window-activation step.
 */
const ACCEPTABLE_FRONTMOST_APPS = [
  'Google Chrome',
  'Google Chrome Canary',
  'Google Chrome for Testing',
  'Chromium',
];

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
      // Hard-gate on the focus shim's `focused` field. Previously we just
      // logged it; now refuse if focus didn't actually land. If we proceeded
      // here with `focused:false`, the keystrokes would go to wherever
      // document.activeElement is — usually the body, sometimes a stale
      // other input. That's exactly the "fuck things up" path we're
      // guarding against.
      if (focusResult.focused !== true) {
        return createErrorResponse(
          `Target element did not receive focus before keystroke. document.activeElement is "${focusResult.tagName}"; expected the target input. Refusing to type into the wrong element.`,
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId, hint: 'focus_failed' },
        );
      }

      await sleep(focusSettleMs);

      const mode: 'paste' | 'keystroke' = args.mode === 'keystroke' ? 'keystroke' : 'paste';

      // Send to the native host. It'll spawn osascript and dispatch.
      type NativeResult =
        | {
            success: true;
            platform: string;
            mode: 'paste' | 'keystroke';
            charsTyped: number;
            durationMs: number;
            frontmostBefore?: string;
          }
        | {
            success: false;
            platform: string;
            error: string;
            code:
              | 'not_supported'
              | 'permission_denied'
              | 'osascript_failed'
              | 'invalid_args'
              | 'timeout'
              | 'wrong_frontmost_app';
            frontmostBefore?: string;
          };
      let nativeRes: NativeResult;
      try {
        nativeRes = await sendNativeRequest<NativeResult>(
          'native_keystroke',
          {
            text: args.text,
            withReturn: args.pressEnter === true,
            mode,
            expectedFrontmostApp: ACCEPTABLE_FRONTMOST_APPS,
          },
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
        if (nativeRes.code === 'wrong_frontmost_app') {
          return createErrorResponse(nativeRes.error, ToolErrorCode.UNKNOWN, {
            tabId,
            frontmostBefore: nativeRes.frontmostBefore,
            hint: 'wrong_frontmost_app',
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
      // Tiny additional settle so the page's input-event handlers (and any
      // React state-flush) have a moment to run before we read.
      await sleep(40);
      const finalInjected = await chrome.scripting.executeScript({
        target: focusTarget,
        world: 'ISOLATED',
        func: readFinalValue,
        args: [shimSelector, shimRef],
      });
      const finalValue =
        typeof finalInjected?.[0]?.result === 'string'
          ? (finalInjected[0].result as string)
          : null;

      // Post-keystroke verification. The keystrokes WERE sent (osascript
      // returned 0), but verifying the page actually received them catches:
      //   - Focus stolen mid-keystroke (next-most-likely failure after the
      //     pre-keystroke frontmost check).
      //   - Input cleared by page-side JS while we were typing (some
      //     auto-completes do this on every input event).
      //   - We typed into a different input than intended (focus shim said
      //     OK but page swapped the focused element after — rare but real
      //     on React-controlled focus management).
      //
      // Heuristic: `finalValue` should CONTAIN the text we typed. We don't
      // require exact equality because of `pressEnter` behaviors, page-
      // side normalization (typeaheads commit a selected option that
      // expands the text), or pre-existing text that wasn't cleared.
      const verify = args.verify !== false;
      let verified: boolean | null = null;
      let verificationMessage: string | null = null;
      if (verify) {
        if (finalValue === null) {
          verified = false;
          verificationMessage = "Couldn't read input value back. Element may have been replaced by the page.";
        } else if (finalValue === '') {
          verified = false;
          verificationMessage =
            'Input is empty after keystroke. Most likely the page-side handler cleared it (common on submit) or focus was stolen mid-keystroke.';
        } else if (!finalValue.includes(args.text)) {
          verified = false;
          verificationMessage = `Input does not contain the expected text. Expected to contain "${args.text}", got "${finalValue.slice(0, 100)}". Keystrokes may have landed elsewhere.`;
        } else {
          verified = true;
        }
      }

      if (verify && verified === false) {
        return createErrorResponse(
          verificationMessage ?? 'Verification failed',
          ToolErrorCode.UNKNOWN,
          {
            tabId,
            frameId: args.frameId,
            hint: 'verification_failed',
            finalValue,
            frontmostBefore: nativeRes.frontmostBefore,
            mode: nativeRes.mode,
          },
        );
      }

      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        text: args.text,
        charsTyped: nativeRes.charsTyped,
        pressedEnter: args.pressEnter === true,
        platform: nativeRes.platform,
        mode: nativeRes.mode,
        durationMs: nativeRes.durationMs,
        finalValue,
        verified,
        frontmostBefore: nativeRes.frontmostBefore ?? null,
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
