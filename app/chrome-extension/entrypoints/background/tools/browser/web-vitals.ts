import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type WebVitalsAction = 'start' | 'snapshot' | 'stop';

interface WebVitalsParams {
  action: WebVitalsAction;
  tabId?: number;
  windowId?: number;
  reload?: boolean; // start only
}

interface VitalsSnapshot {
  lcpMs: number | null;
  clsScore: number | null;
  inpMs: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  fidMs: number | null;
}

interface ShimSuccess extends VitalsSnapshot {
  ok: true;
  installed: boolean;
}

interface ShimFailure {
  ok: false;
  message: string;
}

type ShimResult = ShimSuccess | ShimFailure;

/**
 * Lightweight Core Web Vitals collector. Installs a per-tab
 * `PerformanceObserver` in MAIN world that stores live values on a
 * `window.__hcWebVitals` global. `snapshot` reads those values without
 * disturbing the observer; `stop` reads + disconnects.
 *
 * Different shape from chrome_performance_* (those record full DevTools
 * traces — heavyweight, post-hoc). This is the "what does the user
 * actually feel?" measurement, available live and cheap.
 */
class WebVitalsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WEB_VITALS;
  static readonly mutates = true;

  async execute(args: WebVitalsParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'start' && action !== 'snapshot' && action !== 'stop') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: start, snapshot, stop.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

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
      // For start with reload:true, reload the tab BEFORE injecting so the
      // observer captures cold-start LCP/FCP/TTFB.
      if (action === 'start' && args.reload === true) {
        await chrome.tabs.reload(tabId);
        // Brief wait for the document to start parsing — the MAIN-world
        // shim itself short-circuits if document.readyState !== 'loading'
        // and falls back to attaching listeners synchronously, but a small
        // grace window cuts the race-flake rate.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const target: { tabId: number } = { tabId };
      const injected = await chrome.scripting.executeScript({
        target,
        world: 'MAIN',
        func: webVitalsShim,
        args: [action],
      });
      const first = injected?.[0]?.result as ShimResult | undefined;
      if (!first) {
        return createErrorResponse('web-vitals shim returned no result', ToolErrorCode.UNKNOWN, {
          tabId,
          action,
        });
      }
      if (!first.ok) {
        return createErrorResponse(first.message, ToolErrorCode.UNKNOWN, {
          tabId,
          action,
        });
      }
      return jsonOk({
        ok: true,
        action,
        tabId,
        installed: first.installed,
        lcpMs: first.lcpMs,
        clsScore: first.clsScore,
        inpMs: first.inpMs,
        fcpMs: first.fcpMs,
        ttfbMs: first.ttfbMs,
        fidMs: first.fidMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, { tabId });
      }
      console.error('Error in WebVitalsTool.execute:', error);
      return createErrorResponse(`chrome_web_vitals failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        tabId,
        action,
      });
    }
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

/**
 * MAIN-world shim. Installs (idempotently) per-tab observers on
 * `window.__hcWebVitals`, returns the current snapshot, or stops them.
 * Self-contained — chrome.scripting.func only serializes the function
 * body, not the surrounding scope.
 */
function webVitalsShim(action: 'start' | 'snapshot' | 'stop'): ShimResult {
  try {
    interface VitalsState {
      lcpMs: number | null;
      clsScore: number;
      inpMs: number | null;
      fcpMs: number | null;
      ttfbMs: number | null;
      fidMs: number | null;
      installed: boolean;
      observers: PerformanceObserver[];
    }
    interface WindowWithVitals {
      __hcWebVitals?: VitalsState;
    }
    const w = window as unknown as WindowWithVitals;
    const installState = (): VitalsState => {
      if (w.__hcWebVitals) return w.__hcWebVitals;
      const state: VitalsState = {
        lcpMs: null,
        clsScore: 0,
        inpMs: null,
        fcpMs: null,
        ttfbMs: null,
        fidMs: null,
        installed: false,
        observers: [],
      };
      w.__hcWebVitals = state;

      const safeObserve = (
        type: string,
        cb: (entries: PerformanceEntryList) => void,
        opts: PerformanceObserverInit = { type, buffered: true } as PerformanceObserverInit,
      ): void => {
        try {
          const obs = new PerformanceObserver((list) => cb(list.getEntries()));
          obs.observe(opts);
          state.observers.push(obs);
        } catch {
          // unsupported entry type on this Chromium build — skip
        }
      };

      // LCP: take the most recent.
      safeObserve('largest-contentful-paint', (entries) => {
        const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number };
        if (last && typeof last.startTime === 'number') state.lcpMs = last.startTime;
      });

      // CLS: sum non-input layout-shift values.
      safeObserve('layout-shift', (entries) => {
        for (const entry of entries) {
          const ls = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          };
          if (!ls.hadRecentInput && typeof ls.value === 'number') {
            state.clsScore += ls.value;
          }
        }
      });

      // INP: max event duration (durationThreshold:40 cuts noise).
      safeObserve(
        'event',
        (entries) => {
          for (const entry of entries) {
            const ev = entry as PerformanceEntry & { duration: number };
            if (state.inpMs === null || ev.duration > state.inpMs) state.inpMs = ev.duration;
          }
        },
        { type: 'event', durationThreshold: 40, buffered: true } as PerformanceObserverInit,
      );

      // FCP: filter paint entries by name.
      safeObserve('paint', (entries) => {
        for (const entry of entries) {
          if (entry.name === 'first-contentful-paint') state.fcpMs = entry.startTime;
        }
      });

      // FID: one-shot first-input.
      safeObserve('first-input', (entries) => {
        const e = entries[0] as PerformanceEntry & {
          processingStart: number;
          startTime: number;
        };
        if (e && state.fidMs === null) state.fidMs = e.processingStart - e.startTime;
      });

      // TTFB from the navigation entry.
      safeObserve('navigation', (entries) => {
        const nav = entries[0] as PerformanceNavigationTiming | undefined;
        if (nav) state.ttfbMs = nav.responseStart - nav.startTime;
      });

      state.installed = true;
      return state;
    };

    if (action === 'start') {
      installState();
      const s = w.__hcWebVitals as VitalsState;
      return {
        ok: true,
        installed: s.installed,
        lcpMs: s.lcpMs,
        clsScore: s.clsScore,
        inpMs: s.inpMs,
        fcpMs: s.fcpMs,
        ttfbMs: s.ttfbMs,
        fidMs: s.fidMs,
      };
    }

    if (action === 'snapshot') {
      const s = w.__hcWebVitals;
      if (!s) {
        return {
          ok: true,
          installed: false,
          lcpMs: null,
          clsScore: null,
          inpMs: null,
          fcpMs: null,
          ttfbMs: null,
          fidMs: null,
        };
      }
      return {
        ok: true,
        installed: s.installed,
        lcpMs: s.lcpMs,
        clsScore: s.clsScore,
        inpMs: s.inpMs,
        fcpMs: s.fcpMs,
        ttfbMs: s.ttfbMs,
        fidMs: s.fidMs,
      };
    }

    // stop
    const s = w.__hcWebVitals;
    if (!s) {
      return {
        ok: true,
        installed: false,
        lcpMs: null,
        clsScore: null,
        inpMs: null,
        fcpMs: null,
        ttfbMs: null,
        fidMs: null,
      };
    }
    for (const obs of s.observers) {
      try {
        obs.disconnect();
      } catch {
        // already disconnected — fine
      }
    }
    const final: ShimSuccess = {
      ok: true,
      installed: s.installed,
      lcpMs: s.lcpMs,
      clsScore: s.clsScore,
      inpMs: s.inpMs,
      fcpMs: s.fcpMs,
      ttfbMs: s.ttfbMs,
      fidMs: s.fidMs,
    };
    delete w.__hcWebVitals;
    return final;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const webVitalsTool = new WebVitalsTool();
