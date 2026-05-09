/**
 * chrome_notifications tests.
 *
 * Wraps chrome.notifications so an MCP caller can push native OS pings.
 * Stubs chrome.notifications.create / clear / getAll and asserts the
 * tool's contract per action.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notificationsTool } from '@/entrypoints/background/tools/browser/notifications';

let createMock: ReturnType<typeof vi.fn>;
let clearMock: ReturnType<typeof vi.fn>;
let getAllMock: ReturnType<typeof vi.fn>;
let getURLMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createMock = vi.fn().mockImplementation((id: string, _opts: any, cb: (id: string) => void) => {
    cb(id || 'auto-id');
  });
  clearMock = vi.fn().mockImplementation((_id: string, cb: (cleared: boolean) => void) => {
    cb(true);
  });
  getAllMock = vi
    .fn()
    .mockImplementation((cb: (map: Record<string, boolean>) => void) =>
      cb({ a: true, b: true, c: true }),
    );
  getURLMock = vi.fn().mockImplementation((p: string) => `chrome-extension://x/${p}`);

  (globalThis.chrome as any).notifications = {
    create: createMock,
    clear: clearMock,
    getAll: getAllMock,
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    getURL: getURLMock,
    lastError: undefined,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).notifications;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_notifications', () => {
  it('rejects missing/unknown action', async () => {
    const res = await notificationsTool.execute({} as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('action');
  });

  it('errors when chrome.notifications is undefined', async () => {
    delete (globalThis.chrome as any).notifications;
    const res = await notificationsTool.execute({ action: 'get_all' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.notifications is unavailable');
  });

  it('create requires title and message', async () => {
    const r1 = await notificationsTool.execute({ action: 'create' });
    expect(r1.isError).toBe(true);
    expect((r1.content[0] as any).text).toContain('title');

    const r2 = await notificationsTool.execute({ action: 'create', title: 't' });
    expect(r2.isError).toBe(true);
    expect((r2.content[0] as any).text).toContain('message');
  });

  it('create returns a notificationId and uses the default icon', async () => {
    const res = await notificationsTool.execute({
      action: 'create',
      title: 'Done',
      message: 'task complete',
    });
    expect(res.isError).toBe(false);
    expect(getURLMock).toHaveBeenCalledWith('icon/128.png');
    expect(createMock).toHaveBeenCalled();
    expect(parseBody(res).notificationId).toBe('auto-id');
  });

  it('create caps buttons[] to 2', async () => {
    await notificationsTool.execute({
      action: 'create',
      title: 't',
      message: 'm',
      buttons: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    });
    const passed = createMock.mock.calls[0][1];
    expect(passed.buttons).toEqual([{ title: 'a' }, { title: 'b' }]);
  });

  it('clear requires notificationId', async () => {
    const res = await notificationsTool.execute({ action: 'clear' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('notificationId');
  });

  it('clear forwards the id and reports cleared:true', async () => {
    const res = await notificationsTool.execute({ action: 'clear', notificationId: 'x' });
    expect(res.isError).toBe(false);
    expect(clearMock).toHaveBeenCalled();
    expect(parseBody(res).cleared).toBe(true);
  });

  it('clear_all clears every visible id', async () => {
    const res = await notificationsTool.execute({ action: 'clear_all' });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.cleared).toEqual(['a', 'b', 'c']);
    expect(body.count).toBe(3);
    expect(clearMock).toHaveBeenCalledTimes(3);
  });

  it('get_all returns the list of ids', async () => {
    const res = await notificationsTool.execute({ action: 'get_all' });
    const body = parseBody(res);
    expect(body.ids.sort()).toEqual(['a', 'b', 'c']);
    expect(body.count).toBe(3);
  });
});
