import { createErrorResponse, createErrorResponseFromThrown } from '@/common/tool-handler';
import { ToolErrorCode, TOOL_NAMES } from 'humanchrome-shared';
import { debugLog } from '../utils/debug-log';
import {
  claimTabForClient,
  clearLastWindowForClient,
  consumePacingDelay,
  recordClientTab,
  recordClientWindow,
  resolveAliasForClient,
  resolveOwnedTabIdForClient,
  resolveOwnedWindowIdForClient,
  type ResolveResult,
} from '../utils/client-state';
import { acquireTabLockWithMeta } from '../utils/tab-queue';
import { DEFAULT_TAB_LOCK_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS } from '../utils/timeouts';
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
import { claimTabTool } from './browser/claim-tab';
import { closeMyTabsTool } from './browser/close-my-tabs';
import { ownedTabsTool } from './browser/owned-tabs';
import { queueInspectTool } from './browser/queue-inspect';
import { locatorHandlerTool } from './browser/locator-handler';
import { devReloadTool } from './browser/dev-reload';
import { runtimeInfoTool } from './browser/runtime-info';
import { aliasTabTool } from './browser/alias-tab';
import { extraHttpHeadersTool } from './browser/extra-http-headers';
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
import {
  performanceStartTraceTool,
  performanceStopTraceTool,
  performanceAnalyzeInsightTool,
} from './browser/performance';
import { elementPickerTool } from './browser/element-picker';
// vector-search.ts is now a thin RPC shim — the heavy ML graph lives in
// the offscreen document, so static import is safe (no SW dynamic-import()
// ban risk).
import { vectorSearchTabsContentTool } from './browser/vector-search';

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
  claimTabTool,
  closeMyTabsTool,
  ownedTabsTool,
  queueInspectTool,
  locatorHandlerTool,
  devReloadTool,
  runtimeInfoTool,
  aliasTabTool,
  extraHttpHeadersTool,
  flowRunTool as unknown as ToolInstance,
  listPublishedFlowsTool as unknown as ToolInstance,
  flowDeleteTool as unknown as ToolInstance,
  // Promoted from lazyLoaders — bug #216 (SW import() disallowed).
  javascriptTool,
  readPageTool,
  userscriptTool,
  performanceStartTraceTool,
  performanceStopTraceTool,
  performanceAnalyzeInsightTool,
  elementPickerTool,
  vectorSearchTabsContentTool,
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
  // These tools' chunks happened to land back in background.js in current
  // builds (so the dynamic import resolves to a cached module and works).
  // Listed here for forward-compat: if Rolldown ever splits them out, they
  // become unreachable for the same reason as bug #216, and we should
  // promote them to `eagerTools` (see the eager-import block above).
  [TOOL_NAMES.BROWSER.SCREENSHOT]: async () =>
    (await import('./browser/screenshot')).screenshotTool,
  [TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START]: async () =>
    (await import('./browser/network-capture-debugger')).networkDebuggerStartTool,
  [TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP]: async () =>
    (await import('./browser/network-capture-debugger')).networkDebuggerStopTool,
  [TOOL_NAMES.BROWSER.INTERCEPT_RESPONSE]: async () =>
    (await import('./browser/intercept-response')).interceptResponseTool,
  [TOOL_NAMES.BROWSER.COMPUTER]: async () => (await import('./browser/computer')).computerTool,
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
 * Resolve target tab for this call against per-client ownership.
 *
 * Priority:
 *   1. Explicit `tabId` from caller — auto-claims if unowned, conflict if
 *      owned by another client (mutating tools only; reads are accepted).
 *   2. Client's `activeTabId` if still owned.
 *   3. Most recently added entry in `ownedTabs`.
 *   4. Returns `{}` — caller (dispatcher) decides whether to auto-spawn.
 */
