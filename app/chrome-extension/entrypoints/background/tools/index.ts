import { createErrorResponse, createErrorResponseFromThrown } from '@/common/tool-handler';
import { ToolErrorCode, TOOL_NAMES } from 'humanchrome-shared';
import { debugLog } from '../utils/debug-log';
import {
  recordClientTab,
  resolveTabIdForClient,
  resolveWindowIdForClient,
  consumePacingDelay,
} from '../utils/client-state';
import { acquireTabLock } from '../utils/tab-lock';
import { runWithContext } from '../utils/request-context';

// =============================================================================
// Tool registry — all eager (IMP-0086 reverts IMP-0056's lazy half)
// =============================================================================
//
// IMP-0056 split this into eager + lazy halves with `import('./browser/<x>')`
// for ~14 heavy tools, claiming an ~80–120 KB cold-start saving. In practice
// Rolldown hoists those dynamic imports back to static imports in the entry
// chunk, AND it places the lazy chunks' `BaseBrowserToolExecutor` superclass
// in the entry chunk while making the lazy chunks back-edge import it via
// `../background.js`. ESM evaluation order then resolves `class X extends
// Base` in the lazy chunks before the entry's `class Base { ... }` line —
// TDZ → "Class extends value undefined" → MV3 SW registration fails (status
// 15). Both the perf claim and the basic functionality were broken; reverting
// to all-eager is the cheap fix. Re-introduce lazy loading later by moving
// `BaseBrowserToolExecutor` into a leaf module (e.g. humanchrome-shared) so
// it can sit in its own chunk and the back-edge disappears.
// =============================================================================

import { navigateTool, navigateBatchTool, closeTabsTool, switchTabTool } from './browser/common';
import { closeTabsMatchingTool } from './browser/close-tabs-matching';
import { tabGroupsTool } from './browser/tab-groups';
import { notificationsTool } from './browser/notifications';
import { clipboardTool } from './browser/clipboard';
import { sessionsTool } from './browser/sessions';
import { tabLifecycleTool } from './browser/tab-lifecycle';
import { networkEmulateTool } from './browser/network-emulate';
import { printToPdfTool } from './browser/print-to-pdf';
import { blockOrRedirectTool } from './browser/block-or-redirect';
import { actionBadgeTool } from './browser/action-badge';
import { keepAwakeTool } from './browser/keep-awake';
import { contextMenuTool } from './browser/context-menu';
import { focusTool } from './browser/focus';
import { pasteTool } from './browser/paste';
import { selectTextTool } from './browser/select-text';
import { windowManageTool } from './browser/window-manage';
import { webVitalsTool } from './browser/web-vitals';
import { idleTool } from './browser/idle';
import { alarmsTool } from './browser/alarms';
import { clearBrowsingDataTool } from './browser/clear-browsing-data';
import { proxyTool } from './browser/proxy';
import { identityTool } from './browser/identity';
import { dragDropTool } from './browser/drag-drop';
import { waitForTabTool } from './browser/wait-for-tab';
import { windowTool } from './browser/window';
import { webFetcherTool, getInteractiveElementsTool } from './browser/web-fetcher';
import { clickTool, fillTool } from './browser/interaction';
import { awaitElementTool } from './browser/await-element';
import { networkRequestTool } from './browser/network-request';
import { networkCaptureTool } from './browser/network-capture';
import {
  networkCaptureStartTool,
  networkCaptureStopTool,
} from './browser/network-capture-web-request';
import { keyboardTool } from './browser/keyboard';
import { historyTool, historyDeleteTool } from './browser/history';
import { listFramesTool } from './browser/list-frames';
import {
  bookmarkSearchTool,
  bookmarkAddTool,
  bookmarkUpdateTool,
  bookmarkDeleteTool,
} from './browser/bookmark';
import { getCookiesTool, setCookieTool, removeCookieTool } from './browser/cookies';
import {
  injectScriptTool,
  listInjectedScriptsTool,
  sendCommandToInjectScriptTool,
  removeInjectedScriptTool,
} from './browser/inject-script';
import { consoleTool } from './browser/console';
import { consoleClearTool } from './browser/console-clear';
import { fileUploadTool } from './browser/file-upload';
import { handleDialogTool } from './browser/dialog';
import { handleDownloadTool, downloadListTool, downloadCancelTool } from './browser/download';
import { storageTool } from './browser/storage';
import { debugDumpTool } from './browser/debug-dump';
import { assertTool } from './browser/assert';
import { waitForTool } from './browser/wait-for';
import { paceTool, paceGetTool } from './browser/pace';
import { screenshotTool } from './browser/screenshot';
import { vectorSearchTabsContentTool } from './browser/vector-search';
import { elementPickerTool } from './browser/element-picker';
import {
  networkDebuggerStartTool,
  networkDebuggerStopTool,
} from './browser/network-capture-debugger';
import { interceptResponseTool } from './browser/intercept-response';
import { javascriptTool } from './browser/javascript';
import { readPageTool } from './browser/read-page';
import { computerTool } from './browser/computer';
import { userscriptTool } from './browser/userscript';
import {
  performanceStartTraceTool,
  performanceStopTraceTool,
  performanceAnalyzeInsightTool,
} from './browser/performance';
import { gifRecorderTool } from './browser/gif-recorder';
import { flowRunTool, listPublishedFlowsTool, flowDeleteTool } from './record-replay';

