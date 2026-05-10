import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type NotificationsAction = 'create' | 'clear' | 'clear_all' | 'get_all';
type NotificationType = 'basic' | 'image' | 'list' | 'progress';

interface NotificationsParams {
  action: NotificationsAction;
  notificationId?: string;
  title?: string;
  message?: string;
  type?: NotificationType;
  iconUrl?: string;
  priority?: number;
  buttons?: Array<{ title: string }>;
}

const DEFAULT_ICON = 'icon/128.png';

class NotificationsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NOTIFICATIONS;
  static readonly mutates = true;

  async execute(args: NotificationsParams): Promise<ToolResult> {
    const action = args?.action;
    if (
      action !== 'create' &&
      action !== 'clear' &&
      action !== 'clear_all' &&
      action !== 'get_all'
    ) {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: create, clear, clear_all, get_all.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

    if (typeof chrome.notifications === 'undefined') {
      return createErrorResponse(
        'chrome.notifications is unavailable — the `notifications` permission is not granted.',
        ToolErrorCode.UNKNOWN,
      );
    }

    try {
      switch (action) {
        case 'create':
          return await this.actionCreate(args);
        case 'clear':
          return await this.actionClear(args);
        case 'clear_all':
          return await this.actionClearAll();
        case 'get_all':
          return await this.actionGetAll();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in NotificationsTool.execute:', error);
      return createErrorResponse(`chrome_notifications failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }

  private async actionCreate(args: NotificationsParams): Promise<ToolResult> {
    if (typeof args.title !== 'string' || args.title.length === 0) {
      return createErrorResponse(
        'Parameter [title] is required for action="create".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'title' },
      );
    }
    if (typeof args.message !== 'string') {
      return createErrorResponse(
        'Parameter [message] is required for action="create".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'message' },
      );
    }

    const options: chrome.notifications.NotificationOptions<true> = {
      type: args.type ?? 'basic',
      iconUrl: args.iconUrl ?? chrome.runtime.getURL(DEFAULT_ICON),
      title: args.title,
      message: args.message,
    };
    if (typeof args.priority === 'number') options.priority = args.priority;
    if (Array.isArray(args.buttons) && args.buttons.length > 0) {
      options.buttons = args.buttons.slice(0, 2).map((b) => ({ title: b.title }));
    }

    const notificationId = await new Promise<string>((resolve, reject) => {
      try {
        chrome.notifications.create(args.notificationId ?? '', options, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        });
      } catch (e) {
        reject(e);
      }
    });

    return jsonOk({ ok: true, action: 'create', notificationId });
  }

  private async actionClear(args: NotificationsParams): Promise<ToolResult> {
    if (typeof args.notificationId !== 'string' || args.notificationId.length === 0) {
      return createErrorResponse(
        'Parameter [notificationId] is required for action="clear".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'notificationId' },
      );
    }
    const wasCleared = await new Promise<boolean>((resolve) =>
      chrome.notifications.clear(args.notificationId as string, (cleared) => resolve(cleared)),
    );
    return jsonOk({
      ok: true,
      action: 'clear',
      notificationId: args.notificationId,
      cleared: wasCleared,
    });
  }

  private async actionClearAll(): Promise<ToolResult> {
    const ids = await new Promise<Record<string, boolean>>((resolve) =>
      chrome.notifications.getAll((map) =>
        resolve((map ?? {}) as unknown as Record<string, boolean>),
      ),
    );
    const cleared: string[] = [];
    for (const id of Object.keys(ids)) {
      const ok = await new Promise<boolean>((resolve) =>
        chrome.notifications.clear(id, (b) => resolve(b)),
      );
      if (ok) cleared.push(id);
    }
    return jsonOk({ ok: true, action: 'clear_all', cleared, count: cleared.length });
  }

  private async actionGetAll(): Promise<ToolResult> {
    const ids = await new Promise<Record<string, boolean>>((resolve) =>
      chrome.notifications.getAll((map) =>
        resolve((map ?? {}) as unknown as Record<string, boolean>),
      ),
    );
    return jsonOk({
      ok: true,
      action: 'get_all',
      ids: Object.keys(ids),
      count: Object.keys(ids).length,
    });
  }
}

export const notificationsTool = new NotificationsTool();
