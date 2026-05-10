import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type KeepAwakeAction = 'enable' | 'disable';
type KeepAwakeLevel = 'display' | 'system';

interface KeepAwakeParams {
  action: KeepAwakeAction;
  level?: KeepAwakeLevel;
}

class KeepAwakeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.KEEP_AWAKE;
  static readonly mutates = true;

  async execute(args: KeepAwakeParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'enable' && action !== 'disable') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: enable, disable.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.power === 'undefined') {
      return createErrorResponse(
        'chrome.power is unavailable — the `power` permission is not granted.',
        ToolErrorCode.UNKNOWN,
      );
    }

    try {
      if (action === 'enable') {
        if (args.level !== 'display' && args.level !== 'system') {
          return createErrorResponse(
            'Parameter [level] must be "display" or "system" for action="enable".',
            ToolErrorCode.INVALID_ARGS,
            { arg: 'level' },
          );
        }
        chrome.power.requestKeepAwake(args.level);
        return jsonOk({ ok: true, action: 'enable', level: args.level });
      }
      chrome.power.releaseKeepAwake();
      return jsonOk({ ok: true, action: 'disable' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in KeepAwakeTool.execute:', error);
      return createErrorResponse(`chrome_keep_awake failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }
}

export const keepAwakeTool = new KeepAwakeTool();