interface ToolInstance {
  name: string;
  // Loosened to `any` because each concrete tool narrows its args to its
  // own params interface; we don't try to reconcile those shapes here.
  // The dispatcher only ever forwards an arbitrary args bag.
  execute: (args: any) => Promise<any>;
  // `mutates` lives on the constructor's static side. Not every tool sets
  // it — the dispatcher reads it via `(tool.constructor as any).mutates`.
}

const eagerTools: ToolInstance[] = [
  navigateTool,
  navigateBatchTool,
  closeTabsTool,
  closeTabsMatchingTool,
  switchTabTool,
  tabGroupsTool,
  notificationsTool,
  clipboardTool,
  sessionsTool,
  tabLifecycleTool,
  networkEmulateTool,
  printToPdfTool,
  blockOrRedirectTool,
  actionBadgeTool,
  keepAwakeTool,
  contextMenuTool,
  focusTool,
  pasteTool,
  selectTextTool,
  windowManageTool,
  webVitalsTool,
  idleTool,
  alarmsTool,
  clearBrowsingDataTool,
  proxyTool,
  identityTool,
  dragDropTool,
  waitForTabTool,
  windowTool,
  webFetcherTool,
  getInteractiveElementsTool,
  clickTool,
  fillTool,
  awaitElementTool,
  networkRequestTool,
  networkCaptureTool,
  networkCaptureStartTool,
  networkCaptureStopTool,
  keyboardTool,
  historyTool,
  historyDeleteTool,
  listFramesTool,
  bookmarkSearchTool,
  bookmarkAddTool,
  bookmarkUpdateTool,
  bookmarkDeleteTool,
  getCookiesTool,
  setCookieTool,
  removeCookieTool,
  injectScriptTool,
  listInjectedScriptsTool,
  sendCommandToInjectScriptTool,
  removeInjectedScriptTool,
  consoleTool,
  consoleClearTool,
  fileUploadTool,
  handleDialogTool,
  handleDownloadTool,
  downloadListTool,
  downloadCancelTool,
  storageTool,
  debugDumpTool,
  assertTool,
  waitForTool,
  paceTool,
  paceGetTool,
  flowRunTool as unknown as ToolInstance,
  listPublishedFlowsTool as unknown as ToolInstance,
  flowDeleteTool as unknown as ToolInstance,
  screenshotTool,
  vectorSearchTabsContentTool,
  elementPickerTool,
  networkDebuggerStartTool,
  networkDebuggerStopTool,
  interceptResponseTool,
  javascriptTool,
  readPageTool,
  computerTool,
  userscriptTool,
  performanceStartTraceTool,
  performanceStopTraceTool,
  performanceAnalyzeInsightTool,
  gifRecorderTool,
];

const eagerToolsByName = new Map<string, ToolInstance>(eagerTools.map((t) => [t.name, t]));

async function getTool(name: string): Promise<ToolInstance | undefined> {
  return eagerToolsByName.get(name);
}

/** Test-only — list every name the dispatcher will resolve. */
export function _listRegisteredToolNamesForTest(): string[] {
  return [...eagerToolsByName.keys()];
}

/** Test-only no-op — kept for back-compat with the IMP-0056 lazy era. */
export function _resetLazyToolCacheForTest(): void {}

export interface ToolCallParam {
  name: string;
  args: any;
}

/**
 * Resolve target tab for this call: caller's explicit tabId beats this
 * client's preferred tab (last successful call). When neither is set the
 * tool falls back to the active tab via its own getActiveTabOrThrow path.
 */
function resolveTargetTabId(args: any, clientId: string | undefined): number | undefined {
  const explicit = typeof args?.tabId === 'number' ? (args.tabId as number) : undefined;
  if (explicit !== undefined) return explicit;
  return resolveTabIdForClient(clientId);
}

function resolveTargetWindowId(args: any, clientId: string | undefined): number | undefined {
  const explicit = typeof args?.windowId === 'number' ? (args.windowId as number) : undefined;
  if (explicit !== undefined) return explicit;
  return resolveWindowIdForClient(clientId);
}

/**
 * Sniff a numeric field out of a tool's response payload. Tool responses
 * serialize their JSON inside a single text content block; navigate-like
 * tools include `tabId` / `windowId` for the tab/window they ended up using.
 * Used to record the client's preferred-tab/window pointer when the caller
 * didn't pin one.
 */
function extractFromResult(
  result: any,
  paths: Array<(parsed: any) => unknown>,
): number | undefined {
  const block = result?.content?.find?.((c: any) => c?.type === 'text');
  if (!block?.text || typeof block.text !== 'string') return undefined;
  try {
    const parsed = JSON.parse(block.text);
    for (const path of paths) {
      const id = path(parsed);
      if (typeof id === 'number') return id;
    }
  } catch {
    // body wasn't JSON — fine
  }
  return undefined;
}

