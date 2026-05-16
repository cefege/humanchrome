/**
 * Tests for browser_claim_tab.
 *
 * Exercises arg validation, happy path, ownership transfer, missing-tab
 * handling, and the cross-client conflict rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimTabTool } from '@/entrypoints/background/tools/browser/claim-tab';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
  findTabOwner,
} from '@/entrypoints/background/utils/client-state';

const tabsGet = vi.fn();

beforeEach(() => {
  _resetClientStateForTests();
  tabsGet.mockReset();
  tabsGet.mockImplementation(async (id: number) => ({ id, windowId: 1 }));
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: { get: tabsGet, onRemoved: { addListener: () => undefined } },
  };
});

afterEach(() => {
  _resetClientStateForTests();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

async function asClient(clientId: string | undefined, args: any) {
  return runWithContext({ clientId }, () => claimTabTool.execute(args));
}

describe('browser_claim_tab', () => {
  it('claims an unowned tab and reports previousOwner: null', async () => {
    const res = await asClient('alice', { tabId: 42 });
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.tabId).toBe(42);
    expect(body.previousOwner).toBeNull();
    expect(findTabOwner(42)).toBe('alice');
  });

  it('records the windowId from chrome.tabs.get', async () => {
    tabsGet.mockResolvedValueOnce({ id: 50, windowId: 8 });
    const res = await asClient('alice', { tabId: 50 });
    const body = parseBody(res);
    expect(body.windowId).toBe(8);
  });

  it('errors when tabId is missing', async () => {
    const res = await asClient('alice', {});
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.details?.arg).toBe('tabId');
  });

  it('errors when tabId is not a finite number', async () => {
    const res = await asClient('alice', { tabId: 'forty-two' });
    expect(parseBody(res).error?.code).toBe('INVALID_ARGS');
  });

  it('errors when no clientId is bound', async () => {
    const res = await asClient(undefined, { tabId: 10 });
    expect(parseBody(res).error?.code).toBe('INVALID_ARGS');
  });

  it('errors with TAB_NOT_FOUND when the tab does not exist', async () => {
    tabsGet.mockRejectedValueOnce(new Error('No tab with id'));
    const res = await asClient('alice', { tabId: 99 });
    const body = parseBody(res);
    expect(body.error?.code).toBe('TAB_NOT_FOUND');
    expect(body.error?.details?.tabId).toBe(99);
  });

  it('refuses to claim a tab owned by another client (TAB_NOT_OWNED)', async () => {
    claimTabForClient('bob', 77);
    const res = await asClient('alice', { tabId: 77 });
    const body = parseBody(res);
    expect(body.error?.code).toBe('TAB_NOT_OWNED');
    expect(body.error?.details).toMatchObject({ tabId: 77, owner: 'bob' });
    expect(findTabOwner(77)).toBe('bob');
  });

  it('allows the same client to re-claim a tab it already owns (idempotent)', async () => {
    claimTabForClient('alice', 88);
    const res = await asClient('alice', { tabId: 88 });
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.previousOwner).toBeNull();
    expect(findTabOwner(88)).toBe('alice');
  });
});
