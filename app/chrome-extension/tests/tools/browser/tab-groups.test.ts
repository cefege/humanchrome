/**
 * chrome_tab_groups tests.
 *
 * Wraps chrome.tabs.group / chrome.tabs.ungroup / chrome.tabGroups.* so an
 * MCP caller can partition agent-managed tabs into a labelled, colored
 * group in the tab strip. Tests stub chrome.tabGroups + chrome.tabs and
 * pin each action's contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tabGroupsTool } from '@/entrypoints/background/tools/browser/tab-groups';

type TabGroup = chrome.tabGroups.TabGroup;

const SAMPLE_GROUP: TabGroup = {
  id: 100,
  collapsed: false,
  color: 'blue',
  title: 'Agent run #1',
  windowId: 1,
};

let groupMock: ReturnType<typeof vi.fn>;
let ungroupMock: ReturnType<typeof vi.fn>;
let getGroupMock: ReturnType<typeof vi.fn>;
let queryGroupMock: ReturnType<typeof vi.fn>;
let updateGroupMock: ReturnType<typeof vi.fn>;
let moveGroupMock: ReturnType<typeof vi.fn>;
let queryTabsMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  groupMock = vi.fn().mockResolvedValue(100);
  ungroupMock = vi.fn().mockResolvedValue(undefined);
  getGroupMock = vi.fn().mockResolvedValue({ ...SAMPLE_GROUP });
  queryGroupMock = vi.fn().mockResolvedValue([{ ...SAMPLE_GROUP }]);
  updateGroupMock = vi.fn().mockResolvedValue({ ...SAMPLE_GROUP });
  moveGroupMock = vi.fn().mockResolvedValue({ ...SAMPLE_GROUP });
  queryTabsMock = vi.fn().mockResolvedValue([{ id: 11 }, { id: 12 }, { id: 13 }]);

  (globalThis.chrome as any).tabGroups = {
    get: getGroupMock,
    query: queryGroupMock,
    update: updateGroupMock,
    move: moveGroupMock,
  };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    group: groupMock,
    ungroup: ungroupMock,
    query: queryTabsMock,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).tabGroups;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_tab_groups: argument validation', () => {
  it('rejects a missing/unknown action', async () => {
    const res = await tabGroupsTool.execute({} as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
    expect((res.content[0] as any).text).toContain('action');
  });

  it('rejects an invalid color', async () => {
    const res = await tabGroupsTool.execute({
      action: 'create',
      tabIds: [1],
      color: 'fuchsia' as any,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
    expect((res.content[0] as any).text).toContain('color');
  });

  it('returns an error if chrome.tabGroups is undefined (permission missing)', async () => {
    delete (globalThis.chrome as any).tabGroups;
    const res = await tabGroupsTool.execute({ action: 'query' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.tabGroups is unavailable');
  });
});

describe('chrome_tab_groups action="create"', () => {
  it('groups tabIds and returns the new group descriptor', async () => {
    const res = await tabGroupsTool.execute({ action: 'create', tabIds: [11, 12, 13] });
    expect(res.isError).toBe(false);
    expect(groupMock).toHaveBeenCalledWith({ tabIds: [11, 12, 13] });
    const body = parseBody(res);
    expect(body.action).toBe('create');
    expect(body.group.id).toBe(100);
    expect(body.tabIds).toEqual([11, 12, 13]);
  });

  it('applies title and color via a follow-up tabGroups.update', async () => {
    await tabGroupsTool.execute({
      action: 'create',
      tabIds: [11],
      title: 'Agent run #1',
      color: 'blue',
    });
    expect(updateGroupMock).toHaveBeenCalledWith(100, { title: 'Agent run #1', color: 'blue' });
  });

  it('with an existing groupId, adds tabs to that group instead of creating a new one', async () => {
    await tabGroupsTool.execute({ action: 'create', tabIds: [11, 12], groupId: 200 });
    expect(groupMock).toHaveBeenCalledWith({ groupId: 200, tabIds: [11, 12] });
  });

  it('rejects an empty tabIds array', async () => {
    const res = await tabGroupsTool.execute({ action: 'create', tabIds: [] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('tabIds');
  });
});

describe('chrome_tab_groups action="update"', () => {
  it('updates title, color, and collapsed in one call', async () => {
    await tabGroupsTool.execute({
      action: 'update',
      groupId: 100,
      title: 'Renamed',
      color: 'green',
      collapsed: true,
    });
    expect(updateGroupMock).toHaveBeenCalledWith(100, {
      title: 'Renamed',
      color: 'green',
      collapsed: true,
    });
  });

  it('rejects when groupId is missing', async () => {
    const res = await tabGroupsTool.execute({ action: 'update', title: 'X' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('groupId');
  });

  it('rejects when no updatable field is supplied', async () => {
    const res = await tabGroupsTool.execute({ action: 'update', groupId: 100 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('title|color|collapsed');
  });

  it('surfaces undefined return as a not-found error (concurrent delete)', async () => {
    updateGroupMock.mockResolvedValueOnce(undefined);
    const res = await tabGroupsTool.execute({ action: 'update', groupId: 100, title: 'X' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('not found');
  });
});

describe('chrome_tab_groups action="query"', () => {
  it('forwards filters and returns the serialized groups', async () => {
    queryGroupMock.mockResolvedValueOnce([SAMPLE_GROUP, { ...SAMPLE_GROUP, id: 101 }]);

    const res = await tabGroupsTool.execute({
      action: 'query',
      title: 'Agent',
      color: 'blue',
      windowId: 1,
      collapsed: false,
    });

    expect(queryGroupMock).toHaveBeenCalledWith({
      title: 'Agent',
      color: 'blue',
      windowId: 1,
      collapsed: false,
    });
    const body = parseBody(res);
    expect(body.count).toBe(2);
    expect(body.groups[0].id).toBe(100);
  });

  it('returns an empty list when no groups match', async () => {
    queryGroupMock.mockResolvedValueOnce([]);
    const body = parseBody(await tabGroupsTool.execute({ action: 'query' }));
    expect(body.count).toBe(0);
    expect(body.groups).toEqual([]);
  });
});

describe('chrome_tab_groups action="get"', () => {
  it('returns the group descriptor plus the tabIds currently in it', async () => {
    const res = await tabGroupsTool.execute({ action: 'get', groupId: 100 });
    expect(res.isError).toBe(false);
    expect(getGroupMock).toHaveBeenCalledWith(100);
    expect(queryTabsMock).toHaveBeenCalledWith({ groupId: 100 });
    const body = parseBody(res);
    expect(body.group.id).toBe(100);
    expect(body.tabIds).toEqual([11, 12, 13]);
  });

  it('rejects when groupId is missing', async () => {
    const res = await tabGroupsTool.execute({ action: 'get' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('groupId');
  });
});

describe('chrome_tab_groups action="add_tabs" / "remove_tabs"', () => {
  it('add_tabs forwards groupId + tabIds to chrome.tabs.group', async () => {
    await tabGroupsTool.execute({ action: 'add_tabs', groupId: 100, tabIds: [21, 22] });
    expect(groupMock).toHaveBeenCalledWith({ groupId: 100, tabIds: [21, 22] });
  });

  it('add_tabs rejects when tabIds is empty', async () => {
    const res = await tabGroupsTool.execute({ action: 'add_tabs', groupId: 100, tabIds: [] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('tabIds');
  });

  it('remove_tabs calls chrome.tabs.ungroup with the tabIds', async () => {
    await tabGroupsTool.execute({ action: 'remove_tabs', tabIds: [21, 22] });
    expect(ungroupMock).toHaveBeenCalledWith([21, 22]);
  });

  it('remove_tabs rejects when tabIds is empty', async () => {
    const res = await tabGroupsTool.execute({ action: 'remove_tabs', tabIds: [] });
    expect(res.isError).toBe(true);
  });
});

describe('chrome_tab_groups action="move"', () => {
  it('forwards groupId and index to chrome.tabGroups.move', async () => {
    await tabGroupsTool.execute({ action: 'move', groupId: 100, index: -1 });
    expect(moveGroupMock).toHaveBeenCalledWith(100, { index: -1 });
  });

  it('rejects when index is missing', async () => {
    const res = await tabGroupsTool.execute({ action: 'move', groupId: 100 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('index');
  });

  it('rejects when groupId is missing', async () => {
    const res = await tabGroupsTool.execute({ action: 'move', index: 0 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('groupId');
  });
});

describe('chrome_tab_groups error classification', () => {
  it('classifies "No group with id" rejection as UNKNOWN with groupId metadata', async () => {
    updateGroupMock.mockRejectedValueOnce(new Error('No group with id: 100'));
    const res = await tabGroupsTool.execute({ action: 'update', groupId: 100, title: 'X' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('not found');
    expect(text).toContain('100');
  });

  it('classifies "No tab with id" rejection as TAB_CLOSED', async () => {
    groupMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await tabGroupsTool.execute({ action: 'create', tabIds: [99] });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('TAB_CLOSED');
  });
});
