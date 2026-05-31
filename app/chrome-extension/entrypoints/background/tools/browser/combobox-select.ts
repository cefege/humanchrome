import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { resolveToShimInputs, type SelectorType } from './_selector-resolve';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { sendChar, sendNamedKey, sendSelectAll, sendKey, NAMED_KEYS } from './_keystrokes';

/**
 * chrome_combobox_select — resolves bug #007.
 *
 * React (Downshift / react-aria) and Ember combobox state machines refuse
 * to bind on a synthetic option click — the option highlights but the
 * form's "selected option" state stays empty, and the next Save click
 * silently no-ops. Only the keyboard commit path (ArrowDown to highlight
 * + Enter to commit) updates that state.
 *
 * This tool wraps the discovered-by-pain working sequence so callers
 * don't waste session time discovering it:
 *   1. CDP mouse click on the combobox input (focus)
 *   2. Optional Ctrl+A + Delete (clearFirst)
 *   3. CDP keystrokes type the query char-by-char
 *   4. Poll for [role="option"] elements to render
 *   5. ArrowDown to the option whose text matches matchText
 *   6. Enter to commit
 *
 * All steps run trusted CDP events under a single `withSession` block.
 */

const DEFAULT_PER_KEY_MS = 60;
const DEFAULT_JITTER_MS = 30;
const DEFAULT_WAIT_OPTIONS_MS = 5000;
const MAX_QUERY_LENGTH = 256;
const MAX_ARROW_DOWN = 50;
const OWNER = 'combobox-select' as const;

interface ComboboxSelectParams {
  comboboxSelector?: string;
  selectorType?: SelectorType;
  ref?: string;
  query: string;
  matchText?: string;
  matchMode?: 'exact' | 'contains' | 'startsWith';
  clearFirst?: boolean;
  optionSelector?: string;
  waitForOptionsMs?: number;
  perKeyDelayMs?: number;
  jitterMs?: number;
  force?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

interface FocusShimSuccess {
  ok: true;
  bbox: { x: number; y: number; width: number; height: number };
  point: { x: number; y: number };
  tagName: string;
}
interface FocusShimFailure {
  ok: false;
  message: string;
  notActionable?: boolean;
  failures?: string[];
}
type FocusShimResult = FocusShimSuccess | FocusShimFailure;

interface ProbeOption {
  index: number;
  text: string;
}
interface ProbeSuccess {
  ok: true;
  count: number;
  options: ProbeOption[];
}
interface ProbeFailure {
  ok: false;
  message: string;
}
type ProbeResult = ProbeSuccess | ProbeFailure;

class ComboboxSelectTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.COMBOBOX_SELECT;
  static readonly mutates = true;

