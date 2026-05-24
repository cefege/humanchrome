import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { resolveToShimInputs, type SelectorType } from './_selector-resolve';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * chrome_type_into — IMP-0143.
 *
 * Char-by-char keystroke typing into a focused selector with realistic
 * per-key delay. Anti-bot heuristics on LinkedIn / Tinder / Facebook
 * search boxes flag the lack of keyboard cadence from
 * `chrome_fill_or_select` (which sets `el.value` + dispatches one
 * `input` event) and skip suggestions / shadowban the session.
 *
 * `chrome_keyboard` fires at the window without focus-pinning;
 * `chrome_paste` pastes a single buffer. There was no primitive for
 * "focus this input and type N characters one keystroke at a time
 * with realistic delay between keys" — exactly what humans look like.
 *
 * Implementation: focus the target via ISOLATED-world shim, then
 * dispatch CDP `Input.dispatchKeyEvent` keyDown/keyUp pairs per
 * character with `perKeyDelayMs ± jitter` between them. Optional
 * `clearFirst` selects-all + deletes the existing value; optional
 * `pressEnter` submits at the end.
 *
 * Pairs with `chrome_pace` (slow profile) for naturally-paced flows.
 */

const DEFAULT_PER_KEY_MS = 60;
const DEFAULT_JITTER_MS = 30;
const MAX_TEXT_LENGTH = 1024; // safety: avoid 30-min typing sessions
const OWNER = 'type-into' as const;

interface TypeIntoParams {
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  index?: number;
  multi?: boolean;
  text: string;
  perKeyDelayMs?: number;
  /** ± jitter added to perKeyDelayMs. Set to 0 for fixed cadence. */
  jitterMs?: number;
  pressEnter?: boolean;
  clearFirst?: boolean;
  /** Skip the focus shim's visibility check. */
  force?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

interface FocusShimSuccess {
  ok: true;
  focused: boolean;
  tagName: string;
  isContentEditable: boolean;
}
interface FocusShimFailure {
  ok: false;
  message: string;
  notActionable?: boolean;
  failures?: string[];
}
type FocusShimResult = FocusShimSuccess | FocusShimFailure;

class TypeIntoTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TYPE_INTO;
  static readonly mutates = true;

  async execute(args: TypeIntoParams): Promise<ToolResult> {
    if (typeof args?.text !== 'string') {
      return createErrorResponse(
        'text is required (string)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'text' },
      );
    }
    if (args.text.length > MAX_TEXT_LENGTH) {
      return createErrorResponse(
        `text too long (${args.text.length} > ${MAX_TEXT_LENGTH})`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'text', limit: MAX_TEXT_LENGTH },
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

    const perKey = clamp(
      typeof args.perKeyDelayMs === 'number' ? args.perKeyDelayMs : DEFAULT_PER_KEY_MS,
      0,
      5000,
    );
    const jitter = clamp(
      typeof args.jitterMs === 'number' ? args.jitterMs : DEFAULT_JITTER_MS,
      0,
      5000,
    );

    // Resolve structured/prefixed selector → ref so the shim only handles
    // raw CSS / ref (same pattern as focus/click).
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
      // Step 1: focus the target via ISOLATED shim. The shim also runs
      // a visibility check and reports contenteditable so we know how to
      // clear (Ctrl/Cmd+A vs Selection.removeAllRanges fallback).
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof args.frameId === 'number') target.frameIds = [args.frameId];
      const focusInjected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: focusForTyping,
        args: [shimSelector, shimRef, args.force === true],
      });
      const focusResult = focusInjected?.[0]?.result as FocusShimResult | undefined;
      if (!focusResult) {
        return createErrorResponse(
          'type-into focus shim returned no result',
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

      // Step 2: drive CDP keystrokes. All key dispatch happens through a
      // single attached debugger session so we don't pay attach/detach
      // per keystroke.
      let typedCount = 0;
      await cdpSessionManager.withSession(tabId, OWNER, async () => {
        if (args.clearFirst === true) {
          await sendSelectAll(tabId!);
          await sendKey(tabId!, 'Delete', 'Delete', 46);
        }
        for (const ch of Array.from(args.text)) {
          await sendChar(tabId!, ch);
          typedCount += 1;
          const delay = perKey + (jitter > 0 ? Math.floor((Math.random() - 0.5) * 2 * jitter) : 0);
          if (delay > 0) await sleep(delay);
        }
        if (args.pressEnter === true) {
          await sendKey(tabId!, 'Enter', 'Enter', 13, '\r');
        }
      });

      // Step 3: read back final value so callers can verify what landed.
      const finalInjected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: readFinalValue,
        args: [shimSelector, shimRef],
      });
      const finalValue = finalInjected?.[0]?.result as string | undefined;

      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        typed: typedCount,
        finalValue: typeof finalValue === 'string' ? finalValue : null,
        pressedEnter: args.pressEnter === true,
        cleared: args.clearFirst === true,
        contentEditable: focusResult.isContentEditable,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/another debugger|already attached/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId });
      }
      return classifyTabError(error, {
        toolName: TOOL_NAMES.BROWSER.TYPE_INTO,
        tabId,
        extraDetails: { frameId: args.frameId },
      });
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a single printable character. CDP's keyDown with `text` is the
 * canonical "type this char" call — it triggers keypress + input
 * events naturally and works for ASCII + Unicode. We don't need to
 * supply keyCode for plain text input; Chromium synthesises it.
 */
