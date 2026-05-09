import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import {
  dumpLog,
  clearLog,
  getBufferSize,
  DEBUG_LOG_LEVELS,
  type DebugLogLevel,
  setPersistEnabled,
  getPersistEnabled,
} from '../../utils/debug-log';

interface DebugDumpArgs {
  requestId?: string;
  clientId?: string;
  tool?: string;
  tabId?: number;
  level?: DebugLogLevel;
  sinceMs?: number;
  limit?: number;
  /** Pagination offset, applied newest-first. Defaults to 0. */
  offset?: number;
  /** When true, return chronological order (oldest first). Default newest first. */
  chronological?: boolean;
  clear?: boolean;
  /**
   * Toggle whether log entries persist to chrome.storage.local across
   * SW restarts (IMP-0059). Off by default to avoid the steady-state
   * SW-CPU cost during automation runs. `true` enables persistence
   * before the dump (so subsequent runs survive SW restart); `false`
   * disables it and clears the persisted blob; omitted leaves the
   * current state unchanged.
   */
  persist?: boolean;
}

class DebugDumpTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DEBUG_DUMP;

  async execute(args: DebugDumpArgs = {}): Promise<ToolResult> {
    if (args.level && !(DEBUG_LOG_LEVELS as readonly string[]).includes(args.level)) {
      return createErrorResponse(
        `Invalid level "${args.level}". Must be one of: ${DEBUG_LOG_LEVELS.join(', ')}`,
        ToolErrorCode.INVALID_ARGS,
      );
    }
    if (typeof args.persist === 'boolean') {
      await setPersistEnabled(args.persist);
    }

    if (args.clear === true) {
      await clearLog();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              cleared: true,
              entries: [],
              persistEnabled: getPersistEnabled(),
            }),
          },
        ],
        isError: false,
      };
    }

    const entries = await dumpLog({
      requestId: args.requestId,
      clientId: args.clientId,
      tool: args.tool,
      tabId: args.tabId,
      level: args.level,
      sinceMs: args.sinceMs,
      limit: args.limit,
      offset: args.offset,
      // Default newest-first; respect explicit chronological=true.
      newestFirst: args.chronological !== true,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            entries,
            returned: entries.length,
            bufferSize: getBufferSize(),
            offset: args.offset ?? 0,
            limit: args.limit ?? 200,
            persistEnabled: getPersistEnabled(),
          }),
        },
      ],
      isError: false,
    };
  }
}

export const debugDumpTool = new DebugDumpTool();
