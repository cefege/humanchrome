/**
 * chrome_remove_injected_script tests (IMP-0029).
 *
 * Locks the contract: removed:false when nothing was injected; removed:true
 * after a cleanup signal is sent for an injected tab; falls back to the
 * active tab when tabId is omitted; classifies "no tab with id" gracefully.
 *
 * vi.resetModules() per spec gives each case a fresh module-scoped
 * `injectedTabs` map. Seeding goes through the test-only
 * `_seedInjectedTabForTest` export so we don't depend on injectScriptTool's
 * arg shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'remove-injected-script-test-client';

let tabsGetMock: ReturnType<typeof vi.fn>;
let sendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  _resetClientStateForTests();
  tabsGetMock = vi.fn(async (id: number) => ({ id, url: 'https://example.com', windowId: 1 }));
  sendMessageMock = vi.fn().mockResolvedValue(undefined);
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    get: tabsGetMock,
    sendMessage: sendMessageMock,
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
});

afterEach(() => {
  _resetClientStateForTests();
  vi.restoreAllMocks();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

// After vi.resetModules() the test's top-level imports reference the OLD
// module graph. Re-import the helpers through the fresh graph so test code
// claims tabs against the same module instance the tool will read from.
let freshClaimTabForClient: typeof claimTabForClient;
let freshRunWithContext: typeof runWithContext;
let freshResetClientState: typeof _resetClientStateForTests;

async function loadTool() {
  const mod = await import('@/entrypoints/background/tools/browser/inject-script');
  const cs = await import('@/entrypoints/background/utils/client-state');
  const rc = await import('@/entrypoints/background/utils/request-context');
  freshClaimTabForClient = cs.claimTabForClient;
  freshRunWithContext = rc.runWithContext;
  freshResetClientState = cs._resetClientStateForTests;
  freshResetClientState();
  return mod;
}

function exec(mod: any, args: any): Promise<any> {
  const rc = freshRunWithContext ?? runWithContext;
  return rc({ clientId: TEST_CLIENT }, () => mod.removeInjectedScriptTool.execute(args));
}

describe('chrome_remove_injected_script', () => {
  it('returns removed:false when no injection is registered for the tab', async () => {
    const mod = await loadTool();
    const res = await exec(mod,{ tabId: 99 });
    expect(res.isError).toBe(false);
    expect(parseBody(res)).toEqual({ removed: false, tabId: 99 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to the client-owned tab when tabId is omitted', async () => {
    const mod = await loadTool();
    freshClaimTabForClient(TEST_CLIENT, 7, 1);
    const res = await exec(mod, {});
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.tabId).toBe(7);
    expect(body.removed).toBe(false);
    expect(tabsGetMock).toHaveBeenCalled();
  });

  it('returns TAB_NOT_FOUND when no owned tab exists and tabId is omitted', async () => {
    const mod = await loadTool();
    const res = await exec(mod, {});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('removes the injection and sends the cleanup signal for an injected tab', async () => {
    const mod = await loadTool();
    mod._seedInjectedTabForTest(TEST_CLIENT, 7, { type: 'MAIN' as any, jsScript: 'window.__test = 1;' });

    const res = await exec(mod,{ tabId: 7 });
    expect(res.isError).toBe(false);
    expect(parseBody(res)).toEqual({ removed: true, tabId: 7 });

    const cleanupCall = sendMessageMock.mock.calls.find(
      (c) => (c[1] as any)?.type === 'humanchrome:cleanup',
    );
    expect(cleanupCall).toBeTruthy();
    expect(cleanupCall?.[0]).toBe(7);
  });

  it('second remove call after a real removal returns removed:false (idempotent)', async () => {
    const mod = await loadTool();
    mod._seedInjectedTabForTest(TEST_CLIENT, 7, { type: 'MAIN' as any, jsScript: 'window.__test = 1;' });
    await exec(mod,{ tabId: 7 });
    sendMessageMock.mockClear();

    const res = await exec(mod,{ tabId: 7 });
    expect(parseBody(res)).toEqual({ removed: false, tabId: 7 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('treats "no tab with id" during cleanup as removed:true (tab raced closure)', async () => {
    const mod = await loadTool();
    mod._seedInjectedTabForTest(TEST_CLIENT, 7, { type: 'MAIN' as any, jsScript: 'window.__test = 1;' });
    // handleCleanup catches sendMessage rejections internally, so this also
    // exercises the inner-catch path; either way the surface is removed:true.
    sendMessageMock.mockRejectedValueOnce(new Error('No tab with id: 7'));

    const res = await exec(mod,{ tabId: 7 });
    expect(res.isError).toBe(false);
    expect(parseBody(res).removed).toBe(true);
  });
});
