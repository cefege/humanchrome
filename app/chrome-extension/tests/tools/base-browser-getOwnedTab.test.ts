/**
 * Unit tests for `BaseBrowserToolExecutor.getOwnedTab` (IMP-0157,
 * multi-tab-by-design rollout). Mirrors the dispatcher's resolution
 * priority — the helper exists so tools never call
 * `chrome.tabs.query({active:true})` directly and land on another
 * client's tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolErrorCode } from 'humanchrome-shared';

import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

type OwnedTabOpts = {
  explicit?: number;
  isRead?: boolean;
  windowId?: number;
  required?: boolean;
};

// Concrete tool that exposes the protected helper for tests.
class TestableTool extends BaseBrowserToolExecutor {
  name = 'chrome_test_getOwnedTab';
  async execute(): Promise<any> {
    throw new Error('not exercised');
  }
  public async invoke(opts: OwnedTabOpts = {}): Promise<chrome.tabs.Tab | null> {
    return (
      this as unknown as {
        getOwnedTab: (o: OwnedTabOpts) => Promise<chrome.tabs.Tab | null>;
      }
    ).getOwnedTab(opts);
  }
}

const tool = new TestableTool();

const tabsGetMock = vi.fn();

beforeEach(() => {
  _resetClientStateForTests();
  tabsGetMock.mockReset();
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: tabsGetMock,
      onRemoved: { addListener: () => undefined },
    },
    windows: { onRemoved: { addListener: () => undefined } },
    runtime: { lastError: undefined },
  };
});

afterEach(() => {
  _resetClientStateForTests();
});

describe('BaseBrowserToolExecutor.getOwnedTab', () => {
  it('returns the caller-owned tab via request-context clientId', async () => {
    claimTabForClient('alice', 4242, 1);
    tabsGetMock.mockResolvedValueOnce({ id: 4242, windowId: 1, url: 'https://x' });

    const tab = await runWithContext({ clientId: 'alice' }, () => tool.invoke());
    expect(tab?.id).toBe(4242);
    expect(tabsGetMock).toHaveBeenCalledWith(4242);
  });

  it('throws TAB_NOT_OWNED when an explicit tabId belongs to another client (mutating)', async () => {
    claimTabForClient('bob', 99);
    let caught: any;
    try {
      await runWithContext({ clientId: 'alice' }, () => tool.invoke({ explicit: 99 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(ToolErrorCode.TAB_NOT_OWNED);
    expect(caught.details?.owner).toBe('bob');
  });

  it('accepts an explicit tabId owned by another client when isRead', async () => {
    claimTabForClient('bob', 77);
    tabsGetMock.mockResolvedValueOnce({ id: 77, windowId: 1 });

    const tab = await runWithContext({ clientId: 'alice' }, () =>
      tool.invoke({ explicit: 77, isRead: true }),
    );
    expect(tab?.id).toBe(77);
  });

  it('throws TAB_NOT_FOUND with reason "no-owned-tab" when client has no tabs', async () => {
    let caught: any;
    try {
      await runWithContext({ clientId: 'alice' }, () => tool.invoke());
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe(ToolErrorCode.TAB_NOT_FOUND);
    expect(caught?.details?.reason).toBe('no-owned-tab');
    expect(tabsGetMock).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when required:false', async () => {
    const tab = await runWithContext({ clientId: 'alice' }, () =>
      tool.invoke({ required: false }),
    );
    expect(tab).toBeNull();
  });

  it('throws TAB_NOT_FOUND with reason "closed" when chrome.tabs.get rejects', async () => {
    claimTabForClient('alice', 55);
    tabsGetMock.mockRejectedValueOnce(new Error('No tab with id: 55.'));
    let caught: any;
    try {
      await runWithContext({ clientId: 'alice' }, () => tool.invoke());
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe(ToolErrorCode.TAB_NOT_FOUND);
    expect(caught?.details?.reason).toBe('closed');
  });

  it('throws TAB_NOT_FOUND with reason "window-mismatch" when windowId filter rejects the pick', async () => {
    claimTabForClient('alice', 33, 1);
    tabsGetMock.mockResolvedValueOnce({ id: 33, windowId: 1 });
    let caught: any;
    try {
      await runWithContext({ clientId: 'alice' }, () => tool.invoke({ windowId: 2 }));
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe(ToolErrorCode.TAB_NOT_FOUND);
    expect(caught?.details?.reason).toBe('window-mismatch');
  });

  it('returns null when there is no request context and required:false', async () => {
    // No runWithContext wrapper — no clientId, no owned tabs.
    const tab = await tool.invoke({ required: false });
    expect(tab).toBeNull();
  });
});
