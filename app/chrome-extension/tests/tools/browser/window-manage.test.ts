/**
 * chrome_window tests.
 *
 * Wraps chrome.windows.{create,update,remove}.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { windowManageTool } from '@/entrypoints/background/tools/browser/window-manage';

const SAMPLE_WINDOW = {
  id: 100,
  type: 'normal' as const,
  state: 'normal' as const,
  focused: true,
  incognito: false,
  top: 0,
  left: 0,
  width: 800,
  height: 600,
  tabs: [{ id: 1 }, { id: 2 }],
};

let createMock: ReturnType<typeof vi.fn>;
let updateMock: ReturnType<typeof vi.fn>;
let removeMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createMock = vi.fn().mockResolvedValue({ ...SAMPLE_WINDOW, id: 200 });
  updateMock = vi.fn().mockResolvedValue({ ...SAMPLE_WINDOW });
  removeMock = vi.fn().mockResolvedValue(undefined);
  (globalThis.chrome as any).windows = {
    create: createMock,
    update: updateMock,
    remove: removeMock,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).windows;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_window', () => {
  it('rejects unknown action', async () => {
    const res = await windowManageTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.windows is undefined', async () => {
    delete (globalThis.chrome as any).windows;
    const res = await windowManageTool.execute({ action: 'focus', windowId: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.windows is unavailable');
  });

  it('create with no options spawns a default window', async () => {
    const res = await windowManageTool.execute({ action: 'create' });
    expect(res.isError).toBe(false);
    expect(createMock).toHaveBeenCalledWith({});
    expect(parseBody(res).window.id).toBe(200);
  });

  it('create forwards type, incognito, state, and geometry', async () => {
    await windowManageTool.execute({
      action: 'create',
      type: 'popup',
      incognito: true,
      state: 'maximized',
      left: 100,
      top: 50,
      width: 1024,
      height: 768,
      url: 'https://example.com',
    });
    expect(createMock).toHaveBeenCalledWith({
      type: 'popup',
      incognito: true,
      state: 'maximized',
      left: 100,
      top: 50,
      width: 1024,
      height: 768,
      url: 'https://example.com',
    });
  });

  it('focus requires windowId', async () => {
    const res = await windowManageTool.execute({ action: 'focus' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('windowId');
  });

  it('focus calls chrome.windows.update with focused:true', async () => {
    await windowManageTool.execute({ action: 'focus', windowId: 100 });
    expect(updateMock).toHaveBeenCalledWith(100, { focused: true });
  });

  it('update requires windowId', async () => {
    const res = await windowManageTool.execute({ action: 'update', state: 'minimized' });
    expect(res.isError).toBe(true);
  });

  it('update with no fields returns INVALID_ARGS', async () => {
    const res = await windowManageTool.execute({ action: 'update', windowId: 100 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('focused|state|left|top|width|height');
  });

  it('update forwards state + geometry', async () => {
    await windowManageTool.execute({
      action: 'update',
      windowId: 100,
      state: 'minimized',
      width: 1024,
    });
    expect(updateMock).toHaveBeenCalledWith(100, { state: 'minimized', width: 1024 });
  });

  it('close requires windowId', async () => {
    const res = await windowManageTool.execute({ action: 'close' });
    expect(res.isError).toBe(true);
  });

  it('close forwards windowId to chrome.windows.remove', async () => {
    await windowManageTool.execute({ action: 'close', windowId: 100 });
    expect(removeMock).toHaveBeenCalledWith(100);
  });

  it('classifies "No window with id" as INVALID_ARGS with windowId metadata', async () => {
    updateMock.mockRejectedValueOnce(new Error('No window with id: 999'));
    const res = await windowManageTool.execute({ action: 'focus', windowId: 999 });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('not found');
    expect(text).toContain('999');
  });

  it('returns the updated window object after focus', async () => {
    const body = parseBody(await windowManageTool.execute({ action: 'focus', windowId: 100 }));
    expect(body.window.id).toBe(100);
    expect(body.window.tabsCount).toBe(2);
  });

  it('returns an UNKNOWN error when chrome.windows.create returns undefined', async () => {
    createMock.mockResolvedValueOnce(undefined);
    const res = await windowManageTool.execute({ action: 'create' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('returned undefined');
  });
});