const extractTabIdFromResult = (result: any) =>
  extractFromResult(result, [(p) => p?.tabId, (p) => p?.tab?.id, (p) => p?.tabs?.[0]?.tabId]);

const extractWindowIdFromResult = (result: any) =>
  extractFromResult(result, [(p) => p?.windowId, (p) => p?.tab?.windowId]);

/**
 * Handle tool execution.
 *
 * @param param      Tool name and args from the MCP caller.
 * @param requestId  Optional correlation id from the native-messaging envelope.
 * @param clientId   Optional MCP-session id. When set, callers without an
 *   explicit `tabId` get this client's last-used tab — eliminating cross-talk
 *   between concurrent MCP clients.
 */
export const handleCallTool = async (
  param: ToolCallParam,
  requestId?: string,
  clientId?: string,
) => {
  const tabId = resolveTargetTabId(param.args, clientId);
  const windowId = resolveTargetWindowId(param.args, clientId);
  // Surface the resolved tab/window into args so the tool sees them even when
  // the caller omitted them. Tool internals stay unchanged.
  if (
    param.args &&
    typeof param.args === 'object' &&
    ((tabId !== undefined && param.args.tabId !== tabId) ||
      (windowId !== undefined && param.args.windowId !== windowId))
  ) {
    const next: Record<string, unknown> = { ...param.args };
    if (tabId !== undefined) next.tabId = tabId;
    if (windowId !== undefined) next.windowId = windowId;
    param = { ...param, args: next };
  }
  const startedAt = Date.now();
  // Bind a child logger so every line for this dispatch carries the same
  // correlation fields. The same `requestId` lands in the bridge's stderr
  // pino output via the native messaging envelope.
  const log = debugLog.with({ requestId, clientId, tool: param.name, tabId });
  log.info('tool call start');

  const tool = await getTool(param.name);
  if (!tool) {
    log.warn('tool not found');
    return createErrorResponse(`Tool ${param.name} not found`, ToolErrorCode.INVALID_ARGS, {
      tool: param.name,
    });
  }

  const run = async () => {
    try {
      // Bind the active request context so BaseBrowserToolExecutor.sendMessageToTab
      // can tag outbound envelopes with the same correlation id we just logged.
      // The envelope shape is unchanged for callers that don't read the field.
      const result = await runWithContext<any>(
        { requestId, clientId, tool: param.name, tabId },
        () => tool.execute(param.args),
      );
      const ok = !(result && (result as { isError?: boolean }).isError === true);
      if (ok) {
        // Tools like chrome_navigate pick a tab themselves when the caller
        // omits one — read the tab back out of the response so the client's
        // preferred-tab pointer follows the tab the tool actually used.
        // Skip the sniff when the caller already pinned a tab; tool responses
        // can be tens of KB (read-page) and JSON-parsing them per call adds
        // up on hot paths.
        const sniffedTab = tabId === undefined ? extractTabIdFromResult(result) : undefined;
        const sniffedWindow =
          windowId === undefined ? extractWindowIdFromResult(result) : undefined;
        const effectiveTabId = tabId ?? sniffedTab;
        const effectiveWindowId = windowId ?? sniffedWindow;
        if (typeof effectiveTabId === 'number') {
          recordClientTab(clientId, effectiveTabId, effectiveWindowId);
        }
        log.debug('client tab recorded', {
          tabId: effectiveTabId,
          data: {
            inputTabId: tabId ?? null,
            sniffedTab: sniffedTab ?? null,
            inputWindowId: windowId ?? null,
            sniffedWindow: sniffedWindow ?? null,
          },
        });
      }
      log.info('tool call done', {
        data: { ok, durationMs: Date.now() - startedAt },
      });
      return result;
    } catch (error) {
      log.error('tool call threw', {
        data: {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return createErrorResponseFromThrown(error);
    }
  };

  // Mutating tools serialize per-tab; reads and implicit-tab calls pass through.
  const mutates = (tool.constructor as { mutates?: boolean })?.mutates === true;

  // Per-client pacing throttle (set via chrome_pace). Sleep before any
  // mutating dispatch so anti-bot platforms see human-like rhythm. Reads
  // skip this gate entirely. The delay is consumed even if the call later
  // fails — same as a real human's reaction time isn't refunded by a
  // failed click. State lives in client-state.ts; service-worker restart
  // resets to off.
  if (mutates) {
    const delay = consumePacingDelay(clientId);
    if (delay > 0) {
      log.debug('pacing throttle applied', { data: { delayMs: delay } });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (!mutates || typeof tabId !== 'number') return run();

  let release: (() => void) | undefined;
  try {
    release = await acquireTabLock(tabId);
  } catch (err) {
    log.warn('tab lock timeout');
    return createErrorResponseFromThrown(err);
  }
  try {
    return await run();
  } finally {
    release();
  }
};
