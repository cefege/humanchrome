import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

interface ListFramesParams {
  tabId?: number;
  windowId?: number;
  urlContains?: string;
}

interface FrameEntry {
  frameId: number;
  parentFrameId: number;
  url: string;
  errorOccurred: boolean;
}

/**
 * Enumerate frames in a tab via chrome.webNavigation.getAllFrames.
 *
 * Backs `chrome_list_frames` (IMP-0044). The webNavigation permission
 * is already declared in wxt.config.ts (used by the navigation guards
 * in base-browser), so this tool needs no manifest change.
 */
class ListFramesTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.LIST_FRAMES;

  async execute(args: ListFramesParams = {}): Promise<ToolResult> {
    try {
      const explicitTabId = typeof args.tabId === 'number' ? args.tabId : undefined;

      let tabId: number | undefined = explicitTabId;
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

      let rawFrames: chrome.webNavigation.GetAllFrameResultDetails[] | null = null;
      try {
        rawFrames = await chrome.webNavigation.getAllFrames({ tabId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Tab gone mid-call: classify distinctly so callers can retry.
        if (/no tab with id/i.test(msg)) {
          return createErrorResponse(`Tab ${tabId} not found`, ToolErrorCode.TAB_CLOSED, {
            tabId,
          });
        }
        return createErrorResponse(
          `chrome.webNavigation.getAllFrames failed: ${msg}`,
          ToolErrorCode.UNKNOWN,
          { tabId },
        );
      }

      // chrome.webNavigation.getAllFrames returns null when the tab is
      // discarded / unloaded — treat as "no frames" rather than an error
      // so callers can retry after activating the tab without parsing
      // an error envelope.
      const items: FrameEntry[] = (rawFrames || []).map((f) => ({
        frameId: f.frameId,
        parentFrameId: f.parentFrameId,
        url: f.url || '',
        errorOccurred: !!f.errorOccurred,
      }));

      let filtered = items;
      const needle = typeof args.urlContains === 'string' ? args.urlContains.trim() : '';
      if (needle.length > 0) {
        const lower = needle.toLowerCase();
        filtered = items.filter((f) => f.url.toLowerCase().includes(lower));
      }

      // Stable order: parent frames before children, then by frameId.
      // The main frame (frameId 0, parentFrameId -1) always lands first.
      filtered.sort((a, b) => {
        if (a.parentFrameId !== b.parentFrameId) return a.parentFrameId - b.parentFrameId;
        return a.frameId - b.frameId;
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              tabId,
              frames: filtered,
              count: filtered.length,
              ...(needle.length > 0
                ? { urlContains: needle, totalBeforeFilter: items.length }
                : {}),
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in ListFramesTool.execute:', error);
      return createErrorResponse(`Error listing frames: ${msg}`);
    }
  }
}

export const listFramesTool = new ListFramesTool();
