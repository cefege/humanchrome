import { classifyTabError, createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { resolveToShimInputs, type SelectorType } from './_selector-resolve';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { sendChar, sendKey, sendSelectAll, NAMED_KEYS } from './_keystrokes';

/**
 * chrome_typeahead_probe — Bug-008 follow-up.
 *
 * One-shot diagnostic that focuses a typeahead input, types a sample char
 * via CDP keystrokes, then watches for `watchMs` and reports back: every
 * keyboard/input event that fired (with `isTrusted`), every fetch the
 * page made, plus the final aria-expanded / aria-controls / listbox /
 * options state. Returns a single envelope.
 *
 * Replaces the 100-line ad-hoc probe Bug-008 needed to identify Chrome's
 * keyDown-suppression-on-insertText behaviour. Future Ember-trust /
 * typeahead-lookup-not-firing investigations should run this tool first.
 */

const DEFAULT_WATCH_MS = 3500;
const DEFAULT_SAMPLE = 'a';
const MAX_SAMPLE = 16;
const OWNER = 'typeahead-probe' as const;

interface TypeaheadProbeParams {
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  sample?: string;
  watchMs?: number;
  clearFirst?: boolean;
  networkUrlPattern?: string;
  optionSelector?: string;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

interface FocusShimSuccess {
  ok: true;
  bbox: { x: number; y: number; width: number; height: number };
  point: { x: number; y: number };
  tagName: string;
  inputValue: string;
  ariaExpanded: string | null;
  ariaControls: string | null;
}
interface FocusShimFailure {
  ok: false;
  message: string;
  notActionable?: boolean;
  failures?: string[];
}
type FocusShimResult = FocusShimSuccess | FocusShimFailure;

interface ReadbackResult {
  ok: true;
  inputValueAfter: string | null;
  ariaExpanded: string | null;
  ariaControls: string | null;
  listboxFound: boolean;
  listboxOptionCount: number;
  listboxSampleOpts: string[];
  events: Array<{
    type: string;
    isTrusted: boolean;
    scope: 'input' | 'window' | 'document';
    key?: string;
    code?: string;
    data?: string | null;
    inputType?: string;
    composed?: boolean;
    isComposing?: boolean;
    ts: number;
  }>;
  fetches: Array<{ url: string; method: string; ts: number }>;
}

class TypeaheadProbeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TYPEAHEAD_PROBE;
  static readonly mutates = true;

  async execute(args: TypeaheadProbeParams = {}): Promise<ToolResult> {
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
      return createErrorResponse(
        'Exactly one of [selector] or [ref] is required.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'selector|ref' },
      );
    }
    const sample = typeof args.sample === 'string' && args.sample.length > 0 ? args.sample : DEFAULT_SAMPLE;
    if (sample.length > MAX_SAMPLE) {
      return createErrorResponse(
        `sample too long (${sample.length} > ${MAX_SAMPLE})`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'sample', limit: MAX_SAMPLE },
      );
    }
    const watchMs = clamp(
      typeof args.watchMs === 'number' ? args.watchMs : DEFAULT_WATCH_MS,
      100,
      60000,
    );
    const clearFirst = args.clearFirst !== false; // default true
    const optionSelector =
      typeof args.optionSelector === 'string' && args.optionSelector.length > 0
        ? args.optionSelector
        : '[role="option"]';
    const networkUrlPattern =
      typeof args.networkUrlPattern === 'string' ? args.networkUrlPattern : '';

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

    const target: { tabId: number; frameIds?: number[] } = { tabId };
    if (typeof args.frameId === 'number') target.frameIds = [args.frameId];

    try {
      // Step 1: focus shim — resolve, bbox, point, install fetch + event probes.
      const focusInjected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: installProbeShim,
        args: [shimSelector, shimRef],
      });
      const focusResult = focusInjected?.[0]?.result as FocusShimResult | undefined;
      if (!focusResult) {
        return createErrorResponse(
          'typeahead-probe shim returned no result',
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

      const initialAriaExpanded = focusResult.ariaExpanded;
      const initialAriaControls = focusResult.ariaControls;
      const inputValueBefore = focusResult.inputValue;

      // Step 2: CDP-trusted click on the input center + optional clear +
      // type the sample char-by-char. mouseMoved precedes the press so
      // Chrome's renderer registers the cursor position before the click —
      // bare press/release pairs don't reliably focus form controls in
      // daily Chrome (the same gotcha Bug-002's mouseMoved follow-up fixed
      // in interaction.ts).
      await cdpSessionManager.withSession(tabId, OWNER, async () => {
        await cdpSessionManager.sendCommand(tabId!, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: focusResult.point.x,
          y: focusResult.point.y,
          button: 'none',
          buttons: 0,
        });
        await cdpSessionManager.sendCommand(tabId!, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: focusResult.point.x,
          y: focusResult.point.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await cdpSessionManager.sendCommand(tabId!, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: focusResult.point.x,
          y: focusResult.point.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        if (clearFirst) {
          await sendSelectAll(tabId!);
          await sendKey(
            tabId!,
            NAMED_KEYS.Delete.key,
            NAMED_KEYS.Delete.code,
            NAMED_KEYS.Delete.vk,
          );
        }
        for (const ch of Array.from(sample)) {
          await sendChar(tabId!, ch);
        }
      });

      // Step 3: wait for the page to react (debounce / lookup / render).
      await new Promise((r) => setTimeout(r, watchMs));

      // Step 4: read back what fired.
      const readbackInjected = await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: readProbeResults,
        args: [shimSelector, shimRef, optionSelector, networkUrlPattern],
      });
      const readback = readbackInjected?.[0]?.result as ReadbackResult | undefined;
      if (!readback) {
        return createErrorResponse(
          'typeahead-probe readback returned no result',
          ToolErrorCode.UNKNOWN,
          { tabId, frameId: args.frameId },
        );
      }

      const keydownFired = readback.events.some((e) => e.type === 'keydown' && e.isTrusted);
      const inputFired = readback.events.some((e) => e.type === 'input');
      const lookupFetchFired = networkUrlPattern
        ? readback.fetches.length > 0
        : readback.fetches.some((f) =>
            /typeahead|voyager|autocomplete|suggest|search/i.test(f.url),
          );

      return jsonOk({
        ok: true,
        tabId,
        frameId: args.frameId ?? null,
        sample,
        watchMs,
        cleared: clearFirst,
        inputValueBefore,
        inputValueAfter: readback.inputValueAfter,
        initialAriaExpanded,
        initialAriaControls,
        ariaExpanded: readback.ariaExpanded,
        ariaControls: readback.ariaControls,
        listboxFound: readback.listboxFound,
        listboxOptionCount: readback.listboxOptionCount,
        listboxSampleOpts: readback.listboxSampleOpts,
        eventCount: readback.events.length,
        events: readback.events,
        fetchCount: readback.fetches.length,
        fetches: readback.fetches,
        summary: {
          keydownFired,
          inputFired,
          lookupFetchFired,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/another debugger|already attached/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId });
      }
      return classifyTabError(error, {
        toolName: TOOL_NAMES.BROWSER.TYPEAHEAD_PROBE,
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

/**
 * ISOLATED-world shim #1: resolve target, install capture probes
 * (fetch + window/document/input-level event listeners), return bbox.
 *
 * Stored on `window.__hcTypeaheadProbe` so the readback shim can find them.
 */
function installProbeShim(selector: string | null, ref: string | null): FocusShimResult {
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
    const input = target as HTMLInputElement;
    const failure = checkVisibleSync(target);
    if (failure) {
      return {
        ok: false,
        message: `typeahead input is not actionable: ${failure}`,
        notActionable: true,
        failures: [failure],
      };
    }
    if (input.disabled === true) {
      return { ok: false, message: 'input is disabled', notActionable: true, failures: ['disabled'] };
    }
    if (input.readOnly === true) {
      return {
        ok: false,
        message: 'input is readonly',
        notActionable: true,
        failures: ['not_editable'],
      };
    }

    type ProbeState = {
      el: WeakRef<Element>;
      events: Array<Record<string, unknown>>;
      fetches: Array<{ url: string; method: string; ts: number }>;
      installedAt: number;
      origFetch: typeof window.fetch;
    };
    const w = window as unknown as { __hcTypeaheadProbe?: ProbeState };

    if (w.__hcTypeaheadProbe) {
      // Restore old fetch first so we don't pile up wrappers across runs.
      try {
        window.fetch = w.__hcTypeaheadProbe.origFetch;
      } catch (e) {}
    }

    const events: Array<Record<string, unknown>> = [];
    const fetches: Array<{ url: string; method: string; ts: number }> = [];
    const origFetch = window.fetch.bind(window);
    window.fetch = function (...a: unknown[]) {
      try {
        const u =
          typeof a[0] === 'string'
            ? (a[0] as string)
            : (a[0] as { url?: string })?.url || String(a[0]);
        const init = (a[1] as { method?: string }) || {};
        fetches.push({ url: u.slice(0, 400), method: init.method || 'GET', ts: Date.now() });
      } catch (e) {}
      return origFetch(...(a as Parameters<typeof origFetch>));
    } as typeof window.fetch;

    const TRACKED_TYPES = ['keydown', 'keyup', 'keypress', 'input', 'beforeinput'];
    function record(scope: string, e: Event) {
      const ke = e as KeyboardEvent;
      const ie = e as InputEvent;
      events.push({
        scope,
        type: e.type,
        isTrusted: e.isTrusted,
        key: ke.key ?? null,
        code: ke.code ?? null,
        data: ie.data ?? null,
        inputType: ie.inputType ?? null,
        composed: e.composed ?? null,
        isComposing: ke.isComposing ?? null,
        ts: Date.now(),
      });
    }
    for (const t of TRACKED_TYPES) {
      target.addEventListener(t, (e) => record('input', e), true);
      window.addEventListener(t, (e) => record('window', e), true);
      document.addEventListener(t, (e) => record('document', e), true);
    }

    (window as unknown as { __hcTypeaheadProbe: ProbeState }).__hcTypeaheadProbe = {
      el: new WeakRef(target),
      events,
      fetches,
      installedAt: Date.now(),
      origFetch,
    };

    target.scrollIntoView({ block: 'center', inline: 'center' });
    // Compute rect AFTER scrollIntoView — the rect before scroll is stale
    // when the element has to move into view (or its scrollable parent does).
    const rect = target.getBoundingClientRect();
    // Belt-and-braces focus: the CDP click in BG should focus form controls,
    // but Bug-008's CFT-vs-daily-Chrome divergence has shown that
    // CDP-driven focus isn't always reliable on daily Chrome's keyboard
    // pipeline. .focus() in the shim guarantees keystrokes that follow
    // land on this element regardless of whether the CDP click delivered
    // a mousedown.
    if (typeof (target as HTMLElement).focus === 'function') {
      (target as HTMLElement).focus({ preventScroll: true });
    }
    return {
      ok: true,
      tagName: target.tagName.toLowerCase(),
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      inputValue: input.value ?? '',
      ariaExpanded: target.getAttribute('aria-expanded'),
      ariaControls: target.getAttribute('aria-controls'),
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
 * ISOLATED-world shim #2: harvest the captured logs + final DOM state +
 * uninstall the fetch wrapper. Called once after the watch window elapses.
 */
function readProbeResults(
  selector: string | null,
  ref: string | null,
  optionSelector: string,
  networkUrlPattern: string,
): ReadbackResult {
  type ProbeState = {
    el: WeakRef<Element>;
    events: Array<Record<string, unknown>>;
    fetches: Array<{ url: string; method: string; ts: number }>;
    installedAt: number;
    origFetch: typeof window.fetch;
  };
  const w = window as unknown as { __hcTypeaheadProbe?: ProbeState };
  const state = w.__hcTypeaheadProbe;
  let el: Element | null = null;
  if (state) {
    el = state.el.deref?.() ?? null;
  }
  if (!el) {
    if (ref) {
      const map = (window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> })
        .__claudeElementMap;
      el = map?.[ref]?.deref?.() ?? null;
    } else if (selector) {
      el = document.querySelector(selector);
    }
  }
  const input = el as HTMLInputElement | null;
  const ariaControls = (el as HTMLElement | null)?.getAttribute('aria-controls') ?? null;
  const listbox = ariaControls ? document.getElementById(ariaControls) : null;
  const listboxOptions = listbox
    ? Array.from(listbox.querySelectorAll(optionSelector))
    : [];
  const sampleOpts = listboxOptions
    .slice(0, 10)
    .map((o) => (o.textContent || '').trim().slice(0, 80))
    .filter((t) => t.length > 0);

  // Cap returned arrays so output stays sub-budget on chatty pages.
  const events = (state?.events ?? []).slice(0, 200) as ReadbackResult['events'];
  const fetchesAll = state?.fetches ?? [];
  const fetchesFiltered = networkUrlPattern
    ? fetchesAll.filter((f) => {
        try {
          return new RegExp(networkUrlPattern, 'i').test(f.url);
        } catch {
          return false;
        }
      })
    : fetchesAll;
  const fetches = fetchesFiltered.slice(0, 50);

  // Restore original fetch so re-runs don't stack wrappers indefinitely.
  if (state) {
    try {
      window.fetch = state.origFetch;
    } catch (e) {}
    delete (window as unknown as { __hcTypeaheadProbe?: ProbeState }).__hcTypeaheadProbe;
  }

  return {
    ok: true,
    inputValueAfter: typeof input?.value === 'string' ? input.value : null,
    ariaExpanded: (el as HTMLElement | null)?.getAttribute('aria-expanded') ?? null,
    ariaControls,
    listboxFound: !!listbox,
    listboxOptionCount: listboxOptions.length,
    listboxSampleOpts: sampleOpts,
    events,
    fetches,
  };
}

export const typeaheadProbeTool = new TypeaheadProbeTool();
