import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { createOwnedRegistry } from '../../utils/owned-registry';
import { sendNativeRequest } from '@/entrypoints/background/native-host';
import { DEFAULT_PERF_TRACE_MAX_DURATION_MS, MAX_TOOL_TIMEOUT_MS } from '../../utils/timeouts';

type OwnerTag = 'performance';

interface StartTraceParams {
  reload?: boolean; // whether to reload the page after starting trace
  autoStop?: boolean; // whether to auto stop after a short duration
  durationMs?: number; // custom duration when autoStop is true (default 5000)
}

interface StopTraceParams {
  saveToDownloads?: boolean; // save trace to Downloads as JSON (default true)
  filenamePrefix?: string; // filename prefix (default 'performance_trace')
}

interface AnalyzeInsightParams {
  insightName?: string; // placeholder for future deep insights
  timeoutMs?: number;
}

type TraceEvent = { name?: string; [k: string]: unknown };

type DebuggeeEvent = (source: chrome.debugger.Debuggee, method: string, params?: unknown) => void;

interface TraceSessionState {
  recording: boolean;
  events: TraceEvent[];
  startedAt: number;
  pageUrl?: string;
  listener: DebuggeeEvent;
  stopResolver?: (value: { completed: boolean }) => void;
  stopPromise?: Promise<{ completed: boolean }>;
}

// IMP-0164: backed by `OwnedRegistry` for auto-eviction on tab close.
// Trace sessions are per-tab metadata; all entries route to the system
// bucket. Tab-close eviction prevents `sessions` leaks (previously
// closed tabs left dangling TraceSessionState until restart).
const sessions = createOwnedRegistry<TraceSessionState>();

type LastResult = {
  events: TraceEvent[];
  startedAt: number;
  endedAt: number;
  tabUrl: string;
  saved?: { downloadId?: number; filename?: string; fullPath?: string };
  metrics?: Record<string, number>;
};
const LAST_RESULTS = createOwnedRegistry<LastResult>();

function tracingCategories(): string[] {
  // Keep broadly consistent with other project
  return [
    '-*',
    'blink.console',
    'blink.user_timing',
    'devtools.timeline',
    'disabled-by-default-devtools.screenshot',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.invalidationTracking',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'disabled-by-default-v8.cpu_profiler.hires',
    'latencyInfo',
    'loading',
    'disabled-by-default-lighthouse',
    'v8.execute',
    'v8',
  ];
}

async function enablePerformanceMetrics(tabId: number): Promise<Record<string, number>> {
  try {
    await cdpSessionManager.sendCommand(tabId, 'Performance.enable');
    const result = (await cdpSessionManager.sendCommand(tabId, 'Performance.getMetrics')) as {
      metrics: Array<{ name: string; value: number }>;
    };
    await cdpSessionManager.sendCommand(tabId, 'Performance.disable');
    const map: Record<string, number> = {};
    for (const m of result.metrics || []) map[m.name] = m.value;
    return map;
  } catch (e) {
    return {};
  }
}

async function saveTraceToDownloads(
  json: string,
  filenamePrefix = 'performance_trace',
): Promise<{ downloadId?: number; filename?: string; fullPath?: string }> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}_${timestamp}.json`;
    const dataUrl = `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`;
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    // Attempt to resolve full path
    try {
      await new Promise((r) => setTimeout(r, 120));
      const [item] = await chrome.downloads.search({ id: downloadId });
      return { downloadId, filename, fullPath: item?.filename };
    } catch {
      return { downloadId, filename };
    }
  } catch {
    return {};
  }
}

async function saveTraceToNativeTemp(
  json: string,
  filenamePrefix = 'performance_trace',
): Promise<{ filename?: string; fullPath?: string } | undefined> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}_${timestamp}.json`;
    const base64 = btoa(unescape(encodeURIComponent(json)));

    const resp = await sendNativeRequest<any>(
      'file_operation',
      { action: 'prepareFile', base64Data: base64, fileName: filename },
      30_000,
    );
    if (resp && resp.success && resp.filePath) {
      return { filename, fullPath: resp.filePath };
    }
  } catch {
    // ignore, fallback will apply
  }
  return undefined;
}

async function cleanupNativeTempFile(filePath: string): Promise<void> {
  if (!filePath) return;
  try {
    await sendNativeRequest<any>('file_operation', { action: 'cleanupFile', filePath }, 10_000);
  } catch {
    // best-effort
  }
}

function getOrCreateStopPromise(session: TraceSessionState): Promise<{ completed: boolean }> {
  if (session.stopPromise) return session.stopPromise;
  session.stopPromise = new Promise((resolve) => {
    session.stopResolver = resolve;
  });
  return session.stopPromise;
}

/**
 * Start performance trace
 */
class PerformanceStartTraceInternal extends BaseBrowserToolExecutor {
  name = 'chrome_performance_trace__start_internal';

