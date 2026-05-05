/**
 * Block until a Chrome tab finishes loading.
 *
 * Why this exists
 * ---------------
 * The fan-out workflow (`chrome_navigate_batch` opens N tabs, then the agent
 * iterates through them) needs a way to block on a specific tab transitioning
 * to `status: 'complete'` before reading from it. Polling `chrome.tabs.get`
 * in a tight loop wastes ticks and reacts up to the poll interval late, so
 * this is event-driven via `chrome.tabs.onUpdated`.
 *
 * Resolves with the loaded `chrome.tabs.Tab`. Throws `ToolError(TAB_NOT_FOUND)`
 * if the tabId never existed, `ToolError(TAB_CLOSED)` if the tab is closed
 * during the wait, or `ToolError(TIMEOUT)` if the deadline elapses.
 */

import { ToolError, ToolErrorCode } from 'humanchrome-shared';

export interface WaitForTabOptions {
  /** Cap on time spent waiting for `complete`. Default 30s. */
  timeoutMs?: number;
}

export const DEFAULT_WAIT_FOR_TAB_TIMEOUT_MS = 30_000;

export function waitForTabComplete(
  tabId: number,
  opts: WaitForTabOptions = {},
): Promise<chrome.tabs.Tab> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_FOR_TAB_TIMEOUT_MS;

  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };

    const onUpdated = (
      updatedId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      updatedTab: chrome.tabs.Tab,
    ) => {
      if (updatedId !== tabId) return;
      if (changeInfo.status === 'complete') {
        cleanup();
        resolve(updatedTab);
      }
    };

    const onRemoved = (removedId: number) => {
      if (removedId !== tabId) return;
      cleanup();
      reject(
        new ToolError(
          ToolErrorCode.TAB_CLOSED,
          `Tab ${tabId} was closed before loading completed`,
          { tabId },
        ),
      );
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new ToolError(
          ToolErrorCode.TIMEOUT,
          `Tab ${tabId} did not finish loading within ${timeoutMs}ms`,
          { tabId, timeoutMs },
        ),
      );
    }, timeoutMs);

    // Arm listeners before reading current status so we don't miss a
    // `complete` event in the gap between read and attach.
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete') {
          cleanup();
          resolve(tab);
        }
      },
      () => {
        cleanup();
        reject(new ToolError(ToolErrorCode.TAB_NOT_FOUND, `Tab ${tabId} not found`, { tabId }));
      },
    );
  });
}