  async execute(args: ComboboxSelectParams): Promise<ToolResult> {
    if (typeof args?.query !== 'string' || args.query.length === 0) {
      return createErrorResponse(
        'query is required (non-empty string)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'query' },
      );
    }
    if (args.query.length > MAX_QUERY_LENGTH) {
      return createErrorResponse(
        `query too long (${args.query.length} > ${MAX_QUERY_LENGTH})`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'query', limit: MAX_QUERY_LENGTH },
      );
    }
    const hasSelector =
      typeof args.comboboxSelector === 'string' && args.comboboxSelector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
      return createErrorResponse(
        'Exactly one of [comboboxSelector] or [ref] is required.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'comboboxSelector|ref' },
      );
    }

    const matchText = typeof args.matchText === 'string' ? args.matchText : args.query;
    const matchMode = args.matchMode ?? 'contains';
    const clearFirst = args.clearFirst !== false; // default true
    const optionSelector =
      typeof args.optionSelector === 'string' && args.optionSelector.length > 0
        ? args.optionSelector
        : '[role="option"]';
    const waitForOptionsMs = clamp(
      typeof args.waitForOptionsMs === 'number' ? args.waitForOptionsMs : DEFAULT_WAIT_OPTIONS_MS,
      100,
      60000,
    );
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
      selector: args.comboboxSelector,
      selectorType: args.selectorType,
      ref: args.ref,
      tabId,
      frameId: args.frameId,
    });
    if (!resolved.ok) return resolved.error;
    const { shimSelector, shimRef } = resolved;

    const target: { tabId: number; frameIds?: number[] } = { tabId };
    if (typeof args.frameId === 'number') target.frameIds = [args.frameId];

    try {
      // Step 1: ISOLATED shim → resolve, visibility-check, return bbox+point
      // for the CDP click. No focus() here — CDP mouseDown/mouseUp delivers
      // the trusted focus event the combobox handler is gated on.
      const focusInjected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: comboboxBboxShim,
        args: [shimSelector, shimRef, args.force === true],
      });
      const focusResult = focusInjected?.[0]?.result as FocusShimResult | undefined;
      if (!focusResult) {
        return createErrorResponse(
          'combobox-select bbox shim returned no result',
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

      const { point } = focusResult;

      // Steps 2-7: single CDP session for trusted click → type → arrows → enter.
      let typedCount = 0;
      let arrowDownCount = 0;
      let selectedIndex = -1;
      let selectedText = '';
      let optionCount = 0;
      let probeError: string | null = null;

      await cdpSessionManager.withSession(tabId, OWNER, async () => {
        // Step 2: trusted CDP mouse click on the input center to focus.
        // mouseMoved first — Bug-002 family: stable Chrome 145 sometimes
        // drops a bare press/release pair when no preceding move event
        // established the cursor position.
        await cdpSessionManager.sendCommand(tabId!, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'none',
          buttons: 0,
        });
        await cdpSessionManager.sendCommand(tabId!, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await cdpSessionManager.sendCommand(tabId!, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });

        // Step 3: clear existing input value. Ctrl+A + Delete is the
        // "human-y" path; we follow up with a native-setter fallback in
        // case Ctrl+A didn't actually select the existing text (Bug-008
        // family: stable Chrome can drop synthetic keydown events when
        // they don't reach a focused-and-believed-focused element).
        if (clearFirst) {
          await sendSelectAll(tabId!);
          await sendKey(tabId!, NAMED_KEYS.Delete.key, NAMED_KEYS.Delete.code, NAMED_KEYS.Delete.vk);
          // Verify-and-fallback: read the input value; if still non-empty,
          // force-clear via the native value setter + dispatch a synthetic
          // `input` event so listeners observe the clear.
          await chrome.scripting.executeScript({
            target,
            world: 'ISOLATED',
            func: forceClearShim,
            args: [shimSelector, shimRef],
          });
        }

        // Step 4: type the query char-by-char with realistic cadence.
        for (const ch of Array.from(args.query)) {
          await sendChar(tabId!, ch);
          typedCount += 1;
          const delay = perKey + (jitter > 0 ? Math.floor((Math.random() - 0.5) * 2 * jitter) : 0);
          if (delay > 0) await sleep(delay);
        }

        // Step 5: poll for [role="option"] (or override) to appear & pick target.
        const probe = await pollForOptions({
          tabId: tabId!,
          frameId: args.frameId,
          optionSelector,
          matchText,
          matchMode,
          timeoutMs: waitForOptionsMs,
        });
        if (!probe.ok) {
          probeError = probe.message;
          return;
        }
        optionCount = probe.count;
        selectedIndex = probe.targetIndex;
        selectedText = probe.targetText;

        // Step 6: ArrowDown to highlight the target option, then Enter.
        const downPresses = clamp(selectedIndex + 1, 1, MAX_ARROW_DOWN);
        for (let i = 0; i < downPresses; i += 1) {
          await sendNamedKey(tabId!, 'ArrowDown');
          arrowDownCount += 1;
          if (perKey > 0) await sleep(Math.min(perKey, 80));
        }
        await sendNamedKey(tabId!, 'Enter');
      });

      if (probeError !== null) {
        // Distinguish "options never rendered" (TIMEOUT) from "options rendered
        // but no match" (UNKNOWN) — the probe.message prefixes the variant.
        const code = (probeError as string).startsWith('TIMEOUT:')
          ? ToolErrorCode.TIMEOUT
          : ToolErrorCode.UNKNOWN;
        return createErrorResponse((probeError as string).replace(/^[A-Z_]+:\s*/, ''), code, {
          tabId,
          frameId: args.frameId,
          query: args.query,
          matchText,
          typed: typedCount,
        });
      }

      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        query: args.query,
        matchText,
        typed: typedCount,
        cleared: clearFirst,
        optionCount,
        selectedIndex,
        selectedText,
        arrowDownCount,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/another debugger|already attached/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId });
      }
      return classifyTabError(error, {
        toolName: TOOL_NAMES.BROWSER.COMBOBOX_SELECT,
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

interface PollArgs {
  tabId: number;
  frameId?: number;
  optionSelector: string;
  matchText: string;
  matchMode: 'exact' | 'contains' | 'startsWith';
  timeoutMs: number;
}
interface PollHit {
  ok: true;
  count: number;
  targetIndex: number;
  targetText: string;
}
interface PollMiss {
  ok: false;
  message: string;
}

/**
 * Poll the page for `optionSelector` elements until one matches `matchText`
 * or `timeoutMs` elapses. Polls every 150ms. Returns the matched option's
 * index (so the caller knows how many ArrowDown presses to issue) and the
 * matched text (for the return envelope so callers can verify).
 */
async function pollForOptions(args: PollArgs): Promise<PollHit | PollMiss> {
  const deadline = Date.now() + args.timeoutMs;
  const target: { tabId: number; frameIds?: number[] } = { tabId: args.tabId };
  if (typeof args.frameId === 'number') target.frameIds = [args.frameId];

  let lastCount = 0;
  while (Date.now() < deadline) {
    const injected = await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      func: readComboboxOptions,
      args: [args.optionSelector],
    });
    const probe = injected?.[0]?.result as ProbeResult | undefined;
    if (probe && probe.ok) {
      lastCount = probe.count;
      if (probe.count > 0) {
        const targetIndex = findMatchIndex(probe.options, args.matchText, args.matchMode);
        if (targetIndex >= 0) {
          return {
            ok: true,
            count: probe.count,
            targetIndex,
            targetText: probe.options[targetIndex].text,
          };
        }
      }
    }
    await sleep(150);
  }
  if (lastCount === 0) {
    return {
      ok: false,
      message: `TIMEOUT: no options matching "${args.optionSelector}" rendered within ${args.timeoutMs}ms`,
    };
  }
  return {
    ok: false,
    message: `NO_MATCH: ${lastCount} options rendered but none matched "${args.matchText}" (mode=${args.matchMode})`,
  };
}

