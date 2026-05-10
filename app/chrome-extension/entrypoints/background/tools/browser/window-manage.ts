import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type WindowAction = 'create' | 'focus' | 'update' | 'close';
type WindowType = 'normal' | 'popup' | 'panel';
type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

interface WindowParams {
  action: WindowAction;
  windowId?: number;
  url?: string;
  type?: WindowType;
  incognito?: boolean;
  focused?: boolean;
  state?: WindowState;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

function serializeWindow(w: chrome.windows.Window): Record<string, unknown> {
  return {
    id: w.id ?? null,
    type: w.type ?? null,
    state: w.state ?? null,
    focused: w.focused ?? null,
    incognito: w.incognito ?? null,
    top: w.top ?? null,
    left: w.left ?? null,
    width: w.width ?? null,
    height: w.height ?? null,
    tabsCount: Array.isArray(w.tabs) ? w.tabs.length : 0,
  };
}

class WindowManageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WINDOW_MANAGE;
  static readonly mutates = true;

  async execute(args: WindowParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'create' && action !== 'focus' && action !== 'update' && action !== 'close') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: create, focus, update, close.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.windows === 'undefined') {
      return createErrorResponse('chrome.windows is unavailable.', ToolErrorCode.UNKNOWN);
    }

    try {
      switch (action) {
        case 'create':
          return await this.actionCreate(args);
        case 'focus':
          return await this.actionFocus(args);
        case 'update':
          return await this.actionUpdate(args);
        case 'close':
          return await this.actionClose(args);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // chrome.windows uses "No window with id" — surface as INVALID_ARGS so
      // callers can branch from "the window vanished" without re-raising.
      if (/no window with id/i.test(msg)) {
        return createErrorResponse(
          `Window ${args.windowId} not found`,
          ToolErrorCode.INVALID_ARGS,
          { arg: 'windowId', windowId: args.windowId },
        );
      }
      console.error('Error in WindowManageTool.execute:', error);
      return createErrorResponse(`chrome_window failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }

  private async actionCreate(args: WindowParams): Promise<ToolResult> {
    const opts: chrome.windows.CreateData = {};
    if (typeof args.url === 'string') opts.url = args.url;
    if (args.type === 'normal' || args.type === 'popup' || args.type === 'panel') {
      opts.type = args.type;
    }
    if (typeof args.incognito === 'boolean') opts.incognito = args.incognito;
    if (typeof args.focused === 'boolean') opts.focused = args.focused;
    if (
      args.state === 'normal' ||
      args.state === 'minimized' ||
      args.state === 'maximized' ||
      args.state === 'fullscreen'
    ) {
      opts.state = args.state;
    }
    if (typeof args.left === 'number') opts.left = args.left;
    if (typeof args.top === 'number') opts.top = args.top;
    if (typeof args.width === 'number') opts.width = args.width;
    if (typeof args.height === 'number') opts.height = args.height;

    const created = await chrome.windows.create(opts);
    if (!created) {
      return createErrorResponse('chrome.windows.create returned undefined', ToolErrorCode.UNKNOWN);
    }
    return jsonOk({ ok: true, action: 'create', window: serializeWindow(created) });
  }

  private async actionFocus(args: WindowParams): Promise<ToolResult> {
    if (typeof args.windowId !== 'number') {
      return createErrorResponse(
        'Parameter [windowId] is required for action="focus".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'windowId' },
      );
    }
    const updated = await chrome.windows.update(args.windowId, { focused: true });
    return jsonOk({ ok: true, action: 'focus', window: serializeWindow(updated) });
  }

  private async actionUpdate(args: WindowParams): Promise<ToolResult> {
    if (typeof args.windowId !== 'number') {
      return createErrorResponse(
        'Parameter [windowId] is required for action="update".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'windowId' },
      );
    }
    const updateProps: chrome.windows.UpdateInfo = {};
    if (typeof args.focused === 'boolean') updateProps.focused = args.focused;
    if (
      args.state === 'normal' ||
      args.state === 'minimized' ||
      args.state === 'maximized' ||
      args.state === 'fullscreen'
    ) {
      updateProps.state = args.state;
    }
    if (typeof args.left === 'number') updateProps.left = args.left;
    if (typeof args.top === 'number') updateProps.top = args.top;
    if (typeof args.width === 'number') updateProps.width = args.width;
    if (typeof args.height === 'number') updateProps.height = args.height;
    if (Object.keys(updateProps).length === 0) {
      return createErrorResponse(
        'action="update" needs at least one of [focused], [state], [left], [top], [width], [height].',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'focused|state|left|top|width|height' },
      );
    }
    const updated = await chrome.windows.update(args.windowId, updateProps);
    return jsonOk({ ok: true, action: 'update', window: serializeWindow(updated) });
  }

  private async actionClose(args: WindowParams): Promise<ToolResult> {
    if (typeof args.windowId !== 'number') {
      return createErrorResponse(
        'Parameter [windowId] is required for action="close".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'windowId' },
      );
    }
    await chrome.windows.remove(args.windowId);
    return jsonOk({ ok: true, action: 'close', windowId: args.windowId });
  }
}

export const windowManageTool = new WindowManageTool();
