/**
 * chrome_intercept_response tests.
 *
 * Covers the two recent bug fixes:
 *   - IMP-0093: response bodies larger than MAX_RESPONSE_BODY_BYTES (1 MiB)
 *     are capped and surfaced via a `responseBodyTruncation` envelope that
 *     mirrors network-capture-debugger.ts. Holds for both single-match and
 *     multi-match paths. JSON parsing is skipped when truncated.
 *   - IMP-0094: a forced CDP detach mid-wait resolves the tool with a
 *     CDP_DETACHED error envelope (not a misleading TIMEOUT) and runs full
 *     cleanup (clears the timer, removes both event listeners, releases the
 *     refcounted CDP session).
 *
 * The tool is event-driven: we mock chrome.debugger.onEvent and onDetach,
 * grab the listener callbacks the tool installs, then drive them by hand
 * to simulate Network.* sequences and onDetach. cdpSessionManager is
 * mocked so we control attach/detach/sendCommand from a single seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_RESPONSE_BODY_BYTES } from '@/entrypoints/background/utils/timeouts';

const sendCommandMock = vi.fn();
const attachMock = vi.fn().mockResolvedValue(undefined);
const detachMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: (...args: unknown[]) => attachMock(...args),
    detach: (...args: unknown[]) => detachMock(...args),
    sendCommand: (...args: unknown[]) => sendCommandMock(...args),
    withSession: vi.fn(),
  },
}));

import { interceptResponseTool } from '@/entrypoints/background/tools/browser/intercept-response';

type DebuggerEventListener = (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: unknown,
) => void;
type DebuggerDetachListener = (source: chrome.debugger.Debuggee, reason: string) => void;

interface ListenerHandles {
  events: DebuggerEventListener[];
  detaches: DebuggerDetachListener[];
}

function installListenerCapture(): ListenerHandles {
  const handles: ListenerHandles = { events: [], detaches: [] };
  const dbg = (globalThis.chrome as any).debugger;
  dbg.onEvent.addListener = vi.fn((cb: DebuggerEventListener) => {
    handles.events.push(cb);
  });
  dbg.onEvent.removeListener = vi.fn((cb: DebuggerEventListener) => {
    handles.events = handles.events.filter((l) => l !== cb);
  });
  dbg.onDetach.addListener = vi.fn((cb: DebuggerDetachListener) => {
    handles.detaches.push(cb);
  });
  dbg.onDetach.removeListener = vi.fn((cb: DebuggerDetachListener) => {
    handles.detaches = handles.detaches.filter((l) => l !== cb);
  });
  return handles;
}

function fireEvent(handles: ListenerHandles, tabId: number, method: string, params?: unknown) {
  // Snapshot the listener list before firing — a listener may removeListener
  // itself during dispatch (e.g. timer/finish paths) and we don't want to
  // mutate-while-iterating.
  for (const cb of [...handles.events]) {
    cb({ tabId } as chrome.debugger.Debuggee, method, params);
  }
}

function fireDetach(handles: ListenerHandles, tabId: number, reason = 'replaced_with_devtools') {
  for (const cb of [...handles.detaches]) {
    cb({ tabId } as chrome.debugger.Debuggee, reason);
  }
}

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  sendCommandMock.mockReset();
  attachMock.mockClear();
  detachMock.mockClear();
  // Default: attach + Network.enable succeed
  sendCommandMock.mockImplementation(async (_tabId: number, method: string) => {
    if (method === 'Network.enable') return {};
    // Network.getResponseBody is overridden per-test.
    return {};
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('chrome_intercept_response — argument validation', () => {
  it('rejects missing urlPattern with INVALID_ARGS', async () => {
    const res = await interceptResponseTool.execute({} as any);
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('INVALID_ARGS');
    expect(body.error.details.arg).toBe('urlPattern');
  });

  it('rejects empty urlPattern with INVALID_ARGS', async () => {
    const res = await interceptResponseTool.execute({ urlPattern: '   ' } as any);
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('INVALID_ARGS');
  });
});

describe('chrome_intercept_response — IMP-0093 response body cap (single-match)', () => {
  it('truncates a body larger than MAX_RESPONSE_BODY_BYTES and emits responseBodyTruncation', async () => {
    const handles = installListenerCapture();
    // Body slightly over the cap so we don't allocate gigabytes in CI.
    const oversize = 'a'.repeat(MAX_RESPONSE_BODY_BYTES + 10_000);
    sendCommandMock.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Network.enable') return {};
      if (method === 'Network.getResponseBody') {
        return { body: oversize, base64Encoded: false };
      }
      return {};
    });

    const promise = interceptResponseTool.execute({
      urlPattern: 'api/big',
      tabId: 42,
      timeoutMs: 5_000,
    });

    // Yield once so attach + Network.enable resolve and the listener is wired.
    await Promise.resolve();
    await Promise.resolve();

    fireEvent(handles, 42, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/api/big', method: 'GET' },
    });
    fireEvent(handles, 42, 'Network.responseReceived', {
      requestId: 'r1',
      response: {
        url: 'https://example.com/api/big',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: {},
      },
    });
    fireEvent(handles, 42, 'Network.loadingFinished', { requestId: 'r1' });

    const res = await promise;
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.ok).toBe(true);
    expect(body.responseBodyTruncation).toBeDefined();
    expect(body.responseBodyTruncation.truncated).toBe(true);
    expect(body.responseBodyTruncation.unit).toBe('bytes');
    expect(body.responseBodyTruncation.limit).toBe(MAX_RESPONSE_BODY_BYTES);
    expect(body.responseBodyTruncation.originalSize).toBe(oversize.length);
    expect(body.responseBodyTruncation.rawAvailable).toBe(true);
    // Capped body must be <= the limit and shorter than the original
    expect(typeof body.body).toBe('string');
    expect((body.body as string).length).toBeLessThanOrEqual(MAX_RESPONSE_BODY_BYTES);
    expect((body.body as string).length).toBeLessThan(oversize.length);
    // JSON parsing is skipped on truncated bodies — even though the MIME
    // type says JSON, the capped slice would be invalid.
    expect(body.bodyParsed).toBe(false);
  });

  it('does not emit responseBodyTruncation when the body fits under the cap', async () => {
    const handles = installListenerCapture();
    sendCommandMock.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Network.enable') return {};
      if (method === 'Network.getResponseBody') {
        return { body: JSON.stringify({ ok: true, items: [1, 2, 3] }), base64Encoded: false };
      }
      return {};
    });

    const promise = interceptResponseTool.execute({
      urlPattern: 'api/small',
      tabId: 7,
      timeoutMs: 5_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    fireEvent(handles, 7, 'Network.requestWillBeSent', {
      requestId: 's1',
      request: { url: 'https://example.com/api/small', method: 'GET' },
    });
    fireEvent(handles, 7, 'Network.responseReceived', {
      requestId: 's1',
      response: {
        url: 'https://example.com/api/small',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: {},
      },
    });
    fireEvent(handles, 7, 'Network.loadingFinished', { requestId: 's1' });

    const res = await promise;
    const body = parseBody(res);
    expect(body.responseBodyTruncation).toBeUndefined();
    expect(body.bodyParsed).toBe(true);
    expect(body.body).toEqual({ ok: true, items: [1, 2, 3] });
  });
});

describe('chrome_intercept_response — IMP-0093 response body cap (multi-match)', () => {
  it('caps each oversize body independently and includes responseBodyTruncation per entry', async () => {
    const handles = installListenerCapture();
    const oversize = 'b'.repeat(MAX_RESPONSE_BODY_BYTES + 5_000);
    sendCommandMock.mockImplementation(async (_tabId: number, method: string, params?: any) => {
      if (method === 'Network.enable') return {};
      if (method === 'Network.getResponseBody') {
        // Both requests return oversize bodies.
        return { body: oversize, base64Encoded: false };
      }
      void params;
      return {};
    });

    const promise = interceptResponseTool.execute({
      urlPattern: 'api/list',
      tabId: 11,
      count: 2,
      timeoutMs: 5_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    for (const id of ['m1', 'm2']) {
      fireEvent(handles, 11, 'Network.requestWillBeSent', {
        requestId: id,
        request: { url: `https://example.com/api/list?p=${id}`, method: 'GET' },
      });
      fireEvent(handles, 11, 'Network.responseReceived', {
        requestId: id,
        response: {
          url: `https://example.com/api/list?p=${id}`,
          status: 200,
          statusText: 'OK',
          mimeType: 'application/json',
          headers: {},
        },
      });
      fireEvent(handles, 11, 'Network.loadingFinished', { requestId: id });
    }

    const res = await promise;
    const body = parseBody(res);
    expect(body.matched).toBe(2);
    expect(Array.isArray(body.responses)).toBe(true);
    for (const r of body.responses) {
      expect(r.responseBodyTruncation).toBeDefined();
      expect(r.responseBodyTruncation.truncated).toBe(true);
      expect(r.responseBodyTruncation.unit).toBe('bytes');
      expect(r.responseBodyTruncation.limit).toBe(MAX_RESPONSE_BODY_BYTES);
      expect(r.bodyParsed).toBe(false);
      expect(typeof r.body).toBe('string');
      expect((r.body as string).length).toBeLessThanOrEqual(MAX_RESPONSE_BODY_BYTES);
    }
  });
});

describe('chrome_intercept_response — IMP-0094 onDetach short-circuits the wait', () => {
  it('resolves with CDP_DETACHED (not TIMEOUT) when the session detaches mid-wait', async () => {
    const handles = installListenerCapture();
    sendCommandMock.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Network.enable') return {};
      return {};
    });

    const start = Date.now();
    const promise = interceptResponseTool.execute({
      urlPattern: 'voyager/api',
      tabId: 99,
      // Long timeout so a misleading TIMEOUT would be visibly wrong.
      timeoutMs: 60_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    // Sanity: the tool actually installed an onDetach listener.
    expect(handles.detaches.length).toBe(1);

    // Simulate Chrome forcibly detaching (user opened DevTools / nav).
    fireDetach(handles, 99, 'replaced_with_devtools');

    const res = await promise;
    const elapsed = Date.now() - start;
    // Should return in well under the 60s timeout.
    expect(elapsed).toBeLessThan(5_000);

    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('CDP_DETACHED');
    expect(body.error.code).not.toBe('TIMEOUT');
    expect(body.error.details.tabId).toBe(99);
    expect(body.error.details.reason).toBe('replaced_with_devtools');
    // The session must have been released so a retry can re-attach cleanly.
    expect(detachMock).toHaveBeenCalled();
  });

  it('removes the onDetach listener as part of cleanup', async () => {
    const handles = installListenerCapture();
    sendCommandMock.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Network.enable') return {};
      return {};
    });

    const promise = interceptResponseTool.execute({
      urlPattern: 'voyager/api',
      tabId: 99,
      timeoutMs: 60_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(handles.detaches.length).toBe(1);
    fireDetach(handles, 99, 'target_closed');
    await promise;

    // Cleanup should have called removeListener on both event + detach
    // listener arrays.
    expect(handles.events.length).toBe(0);
    expect(handles.detaches.length).toBe(0);
  });

  it('ignores onDetach events for unrelated tabs', async () => {
    const handles = installListenerCapture();
    sendCommandMock.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Network.enable') return {};
      if (method === 'Network.getResponseBody') {
        return { body: '{"v":1}', base64Encoded: false };
      }
      return {};
    });

    const promise = interceptResponseTool.execute({
      urlPattern: 'api/v1',
      tabId: 5,
      timeoutMs: 5_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    // Detach event for a DIFFERENT tab should be ignored.
    fireDetach(handles, 6, 'target_closed');

    // Now drive the normal happy path on tab 5.
    fireEvent(handles, 5, 'Network.requestWillBeSent', {
      requestId: 'q1',
      request: { url: 'https://example.com/api/v1', method: 'GET' },
    });
    fireEvent(handles, 5, 'Network.responseReceived', {
      requestId: 'q1',
      response: {
        url: 'https://example.com/api/v1',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: {},
      },
    });
    fireEvent(handles, 5, 'Network.loadingFinished', { requestId: 'q1' });

    const res = await promise;
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.body).toEqual({ v: 1 });
  });

  it('multi-match: returns partial responses when detach fires after some matches collected', async () => {
    const handles = installListenerCapture();
    sendCommandMock.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Network.enable') return {};
      if (method === 'Network.getResponseBody') {
        return { body: '{"i":1}', base64Encoded: false };
      }
      return {};
    });

    const promise = interceptResponseTool.execute({
      urlPattern: 'api/list',
      tabId: 22,
      count: 3,
      timeoutMs: 30_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    // One match completes
    fireEvent(handles, 22, 'Network.requestWillBeSent', {
      requestId: 'k1',
      request: { url: 'https://example.com/api/list?p=1', method: 'GET' },
    });
    fireEvent(handles, 22, 'Network.responseReceived', {
      requestId: 'k1',
      response: {
        url: 'https://example.com/api/list?p=1',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: {},
      },
    });
    fireEvent(handles, 22, 'Network.loadingFinished', { requestId: 'k1' });
    // Yield so the async body-read in the multi-match path resolves and
    // pushes into `completed` before we trigger detach.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Now CDP detaches — we should get a non-error envelope with whatever
    // we collected so far instead of an error.
    fireDetach(handles, 22, 'target_closed');

    const res = await promise;
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.matched).toBe(1);
    expect(body.responses).toHaveLength(1);
  });
});

describe('chrome_intercept_response — happy path still works after fixes', () => {
  it('returns parsed JSON for a normal-sized response', async () => {
    const handles = installListenerCapture();
    sendCommandMock.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Network.enable') return {};
      if (method === 'Network.getResponseBody') {
        return { body: '{"users":[{"id":1}]}', base64Encoded: false };
      }
      return {};
    });

    const promise = interceptResponseTool.execute({
      urlPattern: 'graphql',
      tabId: 1,
      timeoutMs: 5_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    fireEvent(handles, 1, 'Network.requestWillBeSent', {
      requestId: 'g1',
      request: { url: 'https://x.com/graphql', method: 'POST' },
    });
    fireEvent(handles, 1, 'Network.responseReceived', {
      requestId: 'g1',
      response: {
        url: 'https://x.com/graphql',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: {},
      },
    });
    fireEvent(handles, 1, 'Network.loadingFinished', { requestId: 'g1' });

    const res = await promise;
    const body = parseBody(res);
    expect(body.ok).toBe(true);
    expect(body.bodyParsed).toBe(true);
    expect(body.body).toEqual({ users: [{ id: 1 }] });
    expect(body.responseBodyTruncation).toBeUndefined();
  });
});
