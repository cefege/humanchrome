/**
 * chrome_locator_handler tests (IMP-0101).
 *
 * The tool keeps a background-side `Map<tabId, Map<handlerId, RegisteredHandler>>`
 * and injects `inject-scripts/locator-handler.js` into the target tab. The
 * inject + sendMessage path is tested indirectly elsewhere; here we spy on
 * the `BaseBrowserToolExecutor` helpers (`injectContentScript` and
 * `sendMessageToTab`) so each test exercises the tool's own logic — arg
 * validation, per-tab/per-handler state, persistent replay, listener cleanup —
 * without re-asserting how the base class wires `chrome.scripting.executeScript`
 * to `chrome.tabs.sendMessage`. Same pattern as `keyboard-shortcuts.test.ts`.
 *
 * Each test resets the module so the per-session monotonic handlerId counter
 * starts from 1 — making the assertions human-readable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'locator-handler-test-client';

let injectMock: ReturnType<typeof vi.fn>;
let sendMessageToTabMock: ReturnType<typeof vi.fn>;
let tabsGetMock: ReturnType<typeof vi.fn>;
let tabsOnRemovedAddListener: ReturnType<typeof vi.fn>;
let webNavOnDOMContentLoadedAddListener: ReturnType<typeof vi.fn>;
let onRemovedHandler: ((tabId: number) => void) | undefined;
let onDOMContentLoadedHandler:
  | ((details: { tabId: number; frameId: number }) => Promise<void> | void)
  | undefined;

function execMod(mod: any, args: any): Promise<any> {
  const rc = freshRunWithContext ?? runWithContext;
  return rc({ clientId: TEST_CLIENT }, () => mod.locatorHandlerTool.execute(args));
}

function installChromeMock() {
  onRemovedHandler = undefined;
  onDOMContentLoadedHandler = undefined;
  tabsOnRemovedAddListener = vi.fn((cb: (tabId: number) => void) => {
    onRemovedHandler = cb;
  });
  webNavOnDOMContentLoadedAddListener = vi.fn(
    (cb: (details: { tabId: number; frameId: number }) => Promise<void> | void) => {
      onDOMContentLoadedHandler = cb;
    },
  );

  tabsGetMock = vi.fn(async (id: number) => ({ id, url: 'https://example.com/', windowId: 1 }));

  (globalThis.chrome as any).scripting = { executeScript: vi.fn().mockResolvedValue([]) };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    get: tabsGetMock,
    sendMessage: vi.fn().mockResolvedValue({ status: 'pong' }),
    onRemoved: {
      addListener: tabsOnRemovedAddListener,
      removeListener: vi.fn(),
    },
  };
  (globalThis.chrome as any).webNavigation = {
    onDOMContentLoaded: {
      addListener: webNavOnDOMContentLoadedAddListener,
      removeListener: vi.fn(),
    },
  };
}

function installInstrumentation(mod: any) {
  injectMock = vi.fn().mockResolvedValue(undefined);
  // Default sendMessageToTab response shapes for each in-page message verb.
  // Per-test overrides via mockResolvedValueOnce / mockImplementationOnce win.
  sendMessageToTabMock = vi.fn(async (_tabId: number, msg: any) => {
    if (msg?.action === 'locator_handler_register') return { success: true };
    if (msg?.action === 'locator_handler_list') {
      return { success: true, handlers: [], count: 0 };
    }
    if (msg?.action === 'locator_handler_remove') return { success: true, removed: true };
    if (msg?.action === 'locator_handler_clear') return { success: true, cleared: 0 };
    return { success: true };
  });
  vi.spyOn(mod.locatorHandlerTool as any, 'injectContentScript').mockImplementation(
    injectMock as any,
  );
  vi.spyOn(mod.locatorHandlerTool as any, 'sendMessageToTab').mockImplementation(
    sendMessageToTabMock as any,
  );
}

// After vi.resetModules() the test's top-level imports of `client-state` and
// `request-context` reference the OLD module graph. Re-import them through the
// fresh graph and stash the helpers so test code can claim tabs against the
// same module instance the tool will read from.
let freshClaimTabForClient: typeof claimTabForClient;
let freshRunWithContext: typeof runWithContext;
let freshResetClientState: typeof _resetClientStateForTests;

async function loadModule() {
  vi.resetModules();
  const mod = await import('@/entrypoints/background/tools/browser/locator-handler');
  const cs = await import('@/entrypoints/background/utils/client-state');
  const rc = await import('@/entrypoints/background/utils/request-context');
  freshClaimTabForClient = cs.claimTabForClient;
  freshRunWithContext = rc.runWithContext;
  freshResetClientState = cs._resetClientStateForTests;
  freshResetClientState();
  installInstrumentation(mod);
  return mod;
}

beforeEach(() => {
  _resetClientStateForTests();
  installChromeMock();
});

afterEach(() => {
  _resetClientStateForTests();
  vi.restoreAllMocks();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_locator_handler: arg validation', () => {
  it('rejects an unknown action', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{ action: 'whatever' as any });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
    expect((res.content[0] as any).text).toContain('action');
  });

  it('register requires selector', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{
      action: 'register',
      dismissSelector: '.close',
      tabId: 7,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('selector');
  });

  it('register requires dismissSelector', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{
      action: 'register',
      selector: '.banner',
      tabId: 7,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('dismissSelector');
  });

  it('register with dismissAction="press" requires key', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.banner',
      dismissAction: 'press',
      tabId: 7,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('key');
  });

  it('register rejects non-positive `times`', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      tabId: 7,
      times: 0,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('times');
  });

  it('remove requires handlerId', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{ action: 'remove', tabId: 7 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('handlerId');
  });
});

describe('chrome_locator_handler: register', () => {
  it('returns a monotonic handlerId and forwards register payload to the page', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{
      action: 'register',
      selector: '#cookie-banner',
      dismissSelector: '.accept-all',
      tabId: 7,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.handlerId).toBe('lh_1');
    expect(body.tabId).toBe(7);
    expect(body.handler.selector).toBe('#cookie-banner');
    expect(body.handler.dismissSelector).toBe('.accept-all');
    expect(body.handler.dismissAction).toBe('click');
    expect(body.handler.persistent).toBe(false);
    expect(body.handler.times).toBeNull();

    // The page register payload should match.
    expect(sendMessageToTabMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: 'locator_handler_register',
        handlerId: 'lh_1',
        selector: '#cookie-banner',
        dismissSelector: '.accept-all',
        dismissAction: 'click',
      }),
    );
    // Helper file should have been injected.
    expect(injectMock).toHaveBeenCalledWith(
      7,
      ['inject-scripts/locator-handler.js'],
      false,
      'ISOLATED',
      false,
    );
  });

  it('register with persistent + dismissAction="press" + key + times forwards every field', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{
      action: 'register',
      selector: '.modal-wrapper',
      dismissSelector: '.modal-wrapper',
      dismissAction: 'press',
      key: 'Escape',
      times: 3,
      persistent: true,
      tabId: 7,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.handler.persistent).toBe(true);
    expect(body.handler.dismissAction).toBe('press');
    expect(body.handler.key).toBe('Escape');
    expect(body.handler.times).toBe(3);
    expect(body.handler.timesRemaining).toBe(3);

    expect(sendMessageToTabMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: 'locator_handler_register',
        dismissAction: 'press',
        key: 'Escape',
        times: 3,
        persistent: true,
      }),
    );
  });

  it('falls back to the client-owned tab when tabId is omitted', async () => {
    const mod = await loadModule();
    freshClaimTabForClient(TEST_CLIENT, 7, 1);
    await execMod(mod, {
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
    });
    expect(tabsGetMock).toHaveBeenCalledWith(7);
    expect(injectMock).toHaveBeenCalledWith(
      7,
      ['inject-scripts/locator-handler.js'],
      false,
      'ISOLATED',
      false,
    );
  });
});

describe('chrome_locator_handler: list', () => {
  it('returns an empty list when no handlers are registered (no injection)', async () => {
    const mod = await loadModule();
    const res = await execMod(mod,{ action: 'list', tabId: 7 });
    const body = parseBody(res);
    expect(body.handlers).toEqual([]);
    expect(body.count).toBe(0);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('after register, list reflects live dismissedCount from the page', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      tabId: 7,
    });

    // Make the next locator_handler_list call return a live count of 2.
    sendMessageToTabMock.mockImplementationOnce(async (_t: number, msg: any) => {
      if (msg?.action === 'locator_handler_list') {
        return {
          success: true,
          handlers: [
            {
              handlerId: 'lh_1',
              selector: '.banner',
              dismissSelector: '.close',
              dismissAction: 'click',
              key: null,
              times: null,
              timesRemaining: null,
              persistent: false,
              dismissedCount: 2,
              lastDismissedAt: 12345,
              createdAt: 1,
            },
          ],
          count: 1,
        };
      }
      return { success: true };
    });

    const res = await execMod(mod,{ action: 'list', tabId: 7 });
    const body = parseBody(res);
    expect(body.count).toBe(1);
    expect(body.handlers[0].handlerId).toBe('lh_1');
    expect(body.handlers[0].dismissedCount).toBe(2);
    expect(body.handlers[0].lastDismissedAt).toBe(12345);
  });

  it('replays handlers when the page reports an empty live list (navigation reset)', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      persistent: true,
      tabId: 7,
    });

    sendMessageToTabMock.mockClear();
    injectMock.mockClear();

    // First list call returns empty (simulating helper gone after navigation),
    // subsequent list call returns the replayed handler.
    let listCount = 0;
    sendMessageToTabMock.mockImplementation(async (_t: number, msg: any) => {
      if (msg?.action === 'locator_handler_register') return { success: true };
      if (msg?.action === 'locator_handler_list') {
        listCount += 1;
        if (listCount === 1) return { success: true, handlers: [], count: 0 };
        return {
          success: true,
          handlers: [
            {
              handlerId: 'lh_1',
              selector: '.banner',
              dismissSelector: '.close',
              dismissAction: 'click',
              key: null,
              times: null,
              timesRemaining: null,
              persistent: true,
              dismissedCount: 0,
              lastDismissedAt: null,
              createdAt: 1,
            },
          ],
          count: 1,
        };
      }
      return { success: true };
    });

    const res = await execMod(mod,{ action: 'list', tabId: 7 });
    const body = parseBody(res);
    expect(body.count).toBe(1);
    // Replay should have invoked a register message in addition to the two list calls.
    const registerCalls = sendMessageToTabMock.mock.calls.filter(
      ([, m]) => m?.action === 'locator_handler_register',
    );
    expect(registerCalls.length).toBe(1);
  });
});

describe('chrome_locator_handler: remove + clear', () => {
  it('remove drops the handler from background state and forwards to page', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      tabId: 7,
    });
    const before = mod._getLocatorHandlerStateForTest();
    expect(before.tabs[0].handlerIds).toEqual(['lh_1']);

    const res = await execMod(mod,{
      action: 'remove',
      handlerId: 'lh_1',
      tabId: 7,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.removed).toBe(true);
    expect(body.handlerId).toBe('lh_1');

    const after = mod._getLocatorHandlerStateForTest();
    expect(after.tabs).toEqual([]); // tab bucket drained

    // The remove payload should have been forwarded.
    expect(sendMessageToTabMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'locator_handler_remove', handlerId: 'lh_1' }),
    );
  });

  it('clear drops every handler on the tab', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.a',
      dismissSelector: '.x',
      tabId: 7,
    });
    await execMod(mod,{
      action: 'register',
      selector: '.b',
      dismissSelector: '.y',
      tabId: 7,
    });
    const before = mod._getLocatorHandlerStateForTest();
    expect(before.tabs[0].handlerIds.sort()).toEqual(['lh_1', 'lh_2']);

    // Override the next clear response so the test asserts the merged max.
    sendMessageToTabMock.mockImplementationOnce(async (_t: number, msg: any) => {
      if (msg?.action === 'locator_handler_clear') return { success: true, cleared: 2 };
      return { success: true };
    });

    const res = await execMod(mod,{ action: 'clear', tabId: 7 });
    const body = parseBody(res);
    expect(body.cleared).toBe(2);

    const after = mod._getLocatorHandlerStateForTest();
    expect(after.tabs).toEqual([]);
  });
});

describe('chrome_locator_handler: multiple tabs + multiple handlers', () => {
  it('handlers in different tabs do not collide', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.a',
      dismissSelector: '.x',
      tabId: 11,
    });
    await execMod(mod,{
      action: 'register',
      selector: '.b',
      dismissSelector: '.y',
      tabId: 22,
    });
    const state = mod._getLocatorHandlerStateForTest();
    const byTab = new Map(state.tabs.map((t) => [t.tabId, t.handlerIds]));
    expect(byTab.get(11)).toEqual(['lh_1']);
    expect(byTab.get(22)).toEqual(['lh_2']);
  });
});

describe('chrome_locator_handler: tab close cleanup', () => {
  it('drops the tab from state when chrome.tabs.onRemoved fires', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.a',
      dismissSelector: '.x',
      tabId: 7,
    });
    expect(onRemovedHandler).toBeDefined();
    onRemovedHandler!(7);
    const state = mod._getLocatorHandlerStateForTest();
    expect(state.tabs).toEqual([]);
  });
});

describe('chrome_locator_handler: persistent re-injection on navigation', () => {
  it('replays persistent handlers on webNavigation.onDOMContentLoaded (main frame)', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      persistent: true,
      tabId: 7,
    });
    expect(onDOMContentLoadedHandler).toBeDefined();

    sendMessageToTabMock.mockClear();
    injectMock.mockClear();

    await onDOMContentLoadedHandler!({ tabId: 7, frameId: 0 });

    // After navigation the helper should have been re-injected and the
    // register payload re-sent.
    const registerCalls = sendMessageToTabMock.mock.calls.filter(
      ([, m]) => m?.action === 'locator_handler_register',
    );
    expect(registerCalls.length).toBe(1);
    expect(injectMock).toHaveBeenCalledWith(
      7,
      ['inject-scripts/locator-handler.js'],
      false,
      'ISOLATED',
      false,
    );
  });

  it('skips replay for subframe events', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      persistent: true,
      tabId: 7,
    });
    sendMessageToTabMock.mockClear();
    injectMock.mockClear();

    await onDOMContentLoadedHandler!({ tabId: 7, frameId: 99 });

    // No replay for non-main-frame events.
    const registerCalls = sendMessageToTabMock.mock.calls.filter(
      ([, m]) => m?.action === 'locator_handler_register',
    );
    expect(registerCalls.length).toBe(0);
  });

  it('drops non-persistent handlers from state on navigation', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      tabId: 7,
    });
    expect(mod._getLocatorHandlerStateForTest().tabs[0].handlerIds).toEqual(['lh_1']);

    await onDOMContentLoadedHandler!({ tabId: 7, frameId: 0 });

    expect(mod._getLocatorHandlerStateForTest().tabs).toEqual([]);
  });
});

describe('chrome_locator_handler: error classification', () => {
  it('classifies "no tab with id" as TAB_CLOSED and drops the tab from state', async () => {
    const mod = await loadModule();
    await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      tabId: 7,
    });
    expect(mod._getLocatorHandlerStateForTest().tabs[0].handlerIds).toEqual(['lh_1']);

    // Next call: injection rejects with the tab-closed signature.
    injectMock.mockRejectedValueOnce(new Error('No tab with id: 7'));

    const res = await execMod(mod,{
      action: 'register',
      selector: '.banner2',
      dismissSelector: '.close2',
      tabId: 7,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
    // Background state for the dead tab was dropped.
    expect(mod._getLocatorHandlerStateForTest().tabs).toEqual([]);
  });

  it('returns TAB_NOT_FOUND when there is no owned tab and tabId omitted', async () => {
    const mod = await loadModule();
    const res = await execMod(mod, {
      action: 'register',
      selector: '.b',
      dismissSelector: '.c',
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('surfaces in-page register failures as UNKNOWN', async () => {
    const mod = await loadModule();
    sendMessageToTabMock.mockImplementationOnce(async (_t: number, msg: any) => {
      if (msg?.action === 'locator_handler_register') {
        return { success: false, error: 'bad selector' };
      }
      return { success: true };
    });
    const res = await execMod(mod,{
      action: 'register',
      selector: '.banner',
      dismissSelector: '.close',
      tabId: 7,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
    expect((res.content[0] as any).text).toContain('bad selector');
  });
});

describe('chrome_locator_handler: dispatcher contract (mutates)', () => {
  it('declares mutates=true so the dispatcher serializes via the per-tab lock', async () => {
    const mod = await loadModule();
    const ctor = mod.locatorHandlerTool.constructor as { mutates?: boolean };
    expect(ctor.mutates).toBe(true);
  });
});
