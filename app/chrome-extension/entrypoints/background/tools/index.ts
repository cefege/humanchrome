import { createErrorResponse, createErrorResponseFromThrown } from '@/common/tool-handler';
import { ToolErrorCode, TOOL_NAMES, enforceOutputBudget } from 'humanchrome-shared';
import { debugLog } from '../utils/debug-log';
import {
  claimTabForClient,
  clearLastWindowForClient,
  consumePacingDelay,
  getBrowserStateForClientPolicy,
  recordClientTab,
  recordClientWindow,
} from '../utils/client-state';
import { ensureClientStateReady } from '../utils/client-state';
import { acquireTabLockWithMeta } from '../utils/tab-queue';
import { runWithContext } from '../utils/request-context';

// =============================================================================
// Tool registry — eager + lazy split (IMP-0056)
// =============================================================================
//
// Pre-IMP-0056 this file did `import * as browserTools from './browser'`,
// which through the barrel star-export construction-time-evaluated EVERY
// tool file at SW boot. That dragged ~80–120 KB of bundled code plus
// per-instance allocations into the cold-start path even when most tools
// were never called in the session.
//
// Now: light tools stay eager (they're tiny, cheap, and called every
// session). Heavy tools — gif-recorder, performance, network-capture-
// debugger, computer, read-page, screenshot, vector-search,
// element-picker, intercept-response, javascript, userscript — are
// loaded on first use via dynamic `import()` and memoized. The Map is
// keyed by tool name; lookup falls through eager → lazy → not-found.
//
// Tests still import the singletons directly from `./browser/<file>`,
// which is unaffected by this change. The `./browser/index.ts` barrel
// stays in place for any future caller that wants the eager-everything
// shape; this dispatcher just doesn't use it.
// =============================================================================