function findMatchIndex(
  options: ProbeOption[],
  needle: string,
  mode: 'exact' | 'contains' | 'startsWith',
): number {
  const needleLower = needle.toLowerCase();
  for (let i = 0; i < options.length; i += 1) {
    const hayLower = options[i].text.toLowerCase();
    if (mode === 'exact' && hayLower === needleLower) return i;
    if (mode === 'startsWith' && hayLower.startsWith(needleLower)) return i;
    if (mode === 'contains' && hayLower.includes(needleLower)) return i;
  }
  return -1;
}

/**
 * ISOLATED-world shim: resolve target, visibility-check, return the
 * viewport center as a CDP click point. Does NOT call .focus() — that's
 * the CDP mouse click's job (trusted focus event).
 */
function comboboxBboxShim(
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

    const target = el as HTMLElement;
    if (!force) {
      const failure = checkVisibleSync(target);
      if (failure) {
        return {
          ok: false,
          message: `combobox is not actionable: ${failure}`,
          notActionable: true,
          failures: [failure],
        };
      }
      const input = target as HTMLInputElement;
      if (input.disabled === true) {
        return {
          ok: false,
          message: 'combobox is disabled',
          notActionable: true,
          failures: ['disabled'],
        };
      }
      if (input.readOnly === true) {
        return {
          ok: false,
          message: 'combobox is readonly',
          notActionable: true,
          failures: ['not_editable'],
        };
      }
    }

    target.scrollIntoView({ block: 'center', inline: 'center' });
    // Belt-and-braces .focus() — CDP click is supposed to focus form
    // controls but stable Chrome 145 has been shown to not always deliver
    // mousedown to the focused input (Bug-008 family). Without focus,
    // subsequent Ctrl+A + Delete + typing keystrokes go nowhere, and a
    // stale value from a previous interaction (the "LGraphQL" residue
    // seen in the Skills smoke test) silently sticks around.
    if (typeof (target as HTMLElement).focus === 'function') {
      (target as HTMLElement).focus({ preventScroll: true });
    }
    const rect = target.getBoundingClientRect();
    return {
      ok: true,
      tagName: target.tagName.toLowerCase(),
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
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

/**
 * ISOLATED-world shim: read the current set of option elements matching
 * `optionSelector` and return their innerText. Defensive against options
 * being rendered inside a portal/aria-controls target rather than as
 * descendants of the combobox — uses a document-wide querySelectorAll.
 */
function readComboboxOptions(optionSelector: string): ProbeResult {
  try {
    const nodes = document.querySelectorAll(optionSelector);
    const options: ProbeOption[] = [];
    nodes.forEach((node, idx) => {
      const html = node as HTMLElement;
      // Skip hidden options (Downshift renders both visible & sr-only labels;
      // hidden ones aren't reachable by ArrowDown navigation either).
      const style = getComputedStyle(html);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const text = (html.innerText || html.textContent || '').trim();
      if (text.length === 0) return;
      options.push({ index: idx, text });
    });
    // Re-index sequentially so ArrowDown count = options[].index even when
    // hidden siblings were skipped.
    options.forEach((o, i) => {
      o.index = i;
    });
    return { ok: true, count: options.length, options };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * ISOLATED-world shim: belt-and-braces clear. Runs after `Ctrl+A + Delete`
 * (which is the human-y path that fires synthetic key events). If
 * `input.value` is still non-empty, force-set the value to '' via the
 * native property descriptor and dispatch a synthetic `input` event so
 * page-side handlers observe the clear.
 *
 * Why this matters: stable Chrome 145 sometimes drops synthetic keydown
 * events delivered after a CDP click — same Bug-008 family. If Ctrl+A
 * didn't actually select the existing text, Delete then deletes nothing,
 * and the query gets appended to whatever stale value was already there
 * (the "LGraphQL" residue seen on LinkedIn Skills before this fix).
 *
 * The native setter + dispatched event is the standard React-friendly
 * clear pattern — React's internal value tracker watches the native
 * descriptor's setter and treats `setValue('') + input event` as a valid
 * controlled-component update.
 */
function forceClearShim(selector: string | null, ref: string | null): { ok: boolean; before?: string; after?: string; forced?: boolean } {
  try {
    let el: Element | null = null;
    if (ref) {
      const map = (window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> })
        .__claudeElementMap;
      el = map?.[ref]?.deref?.() ?? null;
    } else if (selector) {
      el = document.querySelector(selector);
    }
    if (!el) return { ok: false };
    const input = el as HTMLInputElement;
    const before = typeof input.value === 'string' ? input.value : '';
    if (before === '') {
      return { ok: true, before, after: '', forced: false };
    }
    const proto =
      input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') {
      desc.set.call(input, '');
    } else {
      // Last-resort fallback if some browser misbehaves.
      input.value = '';
    }
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    return { ok: true, before, after: input.value, forced: true };
  } catch (err) {
    return { ok: false };
  }
}

/** Test-only: expose pure helpers for vitest. */
export const _findMatchIndexForTest = findMatchIndex;

export const comboboxSelectTool = new ComboboxSelectTool();
