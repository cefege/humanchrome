/**
 * Unit tests for `createOwnedRegistry` (IMP-0158, multi-tab-by-design
 * rollout Phase 1 Foundations). The data structure ships with no callers;
 * IMP-0162 migrates six per-tab module-scope registries onto it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOwnedRegistry,
  OWNED_REGISTRY_SYSTEM_CLIENT,
} from '@/entrypoints/background/utils/owned-registry';
import {
  _resetClientStateForTests,
  releaseClient,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const onRemovedListeners: Array<(tabId: number) => void> = [];

beforeEach(() => {
  _resetClientStateForTests();
  onRemovedListeners.length = 0;
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(),
      onRemoved: {
        addListener: (cb: (tabId: number) => void) => {
          onRemovedListeners.push(cb);
        },
        removeListener: (cb: (tabId: number) => void) => {
          const idx = onRemovedListeners.indexOf(cb);
          if (idx >= 0) onRemovedListeners.splice(idx, 1);
        },
      },
    },
    windows: { onRemoved: { addListener: () => undefined } },
    runtime: { lastError: undefined },
  };
});

afterEach(() => {
  _resetClientStateForTests();
});

describe('createOwnedRegistry', () => {
  it('isolates entries by (clientId, tabId) so two clients on the same tab do not collide', () => {
    const reg = createOwnedRegistry<string>();
    reg.set('alice', 7, 'alice-7');
    reg.set('bob', 7, 'bob-7');

    expect(reg.get('alice', 7)).toBe('alice-7');
    expect(reg.get('bob', 7)).toBe('bob-7');
    expect(reg.size()).toBe(2);
    reg.dispose();
  });

  it('treats an undefined/empty clientId as the system bucket', () => {
    const reg = createOwnedRegistry<number>();
    reg.set(undefined, 1, 99);
    reg.set('', 2, 100);
    expect(reg.get(undefined, 1)).toBe(99);
    expect(reg.get('', 2)).toBe(100);
    // Visible via entries() under the system key.
    const all = [...reg.entries()];
    expect(all.every((e) => e.clientId === OWNED_REGISTRY_SYSTEM_CLIENT)).toBe(true);
    reg.dispose();
  });

  it('delete returns false when the key is unknown and true when it removes', () => {
    const reg = createOwnedRegistry<string>();
    expect(reg.delete('alice', 9)).toBe(false);
    reg.set('alice', 9, 'v');
    expect(reg.has('alice', 9)).toBe(true);
    expect(reg.delete('alice', 9)).toBe(true);
    expect(reg.has('alice', 9)).toBe(false);
    reg.dispose();
  });

  it('fires onEvict once per evicted entry from forgetTab, forgetClient, and delete', () => {
    const evictions: Array<{ clientId: string; tabId: number; value: string }> = [];
    const reg = createOwnedRegistry<string>({
      onEvict: (entry) =>
        evictions.push({ clientId: entry.clientId, tabId: entry.tabId, value: entry.value }),
    });

    reg.set('alice', 1, 'A1');
    reg.set('alice', 2, 'A2');
    reg.set('bob', 1, 'B1');

    reg.delete('alice', 1);
    expect(evictions).toEqual([{ clientId: 'alice', tabId: 1, value: 'A1' }]);

    evictions.length = 0;
    const fromForgetTab = reg.forgetTab(1);
    expect(fromForgetTab.map((e) => e.clientId).sort()).toEqual(['bob']);
    expect(evictions).toEqual([{ clientId: 'bob', tabId: 1, value: 'B1' }]);

    evictions.length = 0;
    const fromForgetClient = reg.forgetClient('alice');
    expect(fromForgetClient.map((e) => e.tabId)).toEqual([2]);
    expect(evictions).toEqual([{ clientId: 'alice', tabId: 2, value: 'A2' }]);

    expect(reg.size()).toBe(0);
    reg.dispose();
  });

  it('subscribes to chrome.tabs.onRemoved by default and forgets the closed tab', () => {
    const evictions: number[] = [];
    const reg = createOwnedRegistry<string>({
      onEvict: (e) => evictions.push(e.tabId),
    });
    reg.set('alice', 7, 'A');
    reg.set('bob', 7, 'B');
    expect(onRemovedListeners.length).toBeGreaterThan(0);

    onRemovedListeners[0]!(7);

    expect(reg.size()).toBe(0);
    expect(evictions.sort()).toEqual([7, 7]);
    reg.dispose();
  });

  it('subscribes to client release and forgets the released client', () => {
    claimTabForClient('alice', 11);
    const reg = createOwnedRegistry<string>();
    reg.set('alice', 11, 'data');
    reg.set('bob', 22, 'other');

    releaseClient('alice');

    expect(reg.get('alice', 11)).toBeUndefined();
    expect(reg.get('bob', 22)).toBe('other');
    reg.dispose();
  });

  it('skipAutoSubscribe lets tests drive eviction manually', () => {
    const reg = createOwnedRegistry<string>({ skipAutoSubscribe: true });
    reg.set('alice', 5, 'A');
    // No listener registered, so an external tab-close does nothing to us.
    expect(onRemovedListeners.length).toBe(0);
    reg.dispose();
  });

  it('onEvict errors are swallowed and do not abort subsequent evictions', () => {
    const evictions: number[] = [];
    const reg = createOwnedRegistry<number>({
      onEvict: (e) => {
        if (e.tabId === 1) throw new Error('boom');
        evictions.push(e.tabId);
      },
    });
    reg.set('alice', 1, 1);
    reg.set('alice', 2, 2);
    reg.forgetClient('alice');
    expect(evictions).toEqual([2]);
    reg.dispose();
  });

  it('dispose unsubscribes from chrome.tabs.onRemoved and clears state', () => {
    const reg = createOwnedRegistry<string>();
    reg.set('alice', 1, 'A');
    expect(onRemovedListeners.length).toBe(1);
    reg.dispose();
    expect(onRemovedListeners.length).toBe(0);
    expect(reg.size()).toBe(0);
  });
});
