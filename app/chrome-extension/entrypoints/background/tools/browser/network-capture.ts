/**
 * `chrome_network_capture` — single facade over two backends with very
 * different capability/cost tradeoffs:
 *
 *   - webRequest backend (network-capture-web-request.ts): cheap, no CDP
 *     attach, no debugger banner; cannot read response bodies and never
 *     activates the tab. Default for headers-only/listing use cases.
 *   - debugger backend (network-capture-debugger.ts): full CDP attach,
 *     surfaces response bodies (capped at MAX_RESPONSE_BODY_SIZE_BYTES),
 *     but pops the "Chrome is being controlled" banner and conflicts with
 *     other CDP holders on the same tab. Required when needResponseBody.
 *
 * Backend selection lives entirely here so callers see one tool and one
 * action vocabulary (start/stop/flush/status); the two backend modules
 * never reach across to each other.
 *
 * `background: true` (default for the debugger backend) suppresses tab
 * activation/window focus on attach so capture doesn't reorder the user's
 * tabs. Only set false when the page genuinely needs to render (e.g.,
 * waiting for a network event that requires layout).
 */
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';
import { networkCaptureStartTool, networkCaptureStopTool } from './network-capture-web-request';
import { networkDebuggerStartTool, networkDebuggerStopTool } from './network-capture-debugger';

type NetworkCaptureBackend = 'webRequest' | 'debugger';

/**
 * Minimal shape of the per-tab buffer entry shared by both backends — the
 * status action only reads `startTime` and `requests`, so the full
 * backend-specific shapes are intentionally not modeled here.
 */
type CaptureBufferEntry = { startTime?: number; requests?: Record<string, unknown> };

interface NetworkCaptureToolParams {
  action: 'start' | 'stop' | 'flush' | 'status';
  needResponseBody?: boolean;
  url?: string;
  maxCaptureTime?: number;
  inactivityTimeout?: number;
  includeStatic?: boolean;
  /** Forwarded to the debugger backend; ignored by the webRequest backend (which never activates). */
  background?: boolean;
}

/**
 * Extract text content from ToolResult
 */
function getFirstText(result: ToolResult): string | undefined {
  const first = result.content?.[0];
  return first && first.type === 'text' ? first.text : undefined;
}

/**
 * Decorate JSON result with additional fields
 */
function decorateJsonResult(result: ToolResult, extra: Record<string, unknown>): ToolResult {
  const text = getFirstText(result);
  if (typeof text !== 'string') return result;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify({ ...parsed, ...extra }) }],
      };
    }
  } catch {
    // If the underlying tool didn't return JSON, keep it as-is
  }
  return result;
}

/**
 * Debugger-backend `captureData` is `private` on the class — every
 * cross-tool reader needs the same cast, so funnel them through one
 * accessor instead of repeating the shape inline.
 */
function getDebuggerCaptureData(): Map<number, CaptureBufferEntry> | undefined {
  const data = (
    networkDebuggerStartTool as unknown as { captureData?: Map<number, CaptureBufferEntry> }
  ).captureData;
  return data instanceof Map ? data : undefined;
}

function isDebuggerCaptureActive(): boolean {
  const data = getDebuggerCaptureData();
  return !!data && data.size > 0;
}

function isWebRequestCaptureActive(): boolean {
  return networkCaptureStartTool.captureData.size > 0;
}

/**
 * Reduce a per-tab capture buffer to the fields the status action exposes
 * (request count, oldest start time, tabIds in scope). Same semantics for
 * both backends, so they share this loop.
 */
function summarizeCapture(data: Map<number, CaptureBufferEntry>): {
  bufferedCount: number;
  earliestStart: number | null;
  tabIds: number[];
} {
  let bufferedCount = 0;
  let earliest = Number.POSITIVE_INFINITY;
  const tabIds: number[] = [];
  for (const [tabId, info] of data) {
    bufferedCount += Object.keys(info.requests || {}).length;
    if (typeof info.startTime === 'number' && info.startTime < earliest) {
      earliest = info.startTime;
    }
    tabIds.push(tabId);
  }
  return {
    bufferedCount,
    earliestStart: Number.isFinite(earliest) ? earliest : null,
    tabIds,
  };
}

