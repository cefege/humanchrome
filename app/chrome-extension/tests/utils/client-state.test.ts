/**
 * Tests for the per-client ownership state.
 *
 * Covers: claim/release, tab-close eviction, resolution priority,
 * ownership conflicts, releaseClient semantics, and the chrome.storage.session
 * round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _handleTabRemovedForTests,
  _handleWindowRemovedForTests,
  _resetClientStateForTests,
  claimTabForClient,
  clearLastWindowForClient,
  findTabOwner,
  getClientState,
  loadPersistedClientState,
  recordClientTab,
  releaseClient,
  releaseTabFromClient,
  resolveOwnedTabIdForClient,
  resolveOwnedWindowIdForClient,
} from '@/entrypoints/background/utils/client-state';

type SessionStore = Record<string, unknown>;

beforeEach(() => {
  _resetClientStateForTests();
  const sessionStore: SessionStore = {};
  (globalThis.chrome as any) = {
    storage: {
      session: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === 'string') return { [key]: sessionStore[key] };
          const out: SessionStore = {};
          for (const k of key) out[k] = sessionStore[k];
          return out;
        }),
        set: vi.fn(async (entry: SessionStore) => {
          Object.assign(sessionStore, entry);
        }),
        __store: sessionStore,
      },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 11 }, { id: 12 }, { id: 13 }]),
      onRemoved: {
        addListener: () => undefined,
      },
    },
  };
});

afterEach(() => {
  _resetClientStateForTests();
});

describe('client-state ownership', () => {
  it('claimTabForClient adds the tab to the owned set and makes it active', () => {
    claimTabForClient('alice', 42, 7);
    const s = getClientState('alice');
    expect(s?.ownedTabs.has(42)).toBe(true);
    expect(s?.activeTabId).toBe(42);
    expect(s?.lastWindowId).toBe(7);
  });

  it('findTabOwner returns the current owner or null', () => {
    claimTabForClient('alice', 100);
    expect(findTabOwner(100)).toBe('alice');
    expect(findTabOwner(101)).toBeNull();
  });

  it('claiming a tab owned by another client transfers ownership and reports previousOwner', () => {
    claimTabForClient('alice', 50);
    const prev = claimTabForClient('bob', 50);
    expect(prev).toBe('alice');
    expect(findTabOwner(50)).toBe('bob');
    expect(getClientState('alice')?.ownedTabs.has(50)).toBe(false);
  });

  it('releaseTabFromClient drops the tab from the owned set', () => {
    claimTabForClient('alice', 60);
    releaseTabFromClient('alice', 60);
    expect(getClientState('alice')?.ownedTabs.has(60)).toBe(false);
    expect(findTabOwner(60)).toBeNull();
  });

  it('releaseClient drops every owned tab but keeps the client entry', () => {
    claimTabForClient('alice', 70);
    claimTabForClient('alice', 71);
    const released = releaseClient('alice');
    expect(released).toBe(2);
    const s = getClientState('alice');
    expect(s).toBeDefined();
    expect(s?.ownedTabs.size).toBe(0);
    expect(s?.activeTabId).toBeUndefined();
  });

  it('tabs.onRemoved evicts the tab from every client', () => {
    claimTabForClient('alice', 80);
    claimTabForClient('bob', 81);
    _handleTabRemovedForTests(80);
    expect(findTabOwner(80)).toBeNull();
    expect(findTabOwner(81)).toBe('bob');
  });
});

describe('resolveOwnedTabIdForClient', () => {
  it('returns the explicit tabId when it is unowned (and auto-claims)', () => {
    const r = resolveOwnedTabIdForClient('alice', 90, { isRead: false });
    expect(r.tabId).toBe(90);
    expect(r.conflict).toBeUndefined();
    expect(findTabOwner(90)).toBe('alice');
  });

  it('returns the explicit tabId when caller is the owner', () => {
    claimTabForClient('alice', 91);
    const r = resolveOwnedTabIdForClient('alice', 91, { isRead: false });
    expect(r.tabId).toBe(91);
    expect(r.conflict).toBeUndefined();
  });

  it('reports a conflict when the explicit tabId is owned by another client (mutating)', () => {
    claimTabForClient('alice', 92);
    const r = resolveOwnedTabIdForClient('bob', 92, { isRead: false });
    expect(r.tabId).toBeUndefined();
    expect(r.conflict).toEqual({ tabId: 92, owner: 'alice' });
  });

  it('reads are exempt from ownership checks', () => {
    claimTabForClient('alice', 93);
    const r = resolveOwnedTabIdForClient('bob', 93, { isRead: true });
    expect(r.tabId).toBe(93);
    expect(r.conflict).toBeUndefined();
    expect(findTabOwner(93)).toBe('alice');
  });

  it('falls back to the client activeTabId when no explicit id is supplied', () => {
    claimTabForClient('alice', 94);
    claimTabForClient('alice', 95);
    const r = resolveOwnedTabIdForClient('alice', undefined, { isRead: false });
    expect(r.tabId).toBe(95);
  });

  it('returns undefined when the client has no owned tabs', () => {
    const r = resolveOwnedTabIdForClient('alice', undefined, { isRead: false });
    expect(r.tabId).toBeUndefined();
  });

  it('returns undefined when no clientId is supplied', () => {
    const r = resolveOwnedTabIdForClient(undefined, undefined, { isRead: false });
    expect(r.tabId).toBeUndefined();
  });
});

describe('recordClientTab', () => {
  it('claims the tab and updates active/window pointers', () => {
    recordClientTab('alice', 200, 8);
    const s = getClientState('alice');
    expect(s?.ownedTabs.has(200)).toBe(true);
    expect(s?.activeTabId).toBe(200);
    expect(s?.lastWindowId).toBe(8);
  });

  it('is a no-op without a clientId or tabId', () => {
    recordClientTab(undefined, 201);
    expect(findTabOwner(201)).toBeNull();
    recordClientTab('alice', NaN as unknown as number);
    expect(getClientState('alice')).toBeUndefined();
  });
});

describe('loadPersistedClientState', () => {
  it('restores owned tabs that still exist in Chrome', async () => {
    const store = (globalThis.chrome as any).storage.session.__store as SessionStore;
    store['humanchrome:ownership'] = {
      alice: { ownedTabIds: [11, 999], activeTabId: 11, lastWindowId: 5, lastSeenAt: 1 },
      bob: { ownedTabIds: [13], lastSeenAt: 2 },
    };
    await loadPersistedClientState();
    expect(getClientState('alice')?.ownedTabs.has(11)).toBe(true);
    // 999 is missing from chrome.tabs.query → dropped
    expect(getClientState('alice')?.ownedTabs.has(999)).toBe(false);
    expect(getClientState('bob')?.ownedTabs.has(13)).toBe(true);
  });

  it('drops clients whose owned tabs are all gone', async () => {
    const store = (globalThis.chrome as any).storage.session.__store as SessionStore;
    store['humanchrome:ownership'] = {
      ghost: { ownedTabIds: [555, 666], lastSeenAt: 1 },
    };
    await loadPersistedClientState();
    expect(getClientState('ghost')).toBeUndefined();
  });
});

describe('resolveOwnedWindowIdForClient (IMP-0090)', () => {
  it("returns the client's lastWindowId when no explicit id is supplied", () => {
    claimTabForClient('alice', 100, 42);
    expect(resolveOwnedWindowIdForClient('alice')).toBe(42);
  });

  it('prefers an explicit windowId over the recency hint', () => {
    claimTabForClient('alice', 100, 42);
    expect(resolveOwnedWindowIdForClient('alice', 99)).toBe(99);
  });

  it('returns undefined for an unknown client', () => {
    expect(resolveOwnedWindowIdForClient('nobody')).toBeUndefined();
  });

  it('returns undefined for an undefined clientId (legacy callers)', () => {
    expect(resolveOwnedWindowIdForClient(undefined)).toBeUndefined();
  });
});

describe('clearLastWindowForClient (IMP-0090)', () => {
  it("nulls only the matching client's lastWindowId when it equals the argument", () => {
    claimTabForClient('alice', 100, 7);
    claimTabForClient('bob', 200, 7);
    clearLastWindowForClient('alice', 7);
    expect(getClientState('alice')?.lastWindowId).toBeUndefined();
    expect(getClientState('bob')?.lastWindowId).toBe(7);
  });

  it('is a no-op when the windowId does not match', () => {
    claimTabForClient('alice', 100, 7);
    clearLastWindowForClient('alice', 999);
    expect(getClientState('alice')?.lastWindowId).toBe(7);
  });
});

describe('_handleWindowRemovedForTests (IMP-0090)', () => {
  it('clears lastWindowId on every client pointing at the closed window', () => {
    claimTabForClient('alice', 100, 33);
    claimTabForClient('bob', 200, 33);
    claimTabForClient('carol', 300, 44);
    _handleWindowRemovedForTests(33);
    expect(getClientState('alice')?.lastWindowId).toBeUndefined();
    expect(getClientState('bob')?.lastWindowId).toBeUndefined();
    expect(getClientState('carol')?.lastWindowId).toBe(44);
  });
});
