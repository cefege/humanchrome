import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { parseHistoryDateString } from './history';

interface HistoryDeleteToolParams {
  url?: string;
  startTime?: string;
  endTime?: string;
  /**
   * Required to be exactly `true` to wipe the entire history. We reject any
   * other value (including `false`) when no other selector is given so a
   * dropped flag can never silently become "delete everything".
   */
  all?: boolean;
}

type DeleteScope = 'url' | 'range' | 'all';

interface HistoryDeleteResult {
  /**
   * Best-effort count of deleted entries. Chrome's `deleteUrl`/`deleteRange`/
   * `deleteAll` resolve with `void`, so:
   *   - `url`    → 1 (one URL targeted; Chrome doesn't tell us if it existed)
   *   - `range`  → -1 (unknown count, completed)
   *   - `all`    → -1 (unknown count, completed)
   */
  deleted: number;
  scope: DeleteScope;
  url?: string;
  startTime?: number;
  endTime?: number;
}

/**
 * Delete entries from Chrome browsing history.
 *
 * Mirrors the read-side `chrome_history` time-parsing grammar so callers can
 * reuse the same `startTime`/`endTime` strings they already use for search.
 * Wraps the three Chrome history-deletion APIs:
 *   - `chrome.history.deleteUrl({ url })`
 *   - `chrome.history.deleteRange({ startTime, endTime })`
 *   - `chrome.history.deleteAll()`
 *
 * Selectors are mutually exclusive: pick exactly one of `url`, range, or
 * `all: true`. `all` requires strict `true` to avoid accidental wipes when a
 * caller serializes a missing flag as `false`.
 */
class HistoryDeleteTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HISTORY_DELETE;

  async execute(args: HistoryDeleteToolParams = {}): Promise<ToolResult> {
    try {
      const { url, startTime, endTime, all } = args;

      const hasUrl = typeof url === 'string' && url.length > 0;
      const hasRange = startTime !== undefined || endTime !== undefined;
      const hasAllFlag = all !== undefined;

      // Reject `all: false` (and any non-boolean) — only strict `true` is meaningful.
      // A bare `all: false` with no other selectors is the most likely accident.
      if (hasAllFlag && all !== true) {
        return createErrorResponse(
          'The `all` flag, when provided, must be strictly `true`. Omit it or pass another selector to delete a subset.',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'all' },
        );
      }

      const allRequested = all === true;

      // Mutual exclusivity: at most one selector group at a time.
      const selectorCount = [hasUrl, hasRange, allRequested].filter(Boolean).length;
      if (selectorCount === 0) {
        return createErrorResponse(
          'Must provide one of `url`, `startTime`/`endTime`, or `all: true`.',
          ToolErrorCode.INVALID_ARGS,
        );
      }
      if (selectorCount > 1) {
        return createErrorResponse(
          'Selectors are mutually exclusive: pass exactly one of `url`, `startTime`/`endTime`, or `all: true`.',
          ToolErrorCode.INVALID_ARGS,
        );
      }

      if (hasUrl) {
        await chrome.history.deleteUrl({ url: url as string });
        const result: HistoryDeleteResult = { deleted: 1, scope: 'url', url };
        return this.ok(result);
      }

      if (hasRange) {
        // Match `chrome.history.search` defaults: missing startTime → epoch 0,
        // missing endTime → now. The Chrome API requires both fields.
        let startMs = 0;
        let endMs = Date.now();

        if (startTime !== undefined) {
          const parsed = parseHistoryDateString(startTime);
          if (parsed === null) {
            return createErrorResponse(
              `Invalid format for start time: "${startTime}". Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".`,
              ToolErrorCode.INVALID_ARGS,
              { arg: 'startTime' },
            );
          }
          startMs = parsed;
        }

        if (endTime !== undefined) {
          const parsed = parseHistoryDateString(endTime);
          if (parsed === null) {
            return createErrorResponse(
              `Invalid format for end time: "${endTime}". Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".`,
              ToolErrorCode.INVALID_ARGS,
              { arg: 'endTime' },
            );
          }
          endMs = parsed;
        }

        if (startMs > endMs) {
          return createErrorResponse(
            'Start time cannot be after end time.',
            ToolErrorCode.INVALID_ARGS,
          );
        }

        await chrome.history.deleteRange({ startTime: startMs, endTime: endMs });
        const result: HistoryDeleteResult = {
          deleted: -1,
          scope: 'range',
          startTime: startMs,
          endTime: endMs,
        };
        return this.ok(result);
      }

      // allRequested
      await chrome.history.deleteAll();
      const result: HistoryDeleteResult = { deleted: -1, scope: 'all' };
      return this.ok(result);
    } catch (error) {
      console.error('Error in HistoryDeleteTool.execute:', error);
      return createErrorResponse(
        `Error deleting browsing history: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private ok(result: HistoryDeleteResult): ToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, ...result }, null, 2),
        },
      ],
      isError: false,
    };
  }
}

export const historyDeleteTool = new HistoryDeleteTool();
