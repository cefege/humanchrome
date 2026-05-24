/**
 * Tests for `chrome_owned_tabs` (IMP-0168).
 *
 * Returns the calling client's owned-tab set as a flat array, with
 * tab metadata refreshed from chrome.tabs.get. Distinct from
 * `chrome_get_windows_and_tabs` — that catalog returns every tab in
 * every window; this is the narrower "what does THIS client own"
 * question that the popup/sidepanel UI panel needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownedTabsTool } from '@/entrypoints/background/tools/browser/owned-tabs';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
  recordClientTab,
} from '@/entrypoints/background/utils/client-state';

const tabsGetMock = vi.fn();

beforeEach(() => {
  _resetClientStateForTests();
  tabsGetMock.mockReset();
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: tabsGetMock,
      onRemoved: { addListener: vi.fn() },
    },
    windows: { onRemoved: { addListener: vi.fn() } },
    runtime: { lastError: undefined },
  };
});

afterEach(() => {
  _resetClientStateForTests();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_owned_tabs (IMP-0168)', () => {
  it('returns INVALID_ARGS when no clientId is on the request context', async () => {
    // No runWithContext wrapper.
    const res = await ownedTabsTool.execute({});
    const body = parseBody(res);
    expect(res.isError).toBe(true);
    expect(body.error.code).toBe('INVALID_ARGS');
  });

  it('returns empty list for a known client with no owned tabs', async () => {
    const res = await runWithContext({ clientId: 'alice' }, () => ownedTabsTool.execute({}));
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.clientId).toBe('alice');
    expect(body.count).toBe(0);
    expect(body.ownedTabs).toEqual([]);
  });

  it('returns one row per owned tab with refreshed metadata', async () => {
    claimTabForClient('alice', 100, 5);
    claimTabForClient('alice', 200, 5);
    tabsGetMock.mockImplementation(async (id: number) => {
      if (id === 100) return { id: 100, windowId: 5, url: 'https://a', title: 'A', active: false, status: 'complete' };
      if (id === 200) return { id: 200, windowId: 5, url: 'https://b', title: 'B', active: true, status: 'complete' };
      throw new Error(`No tab with id: ${id}`);
    });

    const res = await runWithContext({ clientId: 'alice' }, () => ownedTabsTool.execute({}));
    const body = parseBody(res);
    expect(body.count).toBe(2);
    const ids = body.ownedTabs.map((r: any) => r.tabId).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([100, 200]);
    const row100 = body.ownedTabs.find((r: any) => r.tabId === 100);
    expect(row100.url).toBe('https://a');
    expect(row100.windowId).toBe(5);
    expect(row100.active).toBe(false);
    expect(row100.isActive).toBe(false);
  });

  it('marks the dispatcher activeTabId with isPinnedActive=true', async () => {
    claimTabForClient('alice', 100, 5);
    claimTabForClient('alice', 200, 5);
    recordClientTab('alice', 200, 5); // makes 200 the activeTabId
    tabsGetMock.mockImplementation(async (id: number) => ({
      id,
      windowId: 5,
      url: `https://${id}`,
      title: `T${id}`,
      active: false,
    }));

    const res = await runWithContext({ clientId: 'alice' }, () => ownedTabsTool.execute({}));
    const body = parseBody(res);
    expect(body.activeTabId).toBe(200);
    const pinned = body.ownedTabs.find((r: any) => r.isPinnedActive);
    expect(pinned?.tabId).toBe(200);
    const notPinned = body.ownedTabs.find((r: any) => !r.isPinnedActive);
    expect(notPinned?.tabId).toBe(100);
  });

  it('filters to one row when tabId argument is provided', async () => {
    claimTabForClient('alice', 100, 1);
    claimTabForClient('alice', 200, 1);
    tabsGetMock.mockImplementation(async (id: number) => ({
      id,
      windowId: 1,
      url: `https://${id}`,
      title: `T${id}`,
      active: false,
    }));

    const res = await runWithContext({ clientId: 'alice' }, () =>
      ownedTabsTool.execute({ tabId: 200 }),
    );
    const body = parseBody(res);
    expect(body.count).toBe(1);
    expect(body.ownedTabs[0].tabId).toBe(200);
  });

  it('skips tabs that have been closed between claim and refresh', async () => {
    claimTabForClient('alice', 100);
    claimTabForClient('alice', 999);
    tabsGetMock.mockImplementation(async (id: number) => {
      if (id === 100) return { id: 100, windowId: 1, url: 'https://a', title: 'A', active: false };
      throw new Error('No tab with id: 999');
    });

    const res = await runWithContext({ clientId: 'alice' }, () => ownedTabsTool.execute({}));
    const body = parseBody(res);
    // 999 is skipped; only 100 shows up.
    expect(body.count).toBe(1);
    expect(body.ownedTabs[0].tabId).toBe(100);
  });

  it('isolates clients — alice does not see bob and vice versa', async () => {
    claimTabForClient('alice', 100);
    claimTabForClient('bob', 200);
    tabsGetMock.mockImplementation(async (id: number) => ({
      id,
      windowId: 1,
      url: `https://${id}`,
      title: '',
      active: false,
    }));

    const aliceRes = await runWithContext({ clientId: 'alice' }, () => ownedTabsTool.execute({}));
    const aliceBody = parseBody(aliceRes);
    expect(aliceBody.ownedTabs.map((r: any) => r.tabId)).toEqual([100]);

    const bobRes = await runWithContext({ clientId: 'bob' }, () => ownedTabsTool.execute({}));
    const bobBody = parseBody(bobRes);
    expect(bobBody.ownedTabs.map((r: any) => r.tabId)).toEqual([200]);
  });

  it('sorts rows by windowId then tabId', async () => {
    claimTabForClient('alice', 50, 2);
    claimTabForClient('alice', 30, 1);
    claimTabForClient('alice', 40, 1);
    tabsGetMock.mockImplementation(async (id: number) => ({
      id,
      windowId: id < 40 ? 1 : id === 40 ? 1 : 2,
      url: `https://${id}`,
      title: '',
      active: false,
    }));

    const res = await runWithContext({ clientId: 'alice' }, () => ownedTabsTool.execute({}));
    const body = parseBody(res);
    const ordered = body.ownedTabs.map((r: any) => r.tabId);
    expect(ordered).toEqual([30, 40, 50]);
  });
});
