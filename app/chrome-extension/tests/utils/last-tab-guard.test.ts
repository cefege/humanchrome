/**
 * Tests for the last-tab guard. Closing the only tab in a window closes the
 * whole Chrome window — and since the bridge depends on the extension's
 * service worker, that paralyses the entire humanchrome infrastructure
 * until the user manually relaunches Chrome. These tests pin the guard
 * behaviour: open a placeholder before closing the last tab, then
 * auto-clean the placeholder once any other tab opens in the same window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __test, initLastTabGuardListeners, safeRemoveTabs } from '@/utils/last-tab-guard';

interface DebuggerStubs {
  // chrome.tabs.* mocks captured for assertions
  query: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  onCreated: { fire: (tab: chrome.tabs.Tab) => void };
  onRemoved: { fire: (tabId: number, info: chrome.tabs.TabRemoveInfo) => void };
  windowsOnRemoved: { fire: (windowId: number) => void };
}

let stubs: DebuggerStubs;

function installChromeMock(): DebuggerStubs {
  const onCreatedListeners: Array<(tab: chrome.tabs.Tab) => void> = [];
  const onRemovedListeners: Array<(tabId: number, info: chrome.tabs.TabRemoveInfo) => void> = [];
  const windowsOnRemovedListeners: Array<(windowId: number) => void> = [];

  const query = vi.fn();
  const get = vi.fn();
  const create = vi.fn();
  const remove = vi.fn().mockResolvedValue(undefined);

  (globalThis as unknown as { chrome: any }).chrome = {
    runtime: { id: 'test' },
    tabs: {
      query,
      get,
      create,
      remove,
      onCreated: { addListener: (fn: any) => onCreatedListeners.push(fn) },
      onRemoved: { addListener: (fn: any) => onRemovedListeners.push(fn) },
    },
    windows: {
      onRemoved: { addListener: (fn: any) => windowsOnRemovedListeners.push(fn) },
    },
  };

  return {
    query,
    get,
    create,
    remove,
    onCreated: { fire: (tab) => onCreatedListeners.forEach((fn) => fn(tab)) },
    onRemoved: { fire: (tabId, info) => onRemovedListeners.forEach((fn) => fn(tabId, info)) },
    windowsOnRemoved: {
      fire: (windowId) => windowsOnRemovedListeners.forEach((fn) => fn(windowId)),
    },
  };
}

beforeEach(() => {
  __test.reset();
  stubs = installChromeMock();
});

afterEach(() => {
  __test.reset();
  vi.restoreAllMocks();
});

describe('safeRemoveTabs — multi-tab windows', () => {
  it('removes a non-last tab without opening a placeholder', async () => {
    stubs.get.mockImplementation(async (id: number) => ({ id, windowId: 1 }));
    stubs.query.mockResolvedValue([
      { id: 100, windowId: 1 },
      { id: 200, windowId: 1 },
    ]);

    await safeRemoveTabs(100);

    expect(stubs.create).not.toHaveBeenCalled();
    expect(stubs.remove).toHaveBeenCalledWith(100);
  });

  it('does nothing for an already-gone tab (chrome.tabs.get throws)', async () => {
    stubs.get.mockRejectedValue(new Error('No tab with id'));
    await safeRemoveTabs(999);
    expect(stubs.create).not.toHaveBeenCalled();
    expect(stubs.remove).not.toHaveBeenCalled();
  });
});

describe('safeRemoveTabs — last-tab guard', () => {
  it('opens a placeholder BEFORE closing the only tab in a window', async () => {
    stubs.get.mockResolvedValue({ id: 42, windowId: 7 });
    stubs.query.mockResolvedValue([{ id: 42, windowId: 7 }]);
    stubs.create.mockResolvedValue({ id: 999, windowId: 7 });

    const order: string[] = [];
    stubs.create.mockImplementation(async () => {
      order.push('create');
      return { id: 999, windowId: 7 };
    });
    stubs.remove.mockImplementation(async () => {
      order.push('remove');
    });

    await safeRemoveTabs(42);

    expect(order).toEqual(['create', 'remove']);
    expect(stubs.create).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 7, url: 'chrome://newtab/' }),
    );
    expect(stubs.remove).toHaveBeenCalledWith(42);
    expect(__test.hasPlaceholderFor(7)).toBe(true);
  });

  it('opens a placeholder when closing ALL tabs in a window at once', async () => {
    stubs.get.mockImplementation(async (id: number) => ({ id, windowId: 3 }));
    stubs.query.mockResolvedValue([
      { id: 11, windowId: 3 },
      { id: 12, windowId: 3 },
    ]);
    stubs.create.mockResolvedValue({ id: 88, windowId: 3 });

    await safeRemoveTabs([11, 12]);

    expect(stubs.create).toHaveBeenCalledTimes(1);
    expect(stubs.remove).toHaveBeenCalledWith([11, 12]);
    expect(__test.hasPlaceholderFor(3)).toBe(true);
  });

  it('places one placeholder per window when emptying multiple windows', async () => {
    // Tab 1 in window A, tab 2 in window B; query returns each window has 1.
    stubs.get.mockImplementation(async (id: number) => {
      if (id === 1) return { id: 1, windowId: 100 };
      if (id === 2) return { id: 2, windowId: 200 };
      throw new Error('not found');
    });
    stubs.query.mockImplementation(async (q: any) => {
      if (q.windowId === 100) return [{ id: 1, windowId: 100 }];
      if (q.windowId === 200) return [{ id: 2, windowId: 200 }];
      return [];
    });
    let nextPlaceholderId = 500;
    stubs.create.mockImplementation(async (opts: any) => ({
      id: nextPlaceholderId++,
      windowId: opts.windowId,
    }));

    await safeRemoveTabs([1, 2]);

    expect(stubs.create).toHaveBeenCalledTimes(2);
    expect(__test.hasPlaceholderFor(100)).toBe(true);
    expect(__test.hasPlaceholderFor(200)).toBe(true);
  });
});

describe('placeholder auto-cleanup listeners', () => {
  it('closes the placeholder when ANY other tab opens in the same window', async () => {
    stubs.get.mockResolvedValue({ id: 42, windowId: 7 });
    stubs.query.mockResolvedValue([{ id: 42, windowId: 7 }]);
    stubs.create.mockResolvedValue({ id: 999, windowId: 7 });

    initLastTabGuardListeners();
    await safeRemoveTabs(42);

    expect(__test.hasPlaceholderFor(7)).toBe(true);
    stubs.remove.mockClear();

    // Simulate a real tab opening in the same window
    stubs.onCreated.fire({ id: 1234, windowId: 7 } as chrome.tabs.Tab);

    expect(stubs.remove).toHaveBeenCalledWith(999);
    expect(__test.hasPlaceholderFor(7)).toBe(false);
  });

  it('does NOT close the placeholder when the placeholder itself fires onCreated', async () => {
    stubs.get.mockResolvedValue({ id: 42, windowId: 7 });
    stubs.query.mockResolvedValue([{ id: 42, windowId: 7 }]);
    stubs.create.mockResolvedValue({ id: 999, windowId: 7 });

    initLastTabGuardListeners();
    await safeRemoveTabs(42);

    stubs.remove.mockClear();
    stubs.onCreated.fire({ id: 999, windowId: 7 } as chrome.tabs.Tab); // placeholder firing

    expect(stubs.remove).not.toHaveBeenCalled();
    expect(__test.hasPlaceholderFor(7)).toBe(true);
  });

  it('drops tracking when the user closes the placeholder themselves', async () => {
    stubs.get.mockResolvedValue({ id: 42, windowId: 7 });
    stubs.query.mockResolvedValue([{ id: 42, windowId: 7 }]);
    stubs.create.mockResolvedValue({ id: 999, windowId: 7 });

    initLastTabGuardListeners();
    await safeRemoveTabs(42);
    expect(__test.hasPlaceholderFor(7)).toBe(true);

    stubs.onRemoved.fire(999, { windowId: 7, isWindowClosing: false });
    expect(__test.hasPlaceholderFor(7)).toBe(false);
  });

  it('drops tracking when the entire window goes away', async () => {
    stubs.get.mockResolvedValue({ id: 42, windowId: 7 });
    stubs.query.mockResolvedValue([{ id: 42, windowId: 7 }]);
    stubs.create.mockResolvedValue({ id: 999, windowId: 7 });

    initLastTabGuardListeners();
    await safeRemoveTabs(42);
    expect(__test.hasPlaceholderFor(7)).toBe(true);

    stubs.windowsOnRemoved.fire(7);
    expect(__test.hasPlaceholderFor(7)).toBe(false);
  });

  it('initLastTabGuardListeners is idempotent across multiple calls', () => {
    initLastTabGuardListeners();
    initLastTabGuardListeners();
    initLastTabGuardListeners();
    // No assertion crash needed — the guard checks `listenersInstalled` and
    // returns early. If it weren't idempotent, the listener arrays would
    // grow and tests below would observe duplicate fires.
    expect(__test.placeholderCount()).toBe(0);
  });
});
