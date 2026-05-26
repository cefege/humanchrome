import { ToolExecutor } from '@/common/tool-handler';
import type { ToolResult } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { ToolError, ToolErrorCode } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../utils/request-context';
import { resolveOwnedTabIdForClient } from '../utils/client-state';
import { debugLog } from '../utils/debug-log';

const PING_TIMEOUT_MS = 300;
// executeScript resolves before the script's listener registers — a short
// retry loop bridges the gap. Shared by both `injectContentScript`'s
// post-inject wait and `assertHelperPresent`'s companion-helper check.
const POST_INJECT_RETRIES = 5;
const POST_INJECT_DELAY_MS = 60;

/**
 * Base class for browser tool executors
 */
export abstract class BaseBrowserToolExecutor implements ToolExecutor {
  abstract name: string;
  /**
   * When true, the dispatcher serializes calls to this tool against other
   * mutating tool calls targeting the same tab. Reads stay parallel. Default
   * is false — opt in on subclasses that mutate tab state (click, fill, JS,
   * keyboard, navigate, computer, upload).
   */
  static readonly mutates: boolean = false;
  /**
   * When true (default), the dispatcher auto-spawns a fresh tab and claims
   * it for the calling client if no explicit `tabId` was passed and the
   * client has no usable owned tab. Set to `false` on tools that don't
   * need a tab (`pace`, `pace_get`) or that operate across all windows
   * (`get_windows_and_tabs`). Only effective when `mutates` is also true.
   */
  static readonly autoSpawnTab: boolean = true;
  /**
   * Per-call cap on time spent waiting for the per-tab queue. `undefined`
   * means "use `DEFAULT_TAB_LOCK_TIMEOUT_MS`." The dispatcher's resolution
   * order is: caller `args.tabLockTimeoutMs` (clamped to
   * `[100, MAX_TOOL_TIMEOUT_MS]`) → this static → default. Override on
   * tools that legitimately occupy the tab for a long time (performance
   * traces, downloads, GIF recording, intercept-response) so callers
   * stacked behind them don't surface spurious `TAB_LOCK_TIMEOUT`.
   */
  static readonly tabLockTimeoutMs: number | undefined = undefined;
  /**
   * IMP-0179: per-tool output cap enforced by the dispatcher. Defaults to the
   * shared `DEFAULT_OUTPUT_BUDGET_BYTES` (25 KiB) when unset. Override on
   * tools that legitimately return larger payloads (read_page, get_web_content,
   * network-capture stop with bodies) so the cap doesn't truncate normal usage.
   * Callers can also pass `raw: true` to bypass for any single call.
   */
  static readonly outputBudgetBytes: number | undefined = undefined;
  abstract execute(args: any): Promise<ToolResult>;

  /**
   * Send a ping message to the content script and resolve true on `pong`.
   * Single attempt with a fixed timeout — callers loop for retry behavior.
   */
  private async pingOnce(tabId: number, frameId: number | undefined): Promise<boolean> {
    return this.pingAction(tabId, `${this.name}_ping`, frameId);
  }

