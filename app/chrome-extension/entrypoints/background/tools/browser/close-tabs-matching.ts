import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { safeRemoveTabs } from '@/utils/last-tab-guard';
import { getTabCreatedAt } from '../../utils/tab-creation-tracker';

interface CloseTabsMatchingParams {
  urlMatches?: string;
  titleMatches?: string;
  olderThanMs?: number;
  exceptTabIds?: number[];
  windowId?: number;
  dryRun?: boolean;
}

/**
 * Compile a user-supplied filter string into a predicate. Accepts:
 *   - `/pattern/flags` — interpreted as RegExp (flags optional).
 *   - everything else — case-insensitive substring match.
 *
 * A malformed `/regex/` (bad pattern or bad flag) falls back to substring
 * match against the raw string. We don't surface the regex error to the
 * caller because the substring fallback is almost always what they meant
 * — but we DO log so a curious dev can dig in.
 */
function compileMatcher(raw: string | undefined): ((value: string) => boolean) | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // /pattern/flags form
  if (trimmed.startsWith('/') && trimmed.length > 1) {
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash > 0) {
      const pattern = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      try {
        const re = new RegExp(pattern, flags);
        return (value: string) => re.test(value);
      } catch (e) {
        console.warn(
          `chrome_close_tabs_matching: invalid regex "${trimmed}" (${(e as Error).message}); falling back to substring match against the inner pattern`,
        );
        // Fallback: caller meant the inner pattern as a substring.
        // Stripping the /.../ wrapper here matches user intent better
        // than treating the literal `/pattern/` as a substring (which
        // would make the fallback match almost nothing).
        const needle = pattern.toLowerCase();
        return (value: string) => value.toLowerCase().includes(needle);
      }
    }
  }

  const needle = trimmed.toLowerCase();
  return (value: string) => value.toLowerCase().includes(needle);
}

class CloseTabsMatchingTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLOSE_TABS_MATCHING;
  static readonly mutates = true;

  async execute(args: CloseTabsMatchingParams = {}): Promise<ToolResult> {
    const urlPredicate = compileMatcher(args.urlMatches);
    const titlePredicate = compileMatcher(args.titleMatches);
    const olderThanMs =
      typeof args.olderThanMs === 'number' &&
      Number.isFinite(args.olderThanMs) &&
      args.olderThanMs >= 0
        ? args.olderThanMs
        : null;

    if (!urlPredicate && !titlePredicate && olderThanMs === null) {
      return createErrorResponse(
        'At least one of [urlMatches], [titleMatches], or [olderThanMs] is required. Refusing to close every tab without a filter.',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    const exceptSet = new Set<number>(
      Array.isArray(args.exceptTabIds)
        ? args.exceptTabIds.filter((n) => typeof n === 'number')
        : [],
    );

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
    const matched: chrome.tabs.Tab[] = [];
    for (const tab of candidates) {
      if (typeof tab.id !== 'number') continue;
      if (exceptSet.has(tab.id)) continue;

      // Each filter that's set must pass. Filters left unset don't gate.
      // url + title fall back to '' if Chrome omitted them so the matcher
      // can decide consistently (substring '' always matches; regex /a/
      // applied to '' decides on its own).
      if (urlPredicate && !urlPredicate(tab.url ?? '')) continue;
      if (titlePredicate && !titlePredicate(tab.title ?? '')) continue;
      if (olderThanMs !== null) {
        const createdAt = getTabCreatedAt(tab.id);
        if (typeof createdAt !== 'number') continue; // unknown → don't match
        if (now - createdAt < olderThanMs) continue;
      }

      matched.push(tab);
    }

    const tabIdsToClose = matched.map((t) => t.id as number);

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
