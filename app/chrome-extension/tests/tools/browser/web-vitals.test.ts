/**
 * chrome_web_vitals tests.
 *
 * Lightweight Core Web Vitals collector via PerformanceObserver in MAIN
 * world. Tests stub chrome.scripting.executeScript and chrome.tabs.{query,
 * reload}; the in-page observer is exercised indirectly via canned shim
 * responses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { webVitalsTool } from '@/entrypoints/background/tools/browser/web-vitals';

const SAMPLE_VITALS = {
  ok: true,
  installed: true,
  lcpMs: 1200,
  clsScore: 0.05,
  inpMs: 80,
  fcpMs: 600,
  ttfbMs: 120,
  fidMs: null,
};

let executeScriptMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;
let reloadMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executeScriptMock = vi.fn().mockResolvedValue([{ result: SAMPLE_VITALS }]);
  queryMock = vi.fn().mockResolvedValue([{ id: 7 }]);
  reloadMock = vi.fn().mockResolvedValue(undefined);
  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
    reload: reloadMock,
  };
});

afterEach(() => {
  // shared chrome.tabs / chrome.scripting — leave for other tests
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_web_vitals', () => {
  it('rejects unknown action', async () => {
    const res = await webVitalsTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('start without reload runs the shim in MAIN world', async () => {
    await webVitalsTool.execute({ action: 'start', tabId: 7 });
    expect(reloadMock).not.toHaveBeenCalled();
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        world: 'MAIN',
        args: ['start'],
      }),
    );
  });

  it('start with reload:true reloads the tab first', async () => {
    await webVitalsTool.execute({ action: 'start', tabId: 7, reload: true });
    expect(reloadMock).toHaveBeenCalledWith(7);
  });

  it('snapshot does NOT reload', async () => {
    await webVitalsTool.execute({ action: 'snapshot', tabId: 7, reload: true });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('stop forwards the action verbatim', async () => {
    await webVitalsTool.execute({ action: 'stop', tabId: 7 });
    expect(executeScriptMock).toHaveBeenCalledWith(expect.objectContaining({ args: ['stop'] }));
  });

  it('returns the vitals snapshot from the shim', async () => {
    const body = parseBody(await webVitalsTool.execute({ action: 'snapshot', tabId: 7 }));
    expect(body.lcpMs).toBe(1200);
    expect(body.clsScore).toBe(0.05);
    expect(body.inpMs).toBe(80);
    expect(body.fcpMs).toBe(600);
    expect(body.ttfbMs).toBe(120);
    expect(body.fidMs).toBeNull();
    expect(body.installed).toBe(true);
  });

  it('returns nulls when the shim reports no observer installed yet', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          installed: false,
          lcpMs: null,
          clsScore: null,
          inpMs: null,
          fcpMs: null,
          ttfbMs: null,
          fidMs: null,
        },
      },
    ]);
    const body = parseBody(await webVitalsTool.execute({ action: 'snapshot', tabId: 7 }));
    expect(body.installed).toBe(false);
    expect(body.lcpMs).toBeNull();
  });

  it('falls back to the active tab when no tabId is provided', async () => {
    await webVitalsTool.execute({ action: 'snapshot' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('uses the windowId for active-tab lookup', async () => {
    queryMock.mockResolvedValueOnce([{ id: 99 }]);
    await webVitalsTool.execute({ action: 'snapshot', windowId: 3 });
    expect(queryMock).toHaveBeenCalledWith({ active: true, windowId: 3 });
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await webVitalsTool.execute({ action: 'snapshot', tabId: 99 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('returns TAB_NOT_FOUND when there is no active tab', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await webVitalsTool.execute({ action: 'snapshot' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('returns an error when the shim returns no result', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await webVitalsTool.execute({ action: 'snapshot', tabId: 7 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('no result');
  });

  it('surfaces a shim ok:false', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'PerformanceObserver unavailable' } },
    ]);
    const res = await webVitalsTool.execute({ action: 'start', tabId: 7 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('PerformanceObserver unavailable');
  });
});