  async execute(args: StartTraceParams): Promise<ToolResult> {
    const { reload = false, autoStop = false, durationMs = 5000 } = args || {};

    try {
      // Per-client owned tab (IMP-0157). Performance traces are
      // long-running and tab-bound — pick the caller's tab, not the
      // browser's globally-active one.
      const activeTab = await this.getOwnedTab({ isRead: true, required: false });
      if (!activeTab?.id) {
        return createErrorResponse('No active tab found', ToolErrorCode.TAB_NOT_FOUND);
      }
      const tabId = activeTab.id;
      const existed = sessions.get(undefined, tabId);
      if (existed?.recording) {
        return createErrorResponse(
          'A performance trace is already recording for this tab. Call chrome_performance_stop_trace first.',
          ToolErrorCode.UNKNOWN,
          { tabId },
        );
      }

      await cdpSessionManager.attach(tabId, 'performance');

      const state: TraceSessionState = {
        recording: true,
        events: [],
        startedAt: Date.now(),
        pageUrl: activeTab.url || '',
        listener: (source, method, params) => {
          if (source.tabId !== tabId) return;
          if (method === 'Tracing.dataCollected') {
            const value = (params as { value?: TraceEvent[] } | undefined)?.value;
            if (value) {
              try {
                state.events.push(...value);
              } catch {
                // ignore
              }
            }
          } else if (method === 'Tracing.tracingComplete') {
            state.recording = false;
            state.stopResolver?.({ completed: true });
          }
        },
      };
      chrome.debugger.onEvent.addListener(state.listener);
      sessions.set(undefined, tabId, state);

      // Start tracing with categories
      const cats = tracingCategories().join(',');
      await cdpSessionManager.sendCommand(tabId, 'Tracing.start', {
        categories: cats,
        options: 'record-as-much-as-possible',
        transferMode: 'ReportEvents',
      });

      if (reload) {
        try {
          await cdpSessionManager.sendCommand(tabId, 'Page.reload', { ignoreCache: true });
        } catch {
          // best effort; ignore if fails
        }
      }

      if (autoStop) {
        setTimeout(
          async () => {
            try {
              await cdpSessionManager.sendCommand(tabId, 'Tracing.end');
            } catch {
              // ignore
            }
          },
          Math.max(1000, Math.min(durationMs, DEFAULT_PERF_TRACE_MAX_DURATION_MS)),
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message:
                'Performance trace is recording. Use chrome_performance_stop_trace to stop it.',
              reload,
              autoStop,
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Failed to start performance trace: ${e?.message || e}`);
    }
  }
}

/**
 * Stop performance trace
 */
class PerformanceStopTraceInternal extends BaseBrowserToolExecutor {
  name = 'chrome_performance_trace__stop_internal';

  async execute(args: StopTraceParams): Promise<ToolResult> {
    const { saveToDownloads = true, filenamePrefix } = args || {};
    try {
      // Per-client owned tab (IMP-0157).
      const activeTab = await this.getOwnedTab({ isRead: true, required: false });
      if (!activeTab?.id)
        return createErrorResponse('No active tab found', ToolErrorCode.TAB_NOT_FOUND);
      const tabId = activeTab.id;
      const session = sessions.get(undefined, tabId);
      if (!session) {
        return {
          content: [
            { type: 'text', text: 'No performance trace session found for the current tab.' },
          ],
          isError: false,
        };
      }

      let stopResult: { completed: boolean } = { completed: false };
      if (session.recording) {
        // End tracing and wait for completion signal
        await cdpSessionManager.sendCommand(tabId, 'Tracing.end');
        await getOrCreateStopPromise(session);
        stopResult = await session.stopPromise!;
      } else {
        // Already auto-stopped; proceed to finalize without waiting
        stopResult = { completed: true };
      }
      // Fetch metrics before detach
      const metrics = await enablePerformanceMetrics(tabId);

      // Cleanup event listener and detach
      try {
        chrome.debugger.onEvent.removeListener(session.listener);
      } catch {
        // ignore
      }
      try {
        await cdpSessionManager.detach(tabId, 'performance');
      } catch {
        // ignore
      }

      const endedAt = Date.now();
      const trace = { traceEvents: session.events };
      const json = JSON.stringify(trace);

      let saved: { downloadId?: number; filename?: string; fullPath?: string } | undefined;
      if (saveToDownloads) {
        saved = await saveTraceToDownloads(json, filenamePrefix || 'performance_trace');
      } else {
        // Persist to native temp directory so that analysis can run without Downloads permission
        const tempSaved = await saveTraceToNativeTemp(json, filenamePrefix || 'performance_trace');
        if (tempSaved) {
          saved = { ...tempSaved };
        }
      }

      LAST_RESULTS.set(undefined, tabId, {
        events: session.events,
        startedAt: session.startedAt,
        endedAt,
        tabUrl: session.pageUrl || '',
        saved,
        metrics,
      });

      sessions.delete(undefined, tabId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'The performance trace has been stopped.',
              eventCount: session.events.length,
              saved,
              metrics,
              startedAt: session.startedAt,
              endedAt,
              durationMs: endedAt - session.startedAt,
              url: session.pageUrl || '',
              tracingCompleted: stopResult?.completed === true,
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Failed to stop performance trace: ${e?.message || e}`);
    }
  }
}

/**
 * Analyze last trace (lightweight)
 * Note: Deep insights require DevTools front-end trace engine on the native side; this is a
 * pragmatic first step returning basic metrics and a quick event histogram.
 */
class PerformanceAnalyzeInsightInternal extends BaseBrowserToolExecutor {
  name = 'chrome_performance_trace__analyze_internal';