import { navigateTool } from './browser/common';
import { navigateBatchTool } from './browser/navigate-batch';
import { closeTabsTool } from './browser/close-tabs';
// close-tabs-matching and close-my-tabs are imported by close-tabs.ts internally.
import { switchTabTool } from './browser/switch-tab';
import { tabGroupsTool } from './browser/tab-groups';
import { notificationsTool } from './browser/notifications';
import { clipboardTool } from './browser/clipboard';
import { sessionsTool } from './browser/sessions';
import { tabLifecycleTool } from './browser/tab-lifecycle';
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
import { windowTool } from './browser/window';
import { webFetcherTool } from './browser/web-fetcher';
import { clickTool, fillTool } from './browser/interaction';
import { networkRequestTool } from './browser/network-request';
import { networkCaptureTool } from './browser/network-capture';
import {} from './browser/network-capture-web-request';
import { keyboardTool } from './browser/keyboard';
import { historyTool } from './browser/history';
import { listFramesTool } from './browser/list-frames';
import { bookmarkTool } from './browser/bookmark';
import { cookiesTool } from './browser/cookies';
import { injectScriptTool, sendCommandToInjectScriptTool } from './browser/inject-script';
import { consoleTool } from './browser/console';
import { fileUploadTool } from './browser/file-upload';
import { handleDialogTool } from './browser/dialog';
import { handleDownloadTool, downloadTool } from './browser/download';
import { storageTool } from './browser/storage';
import { diagnosticsTool } from './browser/diagnostics';
import { assertTool } from './browser/assert';
import { waitForTool } from './browser/wait-for';
import { paceTool } from './browser/pace';
import { claimTabTool } from './browser/claim-tab';
import { ownedTabsTool } from './browser/owned-tabs';
import { locatorHandlerTool } from './browser/locator-handler';
import { aliasTabTool } from './browser/alias-tab';
import { extraHttpHeadersTool } from './browser/extra-http-headers';
import { emulateTool } from './browser/emulate';
import { getAttributesTool } from './browser/get-attributes';
import { hoverTool } from './browser/hover';
import { typeIntoTool } from './browser/type-into';
import { harExportTool } from './browser/har-export';
import { mockResponseTool } from './browser/mock-response';
import { basicAuthTool } from './browser/basic-auth';
import { setCheckedTool } from './browser/set-checked';
import { comboboxSelectTool } from './browser/combobox-select';
import { fillLwcTool } from './browser/fill-lwc';
import { typeaheadProbeTool } from './browser/typeahead-probe';
import { flowRunTool, listPublishedFlowsTool, flowDeleteTool } from './record-replay';
// Eager imports for tools that USED to be lazy but landed in their own
// Rolldown chunk — bug #216. Chrome forbids dynamic `import()` of new
// modules from a service-worker context (even with `type: "module"`):
// `import() is disallowed on ServiceWorkerGlobalScope by the HTML
// specification` (https://github.com/w3c/ServiceWorker/issues/1356). The
// previous lazy split worked only by accident when the bundler inlined
// the target into background.js; the moment Rolldown emitted a separate
// chunk (which it does for every tool wider than ~3 KB) the runtime call
// blew up. Eager static imports put these chunks into the SW's initial
// module graph, so the wrapper still memoizes on first call but the
// underlying module is already resolved. The lazyLoaders Map remains for
// the heavy chunks (gif-recorder, vector-search) that need a follow-up
// offscreen refactor before they can be eager — see backlog IMP-0121.
import { javascriptTool } from './browser/javascript';
import { readPageTool } from './browser/read-page';
import { userscriptTool } from './browser/userscript';
import { performanceTraceTool } from './browser/performance';
import { elementPickerTool } from './browser/element-picker';
// vector-search.ts is now a thin RPC shim — the heavy ML graph lives in
// the offscreen document, so static import is safe (no SW dynamic-import()
// ban risk).
import { vectorSearchTabsContentTool } from './browser/vector-search';
// IMP-0188: screenshot + intercept-response + computer landed in their own
// Rolldown chunks in a recent build, so the lazy dynamic-import() path
// started failing in MV3 SW (W3C ban). Same root cause as bug #216 — eager
// static imports put their chunks into the SW's initial module graph.
import { screenshotTool } from './browser/screenshot';
import { interceptResponseTool } from './browser/intercept-response';
import { computerTool } from './browser/computer';

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
  switchTabTool,
  tabGroupsTool,
  notificationsTool,
  clipboardTool,
  sessionsTool,
  tabLifecycleTool,
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
  windowTool,
  webFetcherTool,
  clickTool,
  fillTool,
  networkRequestTool,
  networkCaptureTool,
  keyboardTool,
  historyTool,
  listFramesTool,
  bookmarkTool,
  cookiesTool,
  injectScriptTool,
  sendCommandToInjectScriptTool,
  consoleTool,
  fileUploadTool,
  handleDialogTool,
  handleDownloadTool,
  downloadTool,
  storageTool,
  diagnosticsTool,
  assertTool,
  waitForTool,
  paceTool,
  claimTabTool,
  ownedTabsTool,
  locatorHandlerTool,
  aliasTabTool,
  extraHttpHeadersTool,
  emulateTool,
  getAttributesTool,
  hoverTool,
  typeIntoTool,
  harExportTool,
  mockResponseTool,
  basicAuthTool,
  setCheckedTool,
  comboboxSelectTool,
  fillLwcTool,
  typeaheadProbeTool,
  flowRunTool as unknown as ToolInstance,
  listPublishedFlowsTool as unknown as ToolInstance,
  flowDeleteTool as unknown as ToolInstance,
  // Promoted from lazyLoaders — bug #216 (SW import() disallowed).
  javascriptTool,
  readPageTool,
  userscriptTool,
  performanceTraceTool,
  elementPickerTool,
  vectorSearchTabsContentTool,
  // Promoted from lazyLoaders — IMP-0188 (same root cause).
  screenshotTool,
  interceptResponseTool,
  computerTool,
];

const eagerToolsByName = new Map<string, ToolInstance>(eagerTools.map((t) => [t.name, t]));

/**
 * Heavy tools — loaded on first use via dynamic import, then memoized.
 * Each entry returns a Promise that resolves to the singleton instance
 * exported by the corresponding module.
 *
 * The estimated savings (per IMP-0056): SW chunk shrinks by ~80–120 KB
 * in steady state when these tools aren't called. The chrome.scripting
 * / chrome.debugger listener constructors that some of these tools
 * register inside their class constructors also stop firing at boot.
 */
