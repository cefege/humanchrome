import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type TabGroupsAction = 'create' | 'update' | 'query' | 'get' | 'add_tabs' | 'remove_tabs' | 'move';

type TabGroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange';

const VALID_COLORS: TabGroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

interface TabGroupsParams {
  action: TabGroupsAction;
  groupId?: number;
  tabIds?: number[];
  title?: string;
  color?: TabGroupColor;
  collapsed?: boolean;
  windowId?: number;
  index?: number;
}

function serializeGroup(g: chrome.tabGroups.TabGroup): Record<string, unknown> {
  return {
    id: g.id,
    title: g.title ?? '',
    color: g.color,
    collapsed: g.collapsed,
    windowId: g.windowId,
  };
}

class TabGroupsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TAB_GROUPS;
  static readonly mutates = true;

  async execute(args: TabGroupsParams): Promise<ToolResult> {
    const action = args?.action;
    if (
      action !== 'create' &&
      action !== 'update' &&
      action !== 'query' &&
      action !== 'get' &&
      action !== 'add_tabs' &&
      action !== 'remove_tabs' &&
      action !== 'move'
    ) {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: create, update, query, get, add_tabs, remove_tabs, move.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

    if (typeof chrome.tabGroups === 'undefined') {
      return createErrorResponse(
        'chrome.tabGroups is unavailable — the `tabGroups` permission is not granted or this Chromium build is too old (Chrome 89+ required).',
        ToolErrorCode.UNKNOWN,
      );
    }

    if (args.color !== undefined && !VALID_COLORS.includes(args.color)) {
      return createErrorResponse(
        `Parameter [color] must be one of: ${VALID_COLORS.join(', ')}.`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'color', got: args.color },
      );
    }

    try {
      switch (action) {
        case 'create':
          return await this.actionCreate(args);
        case 'update':
          return await this.actionUpdate(args);
        case 'query':
          return await this.actionQuery(args);
        case 'get':
          return await this.actionGet(args);
        case 'add_tabs':
          return await this.actionAddTabs(args);
        case 'remove_tabs':
          return await this.actionRemoveTabs(args);
        case 'move':
          return await this.actionMove(args);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // chrome.tabGroups uses "No group with id" / "No tab with id" — classify
      // distinctly so callers can retry vs. give up.
      if (/no group with id/i.test(msg)) {
        return createErrorResponse(`Tab group ${args.groupId} not found`, ToolErrorCode.UNKNOWN, {
          groupId: args.groupId,
        });
      }
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.TAB_CLOSED, {
          tabIds: args.tabIds,
        });
      }
      console.error('Error in TabGroupsTool.execute:', error);
      return createErrorResponse(`chrome_tab_groups failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }

  private async actionCreate(args: TabGroupsParams): Promise<ToolResult> {
    const tabIds = args.tabIds;
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      return createErrorResponse(
        'Parameter [tabIds] is required for action="create" and must be a non-empty number array.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'tabIds' },
      );
    }

    const createOptions: chrome.tabs.GroupOptions = { tabIds };
    if (typeof args.groupId === 'number') {
      // chrome.tabs.group({groupId, tabIds}) adds tabs to an existing group.
      createOptions.groupId = args.groupId;
    } else if (typeof args.windowId === 'number') {
      createOptions.createProperties = { windowId: args.windowId };
    }

    const groupId = await chrome.tabs.group(createOptions);

    if (args.title !== undefined || args.color !== undefined) {
      const updateProps: chrome.tabGroups.UpdateProperties = {};
      if (args.title !== undefined) updateProps.title = args.title;
      if (args.color !== undefined) updateProps.color = args.color;
      await chrome.tabGroups.update(groupId, updateProps);
    }

    const group = await chrome.tabGroups.get(groupId);
    return jsonOk({ ok: true, action: 'create', group: serializeGroup(group), tabIds });
  }

  private async actionUpdate(args: TabGroupsParams): Promise<ToolResult> {
    if (typeof args.groupId !== 'number') {
      return createErrorResponse(
        'Parameter [groupId] is required for action="update".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'groupId' },
      );
    }

    const updateProps: chrome.tabGroups.UpdateProperties = {};
    if (args.title !== undefined) updateProps.title = args.title;
    if (args.color !== undefined) updateProps.color = args.color;
    if (args.collapsed !== undefined) updateProps.collapsed = args.collapsed;

    if (Object.keys(updateProps).length === 0) {
      return createErrorResponse(
        'action="update" needs at least one of [title], [color], [collapsed].',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'title|color|collapsed' },
      );
    }

    const group = await chrome.tabGroups.update(args.groupId, updateProps);
    if (!group) {
      return createErrorResponse(
        `Tab group ${args.groupId} not found (deleted concurrently?)`,
        ToolErrorCode.UNKNOWN,
        { groupId: args.groupId },
      );
    }
    return jsonOk({ ok: true, action: 'update', group: serializeGroup(group) });
  }

  private async actionQuery(args: TabGroupsParams): Promise<ToolResult> {
    const queryInfo: chrome.tabGroups.QueryInfo = {};
    if (args.title !== undefined) queryInfo.title = args.title;
    if (args.color !== undefined) queryInfo.color = args.color;
    if (args.collapsed !== undefined) queryInfo.collapsed = args.collapsed;
    if (typeof args.windowId === 'number') queryInfo.windowId = args.windowId;

    const groups = await chrome.tabGroups.query(queryInfo);
    return jsonOk({
      ok: true,
      action: 'query',
      groups: groups.map(serializeGroup),
      count: groups.length,
    });
  }

  private async actionGet(args: TabGroupsParams): Promise<ToolResult> {
    if (typeof args.groupId !== 'number') {
      return createErrorResponse(
        'Parameter [groupId] is required for action="get".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'groupId' },
      );
    }
    const group = await chrome.tabGroups.get(args.groupId);
    const tabs = await chrome.tabs.query({ groupId: args.groupId });
    const tabIds = tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number');
    return jsonOk({ ok: true, action: 'get', group: serializeGroup(group), tabIds });
  }

  private async actionAddTabs(args: TabGroupsParams): Promise<ToolResult> {
    if (typeof args.groupId !== 'number') {
      return createErrorResponse(
        'Parameter [groupId] is required for action="add_tabs".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'groupId' },
      );
    }
    if (!Array.isArray(args.tabIds) || args.tabIds.length === 0) {
      return createErrorResponse(
        'Parameter [tabIds] is required for action="add_tabs" and must be a non-empty number array.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'tabIds' },
      );
    }
    const groupId = await chrome.tabs.group({ groupId: args.groupId, tabIds: args.tabIds });
    return jsonOk({ ok: true, action: 'add_tabs', groupId, tabIds: args.tabIds });
  }

  private async actionRemoveTabs(args: TabGroupsParams): Promise<ToolResult> {
    if (!Array.isArray(args.tabIds) || args.tabIds.length === 0) {
      return createErrorResponse(
        'Parameter [tabIds] is required for action="remove_tabs" and must be a non-empty number array.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'tabIds' },
      );
    }
    await chrome.tabs.ungroup(args.tabIds);
    return jsonOk({ ok: true, action: 'remove_tabs', tabIds: args.tabIds });
  }

  private async actionMove(args: TabGroupsParams): Promise<ToolResult> {
    if (typeof args.groupId !== 'number') {
      return createErrorResponse(
        'Parameter [groupId] is required for action="move".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'groupId' },
      );
    }
    if (typeof args.index !== 'number') {
      return createErrorResponse(
        'Parameter [index] is required for action="move".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'index' },
      );
    }
    const group = await chrome.tabGroups.move(args.groupId, { index: args.index });
    if (!group) {
      return createErrorResponse(
        `Tab group ${args.groupId} not found (deleted concurrently?)`,
        ToolErrorCode.UNKNOWN,
        { groupId: args.groupId },
      );
    }
    return jsonOk({ ok: true, action: 'move', group: serializeGroup(group) });
  }
}

export const tabGroupsTool = new TabGroupsTool();
