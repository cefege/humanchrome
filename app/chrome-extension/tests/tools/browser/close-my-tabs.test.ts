/**
 * Tests for browser_close_my_tabs.
 *
 * Exercises happy path, keep[] semantics, race handling, validation,
 * last-tab-guard interaction, and cross-client isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeMyTabsTool } from '@/entrypoints/background/tools/browser/close-my-tabs';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
  findTabOwner,
} from '@/entrypoints/background/utils/client-state';
import { __test as lastTabGuardTest } from '@/utils/last-tab-guard';

const tabsRemove = vi.fn();
const tabsGet = vi.fn();
const tabsQuery = vi.fn();
const tabsCreate = vi.fn();

beforeEach(() => {
  _resetClientStateForTests();
  lastTabGuardTest.reset();
  tabsRemove.mockReset();
  tabsRemove.mockImplementation(async () => undefined);
  tabsGet.mockReset();
  tabsGet.mockImplementation(async (id: number) => ({ id, windowId: 1 }));
  tabsQuery.mockReset();
  // Default: lots of tabs in window 1 so last-tab-guard never fires.
  tabsQuery.mockImplementation(async () => [
    { id: 100, windowId: 1 },
    { id: 101, windowId: 1 },
    { id: 102, windowId: 1 },
    { id: 103, windowId: 1 },
  ]);
  tabsCreate.mockReset();
  tabsCreate.mockImplementation(async ({ windowId }: { windowId: number }) => ({
    id: 9999,
    windowId,
  }));
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: tabsGet,
      remove: tabsRemove,
      query: tabsQuery,
      create: tabsCreate,
      onRemoved: { addListener: () => undefined },
      onCreated: { addListener: () => undefined },
    },
    windows: {
      onRemoved: { addListener: () => undefined },
    },
  };
});

afterEach(() => {
  _resetClientStateForTests();
  lastTabGuardTest.reset();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

async function asClient(clientId: string | undefined, args: any = {}) {
  return runWithContext({ clientId }, () => closeMyTabsTool.execute(args));
}

describe('browser_close_my_tabs', () => {
  it('closes all owned tabs and reports them in `closed`', async () => {
    claimTabForClient('alice', 10);
    claimTabForClient('alice', 11);
    claimTabForClient('alice', 12);

    const res = await asClient('alice');
    const body = parseBody(res);

    expect(body.success).toBe(true);
    expect(body.closed.sort()).toEqual([10, 11, 12]);
    expect(body.kept).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(tabsRemove).toHaveBeenCalledTimes(3);
    expect(findTabOwner(10)).toBeNull();
    expect(findTabOwner(11)).toBeNull();
    expect(findTabOwner(12)).toBeNull();
  });

  it('preserves tabs listed in `keep`', async () => {
    claimTabForClient('alice', 20);
    claimTabForClient('alice', 21);
    claimTabForClient('alice', 22);
    claimTabForClient('alice', 23);

    const res = await asClient('alice', { keep: [21] });
    const body = parseBody(res);

    expect(body.closed.sort()).toEqual([20, 22, 23]);
    expect(body.kept).toEqual([21]);
    expect(findTabOwner(21)).toBe('alice');
  });

  it('no-ops on a client with no owned tabs', async () => {
    const res = await asClient('alice');
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.closed).toEqual([]);
    expect(body.kept).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(tabsRemove).not.toHaveBeenCalled();
  });

  it('silently drops `keep` ids that the client does not own', async () => {
    claimTabForClient('alice', 30);
    claimTabForClient('alice', 31);

    const res = await asClient('alice', { keep: [31, 999] });
    const body = parseBody(res);

    expect(body.closed).toEqual([30]);
    expect(body.kept).toEqual([31]);
    expect(body.failed).toEqual([]);
  });

  it('classifies a mid-call race as TAB_CLOSED in failed[] but keeps success=true', async () => {
    claimTabForClient('alice', 40);
    claimTabForClient('alice', 41);

    tabsRemove.mockImplementation(async (id: number | number[]) => {
      const target = Array.isArray(id) ? id[0] : id;
      if (target === 40) throw new Error('No tab with id 40');
    });

    const res = await asClient('alice');
    const body = parseBody(res);

    expect(body.success).toBe(true);
    expect(body.closed).toEqual([41]);
    expect(body.failed).toEqual([{ tabId: 40, reason: 'TAB_CLOSED' }]);
    expect(findTabOwner(40)).toBeNull();
  });

  it('classifies unexpected remove errors as UNKNOWN with the original message', async () => {
    claimTabForClient('alice', 50);

    tabsRemove.mockImplementation(async () => {
      throw new Error('Permission denied');
    });

    const res = await asClient('alice');
    const body = parseBody(res);

    expect(body.success).toBe(true);
    expect(body.closed).toEqual([]);
    expect(body.failed).toEqual([{ tabId: 50, reason: 'UNKNOWN', message: 'Permission denied' }]);
  });

  it('errors INVALID_ARGS when `keep` is not an array', async () => {
    const res = await asClient('alice', { keep: 'oops' });
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.details?.arg).toBe('keep');
  });

  it('errors INVALID_ARGS when `keep` contains a non-number entry', async () => {
    const res = await asClient('alice', { keep: [1, 'two'] });
    expect(parseBody(res).error?.code).toBe('INVALID_ARGS');
  });

  it('errors INVALID_ARGS when `keep` contains NaN', async () => {
    const res = await asClient('alice', { keep: [Number.NaN] });
    expect(parseBody(res).error?.code).toBe('INVALID_ARGS');
  });

  it('errors INVALID_ARGS when no clientId is bound, and does not mutate ownership', async () => {
    claimTabForClient('alice', 60);
    const res = await asClient(undefined);
    expect(parseBody(res).error?.code).toBe('INVALID_ARGS');
    expect(findTabOwner(60)).toBe('alice');
    expect(tabsRemove).not.toHaveBeenCalled();
  });

  it('opens a placeholder before closing the last tab in a window (last-tab-guard)', async () => {
    claimTabForClient('alice', 100);
    // Only one tab in window 1 — that's our owned tab.
    tabsGet.mockImplementation(async (id: number) => ({ id, windowId: 1 }));
    tabsQuery.mockImplementation(async () => [{ id: 100, windowId: 1 }]);

    const res = await asClient('alice');
    const body = parseBody(res);

    expect(body.closed).toEqual([100]);
    expect(tabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId: 1,
        url: 'chrome://newtab/',
        active: false,
      }),
    );
    expect(findTabOwner(9999)).toBeNull();
  });

  it("only touches the calling client's tabs (cross-client isolation)", async () => {
    claimTabForClient('alice', 70);
    claimTabForClient('bob', 71);

    const res = await asClient('alice');
    const body = parseBody(res);

    expect(body.closed).toEqual([70]);
    expect(findTabOwner(70)).toBeNull();
    expect(findTabOwner(71)).toBe('bob');
    expect(tabsRemove).toHaveBeenCalledTimes(1);
  });

  it('treats keep covering every owned tab as a clean no-op', async () => {
    claimTabForClient('alice', 80);
    claimTabForClient('alice', 81);

    const res = await asClient('alice', { keep: [80, 81] });
    const body = parseBody(res);

    expect(body.closed).toEqual([]);
    expect(body.kept.sort()).toEqual([80, 81]);
    expect(tabsRemove).not.toHaveBeenCalled();
  });
});
