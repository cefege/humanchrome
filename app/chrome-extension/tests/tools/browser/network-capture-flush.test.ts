/**
 * Network capture flush tests (IMP-0028).
 *
 * Targets the new flush action across:
 *   1. The unified `chrome_network_capture` tool (handleFlush)
 *   2. The webRequest backend's flushCapture(tabId)
 *   3. The debugger backend's flushCapture(tabId)
 *
 * The unified tool dispatches to whichever backend is currently active.
 * Both backends share the same drain-but-don't-stop contract: snapshot
 * the buffered requests in the same envelope shape stop returns, then
 * reset only requests + counter + limitReached, leaving listeners,
 * timers, and (for the debugger backend) the CDP session attached.
 *
 * The tests seed the start tools' singleton state directly rather than
 * driving them through chrome.webRequest or chrome.debugger events —
 * we're verifying the flush-vs-stop contract on the public method, not
 * the upstream event plumbing (which is exercised by the existing
 * start/stop suites).
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

import {
  networkCaptureStartTool,
  networkCaptureStopTool,
} from '@/entrypoints/background/tools/browser/network-capture-web-request';
import {
  networkDebuggerStartTool,
  networkDebuggerStopTool,
} from '@/entrypoints/background/tools/browser/network-capture-debugger';
import { networkCaptureTool } from '@/entrypoints/background/tools/browser/network-capture';

interface RawRequest {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  status?: string | number;
  requestTime?: number;
  responseTime?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

function seedWebCapture(tabId: number, requests: RawRequest[]) {
  const requestMap: Record<string, any> = {};
  for (const r of requests) {
    requestMap[r.requestId] = { type: 'xmlhttprequest', requestTime: 1000, ...r };
  }
  networkCaptureStartTool.captureData.set(tabId, {
    tabId,
    tabUrl: 'https://example.com/',
    tabTitle: 'Example',
    startTime: 1000,
    requests: requestMap,
    maxCaptureTime: 60000,
    inactivityTimeout: 30000,
    includeStatic: false,
    limitReached: false,
    lastFlushAt: null,
  });
  // expose private requestCounters via cast — public on instance
  (
    networkCaptureStartTool as unknown as { requestCounters: Map<number, number> }
  ).requestCounters.set(tabId, requests.length);
}

function readWebBuffer(tabId: number) {
  const info = networkCaptureStartTool.captureData.get(tabId);
  return info ? Object.keys(info.requests).length : -1;
}

function seedDebuggerCapture(tabId: number, requests: RawRequest[]) {
  const requestMap: Record<string, any> = {};
  for (const r of requests) {
    requestMap[r.requestId] = { type: 'xhr', status: 'complete', requestTime: 2000, ...r };
  }
  // captureData and requestCounters are private — cast to seed them.
  const dbg = networkDebuggerStartTool as unknown as {
    captureData: Map<number, any>;
    requestCounters: Map<number, number>;
  };
  dbg.captureData.set(tabId, {
    startTime: 2000,
    tabUrl: 'https://example.com/api',
    tabTitle: 'Api',
    maxCaptureTime: 60000,
    inactivityTimeout: 30000,
    includeStatic: false,
    requests: requestMap,
    limitReached: false,
    lastFlushAt: null,
  });
  dbg.requestCounters.set(tabId, requests.length);
}

function readDebuggerBuffer(tabId: number) {
  const info = (
    networkDebuggerStartTool as unknown as { captureData: Map<number, any> }
  ).captureData.get(tabId);
  return info ? Object.keys(info.requests).length : -1;
}

function clearBackendState() {
  // Wipe every per-tab map on both backends to keep tests isolated.
  for (const tabId of Array.from(networkCaptureStartTool.captureData.keys())) {
    networkCaptureStartTool.captureData.delete(tabId);
  }
  const webPriv = networkCaptureStartTool as unknown as {
    requestCounters: Map<number, number>;
    captureTimers: Map<number, NodeJS.Timeout>;
    inactivityTimers: Map<number, NodeJS.Timeout>;
    lastActivityTime: Map<number, number>;
    listeners: Record<string, unknown>;
  };
  webPriv.requestCounters.clear();
  webPriv.captureTimers.clear();
  webPriv.inactivityTimers.clear();
  webPriv.lastActivityTime.clear();
  webPriv.listeners = {};

  const dbgPriv = networkDebuggerStartTool as unknown as {
    captureData: Map<number, any>;
    requestCounters: Map<number, number>;
    captureTimers: Map<number, NodeJS.Timeout>;
    inactivityTimers: Map<number, NodeJS.Timeout>;
    lastActivityTime: Map<number, number>;
  };
  dbgPriv.captureData.clear();
  dbgPriv.requestCounters.clear();
  dbgPriv.captureTimers.clear();
  dbgPriv.inactivityTimers.clear();
  dbgPriv.lastActivityTime.clear();
}

beforeEach(() => {
  clearBackendState();
  // Stable chrome.tabs mocks for the unified-tool path. The unified tool
  // queries the active tab to pick a primary; provide one that does NOT
  // match any seeded capture so the fallback "first ongoing" branch is
  // exercised by default. Individual tests override when they need the
  // active-tab branch.
  (globalThis.chrome as any).tabs.query = vi.fn().mockResolvedValue([{ id: 999 }]);
});

afterEach(() => {
  clearBackendState();
});

describe('webRequest backend — flushCapture', () => {
  it('returns the buffered requests with stop-shaped envelope and stillActive:true', async () => {
    seedWebCapture(42, [
      { requestId: 'r1', url: 'https://api.example.com/a', method: 'GET' },
      { requestId: 'r2', url: 'https://api.example.com/b', method: 'POST' },
    ]);

    const result = await networkCaptureStartTool.flushCapture(42);

    expect(result.success).toBe(true);
    expect(result.data.flushed).toBe(true);
    expect(result.data.stillActive).toBe(true);
    expect(typeof result.data.flushedAt).toBe('number');
    expect(result.data.requestCount).toBe(2);
    expect(result.data.requests.map((r: any) => r.requestId).sort()).toEqual(['r1', 'r2']);
    expect(result.data.previousFlushAt).toBeNull();
    // shape parity with stop
    expect(result.data.captureStartTime).toBe(1000);
    expect(typeof result.data.captureEndTime).toBe('number');
    expect(result.data.tabUrl).toBe('https://example.com/');
  });

  it('clears the buffer and counter after flush, but keeps the capture entry', async () => {
    seedWebCapture(42, [
      { requestId: 'r1', url: 'https://x', method: 'GET' },
      { requestId: 'r2', url: 'https://y', method: 'GET' },
    ]);

    await networkCaptureStartTool.flushCapture(42);

    expect(readWebBuffer(42)).toBe(0);
    expect(networkCaptureStartTool.captureData.has(42)).toBe(true);
    const counter = (
      networkCaptureStartTool as unknown as { requestCounters: Map<number, number> }
    ).requestCounters.get(42);
    expect(counter).toBe(0);
  });

  it('stamps lastFlushAt and echoes it back as previousFlushAt on the next flush', async () => {
    seedWebCapture(42, [{ requestId: 'r1', url: 'https://x', method: 'GET' }]);

    const first = await networkCaptureStartTool.flushCapture(42);
    expect(first.data.previousFlushAt).toBeNull();
    const firstFlushedAt = first.data.flushedAt;

    // simulate a request arriving after the first flush
    const captureInfo = networkCaptureStartTool.captureData.get(42)!;
    captureInfo.requests['r2'] = {
      requestId: 'r2',
      url: 'https://z',
      method: 'GET',
      type: 'xmlhttprequest',
      requestTime: 5000,
    };

    const second = await networkCaptureStartTool.flushCapture(42);
    expect(second.data.previousFlushAt).toBe(firstFlushedAt);
    expect(second.data.requests.map((r: any) => r.requestId)).toEqual(['r2']);
    expect(second.data.requestCount).toBe(1);
  });

  it('a stop after a flush only returns the post-flush requests (no double counting)', async () => {
    seedWebCapture(42, [{ requestId: 'r1', url: 'https://x', method: 'GET' }]);

    await networkCaptureStartTool.flushCapture(42);

    // post-flush request lands in the now-empty buffer
    networkCaptureStartTool.captureData.get(42)!.requests['r3'] = {
      requestId: 'r3',
      url: 'https://q',
      method: 'GET',
      type: 'xmlhttprequest',
      requestTime: 9000,
    };
    (
      networkCaptureStartTool as unknown as { requestCounters: Map<number, number> }
    ).requestCounters.set(42, 1);

    const stop = await networkCaptureStartTool.stopCapture(42);

    expect(stop.success).toBe(true);
    expect(stop.data.requests.map((r: any) => r.requestId)).toEqual(['r3']);
    expect(stop.data.requestCount).toBe(1);
    // capture is fully torn down after stop
    expect(networkCaptureStartTool.captureData.has(42)).toBe(false);
  });

  it('returns an error when no capture is in progress for that tab', async () => {
    const result = await networkCaptureStartTool.flushCapture(123);
    expect(result.success).toBe(false);
  });

  it('resets limitReached so a long capture does not stay capped after drain', async () => {
    seedWebCapture(42, [{ requestId: 'r1', url: 'https://x', method: 'GET' }]);
    networkCaptureStartTool.captureData.get(42)!.limitReached = true;

    await networkCaptureStartTool.flushCapture(42);

    expect(networkCaptureStartTool.captureData.get(42)!.limitReached).toBe(false);
  });
});

describe('debugger backend — flushCapture', () => {
  it('returns the buffered requests with stillActive:true and clears the buffer', async () => {
    seedDebuggerCapture(7, [
      { requestId: 'd1', url: 'https://api/x', method: 'GET' },
      { requestId: 'd2', url: 'https://api/y', method: 'POST' },
    ]);

    const result = await (
      networkDebuggerStartTool as unknown as { flushCapture: (id: number) => Promise<any> }
    ).flushCapture(7);

    expect(result.success).toBe(true);
    expect(result.data.flushed).toBe(true);
    expect(result.data.stillActive).toBe(true);
    expect(result.data.requestCount).toBe(2);
    expect(readDebuggerBuffer(7)).toBe(0);
    // capture entry persists — session stays attached
    expect(
      (networkDebuggerStartTool as unknown as { captureData: Map<number, any> }).captureData.has(7),
    ).toBe(true);
  });

  it('does not call cdpSessionManager.detach (would tear down the session)', async () => {
    const cdp = await import('@/utils/cdp-session-manager');
    const detach = cdp.cdpSessionManager.detach as unknown as ReturnType<typeof vi.fn>;
    detach.mockClear();

    seedDebuggerCapture(7, [{ requestId: 'd1', url: 'https://api/x', method: 'GET' }]);

    await (
      networkDebuggerStartTool as unknown as { flushCapture: (id: number) => Promise<any> }
    ).flushCapture(7);

    expect(detach).not.toHaveBeenCalled();
  });

  it('returns an error when no capture is in progress for that tab', async () => {
    const result = await (
      networkDebuggerStartTool as unknown as { flushCapture: (id: number) => Promise<any> }
    ).flushCapture(99);
    expect(result.success).toBe(false);
  });
});

describe('unified chrome_network_capture — action: flush', () => {
  it('rejects unknown actions including the empty case', async () => {
    const res = await networkCaptureTool.execute({ action: 'bogus' as any });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/start|stop|flush/);
  });

  it('returns "no active captures" when nothing is running on either backend', async () => {
    const res = await networkCaptureTool.execute({ action: 'flush' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/no active network captures/i);
  });

  it('routes to the webRequest backend when only it is active', async () => {
    seedWebCapture(11, [{ requestId: 'w1', url: 'https://w', method: 'GET' }]);

    const res = await networkCaptureTool.execute({ action: 'flush' });

    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.backend).toBe('webRequest');
    expect(body.flushed).toBe(true);
    expect(body.stillActive).toBe(true);
    expect(body.tabId).toBe(11);
    expect(body.requestCount).toBe(1);
    expect(readWebBuffer(11)).toBe(0);
  });

  it('routes to the debugger backend when only it is active', async () => {
    seedDebuggerCapture(13, [{ requestId: 'd1', url: 'https://d', method: 'GET' }]);

    const res = await networkCaptureTool.execute({ action: 'flush' });

    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.backend).toBe('debugger');
    expect(body.needResponseBody).toBe(true);
    expect(body.requestCount).toBe(1);
    expect(readDebuggerBuffer(13)).toBe(0);
  });

  it('honors needResponseBody:true preference when the debugger backend is the active one', async () => {
    seedDebuggerCapture(13, [{ requestId: 'd1', url: 'https://d', method: 'GET' }]);

    const res = await networkCaptureTool.execute({ action: 'flush', needResponseBody: true });

    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.backend).toBe('debugger');
  });

  it('falls back to the active backend when needResponseBody:true is asked but only webRequest is active', async () => {
    seedWebCapture(11, [{ requestId: 'w1', url: 'https://w', method: 'GET' }]);

    const res = await networkCaptureTool.execute({ action: 'flush', needResponseBody: true });

    // explicit needResponseBody:true with no debugger session → no match, falls through to webRequest
    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.backend).toBe('webRequest');
  });

  it('drains every captured tab when multiple captures are active in the same backend', async () => {
    seedWebCapture(11, [{ requestId: 'a1', url: 'https://a', method: 'GET' }]);
    seedWebCapture(12, [
      { requestId: 'b1', url: 'https://b', method: 'GET' },
      { requestId: 'b2', url: 'https://c', method: 'GET' },
    ]);

    const res = await networkCaptureTool.execute({ action: 'flush' });

    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect([11, 12]).toContain(body.tabId);
    expect(Array.isArray(body.otherFlushes)).toBe(true);
    expect(body.otherFlushes.length).toBe(1);
    // both tabs should now have an empty buffer but stay registered
    expect(readWebBuffer(11)).toBe(0);
    expect(readWebBuffer(12)).toBe(0);
    expect(networkCaptureStartTool.captureData.has(11)).toBe(true);
    expect(networkCaptureStartTool.captureData.has(12)).toBe(true);
  });

  it('prefers the active tab when it is among the ongoing captures', async () => {
    (globalThis.chrome as any).tabs.query = vi.fn().mockResolvedValue([{ id: 12 }]);
    seedWebCapture(11, [{ requestId: 'a1', url: 'https://a', method: 'GET' }]);
    seedWebCapture(12, [{ requestId: 'b1', url: 'https://b', method: 'GET' }]);

    const res = await networkCaptureTool.execute({ action: 'flush' });

    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.tabId).toBe(12);
  });

  it('stop after flush still works through the unified tool', async () => {
    seedWebCapture(11, [{ requestId: 'a1', url: 'https://a', method: 'GET' }]);
    await networkCaptureTool.execute({ action: 'flush' });

    // simulate a post-flush request, then stop via the unified tool.
    networkCaptureStartTool.captureData.get(11)!.requests['a2'] = {
      requestId: 'a2',
      url: 'https://post',
      method: 'GET',
      type: 'xmlhttprequest',
      requestTime: 7000,
    };
    (
      networkCaptureStartTool as unknown as { requestCounters: Map<number, number> }
    ).requestCounters.set(11, 1);

    const res = await networkCaptureTool.execute({ action: 'stop' });

    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.requestCount).toBe(1);
    expect(body.requests.map((r: any) => r.requestId)).toEqual(['a2']);
    expect(networkCaptureStartTool.captureData.has(11)).toBe(false);
  });
});

// Sanity: stop tool wiring isn't broken by the refactor — exercise it
// through the surfaced singleton so the buildResultData refactor is
// validated against the original stop path.
describe('regression: stop still returns the same envelope shape', () => {
  it('webRequest stopCapture envelope includes the historical fields', async () => {
    seedWebCapture(50, [
      { requestId: 's1', url: 'https://s', method: 'GET' },
      { requestId: 's2', url: 'https://t', method: 'GET' },
    ]);

    const res = await networkCaptureStartTool.stopCapture(50);

    expect(res.success).toBe(true);
    expect(res.data.captureStartTime).toBeDefined();
    expect(res.data.captureEndTime).toBeDefined();
    expect(res.data.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(res.data.settingsUsed).toBeDefined();
    expect(res.data.commonRequestHeaders).toBeDefined();
    expect(res.data.commonResponseHeaders).toBeDefined();
    expect(res.data.requestLimitReached).toBe(false);
    expect(res.data.tabUrl).toBe('https://example.com/');
    expect(res.data.tabTitle).toBe('Example');
    expect(res.data.requestCount).toBe(2);
  });

  it('debugger stopCapture envelope includes stoppedBy and historical fields', async () => {
    seedDebuggerCapture(60, [{ requestId: 'd1', url: 'https://d', method: 'GET' }]);

    const res = await (
      networkDebuggerStartTool as unknown as {
        stopCapture: (id: number, auto?: boolean) => Promise<any>;
      }
    ).stopCapture(60, false);

    expect(res.success).toBe(true);
    expect(res.data.stoppedBy).toBe('user_request');
    expect(res.data.captureStartTime).toBeDefined();
    expect(res.data.requestCount).toBe(1);
    expect(res.data.tabUrl).toBe('https://example.com/api');
  });
});

// Touch unused imports so they remain typed without dead-code complaints.
void networkCaptureStopTool;
void networkDebuggerStopTool;
