import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type TabLifecycleAction = 'discard' | 'mute' | 'unmute' | 'set_auto_discardable';

interface TabLifecycleParams {
  action: TabLifecycleAction;
  tabId: number;
  autoDiscardable?: boolean;
}

function serializeTab(t: chrome.tabs.Tab): Record<string, unknown> {
  return {
    id: t.id,
    url: t.url ?? '',
    title: t.title ?? '',
    discarded: t.discarded ?? false,
    autoDiscardable: t.autoDiscardable ?? true,
    mutedInfo: t.mutedInfo
      ? { muted: t.mutedInfo.muted, reason: t.mutedInfo.reason ?? null }
      : null,
  };
}

class TabLifecycleTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TAB_LIFECYCLE;
  static readonly mutates = true;

  async execute(args: TabLifecycleParams): Promise<ToolResult> {
    const action = args?.action;
    if (
      action !== 'discard' &&
      action !== 'mute' &&
      action !== 'unmute' &&
      action !== 'set_auto_discardable'
    ) {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: discard, mute, unmute, set_auto_discardable.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof args.tabId !== 'number') {
      return createErrorResponse('Parameter [tabId] is required.', ToolErrorCode.INVALID_ARGS, {
        arg: 'tabId',
      });
    }
    if (action === 'set_auto_discardable' && typeof args.autoDiscardable !== 'boolean') {
      return createErrorResponse(
        'Parameter [autoDiscardable] is required for action="set_auto_discardable".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'autoDiscardable' },
      );
    }

    try {
      let updated: chrome.tabs.Tab | undefined;
      switch (action) {
        case 'discard':
          updated = await chrome.tabs.discard(args.tabId);
          break;
        case 'mute':
          updated = await chrome.tabs.update(args.tabId, { muted: true });
          break;
        case 'unmute':
          updated = await chrome.tabs.update(args.tabId, { muted: false });
          break;
        case 'set_auto_discardable':
          updated = await chrome.tabs.update(args.tabId, {
            autoDiscardable: args.autoDiscardable,
          });
          break;
      }

      if (!updated) {
        return createErrorResponse(
          `Tab ${args.tabId} not found or could not be updated`,
          ToolErrorCode.TAB_CLOSED,
          { tabId: args.tabId, action },
        );
      }
      return jsonOk({ ok: true, action, tab: serializeTab(updated) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab ${args.tabId} not found`, ToolErrorCode.TAB_CLOSED, {
          tabId: args.tabId,
        });
      }
      console.error('Error in TabLifecycleTool.execute:', error);
      return createErrorResponse(`chrome_tab_lifecycle failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
        tabId: args.tabId,
      });
    }
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const tabLifecycleTool = new TabLifecycleTool();
