import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type SessionsAction = 'get_recently_closed' | 'restore';

interface SessionsParams {
  action: SessionsAction;
  sessionId?: string;
  maxResults?: number;
}

interface SerializedTab {
  sessionId?: string;
  url: string;
  title: string;
  windowId?: number;
}

interface SerializedSession {
  lastModified: number;
  tab?: SerializedTab;
  window?: { sessionId?: string; tabs: SerializedTab[] };
}

function serializeTab(t: chrome.tabs.Tab | undefined): SerializedTab | undefined {
  if (!t) return undefined;
  return {
    sessionId: t.sessionId,
    url: t.url ?? '',
    title: t.title ?? '',
    windowId: t.windowId,
  };
}

class SessionsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SESSIONS;
  static readonly mutates = true;

  async execute(args: SessionsParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'get_recently_closed' && action !== 'restore') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: get_recently_closed, restore.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.sessions === 'undefined') {
      return createErrorResponse(
        'chrome.sessions is unavailable — the `sessions` permission is not granted.',
        ToolErrorCode.UNKNOWN,
      );
    }

    try {
      if (action === 'get_recently_closed') {
        const max = typeof args.maxResults === 'number' ? Math.min(args.maxResults, 25) : 25;
        const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: max });
        const items: SerializedSession[] = sessions.map((s) => ({
          lastModified: s.lastModified,
          tab: serializeTab(s.tab),
          window: s.window
            ? {
                sessionId: s.window.sessionId,
                tabs: (s.window.tabs ?? [])
                  .map(serializeTab)
                  .filter((x): x is SerializedTab => x !== undefined),
              }
            : undefined,
        }));
        return jsonOk({ ok: true, action, sessions: items, count: items.length });
      }

      // restore
      const restored =
        typeof args.sessionId === 'string'
          ? await chrome.sessions.restore(args.sessionId)
          : await chrome.sessions.restore();
      return jsonOk({
        ok: true,
        action: 'restore',
        sessionId: args.sessionId,
        restoredTab: serializeTab(restored.tab),
        restoredWindowId: restored.window?.id,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in SessionsTool.execute:', error);
      return createErrorResponse(`chrome_sessions failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const sessionsTool = new SessionsTool();