  /**
   * Generic ping helper. Sends `{action: <pingAction>}` to the tab and
   * resolves true on `{status: 'pong'}`. Use to confirm a specific helper
   * (identified by its ping action name, e.g. `actionability_ping`) is
   * present in the page — distinct from the tool-name ping pattern used
   * by `pingOnce`.
   */
  private async pingAction(
    tabId: number,
    pingAction: string,
    frameId: number | undefined,
  ): Promise<boolean> {
    try {
      const response = (await Promise.race([
        typeof frameId === 'number'
          ? chrome.tabs.sendMessage(tabId, { action: pingAction }, { frameId })
          : chrome.tabs.sendMessage(tabId, { action: pingAction }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS),
        ),
      ])) as { status?: string } | undefined;
      return !!response && response.status === 'pong';
    } catch {
      return false;
    }
  }

  /**
   * IMP-0137: post-injection contract check. Confirms a helper exposed
   * its `<helper>_ping` handler in the page after `injectContentScript`
   * ran (or after the optimistic ping-skip path). Distinct from
   * `pingOnce` because the latter only probes for the calling tool's
   * own helper (`${this.name}_ping`) — this method checks an arbitrary
   * companion helper that the tool depends on (most importantly
   * `actionability_ping` from `actionability.js`).
   *
   * Called explicitly by tools whose contract depends on companion
   * helpers being present (`ClickTool`, `FillTool` → actionability.js).
   * On failure, throws `INJECTION_FAILED` with a message naming the
   * missing helper so build-misconfiguration regressions surface at the
   * contract boundary rather than silently degrading to
   * `actionability_unavailable` failures on every action.
   *
   * Multiple ping retries cover the same Chrome scripting timing
   * window that `injectContentScript` already handles for the primary
   * helper (executeScript resolves before the listener registers).
   */
  protected async assertHelperPresent(
    tabId: number,
    pingAction: string,
    helperLabel: string,
    frameId?: number,
  ): Promise<void> {
    if (await this.waitForPing(tabId, pingAction, frameId)) return;
    debugLog.error('required companion helper missing after injection', {
      tabId,
      data: { pingAction, helperLabel },
    });
    throw new ToolError(
      ToolErrorCode.INJECTION_FAILED,
      `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Required helper "${helperLabel}" did not respond to ${pingAction} in tab ${tabId}. ` +
        `The companion inject-script may have failed to load (check build output / CSP). ` +
        `Without it, pre-action checks cannot run.`,
      { tabId, pingAction, helperLabel },
    );
  }

  /**
   * Ping `pingAction` up to POST_INJECT_RETRIES times (with POST_INJECT_DELAY_MS
   * between attempts) and resolve true on the first pong. Shared between the
   * post-inject self-check in `injectContentScript` and the companion-helper
   * check in `assertHelperPresent`.
   */
  private async waitForPing(
    tabId: number,
    pingAction: string,
    frameId: number | undefined,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < POST_INJECT_RETRIES; attempt++) {
      if (await this.pingAction(tabId, pingAction, frameId)) return true;
      if (attempt < POST_INJECT_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, POST_INJECT_DELAY_MS));
      }
    }
    return false;
  }

  /**
   * Inject content script into tab
   */
  protected async injectContentScript(
    tabId: number,
    files: string[],
    injectImmediately = false,
    world: 'MAIN' | 'ISOLATED' = 'ISOLATED',
    allFrames: boolean = false,
    frameIds?: number[],
  ): Promise<void> {
    const pingFrameId = frameIds?.[0];
    if (await this.pingOnce(tabId, pingFrameId)) return;

    try {
      const target: { tabId: number; allFrames?: boolean; frameIds?: number[] } = { tabId };
      if (frameIds && frameIds.length > 0) {
        target.frameIds = frameIds;
      } else if (allFrames) {
        target.allFrames = true;
      }
      await chrome.scripting.executeScript({
        target,
        files,
        injectImmediately,
        world,
      });

      // executeScript resolves when the script is injected, but Chrome may
      // dispatch our follow-up sendMessage before the script's listener
      // finishes registering — surfaces as "Receiving end does not exist".
      // Confirm responsiveness with short retries so callers can rely on
      // "after injectContentScript, sendMessageToTab works."
      if (await this.waitForPing(tabId, `${this.name}_ping`, pingFrameId)) return;
      debugLog.warn('post-inject ping never returned pong; proceeding anyway', {
        tabId,
        data: { files },
      });
    } catch (injectionError) {
      const errorMessage =
        injectionError instanceof Error ? injectionError.message : String(injectionError);
      debugLog.error('content script injection failed', {
        tabId,
        data: { files, err: errorMessage },
      });
      // Tabs closed mid-call surface as "No tab with id" — classify distinctly so
      // callers can retry against a different target rather than treat it as a CSP issue.
      const code = /no tab with id/i.test(errorMessage)
        ? ToolErrorCode.TAB_CLOSED
        : ToolErrorCode.INJECTION_FAILED;
      throw new ToolError(
        code,
        `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Failed to inject content script in tab ${tabId}: ${errorMessage}`,
        { tabId, files, cause: errorMessage },
      );
    }
  }

  /**
   * Send message to tab.
   *
   * Tags the outbound envelope with `_humanchromeRequestId` (when there is an
   * active request context) so inject-scripts can echo the same id back into
   * the structured logger for end-to-end tracing. Existing callers don't read
   * the field, so this is shape-compatible.
   */
  protected async sendMessageToTab(tabId: number, message: any, frameId?: number): Promise<any> {
    const ctx = getCurrentRequestContext();
    const tagged =
      ctx?.requestId && message && typeof message === 'object'
        ? { ...message, _humanchromeRequestId: ctx.requestId }
        : message;
    try {
      const response =
        typeof frameId === 'number'
          ? await chrome.tabs.sendMessage(tabId, tagged, { frameId })
          : await chrome.tabs.sendMessage(tabId, tagged);

      if (response && response.error) {
        // IMP-0097: structured actionability failures travel as
        // `{error, notActionable: true, failures: [...]}` so the calling
        // tool can map them to `NOT_ACTIONABLE` with details. Don't throw
        // — return the envelope as-is and let the caller branch.
        if (response.notActionable === true) {
          return response;
        }
        throw new Error(String(response.error));
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      debugLog.warn('sendMessageToTab failed', {
        tabId,
        requestId: ctx?.requestId,
        clientId: ctx?.clientId,
        tool: ctx?.tool,
        data: { action: message?.action || 'unknown', err: errorMessage },
      });

      if (error instanceof ToolError) throw error;
      // bfcache: page navigated away (often via SPA back/forward) and the
      // content-script port was closed when Chrome cached the document.
      // From the LLM's perspective the targeted document is gone — same
      // recovery path as a real navigation.
      if (/back\/forward cache|moved into back\/forward/i.test(errorMessage)) {
        throw new ToolError(ToolErrorCode.TARGET_NAVIGATED_AWAY, errorMessage, {
          tabId,
          action: message?.action,
        });
      }
      // "receiving end does not exist" / "no tab with id" → tab is gone or content
      // script never attached; either way, the right signal is TAB_CLOSED.
      if (/no tab with id|receiving end does not exist/i.test(errorMessage)) {
        throw new ToolError(ToolErrorCode.TAB_CLOSED, errorMessage, {
          tabId,
          action: message?.action,
        });
      }
      throw new ToolError(ToolErrorCode.UNKNOWN, errorMessage, {
        tabId,
        action: message?.action,
      });
    }
  }

  /**
   * Try to get an existing tab by id. Returns null when not found.
   */
  protected async tryGetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId !== 'number') return null;
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  /**
   * Optionally focus window and/or activate tab. Defaults preserve current behavior
   * when caller sets activate/focus flags explicitly.
   */
  protected async ensureFocus(
    tab: chrome.tabs.Tab,
    options: { activate?: boolean; focusWindow?: boolean } = {},
  ): Promise<void> {
    const activate = options.activate === true;
    const focusWindow = options.focusWindow === true;
    if (focusWindow && typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    if (activate && typeof tab.id === 'number') {
      await chrome.tabs.update(tab.id, { active: true });
    }
  }

  /**
   * Resolve the tab this tool should operate on, honoring the caller's
   * per-client ownership (IMP-0086) — mirror image of the dispatcher's
   * resolution priority. Prefer this over `getActiveTabOrThrow*` in any
   * tool migrated for the multi-tab-by-design rollout: it never falls
   * back to the globally-active tab, so two clients can't accidentally
   * step on each other.
   *
   * Resolution priority (delegates to `resolveOwnedTabIdForClient`):
   *   1. `opts.explicit` if a finite number — ownership-checked unless
   *      `opts.isRead`.
   *   2. The caller's `activeTabId` if still owned.
   *   3. The most-recently-inserted entry in the caller's owned set.
   *   4. If `opts.required !== false`: throws `TAB_NOT_FOUND` with
   *      `details.reason ∈ {'no-owned-tab','closed','window-mismatch'}`.
   *      If `opts.required === false`: returns `null`.
   *
   * `opts.windowId` filters AFTER the owned-set pick — we never run
   * `chrome.tabs.query({windowId, active:true})`, which would re-introduce
   * the implicit-global-tab path this helper exists to replace.
   */
  protected async getOwnedTab(opts?: {
    explicit?: number;
    isRead?: boolean;
    windowId?: number;
    required?: true;
  }): Promise<chrome.tabs.Tab>;
  protected async getOwnedTab(opts: {
    explicit?: number;
    isRead?: boolean;
    windowId?: number;
    required: false;
  }): Promise<chrome.tabs.Tab | null>;
  protected async getOwnedTab(
    opts: {
      explicit?: number;
      isRead?: boolean;
      windowId?: number;
      required?: boolean;
    } = {},
  ): Promise<chrome.tabs.Tab | null> {
    const required = opts.required !== false;
    const clientId = getCurrentRequestContext()?.clientId;
    const resolved = resolveOwnedTabIdForClient(clientId, opts.explicit, { isRead: opts.isRead });
    if (resolved.conflict) {
      throw new ToolError(
        ToolErrorCode.TAB_NOT_OWNED,
        `Tab ${resolved.conflict.tabId} is owned by client ${resolved.conflict.owner}`,
        { tabId: resolved.conflict.tabId, owner: resolved.conflict.owner },
      );
    }
    if (resolved.tabId === undefined) {
      if (required) {
        throw new ToolError(ToolErrorCode.TAB_NOT_FOUND, 'No owned tab for this client', {
          reason: 'no-owned-tab',
          clientId,
        });
      }
      return null;
    }
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(resolved.tabId);
    } catch {
      if (required) {
        throw new ToolError(
          ToolErrorCode.TAB_NOT_FOUND,
          `Owned tab ${resolved.tabId} no longer exists`,
          { tabId: resolved.tabId, reason: 'closed' },
        );
      }
      return null;
    }
    if (typeof opts.windowId === 'number' && tab.windowId !== opts.windowId) {
      if (required) {
        throw new ToolError(
          ToolErrorCode.TAB_NOT_FOUND,
          `Owned tab ${resolved.tabId} is not in window ${opts.windowId}`,
          { tabId: resolved.tabId, windowId: opts.windowId, reason: 'window-mismatch' },
        );
      }
      return null;
    }
    return tab;
  }

  /**
   * Read the main-frame `{url, documentId}` in one IPC. Returns undefined
   * when webNavigation isn't available (permission missing, test context),
   * so callers can fall back to chrome.tabs.get.
   */
  private async getMainFrameInfo(
    tabId: number,
  ): Promise<{ url?: string; documentId?: string } | undefined> {
    try {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      if (!frame) return undefined;
      return { url: frame.url, documentId: frame.documentId };
    } catch {
      return undefined;
    }
  }

  /**
   * Capture the document identity for a tab so we can detect mid-call
   * navigation later. URL alone is fragile for SPAs; documentId from
   * webNavigation.getFrame is stable per loaded document and changes
   * on hard navigation.
   */
  protected async snapshotTabState(tabId: number): Promise<TabSnapshot> {
    const frame = await this.getMainFrameInfo(tabId);
    if (frame?.url) {
      return { tabId, url: frame.url, documentId: frame.documentId, takenAt: Date.now() };
    }
    // Fall back to chrome.tabs.get only when webNavigation didn't answer —
    // saves one IPC on the common path.
    const tab = await this.tryGetTab(tabId);
    if (!tab) {
      throw new ToolError(ToolErrorCode.TAB_CLOSED, `Tab ${tabId} not found`, { tabId });
    }
    return { tabId, url: tab.url ?? '', documentId: undefined, takenAt: Date.now() };
  }

  /**
   * Verify the tab is still on the same document as when `snapshot` was
   * taken. Throws TARGET_NAVIGATED_AWAY otherwise. `ignoreHashOnly`
   * (default true) treats in-page anchor changes as non-navigation.
   */
  protected async assertSameDocument(
    snapshot: TabSnapshot,
    opts: { ignoreHashOnly?: boolean } = {},
  ): Promise<void> {
    const ignoreHashOnly = opts.ignoreHashOnly !== false;

    const frame = await this.getMainFrameInfo(snapshot.tabId);
    let currentUrl = frame?.url;
    const currentDocId = frame?.documentId;
    if (!frame) {
      const tab = await this.tryGetTab(snapshot.tabId);
      if (!tab) {
        throw new ToolError(ToolErrorCode.TAB_CLOSED, `Tab ${snapshot.tabId} closed during call`, {
          tabId: snapshot.tabId,
        });
      }
      currentUrl = tab.url ?? '';
    }

    const haveBothDocIds = !!(snapshot.documentId && currentDocId);
    const docChanged = haveBothDocIds && currentDocId !== snapshot.documentId;
    const before = ignoreHashOnly ? stripHash(snapshot.url) : snapshot.url;
    const after = ignoreHashOnly ? stripHash(currentUrl ?? '') : (currentUrl ?? '');
    const urlChanged = !haveBothDocIds && !!before && !!after && before !== after;

    if (!docChanged && !urlChanged) return;

    throw new ToolError(
      ToolErrorCode.TARGET_NAVIGATED_AWAY,
      `Tab ${snapshot.tabId} navigated mid-call`,
      {
        tabId: snapshot.tabId,
        fromUrl: snapshot.url,
        toUrl: currentUrl ?? '',
        ...(docChanged ? { fromDocumentId: snapshot.documentId, toDocumentId: currentDocId } : {}),
      },
    );
  }

  /**
   * Snapshot before, run action, assert document unchanged after.
   * Use for tools whose contract assumes the page does not navigate
   * (e.g. ref-based clicks where the snapshot's refs identify the
   * current document).
   */
  protected async withNavigationGuard<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const snap = await this.snapshotTabState(tabId);
    const result = await fn();
    await this.assertSameDocument(snap);
    return result;
  }
}

export interface TabSnapshot {
  tabId: number;
  url: string;
  documentId?: string;
  takenAt: number;
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}
