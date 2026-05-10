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

let queryMock: ReturnType<typeof vi.fn>;
let sendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  queryMock = vi.fn().mockResolvedValue([{ id: 7, url: 'https://example.com', windowId: 1 }]);
  sendMessageMock = vi.fn().mockResolvedValue(undefined);
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
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
  vi.restoreAllMocks();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

async function loadTool() {
  return await import('@/entrypoints/background/tools/browser/inject-script');
}

describe('chrome_remove_injected_script', () => {
  it('returns removed:false when no injection is registered for the tab', async () => {
    const mod = await loadTool();
    const res = await mod.removeInjectedScriptTool.execute({ tabId: 99 });
    expect(res.isError).toBe(false);
    expect(parseBody(res)).toEqual({ removed: false, tabId: 99 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to the active tab when tabId is omitted', async () => {
    const mod = await loadTool();
    const res = await mod.removeInjectedScriptTool.execute({});
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.tabId).toBe(7);
    expect(body.removed).toBe(false);
    expect(queryMock).toHaveBeenCalled();
  });

  it('returns TAB_NOT_FOUND when no active tab exists and tabId is omitted', async () => {
    queryMock.mockResolvedValueOnce([]);
    const mod = await loadTool();
    const res = await mod.removeInjectedScriptTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('removes the injection and sends the cleanup signal for an injected tab', async () => {
    const mod = await loadTool();
    mod._seedInjectedTabForTest(7, { type: 'MAIN' as any, jsScript: 'window.__test = 1;' });

    const res = await mod.removeInjectedScriptTool.execute({ tabId: 7 });
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
    mod._seedInjectedTabForTest(7, { type: 'MAIN' as any, jsScript: 'window.__test = 1;' });
    await mod.removeInjectedScriptTool.execute({ tabId: 7 });
    sendMessageMock.mockClear();

    const res = await mod.removeInjectedScriptTool.execute({ tabId: 7 });
    expect(parseBody(res)).toEqual({ removed: false, tabId: 7 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('treats "no tab with id" during cleanup as removed:true (tab raced closure)', async () => {
    const mod = await loadTool();
    mod._seedInjectedTabForTest(7, { type: 'MAIN' as any, jsScript: 'window.__test = 1;' });
    // handleCleanup catches sendMessage rejections internally, so this also
    // exercises the inner-catch path; either way the surface is removed:true.
    sendMessageMock.mockRejectedValueOnce(new Error('No tab with id: 7'));

    const res = await mod.removeInjectedScriptTool.execute({ tabId: 7 });
    expect(res.isError).toBe(false);
    expect(parseBody(res).removed).toBe(true);
  });
});
