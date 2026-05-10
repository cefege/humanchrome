/**
 * chrome_network_capture status action tests (IMP-0053).
 *
 * Locks the read-only inspection contract: status returns the active
 * backend (debugger | webRequest | null), the count of buffered
 * requests across all tracked tabs, the age of the oldest start time
 * (`sinceMs`), and the tabIds in scope. Critically, calling status
 * MUST NOT touch listeners, timers, or buffered requests — flush/stop
 * are the only mutating actions on the capture state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: vi.fn().mockResolvedValue({}),
    detach: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn().mockResolvedValue(undefined),
    withSession: vi.fn(),
  },
}));

import { networkCaptureStartTool } from '@/entrypoints/background/tools/browser/network-capture-web-request';
import { networkDebuggerStartTool } from '@/entrypoints/background/tools/browser/network-capture-debugger';
import { networkCaptureTool } from '@/entrypoints/background/tools/browser/network-capture';

function clearBackendState() {
  for (const tabId of Array.from(networkCaptureStartTool.captureData.keys())) {
    networkCaptureStartTool.captureData.delete(tabId);
  }
  const dbgPriv = networkDebuggerStartTool as unknown as {
    captureData: Map<number, any>;
  };
  dbgPriv.captureData.clear();
}

function seedWebCapture(tabId: number, requestCount: number, startTime: number) {
  const requests: Record<string, any> = {};
  for (let i = 0; i < requestCount; i++) {
    requests[`r-${tabId}-${i}`] = {
      requestId: `r-${tabId}-${i}`,
      url: `https://example.com/${i}`,
      method: 'GET',
      type: 'xmlhttprequest',
      requestTime: startTime,
    };
  }
  networkCaptureStartTool.captureData.set(tabId, {
    tabId,
    tabUrl: 'https://example.com/',
    tabTitle: 'Example',
    startTime,
    requests,
    maxCaptureTime: 60000,
    inactivityTimeout: 30000,
    includeStatic: false,
    limitReached: false,
    lastFlushAt: null,
  });
}

function seedDebuggerCapture(tabId: number, requestCount: number, startTime: number) {
  const requests: Record<string, any> = {};
  for (let i = 0; i < requestCount; i++) {
    requests[`r-${tabId}-${i}`] = { requestId: `r-${tabId}-${i}` };
  }
  const dbg = networkDebuggerStartTool as unknown as { captureData: Map<number, any> };
  dbg.captureData.set(tabId, {
    startTime,
    tabUrl: 'https://example.com/api',
    tabTitle: 'Api',
    requests,
  });
}

beforeEach(() => {
  clearBackendState();
});

afterEach(() => {
  clearBackendState();
  vi.useRealTimers();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_network_capture action="status"', () => {
  it('returns active=false, backend=null, bufferedCount=0 when nothing is captured', async () => {
    const body = parseBody(await networkCaptureTool.execute({ action: 'status' }));
    expect(body).toEqual({
      active: false,
      backend: null,
      sinceMs: null,
      bufferedCount: 0,
      tabIds: [],
    });
  });

  it('reports the webRequest backend when a webRequest capture is running', async () => {
    seedWebCapture(7, 3, Date.now() - 500);
    const body = parseBody(await networkCaptureTool.execute({ action: 'status' }));
    expect(body.active).toBe(true);
    expect(body.backend).toBe('webRequest');
    expect(body.bufferedCount).toBe(3);
    expect(body.tabIds).toEqual([7]);
    expect(typeof body.sinceMs).toBe('number');
    expect(body.sinceMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the debugger backend when only a debugger capture is running', async () => {
    seedDebuggerCapture(11, 2, Date.now() - 1000);
    const body = parseBody(await networkCaptureTool.execute({ action: 'status' }));
    expect(body.active).toBe(true);
    expect(body.backend).toBe('debugger');
    expect(body.bufferedCount).toBe(2);
    expect(body.tabIds).toEqual([11]);
  });

  it('prefers debugger over webRequest when both are somehow active', async () => {
    seedWebCapture(7, 3, Date.now() - 200);
    seedDebuggerCapture(11, 5, Date.now() - 500);
    const body = parseBody(await networkCaptureTool.execute({ action: 'status' }));
    expect(body.backend).toBe('debugger');
    expect(body.bufferedCount).toBe(5);
    expect(body.tabIds).toEqual([11]);
  });

  it('aggregates bufferedCount and tabIds across multiple captured tabs', async () => {
    seedWebCapture(7, 3, Date.now() - 1000);
    seedWebCapture(8, 4, Date.now() - 500);
    const body = parseBody(await networkCaptureTool.execute({ action: 'status' }));
    expect(body.bufferedCount).toBe(7);
    expect([...body.tabIds].sort()).toEqual([7, 8]);
  });

  it('uses the oldest startTime across tabs for sinceMs', async () => {
    const now = Date.now();
    seedWebCapture(7, 1, now - 5000);
    seedWebCapture(8, 1, now - 2000);
    const body = parseBody(await networkCaptureTool.execute({ action: 'status' }));
    // sinceMs measures from the OLDEST start, so it should be ~5000+
    expect(body.sinceMs).toBeGreaterThanOrEqual(4900);
  });

  it('does NOT mutate buffered request state', async () => {
    seedWebCapture(7, 3, Date.now() - 500);
    const before = Object.keys(networkCaptureStartTool.captureData.get(7)!.requests).length;

    await networkCaptureTool.execute({ action: 'status' });
    await networkCaptureTool.execute({ action: 'status' });

    const after = Object.keys(networkCaptureStartTool.captureData.get(7)!.requests).length;
    expect(after).toBe(before);
    expect(after).toBe(3);
  });

  it('rejects unknown actions with the canonical error', async () => {
    const res = await networkCaptureTool.execute({
      action: 'frobnicate' as any,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('start, stop, flush, status');
  });
});