  async execute(args: AnalyzeInsightParams): Promise<ToolResult> {
    const { insightName } = args || {};
    try {
      // Per-client owned tab (IMP-0157).
      const activeTab = await this.getOwnedTab({ isRead: true, required: false });
      if (!activeTab?.id)
        return createErrorResponse('No active tab found', ToolErrorCode.TAB_NOT_FOUND);
      const tabId = activeTab.id;
      const result = LAST_RESULTS.get(undefined, tabId);
      if (!result) {
        return createErrorResponse(
          'No recorded trace for this tab. Call chrome_performance_start_trace then chrome_performance_stop_trace first.',
          ToolErrorCode.UNKNOWN,
          { tabId },
        );
      }

      // Prefer native-side deep analysis when we have a saved file path
      const fullPath = result.saved?.fullPath;
      if (fullPath) {
        try {
          const timeoutMs = Math.max(
            10_000,
            Math.min(args?.timeoutMs ?? DEFAULT_PERF_TRACE_MAX_DURATION_MS, MAX_TOOL_TIMEOUT_MS),
          );
          const resp = await sendNativeRequest<{
            success?: boolean;
            summary?: unknown;
            insight?: unknown;
          }>(
            'file_operation',
            { action: 'analyzeTrace', traceFilePath: fullPath, insightName },
            timeoutMs,
          );
          if (resp && resp.success) {
            // Best-effort cleanup for temp files (Downloads paths are ignored by native cleaner)
            await cleanupNativeTempFile(fullPath);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    url: result.tabUrl,
                    startedAt: result.startedAt,
                    endedAt: result.endedAt,
                    durationMs: result.endedAt - result.startedAt,
                    metrics: result.metrics || {},
                    saved: result.saved,
                    summary: resp.summary,
                    insight: resp.insight,
                  }),
                },
              ],
              isError: false,
            };
          }
          // If native returned error, fall through to lightweight analysis
        } catch (e) {
          // Fallback to lightweight analysis below
        }
      }

      // Lightweight fallback (when no saved file path)
      const counts = new Map<string, number>();
      for (const ev of result.events.slice(0, 100000)) {
        const n = typeof ev?.name === 'string' ? ev.name : 'unknown';
        counts.set(n, (counts.get(n) || 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([name, count]) => ({ name, count }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              info: 'Lightweight analysis (no saved file path). Native-side deep analysis unavailable.',
              requestedInsight: insightName || null,
              url: result.tabUrl,
              startedAt: result.startedAt,
              endedAt: result.endedAt,
              durationMs: result.endedAt - result.startedAt,
              metrics: result.metrics || {},
              topEventNames: top,
              saved: result.saved,
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Failed to analyze trace: ${e?.message || e}`);
    }
  }
}

const performanceStartTraceInternal = new PerformanceStartTraceInternal();
const performanceStopTraceInternal = new PerformanceStopTraceInternal();
const performanceAnalyzeInsightInternal = new PerformanceAnalyzeInsightInternal();

// Backward-compat exports for tests that import the per-action handlers.
export const performanceStartTraceTool = performanceStartTraceInternal;
export const performanceStopTraceTool = performanceStopTraceInternal;
export const performanceAnalyzeInsightTool = performanceAnalyzeInsightInternal;

/**
 * Unified chrome_performance_trace tool (Slice 8 of IMP-0188 catalog consolidation).
 * Routes by `action` to start/stop/analyze.
 */
type PerformanceTraceAction = 'start' | 'stop' | 'analyze';
const PERFORMANCE_ACTIONS: readonly PerformanceTraceAction[] = [
  'start',
  'stop',
  'analyze',
] as const;

class PerformanceTraceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PERFORMANCE_TRACE;
  static readonly mutates = true;

  async execute(
    args: { action: PerformanceTraceAction } & Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!args || typeof args.action !== 'string') {
      return createErrorResponse(
        `\`action\` is required (one of: ${PERFORMANCE_ACTIONS.join(', ')})`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (!PERFORMANCE_ACTIONS.includes(args.action)) {
      return createErrorResponse(
        `Invalid action "${args.action}": expected one of ${PERFORMANCE_ACTIONS.join(', ')}`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    switch (args.action) {
      case 'start':
        return performanceStartTraceInternal.execute(args as any);
      case 'stop':
        return performanceStopTraceInternal.execute(args as any);
      case 'analyze':
        return performanceAnalyzeInsightInternal.execute(args as any);
    }
  }
}

export const performanceTraceTool = new PerformanceTraceTool();
