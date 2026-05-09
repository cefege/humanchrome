/**
 * chrome_context_menu tests.
 *
 * Wraps chrome.contextMenus.{create,update,remove,removeAll}. Stubs the API
 * and asserts the tool's contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  contextMenuTool,
  _resetContextMenuKnownIdsForTest,
} from '@/entrypoints/background/tools/browser/context-menu';

let createMock: ReturnType<typeof vi.fn>;
let updateMock: ReturnType<typeof vi.fn>;
let removeMock: ReturnType<typeof vi.fn>;
let removeAllMock: ReturnType<typeof vi.fn>;
let onClickedAddListener: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetContextMenuKnownIdsForTest();
  createMock = vi.fn().mockImplementation((_props: any, cb: () => void) => cb());
  updateMock = vi.fn().mockImplementation((_id: any, _props: any, cb: () => void) => cb());
  removeMock = vi.fn().mockImplementation((_id: any, cb: () => void) => cb());
  removeAllMock = vi.fn().mockImplementation((cb: () => void) => cb());
  onClickedAddListener = vi.fn();
  (globalThis.chrome as any).contextMenus = {
    create: createMock,
    update: updateMock,
    remove: removeMock,
    removeAll: removeAllMock,
    onClicked: { addListener: onClickedAddListener },
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    lastError: undefined,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).contextMenus;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_context_menu', () => {
  it('rejects unknown action', async () => {
    const res = await contextMenuTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.contextMenus is undefined', async () => {
    delete (globalThis.chrome as any).contextMenus;
    const res = await contextMenuTool.execute({ action: 'remove_all' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.contextMenus is unavailable');
  });

  it('add requires title', async () => {
    const res = await contextMenuTool.execute({ action: 'add' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('title');
  });

  it('add forwards id, title, and default contexts=["page"]', async () => {
    const res = await contextMenuTool.execute({ action: 'add', id: 'x', title: 'X' });
    expect(res.isError).toBe(false);
    expect(createMock).toHaveBeenCalled();
    const props = createMock.mock.calls[0][0];
    expect(props.id).toBe('x');
    expect(props.title).toBe('X');
    expect(props.contexts).toEqual(['page']);
  });

  it('add auto-generates an id when none is supplied', async () => {
    const res = await contextMenuTool.execute({ action: 'add', title: 'Auto' });
    expect(res.isError).toBe(false);
    expect(parseBody(res).id).toMatch(/^humanchrome-cm-/);
  });

  it('add installs the onClicked listener exactly once', async () => {
    await contextMenuTool.execute({ action: 'add', title: '1' });
    await contextMenuTool.execute({ action: 'add', title: '2' });
    expect(onClickedAddListener).toHaveBeenCalledTimes(1);
  });

  it('update requires id', async () => {
    const res = await contextMenuTool.execute({ action: 'update' });
    expect(res.isError).toBe(true);
  });

  it('update with no fields returns INVALID_ARGS', async () => {
    const res = await contextMenuTool.execute({ action: 'update', id: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('title|contexts|documentUrlPatterns');
  });

  it('update forwards title and contexts', async () => {
    await contextMenuTool.execute({
      action: 'update',
      id: 'x',
      title: 'Renamed',
      contexts: ['page', 'selection'],
    });
    expect(updateMock).toHaveBeenCalled();
    const updateArgs = updateMock.mock.calls[0];
    expect(updateArgs[0]).toBe('x');
    expect(updateArgs[1]).toEqual({ title: 'Renamed', contexts: ['page', 'selection'] });
  });

  it('remove requires id', async () => {
    const res = await contextMenuTool.execute({ action: 'remove' });
    expect(res.isError).toBe(true);
  });

  it('remove forwards the id and untracks it', async () => {
    await contextMenuTool.execute({ action: 'add', id: 'x', title: 't' });
    await contextMenuTool.execute({ action: 'remove', id: 'x' });
    expect(removeMock).toHaveBeenCalledWith('x', expect.any(Function));
  });

  it('remove_all clears every menu item and reports the agent-owned count', async () => {
    await contextMenuTool.execute({ action: 'add', id: 'a', title: 'A' });
    await contextMenuTool.execute({ action: 'add', id: 'b', title: 'B' });
    const body = parseBody(await contextMenuTool.execute({ action: 'remove_all' }));
    expect(removeAllMock).toHaveBeenCalled();
    expect(body.removed).toBe(2);
  });
});