type LazyLoader = () => Promise<ToolInstance>;

const lazyLoaders: Record<string, LazyLoader> = {
  // Only gif-recorder remains lazy — its chunk doesn't fold into background.js,
  // and the captureVisibleTab loop carries enough state that promoting it
  // wastes SW boot time when GIF recording isn't used. If we hit the same
  // dynamic-import() failure here (IMP-0188 / bug #216), promote to eager.
  [TOOL_NAMES.BROWSER.GIF_RECORDER]: async () =>
    (await import('./browser/gif-recorder')).gifRecorderTool,
};

const lazyResolved = new Map<string, ToolInstance>();
const lazyInflight = new Map<string, Promise<ToolInstance>>();

async function resolveLazyTool(name: string): Promise<ToolInstance | undefined> {
  const cached = lazyResolved.get(name);
  if (cached) return cached;
  const inflight = lazyInflight.get(name);
  if (inflight) return inflight;
  const loader = lazyLoaders[name];
  if (!loader) return undefined;
  const promise = loader().then((tool) => {
    lazyResolved.set(name, tool);
    lazyInflight.delete(name);
    return tool;
  });
  lazyInflight.set(name, promise);
  return promise;
}

/**
 * Resolve a tool by name. Eager tools answer instantly; heavy tools
 * are imported on first use and memoized for subsequent calls.
 */
async function getTool(name: string): Promise<ToolInstance | undefined> {
  const eager = eagerToolsByName.get(name);
  if (eager) return eager;
  return resolveLazyTool(name);
}

/** Test-only — drop the lazy memo so a test can re-exercise the loader. */
/**
 * Test-only escape hatches: inject/remove a tool by name without touching the
 * frozen registry. Used by `dispatcher-output-budget.contract.test.ts` to
 * exercise the IMP-0179 budget against a synthetic tool that returns
 * arbitrarily-sized payloads.
 */
export function _registerToolForTest(tool: ToolInstance): void {
  eagerToolsByName.set(tool.name, tool);
}

export function _unregisterToolForTest(name: string): void {
  eagerToolsByName.delete(name);
}

export function _resetLazyToolCacheForTest(): void {
  lazyResolved.clear();
  lazyInflight.clear();
}

export function listRegisteredToolNames(): string[] {
  return [...eagerToolsByName.keys(), ...Object.keys(lazyLoaders)];
}

