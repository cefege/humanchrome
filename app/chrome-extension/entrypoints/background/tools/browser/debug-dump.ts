import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import {
  dumpLog,
  clearLog,
  getBufferSize,
  DEBUG_LOG_LEVELS,
  type DebugLogLevel,
} from '../../utils/debug-log';

interface DebugDumpArgs {
  requestId?: string;
  tool?: string;
  tabId?: number;
  level?: DebugLogLevel;
  sinceMs?: number;
  limit?: number;
  clear?: boolean;
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
    if (args.clear === true) {
      await clearLog();
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, cleared: true, entries: [] }) }],
        isError: false,
      };
    }

    const entries = await dumpLog({
      requestId: args.requestId,
      tool: args.tool,
      tabId: args.tabId,
      level: args.level,
      sinceMs: args.sinceMs,
      limit: args.limit,
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
          }),
        },
      ],
      isError: false,
    };
  }
}

export const debugDumpTool = new DebugDumpTool();
