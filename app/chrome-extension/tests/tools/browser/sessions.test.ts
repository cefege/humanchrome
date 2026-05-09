/**
 * chrome_sessions tests.
 *
 * Wraps chrome.sessions for un-closing recently-closed tabs/windows.
 * Stubs the API and asserts the tool's contract per action.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionsTool } from '@/entrypoints/background/tools/browser/sessions';

let getRecentlyClosedMock: ReturnType<typeof vi.fn>;
let restoreMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getRecentlyClosedMock = vi.fn().mockResolvedValue([
    {
      lastModified: 1700000000,
      tab: {
        sessionId: 's1',
        url: 'https://example.com',
        title: 'Example',
        windowId: 1,
      },
    },
  ]);
  restoreMock = vi.fn().mockResolvedValue({
    tab: { sessionId: 's1', url: 'https://example.com', title: 'Example', windowId: 1 },
  });
  (globalThis.chrome as any).sessions = {
    getRecentlyClosed: getRecentlyClosedMock,
    restore: restoreMock,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).sessions;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_sessions', () => {
  it('rejects unknown action', async () => {
    const res = await sessionsTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.sessions is undefined', async () => {
    delete (globalThis.chrome as any).sessions;
    const res = await sessionsTool.execute({ action: 'restore' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.sessions is unavailable');
  });

  it('get_recently_closed forwards maxResults capped to 25', async () => {
    await sessionsTool.execute({ action: 'get_recently_closed', maxResults: 100 });
    expect(getRecentlyClosedMock).toHaveBeenCalledWith({ maxResults: 25 });
  });

  it('get_recently_closed serializes tab entries', async () => {
    const body = parseBody(await sessionsTool.execute({ action: 'get_recently_closed' }));
    expect(body.count).toBe(1);
    expect(body.sessions[0].tab.url).toBe('https://example.com');
  });

  it('get_recently_closed serializes window entries with their tabs', async () => {
    getRecentlyClosedMock.mockResolvedValueOnce([
      {
        lastModified: 1,
        window: {
          sessionId: 'w1',
          tabs: [
            { sessionId: 't1', url: 'https://a/', title: 'A', windowId: 9 },
            { sessionId: 't2', url: 'https://b/', title: 'B', windowId: 9 },
          ],
        },
      },
    ]);
    const body = parseBody(await sessionsTool.execute({ action: 'get_recently_closed' }));
    expect(body.sessions[0].window.tabs.length).toBe(2);
    expect(body.sessions[0].window.tabs[0].url).toBe('https://a/');
  });

  it('restore with sessionId calls chrome.sessions.restore(sessionId)', async () => {
    await sessionsTool.execute({ action: 'restore', sessionId: 's1' });
    expect(restoreMock).toHaveBeenCalledWith('s1');
  });

  it('restore without sessionId calls chrome.sessions.restore()', async () => {
    await sessionsTool.execute({ action: 'restore' });
    expect(restoreMock).toHaveBeenCalledWith();
  });

  it('restore returns the restored tab url', async () => {
    const body = parseBody(await sessionsTool.execute({ action: 'restore', sessionId: 's1' }));
    expect(body.restoredTab.url).toBe('https://example.com');
  });
});
