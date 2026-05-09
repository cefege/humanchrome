import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import {
  parseISO,
  subDays,
  subWeeks,
  subMonths,
  subYears,
  startOfToday,
  startOfYesterday,
  isValid,
  format,
} from 'date-fns';

interface HistoryToolParams {
  text?: string;
  startTime?: string;
  endTime?: string;
  maxResults?: number;
  excludeCurrentTabs?: boolean;
}

interface HistoryItem {
  id: string;
  url?: string;
  title?: string;
  lastVisitTime?: number; // Timestamp in milliseconds
  visitCount?: number;
  typedCount?: number;
}

interface HistoryResult {
  items: HistoryItem[];
  totalCount: number;
  timeRange: {
    startTime: number;
    endTime: number;
    startTimeFormatted: string;
    endTimeFormatted: string;
  };
  query?: string;
}

interface HistoryDeleteToolParams {
  url?: string;
  startTime?: string;
  endTime?: string;
  all?: boolean;
  confirmDeleteAll?: boolean;
}

/**
 * Parse a date string into milliseconds since epoch.
 * Returns null if the date string is invalid.
 * Supports:
 *  - ISO date strings (e.g., "2023-10-31", "2023-10-31T14:30:00.000Z")
 *  - Relative times: "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"
 *  - Special keywords: "now", "today", "yesterday"
 */
function parseDateString(dateStr: string | undefined | null): number | null {
  if (!dateStr) {
    return null;
  }

  const now = new Date();
  const lowerDateStr = dateStr.toLowerCase().trim();

  if (lowerDateStr === 'now') return now.getTime();
  if (lowerDateStr === 'today') return startOfToday().getTime();
  if (lowerDateStr === 'yesterday') return startOfYesterday().getTime();

  const relativeMatch = lowerDateStr.match(
    /^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/,
  );
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    let resultDate: Date;
    if (unit.startsWith('day')) resultDate = subDays(now, amount);
    else if (unit.startsWith('week')) resultDate = subWeeks(now, amount);
    else if (unit.startsWith('month')) resultDate = subMonths(now, amount);
    else if (unit.startsWith('year')) resultDate = subYears(now, amount);
    else return null;
    return resultDate.getTime();
  }

  // Try parsing as ISO or other common date string formats.
  // Native Date constructor can be unreliable for non-standard formats.
  // date-fns' parseISO is good for ISO 8601.
  let parsedDate = parseISO(dateStr);
  if (isValid(parsedDate)) {
    return parsedDate.getTime();
  }

  // Fallback to new Date() for other potential formats, but with caution
  parsedDate = new Date(dateStr);
  if (isValid(parsedDate) && dateStr.includes(parsedDate.getFullYear().toString())) {
    return parsedDate.getTime();
  }

  console.warn(`Could not parse date string: ${dateStr}`);
  return null;
}

function formatDate(timestamp: number): string {
  return format(timestamp, 'yyyy-MM-dd HH:mm:ss');
}

class HistoryTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HISTORY;
  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  async execute(args: HistoryToolParams): Promise<ToolResult> {
    try {
      console.log('Executing HistoryTool with args:', args);

      const {
        text = '',
        maxResults = 100, // Default to 100 results
        excludeCurrentTabs = false,
      } = args;

      const now = Date.now();
      let startTimeMs: number;
      let endTimeMs: number;

      // Parse startTime
      if (args.startTime) {
        const parsedStart = parseDateString(args.startTime);
        if (parsedStart === null) {
          return createErrorResponse(
            `Invalid format for start time: "${args.startTime}". Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".`,
            ToolErrorCode.INVALID_ARGS,
            { arg: 'startTime' },
          );
        }
        startTimeMs = parsedStart;
      } else {
        // Default to 24 hours ago if startTime is not provided
        startTimeMs = now - HistoryTool.ONE_DAY_MS;
      }

      // Parse endTime
      if (args.endTime) {
        const parsedEnd = parseDateString(args.endTime);
        if (parsedEnd === null) {
          return createErrorResponse(
            `Invalid format for end time: "${args.endTime}". Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".`,
            ToolErrorCode.INVALID_ARGS,
            { arg: 'endTime' },
          );
        }
        endTimeMs = parsedEnd;
      } else {
        // Default to current time if endTime is not provided
        endTimeMs = now;
      }

      // Validate time range
      if (startTimeMs > endTimeMs) {
        return createErrorResponse(
          'Start time cannot be after end time.',
          ToolErrorCode.INVALID_ARGS,
        );
      }

      console.log(
        `Searching history from ${formatDate(startTimeMs)} to ${formatDate(endTimeMs)} for query "${text}"`,
      );

      const historyItems = await chrome.history.search({
        text,
        startTime: startTimeMs,
        endTime: endTimeMs,
        maxResults,
      });

      console.log(`Found ${historyItems.length} history items before filtering current tabs.`);

      let filteredItems = historyItems;
      if (excludeCurrentTabs && historyItems.length > 0) {
        const currentTabs = await chrome.tabs.query({});
        const openUrls = new Set<string>();

        currentTabs.forEach((tab) => {
          if (tab.url) {
            openUrls.add(tab.url);
          }
        });

        if (openUrls.size > 0) {
          filteredItems = historyItems.filter((item) => !(item.url && openUrls.has(item.url)));
          console.log(
            `Filtered out ${historyItems.length - filteredItems.length} items that are currently open. ${filteredItems.length} items remaining.`,
          );
        }
      }

      const result: HistoryResult = {
        items: filteredItems.map((item) => ({
          id: item.id,
          url: item.url,
          title: item.title,
          lastVisitTime: item.lastVisitTime,
          visitCount: item.visitCount,
          typedCount: item.typedCount,
        })),
        totalCount: filteredItems.length,
        timeRange: {
          startTime: startTimeMs,
          endTime: endTimeMs,
          startTimeFormatted: formatDate(startTimeMs),
          endTimeFormatted: formatDate(endTimeMs),
        },
      };

      if (text) {
        result.query = text;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in HistoryTool.execute:', error);
      return createErrorResponse(
        `Error retrieving browsing history: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

class HistoryDeleteTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HISTORY_DELETE;

  async execute(args: HistoryDeleteToolParams): Promise<ToolResult> {
    const { url, startTime, endTime, all, confirmDeleteAll } = args ?? {};
    const hasUrl = typeof url === 'string' && url.length > 0;
    const hasRangeStart = typeof startTime === 'string' && startTime.length > 0;
    const hasRangeEnd = typeof endTime === 'string' && endTime.length > 0;
    const hasRange = hasRangeStart || hasRangeEnd;
    const wantAll = all === true;

    const modeCount = (hasUrl ? 1 : 0) + (hasRange ? 1 : 0) + (wantAll ? 1 : 0);
    if (modeCount === 0) {
      return createErrorResponse(
        'Provide one of: `url`, `startTime`+`endTime`, or `all: true` (with `confirmDeleteAll: true`).',
        ToolErrorCode.INVALID_ARGS,
      );
    }
    if (modeCount > 1) {
      return createErrorResponse(
        'Choose exactly one deletion mode: `url`, time range, or `all`. Combining modes is not supported.',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    try {
      if (hasUrl) {
        await chrome.history.deleteUrl({ url: url! });
        return jsonResult({
          success: true,
          mode: 'url',
          url,
          message: `Deleted history entries for ${url}.`,
        });
      }

      if (hasRange) {
        if (!hasRangeStart || !hasRangeEnd) {
          return createErrorResponse(
            'Time-range deletion requires both `startTime` and `endTime`.',
            ToolErrorCode.INVALID_ARGS,
            { arg: hasRangeStart ? 'endTime' : 'startTime' },
          );
        }

        const startMs = parseDateString(startTime);
        if (startMs === null) {
          return createErrorResponse(
            `Invalid format for start time: "${startTime}". Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".`,
            ToolErrorCode.INVALID_ARGS,
            { arg: 'startTime' },
          );
        }
        const endMs = parseDateString(endTime);
        if (endMs === null) {
          return createErrorResponse(
            `Invalid format for end time: "${endTime}". Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".`,
            ToolErrorCode.INVALID_ARGS,
            { arg: 'endTime' },
          );
        }
        if (startMs > endMs) {
          return createErrorResponse(
            'Start time cannot be after end time.',
            ToolErrorCode.INVALID_ARGS,
          );
        }

        await chrome.history.deleteRange({ startTime: startMs, endTime: endMs });
        return jsonResult({
          success: true,
          mode: 'range',
          range: {
            startTime: startMs,
            endTime: endMs,
            startTimeFormatted: formatDate(startMs),
            endTimeFormatted: formatDate(endMs),
          },
          message: `Deleted history entries from ${formatDate(startMs)} to ${formatDate(endMs)}.`,
        });
      }

      // wantAll path
      if (!confirmDeleteAll) {
        return createErrorResponse(
          'Refusing to delete all history without `confirmDeleteAll: true`.',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'confirmDeleteAll' },
        );
      }
      await chrome.history.deleteAll();
      return jsonResult({
        success: true,
        mode: 'all',
        message: 'Deleted all browsing history.',
      });
    } catch (error) {
      console.error('Error in HistoryDeleteTool.execute:', error);
      return createErrorResponse(
        `Error deleting browsing history: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError: false,
  };
}

export const historyTool = new HistoryTool();
export const historyDeleteTool = new HistoryDeleteTool();