export interface ToolCallParam {
  name: string;
  args: any;
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
 * Try to create a fresh tab the calling client will own. Used when a
 * mutating tool has no explicit `tabId` and the client has no usable
 * owned tab. The tab opens in the background (`active: false`) so the
 * user's current focus isn't disturbed. Returns the new tabId or
 * `undefined` on failure (caller falls through to its own active-tab
 * path as a last resort).
 */
async function autoSpawnOwnedTab(
  clientId: string | undefined,
  preferredWindowId: number | undefined,
): Promise<number | undefined> {
  if (!clientId || typeof chrome === 'undefined' || !chrome.tabs?.create) return undefined;

  let livePreferredWindowId = preferredWindowId;
  if (livePreferredWindowId !== undefined && chrome.windows?.get) {
    try {
      await chrome.windows.get(livePreferredWindowId);
    } catch {
      clearLastWindowForClient(clientId, livePreferredWindowId);
      livePreferredWindowId = undefined;
    }
  }

  try {
    const createArgs: chrome.tabs.CreateProperties = { url: 'about:blank', active: false };
    if (livePreferredWindowId !== undefined) createArgs.windowId = livePreferredWindowId;
    const created = await chrome.tabs.create(createArgs);
    if (typeof created?.id !== 'number') return undefined;
    claimTabForClient(clientId, created.id, created.windowId);
    return created.id;
  } catch {
    return undefined;
  }
}

function createBrowserPolicyError(error: {
  code: string;
  message: string;
  details: unknown;
}) {
  const code =
    error.code === 'TAB_NOT_OWNED'
      ? ToolErrorCode.TAB_NOT_OWNED
      : error.code === 'TAB_NOT_FOUND'
        ? ToolErrorCode.TAB_NOT_FOUND
        : error.code === 'INVALID_ARGS'
          ? ToolErrorCode.INVALID_ARGS
          : ToolErrorCode.UNKNOWN;
  return createErrorResponse(error.message, code, error.details as Record<string, unknown>);
}

/**
 * Handle tool execution.
 *
 * @param param      Tool name and args from the MCP caller.
 * @param requestId  Optional correlation id from the native-messaging envelope.
 * @param clientId   Optional MCP-session id. When set, the dispatcher resolves
 *   the target tab against this client's owned-tab set — eliminating cross-talk
 *   between concurrent MCP clients. Mutating tools without a usable owned tab
 *   get a fresh background tab auto-spawned and owned by this client.
 */
export const handleCallTool = async (
  param: ToolCallParam,
  requestId?: string,
  clientId?: string,
) => {
  const startedAt = Date.now();
  try {
    await ensureClientStateReady();
  } catch (error) {
    return createErrorResponseFromThrown(error);
  }
  const tool = await getTool(param.name);
  // Logger child first so the not-found path still carries correlation fields.
  const earlyLog = debugLog.with({ requestId, clientId, tool: param.name });
  if (!tool) {
    earlyLog.warn('tool not found');
    return createErrorResponse(`Tool ${param.name} not found`, ToolErrorCode.INVALID_ARGS, {
      tool: param.name,
    });
  }

  const mutates = (tool.constructor as { mutates?: boolean })?.mutates === true;
  const autoSpawn = (tool.constructor as { autoSpawnTab?: boolean })?.autoSpawnTab !== false;

  const callerSuppliesUrl = typeof param.args?.url === 'string' && param.args.url.length > 0;
  const explicitTabId = typeof param.args?.tabId === 'number' ? param.args.tabId : undefined;
  const trimmedTabAlias =
    typeof param.args?.tabAlias === 'string' && param.args.tabAlias.trim().length > 0
      ? param.args.tabAlias.trim()
      : undefined;
  const explicitWindowId =
    typeof param.args?.windowId === 'number' ? (param.args.windowId as number) : undefined;
  const isWindowCloseAction =
    param.name === TOOL_NAMES.BROWSER.WINDOW_MANAGE && param.args?.action === 'close';
  const state = getBrowserStateForClientPolicy();
  let dispatchPlan = state.planDispatch(
    {
      target: {
        clientId,
        explicitTabId,
        trimmedTabAlias,
        access: mutates ? 'mutate' : 'read',
      },
      autoSpawnPolicy: autoSpawn ? 'enabled' : 'disabled',
      urlTargeting: callerSuppliesUrl ? 'provided' : 'absent',
      explicitWindowId,
      windowTargeting: isWindowCloseAction ? 'explicitOnly' : 'useClientHint',
      tabLiveness: 'unprobed',
    },
    Date.now(),
  );
  if (dispatchPlan.kind === 'rejected') return createBrowserPolicyError(dispatchPlan.error);

  if (dispatchPlan.kind === 'needsLivenessProbe') {
    let liveness: 'live' | 'missing' = 'live';
    if (typeof chrome !== 'undefined' && chrome.tabs?.get) {
      try {
        await chrome.tabs.get(dispatchPlan.continuation.tabId);
      } catch {
        liveness = 'missing';
      }
    }
    dispatchPlan = state.resumeDispatch(dispatchPlan.continuation, liveness);
  }
  if (dispatchPlan.kind === 'rejected') return createBrowserPolicyError(dispatchPlan.error);
  if (dispatchPlan.kind !== 'ready') {
    return createErrorResponse('Browser dispatch could not resolve a target.', ToolErrorCode.UNKNOWN);
  }

  let tabId = dispatchPlan.target.forwardedTabId;
  if (dispatchPlan.target.autoSpawn) {
    tabId = await autoSpawnOwnedTab(clientId, dispatchPlan.target.autoSpawn.preferredWindowId);
  }
  const windowId = dispatchPlan.target.forwardedWindowId;

  let callerTabLockTimeoutMs: number | undefined;
  if (
    param.args &&
    typeof param.args === 'object' &&
    typeof (param.args as Record<string, unknown>).tabLockTimeoutMs === 'number'
  ) {
    const raw = (param.args as Record<string, number>).tabLockTimeoutMs;
    if (Number.isFinite(raw)) {
      const transportSafeInteger = Math.trunc(
        Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, raw)),
      );
      callerTabLockTimeoutMs = state.clampTabLockTimeout(transportSafeInteger) ?? undefined;
    }
  }

  // Surface Rust-selected targets into the unchanged tool argument shape.
  if (param.args && typeof param.args === 'object') {
    const next: Record<string, unknown> = { ...param.args };
    let mutated = false;
    if (tabId !== undefined && next.tabId !== tabId) {
      next.tabId = tabId;
      mutated = true;
    }
    if (windowId !== undefined && next.windowId !== windowId) {
      next.windowId = windowId;
      mutated = true;
    }
    if ('tabLockTimeoutMs' in next) {
      delete next.tabLockTimeoutMs;
      mutated = true;
    }
    if ('tabAlias' in next) {
      delete next.tabAlias;
      mutated = true;
    }
    if (mutated) param = { ...param, args: next };
  }

  const log = debugLog.with({ requestId, clientId, tool: param.name, tabId });
  log.info('tool call start');

  const run = async () => {
    try {
      // Bind the active request context so BaseBrowserToolExecutor.sendMessageToTab
      // can tag outbound envelopes with the same correlation id we just logged.
      // The envelope shape is unchanged for callers that don't read the field.
      const rawResult = await runWithContext<any>(
        { requestId, clientId, tool: param.name, tabId },
        () => tool.execute(param.args),
      );
      // IMP-0179: enforce dispatcher-level output budget. Per-tool truncation
      // envelopes (network-capture's `responseBodyTruncation`, userscript's
      // `maxOutputBytes`, console's `truncation`) remain authoritative — this
      // is the OUTER guard. Callers opt out with `raw: true` on the args bag.
      const toolCtor = tool.constructor as unknown as { outputBudgetBytes?: number };
      const result = enforceOutputBudget(rawResult, {
        raw: (param.args as any)?.raw === true,
        budgetBytes: toolCtor.outputBudgetBytes,
      });
      const ok = !(result && (result as { isError?: boolean }).isError === true);
      if (ok) {
        // Tools like chrome_navigate pick a tab themselves when the caller
        // omits one — read the tab back out of the response so the client's
        // ownership pointer follows the tab the tool actually used. Skip the
        // sniff when the caller already pinned a tab; tool responses can be
        // tens of KB (read-page) and JSON-parsing per call adds up.
        const sniffedTab = tabId === undefined ? extractTabIdFromResult(result) : undefined;
        const sniffedWindow =
          windowId === undefined ? extractWindowIdFromResult(result) : undefined;
        const effectiveTabId = tabId ?? sniffedTab;
        const effectiveWindowId = windowId ?? sniffedWindow;
        if (typeof effectiveTabId === 'number') {
          recordClientTab(clientId, effectiveTabId, effectiveWindowId);
        } else if (typeof effectiveWindowId === 'number') {
          recordClientWindow(clientId, effectiveWindowId);
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

  const staticTimeout = (tool.constructor as { tabLockTimeoutMs?: number }).tabLockTimeoutMs;
  const effectiveTimeoutMs =
    callerTabLockTimeoutMs ?? staticTimeout ?? state.defaultTabLockTimeout();

  let release: (() => void) | undefined;
  try {
    const acquired = await acquireTabLockWithMeta(tabId, {
      timeoutMs: effectiveTimeoutMs,
      clientId,
    });
    release = acquired.release;
    if (acquired.waitedMs > 5 || acquired.queuedAtPosition > 1) {
      log.debug('tab queue waited', {
        data: {
          waitedMs: acquired.waitedMs,
          queuedAtPosition: acquired.queuedAtPosition,
          timeoutMs: effectiveTimeoutMs,
        },
      });
    }
  } catch (err) {
    log.warn('tab queue acquire failed');
    return createErrorResponseFromThrown(err);
  }
  try {
    return await run();
  } finally {
    release();
  }
};
