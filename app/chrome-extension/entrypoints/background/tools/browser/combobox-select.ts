import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { resolveToShimInputs, type SelectorType } from './_selector-resolve';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { cdpClick, sendChar, sendNamedKey, sendSelectAll } from './_keystrokes';

/**
 * chrome_combobox_select — commit a React/Ember combobox option via the
 * keyboard path (ArrowDown to highlight + Enter), the only sequence that
 * binds Downshift/react-aria/Ember combobox state. Synthetic option
 * clicks highlight but don't bind, so callers that don't use this end
 * up with the option visually selected but the form treating no skill
 * as chosen.
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

      let typedCount = 0;
      let arrowDownCount = 0;
      let selectedIndex = -1;
      let selectedText = '';
      let optionCount = 0;
      let probeMiss: { reason: 'timeout' | 'no_match'; message: string } | null = null;

      await cdpSessionManager.withSession(tabId, OWNER, async () => {
        await cdpClick(tabId!, point.x, point.y);

        if (clearFirst) {
          await sendSelectAll(tabId!);
          await sendNamedKey(tabId!, 'Delete');
          // Belt-and-braces clear: Ctrl+A + Delete can no-op if focus
          // didn't fully land. forceClearShim reads input.value and force-
          // sets it via the React-friendly native property descriptor.
          await chrome.scripting.executeScript({
            target,
            world: 'ISOLATED',
            func: forceClearShim,
            args: [shimSelector, shimRef],
          });
        }

        for (const ch of Array.from(args.query)) {
          await sendChar(tabId!, ch);
          typedCount += 1;
          const delay = perKey + (jitter > 0 ? Math.floor((Math.random() - 0.5) * 2 * jitter) : 0);
          if (delay > 0) await sleep(delay);
        }

        const probe = await pollForOptions({
          tabId: tabId!,
          frameId: args.frameId,
          optionSelector,
          matchText,
          matchMode,
          timeoutMs: waitForOptionsMs,
        });
        if (!probe.ok) {
          probeMiss = { reason: probe.reason, message: probe.message };
          return;
        }
        optionCount = probe.count;
        selectedIndex = probe.targetIndex;
        selectedText = probe.targetText;

        // ArrowDown + Enter to commit. Skip the sleep after the LAST
        // ArrowDown — Enter doesn't need the highlight animation to settle.
        const downPresses = clamp(selectedIndex + 1, 1, MAX_ARROW_DOWN);
        for (let i = 0; i < downPresses; i += 1) {
          await sendNamedKey(tabId!, 'ArrowDown');
          arrowDownCount += 1;
          if (perKey > 0 && i < downPresses - 1) await sleep(Math.min(perKey, 80));
        }
        await sendNamedKey(tabId!, 'Enter');
      });

      if (probeMiss !== null) {
        const { reason, message } = probeMiss as { reason: 'timeout' | 'no_match'; message: string };
        const code = reason === 'timeout' ? ToolErrorCode.TIMEOUT : ToolErrorCode.UNKNOWN;
        return createErrorResponse(message, code, {
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
  reason: 'timeout' | 'no_match';
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
      reason: 'timeout',
      message: `no options matching "${args.optionSelector}" rendered within ${args.timeoutMs}ms`,
    };
  }
  return {
    ok: false,
    reason: 'no_match',
    message: `${lastCount} options rendered but none matched "${args.matchText}" (mode=${args.matchMode})`,
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
 * Force-clear an input when Ctrl+A + Delete didn't take. React's internal
 * value tracker watches the native property descriptor's setter, so
 * `descriptor.set.call(input, '')` + a synthetic `input` event is the
 * canonical "clear a controlled input from outside" pattern.
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