async function sendChar(tabId: number, ch: string): Promise<void> {
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: ch,
    unmodifiedText: ch,
    key: ch,
  });
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ch,
  });
}

/**
 * Send a named non-printable key (Enter, Delete, etc). CDP needs `key`,
 * `code`, `windowsVirtualKeyCode` to recognize it as a control key
 * rather than printable text.
 */
async function sendKey(
  tabId: number,
  key: string,
  code: string,
  vk: number,
  text?: string,
): Promise<void> {
  const down: Record<string, unknown> = {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
  if (text) down.text = text;
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', down);
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
}

/**
 * Cross-platform Select-All. Sends Cmd+A on Mac (via modifiers:4) and
 * Ctrl+A everywhere else (modifiers:2). The keyboard.ts platform-cache
 * isn't reachable from here without an extra IPC, but Chromium honors
 * the modifier mask regardless of host OS so the meta path works on
 * both — pick meta to avoid Windows/Linux divergence.
 */
async function sendSelectAll(tabId: number): Promise<void> {
  // Use Ctrl+A (modifiers: 2) — universally accepted across browsers
  // for text inputs and contenteditable. Cmd+A works on Mac too but
  // some Linux/Windows builds only honor Ctrl.
  const aDown = {
    type: 'rawKeyDown' as const,
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  };
  const aUp = {
    type: 'keyUp' as const,
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  };
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', aDown);
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', aUp);
}

/**
 * ISOLATED-world shim: resolve target, run a sync visibility check,
 * focus, return `isContentEditable` so the caller knows the target's
 * shape. Same checkVisibleSync as focus.ts (omitting pointer-events
 * per IMP-0153).
 */
function focusForTyping(
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
      // For typing, the element must accept input. Disabled / readonly
      // would silently swallow CDP keystrokes.
      const input = focusable as HTMLInputElement;
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

    focusable.focus({ preventScroll: false });
    return {
      ok: true,
      focused: document.activeElement === el,
      tagName: el.tagName.toLowerCase(),
      isContentEditable: (focusable as HTMLElement).isContentEditable === true,
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
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 'not_visible';
    return null;
  }
}

/**
 * Post-typing read-back: returns the element's current value (inputs)
 * or innerText (contenteditable) so the caller can verify what landed.
 * Returns undefined when the element no longer exists.
 */
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
    if (typeof input.value === 'string') return input.value;
    return (el as HTMLElement).innerText;
  } catch {
    return undefined;
  }
}

export const typeIntoTool = new TypeIntoTool();
