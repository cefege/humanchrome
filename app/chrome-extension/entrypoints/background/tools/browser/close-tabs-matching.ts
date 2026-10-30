import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { browserMetadataPolicy, ToolErrorCode } from 'humanchrome-shared';
import { safeRemoveTabs } from '@/utils/last-tab-guard';
import { ensureRustKernel } from '@/shared/rust-kernel';
import { getTabCreatedAt } from '../../utils/tab-creation-tracker';

interface CloseTabsMatchingParams {
  urlMatches?: string;
  titleMatches?: string;
  olderThanMs?: number;
  exceptTabIds?: number[];
  windowId?: number;
  dryRun?: boolean;
}

/** Chrome query/removal adapter; Rust owns filter planning and candidate selection. */

class CloseTabsMatchingTool extends BaseBrowserToolExecutor {
  name = 'chrome_close_tabs__matching_internal';
  static readonly mutates = true;

  async execute(args: CloseTabsMatchingParams = {}): Promise<ToolResult> {
    await ensureRustKernel();
    const filters = {
      urlMatches: args.urlMatches,
      titleMatches: args.titleMatches,
      olderThanMs: args.olderThanMs,
    };
    if (
      browserMetadataPolicy.selectCloseTabIndexes(filters, [], args.exceptTabIds, 0).kind ===
      'invalid'
    ) {
      return createErrorResponse(
        'At least one of [urlMatches], [titleMatches], or [olderThanMs] is required. Refusing to close every tab without a filter.',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    let candidates: chrome.tabs.Tab[];
    try {
      const queryFilter: chrome.tabs.QueryInfo =
        typeof args.windowId === 'number' ? { windowId: args.windowId } : {};
      candidates = await chrome.tabs.query(queryFilter);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`chrome.tabs.query failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        windowId: args.windowId,
      });
    }

    const now = Date.now();
    const selection = browserMetadataPolicy.selectCloseTabIndexes(
      filters,
      candidates.map((tab) => ({
        id: typeof tab.id === 'number' ? tab.id : undefined,
        url: tab.url ?? '',
        title: tab.title ?? '',
        createdAt: typeof tab.id === 'number' ? getTabCreatedAt(tab.id) : undefined,
      })),
      args.exceptTabIds,
      now,
    );
    if (selection.kind === 'invalid') {
      return createErrorResponse(
        'At least one of [urlMatches], [titleMatches], or [olderThanMs] is required. Refusing to close every tab without a filter.',
        ToolErrorCode.INVALID_ARGS,
      );
    }
    const matched = selection.indexes.map((index) => candidates[index]!);
    const tabIdsToClose = matched.map((tab) => tab.id as number);

    if (args.dryRun === true) {
      return jsonResult({
        ok: true,
        dryRun: true,
        scanned: candidates.length,
        matched: matched.length,
        tabIds: tabIdsToClose,
      });
    }

    if (tabIdsToClose.length === 0) {
      return jsonResult({
        ok: true,
        closed: 0,
        scanned: candidates.length,
        matched: 0,
        tabIds: [],
      });
    }

    try {
      // safeRemoveTabs honors the IMP-0062 last-tab-in-window guard:
      // if the planned removals would empty a window, it opens a
      // chrome://newtab/ placeholder first so the window survives.
      await safeRemoveTabs(tabIdsToClose);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Failed to close tabs: ${msg}`, ToolErrorCode.UNKNOWN, {
        attemptedTabIds: tabIdsToClose,
      });
    }

    return jsonResult({
      ok: true,
      closed: tabIdsToClose.length,
      scanned: candidates.length,
      matched: tabIdsToClose.length,
      tabIds: tabIdsToClose,
    });
  }
}

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
    isError: false,
  };
}

export const closeTabsMatchingTool = new CloseTabsMatchingTool();
