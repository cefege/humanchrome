/**
 * Shared base for the two network-capture backends (IMP-0129).
 *
 * `network-capture-debugger.ts` (CDP-based, response bodies, popup banner) and
 * `network-capture-web-request.ts` (chrome.webRequest, no bodies, no banner)
 * inherit fundamentally different event sources but share a lot of bookkeeping:
 * per-tab capture buffers keyed by tabId, max-time + inactivity timers,
 * request counters, tab-removed / tab-created lifecycle handlers, and the
 * flush-resets-buffer-but-leaves-listeners contract.
 *
 * Conservative dedupe (per IMP-0141 AgentEngineBase rule): only true overlap
 * lives here. Anything where the two files diverge on semantics —
 * `analyzeCommonHeaders` / `filterOutCommonHeaders` case handling, the
 * `buildResultData` envelope shape, listener install/teardown — stays in the
 * concrete subclass.
 */
import { BaseBrowserToolExecutor } from '../base-browser';
import { LIMITS } from '@/common/constants';

/**
 * Minimum field set every per-request record carries. Both backends extend
 * this with backend-specific fields (debugger adds `loaderId`, `frameId`,
 * `responseBody`, etc.; webRequest adds `responseSize`, `errorText`).
 */
export interface BaseNetworkRequestInfo {
  requestId: string;
  url: string;
  method: string;
  type: string;
  requestTime?: number;
  responseTime?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  specificRequestHeaders?: Record<string, string>;
  specificResponseHeaders?: Record<string, string>;
  mimeType?: string;
  errorText?: string;
}

/**
 * Common per-tab capture buffer shape. Subclasses extend with backend
 * fields (the debugger backend doesn't model `tabId` or `endTime` on the
 * buffer; that's fine — TypeScript structural typing). Both backends key
 * the per-tab Map on the tabId.
 */
export interface BaseCaptureInfo<TRequest extends BaseNetworkRequestInfo> {
  startTime: number;
  tabUrl: string;
  tabTitle: string;
  requests: Record<string, TRequest>;
  maxCaptureTime: number;
  inactivityTimeout: number;
  includeStatic: boolean;
  limitReached?: boolean;
  /**
   * Timestamp of the last flush that drained the buffer. Echoed back as
   * `previousFlushAt` on the next flush/stop envelope so callers can
   * stitch successive drains together unambiguously. Null until first
   * flush.
   */
  lastFlushAt?: number | null;
}

/** Default cap for buffered requests per capture session; shared across backends. */
export const MAX_REQUESTS_PER_CAPTURE = LIMITS.MAX_NETWORK_REQUESTS;

/** Default max capture time (3 minutes). */
export const DEFAULT_MAX_CAPTURE_TIME_MS = 3 * 60 * 1000;

/** Default inactivity timeout (1 minute). */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 60 * 1000;

/**
 * Abstract base for both network capture start tools.
 *
 * Subclasses implement:
 *   - `stopCapture(tabId, ...)` — the user-facing teardown; signature
 *     varies between backends (debugger takes an `isAutoStop` flag).
 *   - `startCaptureForTab(tabId, options)` — backend-specific listener /
 *     CDP attach. Called by `handleTabCreated` for opener-tab inheritance.
 *   - `cleanupCapture(tabId)` — backend-specific cleanup; must call
 *     `clearSharedTimersAndState(tabId)` to wipe the shared maps.
 *   - `logLabel()` — short label used in shared log messages (e.g.
 *     `NetworkDebuggerStartTool`, `NetworkCaptureV2`).
 */
export abstract class NetworkCaptureBase<
  TRequest extends BaseNetworkRequestInfo,
  TCaptureInfo extends BaseCaptureInfo<TRequest>,
