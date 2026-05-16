/**
 * Tests for the dispatcher's per-client tab-ownership and auto-spawn logic.
 *
 * The dispatcher (handleCallTool in entrypoints/background/tools/index.ts)
 * must:
 *   1. Resolve a target tab from the calling client's owned set before
 *      executing the tool — never fall back to the globally-active tab.
 *   2. Auto-spawn a new background tab for the client when a mutating tool
 *      is invoked without an explicit tabId AND the client has no usable
 *      owned tab (unless the tool sets `autoSpawnTab = false` or the
 *      caller supplied a URL).
 *   3. Refuse mutating calls that target a tab owned by another client
 *      with `TAB_NOT_OWNED`.
 *
 * Read-only tools are exempt from auto-spawn and ownership conflicts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleCallTool } from '@/entrypoints/background/tools';
import {
  _resetClientStateForTests,
  claimTabForClient,
  findTabOwner,
} from '@/entrypoints/background/utils/client-state';

const createTabMock = vi.fn();
const windowsGetMock = vi.fn();

beforeEach(() => {
  _resetClientStateForTests();
  createTabMock.mockReset();
  createTabMock.mockResolvedValue({ id: 9001, windowId: 1 });
  windowsGetMock.mockReset();
  windowsGetMock.mockImplementation(async (id: number) => ({ id }));
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      create: createTabMock,
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: { addListener: () => undefined },
      query: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
    },
    windows: { get: windowsGetMock, update: vi.fn(async () => undefined) },
    runtime: { lastError: undefined },
  };
});

afterEach(() => {
  _resetClientStateForTests();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('handleCallTool — ownership + auto-spawn', () => {
  it('auto-spawns a new tab when a mutating tool has no explicit tabId and no owned tabs', async () => {
    // chrome_click_element is mutating and does not set autoSpawnTab = false.
    // We give the tool a tabId it can't find (mocked tabs.get returns one)
    // so it short-circuits to its own error — that's fine, we only check
    // that the dispatcher called chrome.tabs.create exactly once for the
    // auto-spawn.
    await handleCallTool(
      { name: 'chrome_click_element', args: { selector: '#button' } },
      'req-1',
      'alice',
    );
    expect(createTabMock).toHaveBeenCalledTimes(1);
    expect(createTabMock).toHaveBeenCalledWith({ url: 'about:blank', active: false });
    // The spawned tab is now owned by alice.
    expect(findTabOwner(9001)).toBe('alice');
  });

  it('does NOT auto-spawn when the client already has an owned tab', async () => {
    claimTabForClient('alice', 555);
    await handleCallTool(
      { name: 'chrome_click_element', args: { selector: '#button' } },
      'req-2',
      'alice',
    );
    expect(createTabMock).not.toHaveBeenCalled();
  });

  it('does NOT auto-spawn for read-only tools', async () => {
    // chrome_read_page is read-only (mutates = false). Even with no owned
    // tab the dispatcher should not call chrome.tabs.create.
    await handleCallTool({ name: 'chrome_read_page', args: {} }, 'req-3', 'alice');
    expect(createTabMock).not.toHaveBeenCalled();
  });

  it('does NOT auto-spawn for tools with autoSpawnTab = false (pace)', async () => {
    await handleCallTool({ name: 'chrome_pace', args: { profile: 'human' } }, 'req-4', 'alice');
    expect(createTabMock).not.toHaveBeenCalled();
  });

  it('does NOT auto-spawn when the caller passes a URL (navigate-style)', async () => {
    // chrome_navigate is mutating but it manages its own tab creation
    // when given a url. We pass a stub tabId so navigate can short-circuit.
    await handleCallTool(
      { name: 'chrome_navigate', args: { url: 'https://example.com' } },
      'req-5',
      'alice',
    );
    expect(createTabMock).not.toHaveBeenCalled();
  });

  it('errors with TAB_NOT_OWNED when targeting another clients tab', async () => {
    claimTabForClient('bob', 777);
    const res = await handleCallTool(
      { name: 'chrome_click_element', args: { tabId: 777, selector: '#x' } },
      'req-6',
      'alice',
    );
    const body = parseBody(res);
    expect(body.error?.code).toBe('TAB_NOT_OWNED');
    expect(body.error?.details).toMatchObject({ tabId: 777, owner: 'bob' });
    expect(createTabMock).not.toHaveBeenCalled();
  });

  it('allows the owner to use their own tab without conflict', async () => {
    claimTabForClient('alice', 888);
    const res = await handleCallTool(
      { name: 'chrome_click_element', args: { tabId: 888, selector: '#x' } },
      'req-7',
      'alice',
    );
    const body = parseBody(res);
    expect(body.error?.code).not.toBe('TAB_NOT_OWNED');
    expect(createTabMock).not.toHaveBeenCalled();
  });

  it('reads can target any tab regardless of ownership', async () => {
    claimTabForClient('bob', 999);
    const res = await handleCallTool(
      { name: 'chrome_read_page', args: { tabId: 999 } },
      'req-8',
      'alice',
    );
    const body = parseBody(res);
    expect(body.error?.code).not.toBe('TAB_NOT_OWNED');
  });

  it('does NOT auto-spawn when no clientId is bound (legacy callers)', async () => {
    await handleCallTool(
      { name: 'chrome_click_element', args: { selector: '#x' } },
      'req-9',
      undefined,
    );
    expect(createTabMock).not.toHaveBeenCalled();
  });

  it("auto-spawn passes windowId from the client's lastWindowId (IMP-0090)", async () => {
    // Seed alice with a lastWindowId pointing at window 55 but no usable
    // owned tab (so the dispatcher must auto-spawn). chrome.windows.get
    // resolves cleanly so the probe doesn't strip the windowId.
    claimTabForClient('alice', 9001, 55);
    // Drop the tab from the owned set so resolveTargetTab returns undefined
    // but the lastWindowId hint stays.
    const { _handleTabRemovedForTests } =
      await import('@/entrypoints/background/utils/client-state');
    _handleTabRemovedForTests(9001);

    createTabMock.mockResolvedValueOnce({ id: 9100, windowId: 55 });
    await handleCallTool(
      { name: 'chrome_click_element', args: { selector: '#button' } },
      'req-w1',
      'alice',
    );
    expect(createTabMock).toHaveBeenCalledWith({
      url: 'about:blank',
      active: false,
      windowId: 55,
    });
  });

  it('auto-spawn omits windowId when the client has no lastWindowId', async () => {
    await handleCallTool(
      { name: 'chrome_click_element', args: { selector: '#button' } },
      'req-w2',
      'alice',
    );
    expect(createTabMock).toHaveBeenCalledWith({ url: 'about:blank', active: false });
  });

  it('auto-spawn drops a stale windowId when chrome.windows.get throws "No window with id"', async () => {
    const cs = await import('@/entrypoints/background/utils/client-state');
    cs.claimTabForClient('alice', 7001, 77);
    cs._handleTabRemovedForTests(7001);

    windowsGetMock.mockRejectedValueOnce(new Error('No window with id 77'));
    createTabMock.mockResolvedValueOnce({ id: 7100, windowId: 1 });

    await handleCallTool(
      { name: 'chrome_click_element', args: { selector: '#button' } },
      'req-w3',
      'alice',
    );
    // No windowId on the create — the probe stripped it.
    expect(createTabMock).toHaveBeenCalledWith({ url: 'about:blank', active: false });
    // The stale lastWindowId (77) was cleared; the new tab's windowId (1)
    // becomes the fresh recency hint via claimTabForClient.
    expect(cs.getClientState('alice')?.lastWindowId).toBe(1);
  });

  it('injects args.windowId from lastWindowId for non-spawning mutating tools', async () => {
    // chrome_window create is a mutating tool that reads args.windowId.
    // It sets autoSpawnTab=false so no auto-spawn fires.
    claimTabForClient('alice', 2001, 88);
    // Stub windows.create so the tool can return.
    (globalThis.chrome as any).windows.create = vi.fn(async () => ({ id: 999 }));

    await handleCallTool({ name: 'chrome_window', args: { action: 'focus' } }, 'req-w4', 'alice');
    // chrome_window's focus path calls windows.update(windowId, {focused:true}).
    // The injection should make windowId = 88 visible to the tool, which
    // forwards it to chrome.windows.update.
    expect((globalThis.chrome as any).windows.update).toHaveBeenCalledWith(
      88,
      expect.objectContaining({ focused: true }),
    );
  });

  it("does NOT inject windowId for chrome_window action='close' (carve-out)", async () => {
    claimTabForClient('alice', 3001, 88);
    (globalThis.chrome as any).windows.remove = vi.fn(async () => undefined);

    const res = await handleCallTool(
      { name: 'chrome_window', args: { action: 'close' } },
      'req-w5',
      'alice',
    );
    const body = parseBody(res);
    // Tool surfaces its own INVALID_ARGS when windowId is missing — we
    // deliberately did NOT inject lastWindowId.
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect((globalThis.chrome as any).windows.remove).not.toHaveBeenCalled();
  });
});
