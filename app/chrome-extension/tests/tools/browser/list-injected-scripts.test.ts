/**
 * chrome_list_injected_scripts tests (IMP-0041).
 *
 * The new tool is a pure read of the in-memory `injectedTabs` Map that
 * `chrome_inject_script` and `chrome_send_command_to_inject_script`
 * already maintain. To exercise it we exercise the inject pipeline so
 * the Map is populated through the public API rather than poking at
 * internals — the test then asserts the list tool reflects the state.
 *
 * The inject pipeline calls chrome.scripting.executeScript and
 * chrome.tabs.sendMessage; both are stubbed. Each test resets modules
 * so the module-scoped Map starts empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ListResult {
  injectedTabs: Array<{
    tabId: number;
    world: 'MAIN' | 'ISOLATED';
    scriptLength: number;
    injectedAt: number;
  }>;
  count: number;
}

function installChromeMock() {
  (globalThis.chrome as any).tabs.query = vi
    .fn()
    .mockResolvedValue([{ id: 1, url: 'https://example.com/' }]);
  (globalThis.chrome as any).tabs.get = vi.fn(async (id: number) => ({
    id,
    url: `https://tab-${id}.example/`,
  }));
  (globalThis.chrome as any).tabs.update = vi.fn().mockResolvedValue({});
  (globalThis.chrome as any).tabs.sendMessage = vi.fn().mockResolvedValue({ ok: true });
  (globalThis.chrome as any).tabs.create = vi.fn().mockResolvedValue({ id: 100 });
  (globalThis.chrome as any).windows = {
    update: vi.fn().mockResolvedValue({}),
  };
  (globalThis.chrome as any).scripting = {
    executeScript: vi.fn().mockResolvedValue([{ result: undefined }]),
  };
  // For the chrome.tabs.onRemoved listener registered at module load.
  (globalThis.chrome as any).tabs.onRemoved = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

async function loadModule() {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/inject-script');
}

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  vi.useRealTimers();
});

function parseList(text: string): ListResult {
  return JSON.parse(text);
}

describe('chrome_list_injected_scripts', () => {
  it('returns an empty list when no tabs have injections', async () => {
    const mod = await loadModule();
    const res = await mod.listInjectedScriptsTool.execute({});

    expect(res.isError).toBe(false);
    const body = parseList((res.content[0] as any).text);
    expect(body).toEqual({ injectedTabs: [], count: 0 });
  });

  it('lists every injected tab after sequential inject calls', async () => {
    const mod = await loadModule();

    await mod.injectScriptTool.execute({
      tabId: 11,
      type: 'ISOLATED' as any,
      jsScript: 'const x = 1;',
    });
    await mod.injectScriptTool.execute({
      tabId: 22,
      type: 'MAIN' as any,
      jsScript: 'window.__t = "hi";',
    });

    const res = await mod.listInjectedScriptsTool.execute({});

    expect(res.isError).toBe(false);
    const body = parseList((res.content[0] as any).text);
    expect(body.count).toBe(2);

    const byTab = new Map(body.injectedTabs.map((e) => [e.tabId, e]));
    expect(byTab.get(11)).toMatchObject({
      tabId: 11,
      world: 'ISOLATED',
      scriptLength: 'const x = 1;'.length,
    });
    expect(byTab.get(22)).toMatchObject({
      tabId: 22,
      world: 'MAIN',
      scriptLength: 'window.__t = "hi";'.length,
    });

    // Timestamps are real Date.now() values — assert they're recent + valid.
    for (const entry of body.injectedTabs) {
      expect(entry.injectedAt).toBeGreaterThan(0);
      expect(entry.injectedAt).toBeLessThanOrEqual(Date.now());
    }
  });

  it('returns sorted results by tabId for deterministic iteration', async () => {
    const mod = await loadModule();

    // Inject in a non-monotonic order to prove the sort is real.
    await mod.injectScriptTool.execute({
      tabId: 30,
      type: 'ISOLATED' as any,
      jsScript: '/* a */',
    });
    await mod.injectScriptTool.execute({
      tabId: 10,
      type: 'ISOLATED' as any,
      jsScript: '/* b */',
    });
    await mod.injectScriptTool.execute({
      tabId: 20,
      type: 'ISOLATED' as any,
      jsScript: '/* c */',
    });

    const res = await mod.listInjectedScriptsTool.execute({});
    const body = parseList((res.content[0] as any).text);

    expect(body.injectedTabs.map((e) => e.tabId)).toEqual([10, 20, 30]);
  });

  it('filters by tabId when provided', async () => {
    const mod = await loadModule();

    await mod.injectScriptTool.execute({
      tabId: 11,
      type: 'ISOLATED' as any,
      jsScript: 'a',
    });
    await mod.injectScriptTool.execute({
      tabId: 22,
      type: 'MAIN' as any,
      jsScript: 'b',
    });

    const res = await mod.listInjectedScriptsTool.execute({ tabId: 22 });
    const body = parseList((res.content[0] as any).text);

    expect(body.count).toBe(1);
    expect(body.injectedTabs[0].tabId).toBe(22);
    expect(body.injectedTabs[0].world).toBe('MAIN');
  });

  it('returns an empty list when filtered to a tabId that has no injection', async () => {
    const mod = await loadModule();

    await mod.injectScriptTool.execute({
      tabId: 11,
      type: 'ISOLATED' as any,
      jsScript: 'a',
    });

    const res = await mod.listInjectedScriptsTool.execute({ tabId: 999 });
    const body = parseList((res.content[0] as any).text);

    expect(body).toEqual({ injectedTabs: [], count: 0 });
  });

  it('reflects re-injection: the entry is replaced and injectedAt updates', async () => {
    const mod = await loadModule();

    await mod.injectScriptTool.execute({
      tabId: 11,
      type: 'ISOLATED' as any,
      jsScript: 'a',
    });

    const before = parseList(
      ((await mod.listInjectedScriptsTool.execute({ tabId: 11 })).content[0] as any).text,
    );
    const firstInjectedAt = before.injectedTabs[0].injectedAt;

    // Sleep one ms to make sure Date.now() advances on the second inject.
    await new Promise((r) => setTimeout(r, 2));

    await mod.injectScriptTool.execute({
      tabId: 11,
      type: 'MAIN' as any,
      jsScript: 'longer-script-content',
    });

    const after = parseList(
      ((await mod.listInjectedScriptsTool.execute({ tabId: 11 })).content[0] as any).text,
    );

    expect(after.count).toBe(1);
    expect(after.injectedTabs[0]).toMatchObject({
      tabId: 11,
      world: 'MAIN',
      scriptLength: 'longer-script-content'.length,
    });
    expect(after.injectedTabs[0].injectedAt).toBeGreaterThan(firstInjectedAt);
  });

  it('does not mutate any chrome.* state when called', async () => {
    const mod = await loadModule();

    const scriptingSpy = (globalThis.chrome as any).scripting.executeScript as ReturnType<
      typeof vi.fn
    >;
    const tabsUpdateSpy = (globalThis.chrome as any).tabs.update as ReturnType<typeof vi.fn>;
    const sendMessageSpy = (globalThis.chrome as any).tabs.sendMessage as ReturnType<typeof vi.fn>;

    await mod.injectScriptTool.execute({
      tabId: 11,
      type: 'ISOLATED' as any,
      jsScript: 'a',
    });
    scriptingSpy.mockClear();
    tabsUpdateSpy.mockClear();
    sendMessageSpy.mockClear();

    await mod.listInjectedScriptsTool.execute({});

    expect(scriptingSpy).not.toHaveBeenCalled();
    expect(tabsUpdateSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});