function resolveTargetTab(args: any, clientId: string | undefined, isRead: boolean): ResolveResult {
  const explicit = typeof args?.tabId === 'number' ? (args.tabId as number) : undefined;
  const alias = typeof args?.tabAlias === 'string' ? args.tabAlias.trim() : '';
  // IMP-0170: `tabId` and `tabAlias` are mutually exclusive. If the caller
  // supplies both, we surface a dedicated error rather than silently
  // picking one — silent precedence would mask LLM-side bugs where the
  // caller thought they were targeting a different tab.
  if (typeof explicit === 'number' && alias.length > 0) {
    return { conflictingArgs: { tabId: explicit, alias } };
  }
  if (alias.length > 0) {
    const hit = resolveAliasForClient(clientId, alias);
    if (typeof hit.tabId === 'number') {
      // Resolved via alias → re-enter the normal owned-tab resolver so
      // ownership-conflict semantics apply (alias-on-force-claimed-tab
      // path). For the client's own tab this is a no-op; for the cross-
      // client edge case where the alias hasn't been evicted yet, the
      // standard conflict path fires.
      return resolveOwnedTabIdForClient(clientId, hit.tabId, { isRead });
    }
    return {
      aliasMiss: { alias, reason: hit.reason ?? 'unknown-alias' },
    };
  }
  return resolveOwnedTabIdForClient(clientId, explicit, { isRead });
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
async function autoSpawnOwnedTab(clientId: string | undefined): Promise<number | undefined> {
  if (!clientId) return undefined;
  if (typeof chrome === 'undefined' || !chrome.tabs?.create) return undefined;

  // Prefer the client's last-known window so multi-window sessions stay
  // coherent. Probe with chrome.windows.get first so we don't pass a dead
  // windowId to chrome.tabs.create — that would throw and lose us the
  // implicit fallback to Chrome's last-focused window.
  let preferredWindowId = resolveOwnedWindowIdForClient(clientId);
  if (preferredWindowId !== undefined && chrome.windows?.get) {
    try {
      await chrome.windows.get(preferredWindowId);
    } catch {
      clearLastWindowForClient(clientId, preferredWindowId);
      preferredWindowId = undefined;
    }
  }

  try {
    const createArgs: chrome.tabs.CreateProperties = { url: 'about:blank', active: false };
    if (preferredWindowId !== undefined) createArgs.windowId = preferredWindowId;
    const created = await chrome.tabs.create(createArgs);
    if (typeof created?.id !== 'number') return undefined;
    claimTabForClient(clientId, created.id, created.windowId);
    return created.id;
  } catch {
    return undefined;
  }
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

  // Resolve target tab against ownership BEFORE injecting into args.
  const resolved = resolveTargetTab(param.args, clientId, !mutates);
  if (resolved.conflictingArgs) {
    // IMP-0170: mutually-exclusive args.
    return createErrorResponse(
      `Cannot pass both \`tabId\` and \`tabAlias\` — choose one.`,
      ToolErrorCode.INVALID_ARGS,
      resolved.conflictingArgs,
    );
  }
  if (resolved.aliasMiss) {
    // IMP-0170: alias unknown or pointed at an evicted tab.
    return createErrorResponse(
      `No tab aliased as "${resolved.aliasMiss.alias}" for this client (${resolved.aliasMiss.reason}). Use browser_alias_tab to set it first.`,
      ToolErrorCode.TAB_NOT_FOUND,
      { alias: resolved.aliasMiss.alias, reason: resolved.aliasMiss.reason },
    );
  }
  if (resolved.conflict) {
    earlyLog.warn('tab not owned', {
      data: { tabId: resolved.conflict.tabId, owner: resolved.conflict.owner },
    });
    return createErrorResponse(
      `Tab ${resolved.conflict.tabId} is owned by client ${resolved.conflict.owner}`,
      ToolErrorCode.TAB_NOT_OWNED,
      { tabId: resolved.conflict.tabId, owner: resolved.conflict.owner },
    );
  }
  let tabId = resolved.tabId;

  // If a mutating tool has no resolved owned tab and didn't opt out of
  // auto-spawn (and the caller didn't supply a url for tools like navigate
  // that open their own tab), spawn a fresh tab for this client. This is
  // the key isolation invariant: anonymous mutating calls never land on
  // another client's tab.
  const callerSuppliesUrl = typeof param.args?.url === 'string' && param.args.url.length > 0;
  if (tabId === undefined && mutates && autoSpawn && clientId !== undefined && !callerSuppliesUrl) {
    tabId = await autoSpawnOwnedTab(clientId);
  }

  let windowId =
    typeof param.args?.windowId === 'number' ? (param.args.windowId as number) : undefined;

  // Mirror tab injection for `windowId`: if the caller omitted one, fall
  // back to the client's `lastWindowId` so multi-window sessions don't
  // scatter across whichever window Chrome happens to have focused.
  // Carve-out: `chrome_window action: 'close'` must stay explicit —
  // implicit-close-by-last-window would be too destructive.
  const isWindowCloseAction =
    param.name === TOOL_NAMES.BROWSER.WINDOW_MANAGE && param.args?.action === 'close';
  const resolvedWindowId = isWindowCloseAction
    ? windowId
    : resolveOwnedWindowIdForClient(clientId, windowId);

  // Per-call tab-lock timeout override (IMP-0087). Strip from forwarded
  // args so tools don't see the meta-arg; clamp to a sane range.
  let callerTabLockTimeoutMs: number | undefined;
  if (
    param.args &&
    typeof param.args === 'object' &&
    typeof (param.args as Record<string, unknown>).tabLockTimeoutMs === 'number'
  ) {
    const raw = (param.args as Record<string, number>).tabLockTimeoutMs;
    if (Number.isFinite(raw)) {
      callerTabLockTimeoutMs = Math.max(100, Math.min(raw, MAX_TOOL_TIMEOUT_MS));
    }
  }

  // Surface the resolved tab/window into args so the tool sees them even
  // when the caller omitted them. Tool internals stay unchanged.
  if (param.args && typeof param.args === 'object') {
    const next: Record<string, unknown> = { ...param.args };
    let mutated = false;
    if (tabId !== undefined && next.tabId !== tabId) {
      next.tabId = tabId;
      mutated = true;
    }
    if (resolvedWindowId !== undefined && next.windowId !== resolvedWindowId) {
      next.windowId = resolvedWindowId;
      mutated = true;
    }
    if ('tabLockTimeoutMs' in next) {
      delete next.tabLockTimeoutMs;
      mutated = true;
    }
    // IMP-0170: strip `tabAlias` from forwarded args. It was just a
    // dispatcher-level pointer to the tab; the tool sees the resolved
    // `tabId` instead and never needs to know about the alias.
    if ('tabAlias' in next) {
      delete next.tabAlias;
      mutated = true;
    }
    if (mutated) param = { ...param, args: next };
  }
  windowId = resolvedWindowId;

  const log = debugLog.with({ requestId, clientId, tool: param.name, tabId });
  log.info('tool call start');

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
  const effectiveTimeoutMs = callerTabLockTimeoutMs ?? staticTimeout ?? DEFAULT_TAB_LOCK_TIMEOUT_MS;

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