/**
 * Unified Network Capture Tool
 *
 * Provides a single entry point for network capture, automatically selecting
 * the appropriate backend based on the `needResponseBody` parameter:
 * - needResponseBody=false (default): uses webRequest API (lightweight, no debugger conflict)
 * - needResponseBody=true: uses Debugger API (captures response body, may conflict with DevTools)
 */
class NetworkCaptureTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_CAPTURE;

  async execute(args: NetworkCaptureToolParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'start' && action !== 'stop' && action !== 'flush' && action !== 'status') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: start, stop, flush, status',
      );
    }

    const wantBody = args?.needResponseBody === true;
    const debuggerActive = isDebuggerCaptureActive();
    const webActive = isWebRequestCaptureActive();

    if (action === 'start') {
      return this.handleStart(args, wantBody, debuggerActive, webActive);
    }

    if (action === 'flush') {
      return this.handleFlush(args, debuggerActive, webActive);
    }

    if (action === 'status') {
      return this.handleStatus(debuggerActive, webActive);
    }

    return this.handleStop(args, debuggerActive, webActive);
  }

  /**
   * Side-effect-free inspection of the capture buffer. Lets agents check
   * for an in-flight capture (and how much it's accumulated) before
   * choosing to flush — which empties the buffer — or stop, which also
   * tears the listener down.
   *
   * Backend selection mirrors handleFlush/handleStop: if both somehow run
   * at once, debugger wins because it's the more invasive session.
   */
  private async handleStatus(debuggerActive: boolean, webActive: boolean): Promise<ToolResult> {
    const backend: NetworkCaptureBackend | null = debuggerActive
      ? 'debugger'
      : webActive
        ? 'webRequest'
        : null;

    let summary = {
      bufferedCount: 0,
      earliestStart: null as number | null,
      tabIds: [] as number[],
    };
    if (backend === 'debugger') {
      const data = getDebuggerCaptureData();
      if (data) summary = summarizeCapture(data);
    } else if (backend === 'webRequest') {
      summary = summarizeCapture(networkCaptureStartTool.captureData);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            active: backend !== null,
            backend,
            sinceMs: summary.earliestStart === null ? null : Date.now() - summary.earliestStart,
            bufferedCount: summary.bufferedCount,
            tabIds: summary.tabIds,
          }),
        },
      ],
      isError: false,
    };
  }

  private async handleStart(
    args: NetworkCaptureToolParams,
    wantBody: boolean,
    debuggerActive: boolean,
    webActive: boolean,
  ): Promise<ToolResult> {
    // Prevent any capture conflict (cross-mode or same-mode)
    if (debuggerActive || webActive) {
      const activeMode = debuggerActive ? 'debugger' : 'webRequest';
      return createErrorResponse(
        `Network capture is already active in ${activeMode} mode. Stop it before starting a new capture.`,
      );
    }

    const delegate = wantBody ? networkDebuggerStartTool : networkCaptureStartTool;
    const backend: NetworkCaptureBackend = wantBody ? 'debugger' : 'webRequest';

    const result = await delegate.execute({
      url: args.url,
      maxCaptureTime: args.maxCaptureTime,
      inactivityTimeout: args.inactivityTimeout,
      includeStatic: args.includeStatic,
      ...(typeof args.background === 'boolean' ? { background: args.background } : {}),
    });

    return decorateJsonResult(result, { backend, needResponseBody: wantBody });
  }

  private async handleFlush(
    args: NetworkCaptureToolParams,
    debuggerActive: boolean,
    webActive: boolean,
  ): Promise<ToolResult> {
    // Pick the same backend we'd pick on stop, but call flushCapture
    // instead so the underlying capture state stays attached.
    let backendToFlush: NetworkCaptureBackend | null = null;

    if (args?.needResponseBody === true) {
      backendToFlush = debuggerActive ? 'debugger' : null;
    } else if (args?.needResponseBody === false) {
      backendToFlush = webActive ? 'webRequest' : null;
    }

    if (!backendToFlush) {
      if (debuggerActive) {
        backendToFlush = 'debugger';
      } else if (webActive) {
        backendToFlush = 'webRequest';
      }
    }

    if (!backendToFlush) {
      return createErrorResponse('No active network captures found in any tab.');
    }

    const startTool =
      backendToFlush === 'debugger' ? networkDebuggerStartTool : networkCaptureStartTool;
    const captureData = (startTool as unknown as { captureData?: Map<number, unknown> })
      .captureData;
    const ongoing =
      captureData instanceof Map ? Array.from(captureData.keys() as IterableIterator<number>) : [];

    if (ongoing.length === 0) {
      return createErrorResponse('No active network captures found in any tab.');
    }

    // Mirror the stop-tool's tab-selection precedence: active tab if it
    // happens to be one of the captured tabs, otherwise the first ongoing.
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTabId = activeTabs[0]?.id;
    const primaryTabId =
      typeof activeTabId === 'number' && ongoing.includes(activeTabId) ? activeTabId : ongoing[0];

    const primaryResult = await (
      startTool as unknown as { flushCapture: (id: number) => Promise<any> }
    ).flushCapture(primaryTabId);

    if (!primaryResult || !primaryResult.success) {
      return createErrorResponse(
        primaryResult?.message || `Failed to flush network capture for tab ${primaryTabId}`,
      );
    }

    // For multi-tab captures, drain the rest with continue-on-error.
    const otherFlushes: Array<{ tabId: number; data?: any; error?: string }> = [];
    if (ongoing.length > 1) {
      for (const tabId of ongoing) {
        if (tabId === primaryTabId) continue;
        try {
          const result = await (
            startTool as unknown as { flushCapture: (id: number) => Promise<any> }
          ).flushCapture(tabId);
          if (result?.success) {
            otherFlushes.push({ tabId, data: result.data });
          } else {
            otherFlushes.push({ tabId, error: result?.message || 'unknown error' });
          }
        } catch (error: any) {
          otherFlushes.push({ tabId, error: error?.message || String(error) });
        }
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            backend: backendToFlush,
            needResponseBody: backendToFlush === 'debugger',
            flushed: true,
            stillActive: true,
            tabId: primaryTabId,
            ...primaryResult.data,
            ...(otherFlushes.length > 0 ? { otherFlushes } : {}),
          }),
        },
      ],
      isError: false,
    };
  }

  private async handleStop(
    args: NetworkCaptureToolParams,
    debuggerActive: boolean,
    webActive: boolean,
  ): Promise<ToolResult> {
    // Determine which backend to stop
    let backendToStop: NetworkCaptureBackend | null = null;

    // If user explicitly specified needResponseBody, try to stop that specific backend
    if (args?.needResponseBody === true) {
      backendToStop = debuggerActive ? 'debugger' : null;
    } else if (args?.needResponseBody === false) {
      backendToStop = webActive ? 'webRequest' : null;
    }

    // If no explicit preference or the specified backend isn't active, auto-detect
    if (!backendToStop) {
      if (debuggerActive) {
        backendToStop = 'debugger';
      } else if (webActive) {
        backendToStop = 'webRequest';
      }
    }

    if (!backendToStop) {
      return createErrorResponse('No active network captures found in any tab.');
    }

    const delegateStop =
      backendToStop === 'debugger' ? networkDebuggerStopTool : networkCaptureStopTool;
    const result = await delegateStop.execute();

    return decorateJsonResult(result, {
      backend: backendToStop,
      needResponseBody: backendToStop === 'debugger',
    });
  }
}

export const networkCaptureTool = new NetworkCaptureTool();