> extends BaseBrowserToolExecutor {
  /**
   * Per-tab capture buffer. `public` because cross-tool readers
   * (`har-export.ts`, `network-capture.ts` facade) reach into it via the
   * singleton — keeping it accessible avoids the cast-per-call pattern.
   */
  public captureData: Map<number, TCaptureInfo> = new Map();

  protected captureTimers: Map<number, NodeJS.Timeout> = new Map();
  protected inactivityTimers: Map<number, NodeJS.Timeout> = new Map();
  protected lastActivityTime: Map<number, number> = new Map();
  protected requestCounters: Map<number, number> = new Map();

  /**
   * Install lifecycle listeners (tab-removed cleans up; tab-created
   * inherits capture from opener tab). Idempotent — wire up once in the
   * subclass constructor after the singleton dedup check.
   */
  protected installSharedTabListeners(): void {
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
    chrome.tabs.onCreated.addListener(this.handleTabCreated.bind(this));
  }

  protected handleTabRemoved(tabId: number): void {
    if (this.captureData.has(tabId)) {
      console.log(`${this.logLabel()}: Tab ${tabId} was closed, cleaning up resources.`);
      this.cleanupCapture(tabId);
    }
  }

  /**
   * If a new tab is opened from a tab currently capturing, extend the
   * capture to the new tab with the opener's settings. Mirrors what
   * Chrome DevTools "Preserve log" + popup-tracking does so cross-tab
   * navigations don't drop requests on the floor.
   */
  protected async handleTabCreated(tab: chrome.tabs.Tab): Promise<void> {
    try {
      if (this.captureData.size === 0) return;

      const openerTabId = tab.openerTabId;
      if (!openerTabId) return;

      if (!this.captureData.has(openerTabId)) return;

      const newTabId = tab.id;
      if (!newTabId) return;

      console.log(
        `${this.logLabel()}: New tab ${newTabId} created from capturing tab ${openerTabId}, will extend capture to it.`,
      );

      const openerCaptureInfo = this.captureData.get(openerTabId);
      if (!openerCaptureInfo) return;

      await new Promise((resolve) => setTimeout(resolve, 500));

      await this.startCaptureForTab(newTabId, {
        maxCaptureTime: openerCaptureInfo.maxCaptureTime,
        inactivityTimeout: openerCaptureInfo.inactivityTimeout,
        includeStatic: openerCaptureInfo.includeStatic,
      });

      console.log(`${this.logLabel()}: Successfully extended capture to new tab ${newTabId}`);
    } catch (error) {
      console.error(`${this.logLabel()}: Error extending capture to new tab:`, error);
    }
  }

  /**
   * Bump the last-activity timestamp and (re)arm the inactivity watchdog.
   * Called from each backend's per-event handler so any captured network
   * activity resets the no-traffic auto-stop.
   */
  protected updateLastActivityTime(tabId: number): void {
    this.lastActivityTime.set(tabId, Date.now());
    const captureInfo = this.captureData.get(tabId);

    if (captureInfo && captureInfo.inactivityTimeout > 0) {
      if (this.inactivityTimers.has(tabId)) {
        clearTimeout(this.inactivityTimers.get(tabId)!);
      }
      this.inactivityTimers.set(
        tabId,
        setTimeout(() => this.checkInactivity(tabId), captureInfo.inactivityTimeout),
      );
    }
  }

  protected checkInactivity(tabId: number): void {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    const lastActivity = this.lastActivityTime.get(tabId) || captureInfo.startTime;
    const now = Date.now();
    const inactiveTime = now - lastActivity;

    if (inactiveTime >= captureInfo.inactivityTimeout) {
      console.log(
        `${this.logLabel()}: No activity for ${inactiveTime}ms (threshold: ${captureInfo.inactivityTimeout}ms), stopping capture for tab ${tabId}`,
      );
      this.stopCaptureByInactivity(tabId);
    } else {
      // Reschedule for the remaining time; survives system sleep / SW
      // throttling that delayed the original fire.
      const remainingTime = Math.max(0, captureInfo.inactivityTimeout - inactiveTime);
      this.inactivityTimers.set(
        tabId,
        setTimeout(() => this.checkInactivity(tabId), remainingTime),
      );
    }
  }

  /**
   * Reset the buffered state after a flush (shared across backends —
   * both clear requests + counter + limitReached, stamp lastFlushAt,
   * and bump the activity timestamp so the inactivity watchdog doesn't
   * fire as a side-effect of the buffer-drain pause).
   */
  protected resetBufferAfterFlush(captureInfo: TCaptureInfo, tabId: number, flushedAt: number): void {
    captureInfo.requests = {} as TCaptureInfo['requests'];
    captureInfo.limitReached = false;
    captureInfo.lastFlushAt = flushedAt;
    this.requestCounters.set(tabId, 0);
    this.updateLastActivityTime(tabId);
  }

  /**
   * Clear the shared per-tab maps. Subclasses call this from their own
   * `cleanupCapture` and then add backend-specific teardown (debugger
   * also wipes pending getResponseBody promises; webRequest may
   * removeListeners() once captureData is empty).
   */
  protected clearSharedTimersAndState(tabId: number): void {
    if (this.captureTimers.has(tabId)) {
      clearTimeout(this.captureTimers.get(tabId)!);
      this.captureTimers.delete(tabId);
    }
    if (this.inactivityTimers.has(tabId)) {
      clearTimeout(this.inactivityTimers.get(tabId)!);
      this.inactivityTimers.delete(tabId);
    }

    this.lastActivityTime.delete(tabId);
    this.captureData.delete(tabId);
    this.requestCounters.delete(tabId);
  }

  /** Backend-specific. Subclass installs listeners / attaches CDP. */
  protected abstract startCaptureForTab(
    tabId: number,
    options: {
      maxCaptureTime: number;
      inactivityTimeout: number;
      includeStatic: boolean;
    },
  ): Promise<void>;

  /** Backend-specific. Removes from `captureData` plus any backend cleanup. */
  protected abstract cleanupCapture(tabId: number): void;

  /**
   * Backend-specific stop. Returns the final envelope. Signature varies
   * by backend (debugger takes an `isAutoStop` flag) so the inactivity
   * fallback below uses an `any`-shaped call that both subclasses honor.
   */
  protected abstract stopCapture(tabId: number, ...args: unknown[]): Promise<unknown>;

  /** Short label used in shared log messages. */
  protected abstract logLabel(): string;

  /**
   * Inactivity-driven stop. Calls back into the subclass's `stopCapture`
   * with `isAutoStop=true` (debugger backend reads it; webRequest ignores
   * the extra arg).
   */
  protected async stopCaptureByInactivity(tabId: number): Promise<void> {
    const captureInfo = this.captureData.get(tabId);
    if (!captureInfo) return;

    console.log(`${this.logLabel()}: Stopping capture due to inactivity for tab ${tabId}.`);
    await this.stopCapture(tabId, true);
  }
}
