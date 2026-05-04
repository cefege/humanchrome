import { ToolExecutor } from '@/common/tool-handler';
import type { ToolResult } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { ToolError, ToolErrorCode } from 'humanchrome-shared';

const PING_TIMEOUT_MS = 300;

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
  abstract execute(args: any): Promise<ToolResult>;

  /**
   * Send a ping message to the content script and resolve true on `pong`.
   * Single attempt with a fixed timeout — callers loop for retry behavior.
   */
  private async pingOnce(tabId: number, frameId: number | undefined): Promise<boolean> {
    try {
      const response = await Promise.race([
        typeof frameId === 'number'
          ? chrome.tabs.sendMessage(tabId, { action: `${this.name}_ping` }, { frameId })
          : chrome.tabs.sendMessage(tabId, { action: `${this.name}_ping` }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS),
        ),
      ]);
      return !!response && (response as any).status === 'pong';
    } catch {
      return false;
    }
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
      } as any);

      // executeScript resolves when the script is injected, but Chrome may
      // dispatch our follow-up sendMessage before the script's listener
      // finishes registering — surfaces as "Receiving end does not exist".
      // Confirm responsiveness with short retries so callers can rely on
      // "after injectContentScript, sendMessageToTab works."
      const POST_INJECT_RETRIES = 5;
      const POST_INJECT_DELAY_MS = 60;
      for (let attempt = 0; attempt < POST_INJECT_RETRIES; attempt++) {
        if (await this.pingOnce(tabId, pingFrameId)) return;
        await new Promise((r) => setTimeout(r, POST_INJECT_DELAY_MS));
      }
      console.warn(
        `Post-inject ping never returned pong for tab ${tabId} (${files.join(',')}); proceeding anyway`,
      );
    } catch (injectionError) {
      const errorMessage =
        injectionError instanceof Error ? injectionError.message : String(injectionError);
      console.error(
        `Content script '${files.join(', ')}' injection failed for tab ${tabId}: ${errorMessage}`,
      );
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
   * Send message to tab
   */
  protected async sendMessageToTab(tabId: number, message: any, frameId?: number): Promise<any> {
    try {
      const response =
        typeof frameId === 'number'
          ? await chrome.tabs.sendMessage(tabId, message, { frameId })
          : await chrome.tabs.sendMessage(tabId, message);

      if (response && response.error) {
        throw new Error(String(response.error));
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `Error sending message to tab ${tabId} for action ${message?.action || 'unknown'}: ${errorMessage}`,
      );

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
   * Get the active tab in the current window. Throws when not found.
   */
  protected async getActiveTabOrThrow(): Promise<chrome.tabs.Tab> {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active || !active.id) {
      throw new ToolError(ToolErrorCode.TAB_NOT_FOUND, 'Active tab not found');
    }
    return active;
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
   * Get the active tab. When windowId provided, search within that window; otherwise currentWindow.
   */
  protected async getActiveTabInWindow(windowId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof windowId === 'number') {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      return tabs && tabs[0] ? tabs[0] : null;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  /**
   * Same as getActiveTabInWindow, but throws if not found.
   */
  protected async getActiveTabOrThrowInWindow(windowId?: number): Promise<chrome.tabs.Tab> {
    const tab = await this.getActiveTabInWindow(windowId);
    if (!tab || !tab.id) {
      throw new ToolError(ToolErrorCode.TAB_NOT_FOUND, 'Active tab not found', { windowId });
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
      return { url: frame.url, documentId: (frame as any)?.documentId };
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
