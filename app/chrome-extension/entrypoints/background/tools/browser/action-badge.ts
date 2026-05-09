import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type ActionBadgeAction = 'set' | 'clear';

interface ActionBadgeParams {
  action: ActionBadgeAction;
  text?: string;
  color?: string;
  tabId?: number;
}

const HEX_RE = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

function hexToRgba(hex: string): [number, number, number, number] {
  const stripped = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(stripped.slice(0, 2), 16);
  const g = parseInt(stripped.slice(2, 4), 16);
  const b = parseInt(stripped.slice(4, 6), 16);
  const a = stripped.length === 8 ? parseInt(stripped.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

class ActionBadgeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.ACTION_BADGE;
  static readonly mutates = true;

  async execute(args: ActionBadgeParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'set' && action !== 'clear') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: set, clear.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.action === 'undefined') {
      return createErrorResponse('chrome.action is unavailable.', ToolErrorCode.UNKNOWN);
    }

    try {
      if (action === 'clear') {
        const detail: chrome.action.BadgeTextDetails = { text: '' };
        if (typeof args.tabId === 'number') detail.tabId = args.tabId;
        await chrome.action.setBadgeText(detail);
        return jsonOk({ ok: true, action: 'clear', tabId: args.tabId ?? null });
      }

      // set
      if (typeof args.text !== 'string') {
        return createErrorResponse(
          'Parameter [text] is required for action="set".',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'text' },
        );
      }
      const textDetail: chrome.action.BadgeTextDetails = { text: args.text };
      if (typeof args.tabId === 'number') textDetail.tabId = args.tabId;
      await chrome.action.setBadgeText(textDetail);

      if (typeof args.color === 'string' && args.color.length > 0) {
        if (!HEX_RE.test(args.color)) {
          return createErrorResponse(
            'Parameter [color] must be a hex string like "#RRGGBB" or "#RRGGBBAA".',
            ToolErrorCode.INVALID_ARGS,
            { arg: 'color', got: args.color },
          );
        }
        const colorDetail: chrome.action.BadgeColorDetails = { color: hexToRgba(args.color) };
        if (typeof args.tabId === 'number') colorDetail.tabId = args.tabId;
        await chrome.action.setBadgeBackgroundColor(colorDetail);
      }

      return jsonOk({
        ok: true,
        action: 'set',
        text: args.text,
        color: args.color ?? null,
        tabId: args.tabId ?? null,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in ActionBadgeTool.execute:', error);
      return createErrorResponse(`chrome_action_badge failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const actionBadgeTool = new ActionBadgeTool();
