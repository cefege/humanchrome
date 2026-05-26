import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode, invalidArgsEnumDetails } from 'humanchrome-shared';

const CLIPBOARD_ACTIONS = ['read', 'write'] as const;
import { offscreenManager } from '@/utils/offscreen-manager';
import { MessageTarget } from '@/common/message-types';

type ClipboardAction = 'read' | 'write';

interface ClipboardParams {
  action: ClipboardAction;
  text?: string;
}

interface OffscreenResponse {
  success: boolean;
  result?: string;
  error?: string;
}

class ClipboardTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLIPBOARD;
  static readonly mutates = true;
  static readonly autoSpawnTab = false;

  async execute(args: ClipboardParams): Promise<ToolResult> {
    const action = args?.action;
    if (!CLIPBOARD_ACTIONS.includes(action as (typeof CLIPBOARD_ACTIONS)[number])) {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: read, write.',
        ToolErrorCode.INVALID_ARGS,
        invalidArgsEnumDetails('action', action, CLIPBOARD_ACTIONS),
      );
    }
    if (action === 'write' && typeof args.text !== 'string') {
      return createErrorResponse(
        'Parameter [text] is required for action="write".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'text' },
      );
    }

    try {
      await offscreenManager.ensureOffscreenDocument();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(
        `Failed to initialize offscreen document: ${msg}`,
        ToolErrorCode.UNKNOWN,
      );
    }

    const message =
      action === 'read'
        ? { target: MessageTarget.Offscreen, type: 'clipboard.read' }
        : {
            target: MessageTarget.Offscreen,
            type: 'clipboard.write',
            text: args.text as string,
          };

    let response: OffscreenResponse;
    try {
      response = (await chrome.runtime.sendMessage(message)) as OffscreenResponse;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Offscreen clipboard call failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }

    if (!response || response.success !== true) {
      return createErrorResponse(
        response?.error ?? 'Offscreen clipboard call returned no response',
        ToolErrorCode.UNKNOWN,
        { action },
      );
    }

    if (action === 'read') {
      return jsonOk({ ok: true, action: 'read', text: response.result ?? '' });
    }
    return jsonOk({ ok: true, action: 'write', written: true });
  }
}

export const clipboardTool = new ClipboardTool();
