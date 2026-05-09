import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type ContextMenuAction = 'add' | 'update' | 'remove' | 'remove_all';
type Context =
  | 'all'
  | 'page'
  | 'frame'
  | 'selection'
  | 'link'
  | 'editable'
  | 'image'
  | 'video'
  | 'audio'
  | 'launcher'
  | 'browser_action'
  | 'page_action'
  | 'action';

interface ContextMenuParams {
  action: ContextMenuAction;
  id?: string;
  title?: string;
  contexts?: Context[];
  documentUrlPatterns?: string[];
}

// Track menu items registered through this tool so list/cleanup can
// distinguish between agent-owned and externally-registered items.
const knownIds = new Set<string>();

let listenerInstalled = false;
function installClickListener(): void {
  if (listenerInstalled) return;
  if (typeof chrome.contextMenus === 'undefined') return;
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    // The bridge reads `context_menu_clicked` events out of the native-message
    // stream. Each click broadcasts as a runtime message tagged with the menu
    // id so any flow that's polling can correlate.
    chrome.runtime
      .sendMessage({
        target: 'background',
        type: 'context_menu_clicked',
        menuItemId: info.menuItemId,
        info,
        tab,
      })
      .catch(() => {
        // No listener — fine. The bridge connector polls onClicked directly.
      });
  });
  listenerInstalled = true;
}

class ContextMenuTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CONTEXT_MENU;
  static readonly mutates = true;

  async execute(args: ContextMenuParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'add' && action !== 'update' && action !== 'remove' && action !== 'remove_all') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: add, update, remove, remove_all.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.contextMenus === 'undefined') {
      return createErrorResponse('chrome.contextMenus is unavailable.', ToolErrorCode.UNKNOWN);
    }

    installClickListener();

    try {
      switch (action) {
        case 'add':
          return await this.actionAdd(args);
        case 'update':
          return await this.actionUpdate(args);
        case 'remove':
          return await this.actionRemove(args);
        case 'remove_all':
          return await this.actionRemoveAll();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in ContextMenuTool.execute:', error);
      return createErrorResponse(`chrome_context_menu failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }

  private async actionAdd(args: ContextMenuParams): Promise<ToolResult> {
    if (typeof args.title !== 'string' || args.title.length === 0) {
      return createErrorResponse(
        'Parameter [title] is required for action="add".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'title' },
      );
    }

    const id =
      typeof args.id === 'string' && args.id.length > 0 ? args.id : `humanchrome-cm-${Date.now()}`;
    const contextsArr = (args.contexts ?? ['page']) as Context[];
    const properties: chrome.contextMenus.CreateProperties = {
      id,
      title: args.title,
      contexts: contextsArr as unknown as chrome.contextMenus.CreateProperties['contexts'],
    };
    if (Array.isArray(args.documentUrlPatterns) && args.documentUrlPatterns.length > 0) {
      properties.documentUrlPatterns = args.documentUrlPatterns;
    }

    await new Promise<void>((resolve, reject) => {
      chrome.contextMenus.create(properties, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });

    knownIds.add(id);
    return jsonOk({
      ok: true,
      action: 'add',
      id,
      title: args.title,
      contexts: properties.contexts,
    });
  }

  private async actionUpdate(args: ContextMenuParams): Promise<ToolResult> {
    if (typeof args.id !== 'string' || args.id.length === 0) {
      return createErrorResponse(
        'Parameter [id] is required for action="update".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'id' },
      );
    }
    type UpdateProps = Omit<chrome.contextMenus.CreateProperties, 'id'>;
    const updateProps: UpdateProps = {};
    if (typeof args.title === 'string') updateProps.title = args.title;
    if (Array.isArray(args.contexts) && args.contexts.length > 0) {
      updateProps.contexts = args.contexts as unknown as UpdateProps['contexts'];
    }
    if (Array.isArray(args.documentUrlPatterns) && args.documentUrlPatterns.length > 0) {
      updateProps.documentUrlPatterns = args.documentUrlPatterns;
    }
    if (Object.keys(updateProps).length === 0) {
      return createErrorResponse(
        'action="update" needs at least one of [title], [contexts], [documentUrlPatterns].',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'title|contexts|documentUrlPatterns' },
      );
    }

    await new Promise<void>((resolve, reject) => {
      chrome.contextMenus.update(args.id as string, updateProps, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });

    return jsonOk({ ok: true, action: 'update', id: args.id });
  }

  private async actionRemove(args: ContextMenuParams): Promise<ToolResult> {
    if (typeof args.id !== 'string' || args.id.length === 0) {
      return createErrorResponse(
        'Parameter [id] is required for action="remove".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'id' },
      );
    }
    await new Promise<void>((resolve, reject) => {
      chrome.contextMenus.remove(args.id as string, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
    knownIds.delete(args.id);
    return jsonOk({ ok: true, action: 'remove', id: args.id });
  }

  private async actionRemoveAll(): Promise<ToolResult> {
    await new Promise<void>((resolve, reject) => {
      chrome.contextMenus.removeAll(() => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
    const count = knownIds.size;
    knownIds.clear();
    return jsonOk({ ok: true, action: 'remove_all', removed: count });
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const contextMenuTool = new ContextMenuTool();

/** Test-only — drop the registry shadow used by `add` / `remove_all` reporting. */
export function _resetContextMenuKnownIdsForTest(): void {
  knownIds.clear();
  listenerInstalled = false;
}
