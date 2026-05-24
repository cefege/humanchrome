/**
 * chrome_mock_response tests (IMP-0128).
 *
 * Coverage: arg validation, register installs handler + attaches CDP +
 * enables Fetch, listener fulfills matching requests with synthesized
 * body, bodyJson auto-serializes + sets content-type, list_mocks
 * echoes the registry, unregister_mock drops one handler, clear drops
 * all + detaches CDP on last, once auto-unregisters after first match,
 * mismatch passes through via Fetch.continueRequest, method filter,
 * CDP_BUSY classification, mutex body+bodyJson.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendCommandMock = vi.fn(async () => undefined);
const attachMock = vi.fn(async () => undefined);
const detachMock = vi.fn(async () => undefined);

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: (...args: unknown[]) => (sendCommandMock as (...a: unknown[]) => unknown)(...args),
    attach: (...args: unknown[]) => (attachMock as (...a: unknown[]) => unknown)(...args),
    detach: (...args: unknown[]) => (detachMock as (...a: unknown[]) => unknown)(...args),
    withSession: vi.fn(),
  },
}));

import {
  mockResponseTool,
  _resetMockResponseForTests,
} from '@/entrypoints/background/tools/browser/mock-response';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'mock-resp-test-client';
const TAB_ID = 7;

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => mockResponseTool.execute(args));
}
function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

type DebuggerEventListener = (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: unknown,
) => void;
let cdpListeners: DebuggerEventListener[] = [];

beforeEach(() => {
  _resetClientStateForTests();
  _resetMockResponseForTests();
  cdpListeners = [];
  sendCommandMock.mockReset();
  sendCommandMock.mockResolvedValue(undefined);
  attachMock.mockClear();
  detachMock.mockClear();
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: { addListener: () => undefined },
    },
    debugger: {
      onEvent: {
        addListener: (cb: DebuggerEventListener) => {
          cdpListeners.push(cb);
        },
        removeListener: (cb: DebuggerEventListener) => {
          cdpListeners = cdpListeners.filter((l) => l !== cb);
        },
      },
    },
    windows: { onRemoved: { addListener: () => undefined } },
    runtime: { lastError: undefined },
  };
  claimTabForClient(TEST_CLIENT, TAB_ID, 1);
});

afterEach(() => {
  _resetClientStateForTests();
  _resetMockResponseForTests();
});

function firePaused(requestId: string, url: string, method = 'GET'): Promise<void> {
  const listener = cdpListeners[0];
  if (!listener) throw new Error('no CDP listener installed');
  listener(
    { tabId: TAB_ID } as chrome.debugger.Debuggee,
    'Fetch.requestPaused',
    { requestId, request: { url, method } },
  );
  // Listener is fire-and-forget — give microtasks a chance to drain.
  return new Promise((r) => setImmediate(r));
}

describe('chrome_mock_response — validation', () => {
  it('rejects unknown action', async () => {
    const res = await exec({ action: 'rewrite' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('action');
  });

  it('register requires urlPattern', async () => {
    const res = await exec({ action: 'register' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('urlPattern');
  });

  it('register rejects body + bodyJson together', async () => {
    const res = await exec({
      action: 'register',
      urlPattern: 'foo',
      body: 'a',
      bodyJson: { a: 1 },
    });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('body|bodyJson');
  });

  it('unregister_mock requires handlerId', async () => {
    const res = await exec({ action: 'unregister_mock' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('handlerId');
  });
});

describe('chrome_mock_response — register + fulfill', () => {
  it('installs handler, attaches CDP + Fetch.enable, fulfills matching request', async () => {
    const res = await exec({
      action: 'register',
      urlPattern: '/api/users',
      bodyJson: { ok: true },
      status: 201,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(typeof body.handlerId).toBe('string');
    expect(body.status).toBe(201);

    // attach + Fetch.enable were issued on first handler.
    expect(attachMock).toHaveBeenCalledWith(TAB_ID, 'mock-response');
    const enableCall = sendCommandMock.mock.calls.find((c) => (c as unknown[])[1] === 'Fetch.enable');
    expect((enableCall as unknown[])?.[2]).toEqual({ patterns: [{ requestStage: 'Request' }] });

    sendCommandMock.mockClear();

    // Fire a matching paused request → tool calls Fetch.fulfillRequest
    // with the encoded body + headers.
    await firePaused('req-1', 'https://example.com/api/users');
    const fulfillCall = sendCommandMock.mock.calls.find((c) => (c as unknown[])[1] === 'Fetch.fulfillRequest');
    expect(fulfillCall).toBeDefined();
    const params = (fulfillCall as unknown[])![2] as any;
    expect(params.requestId).toBe('req-1');
    expect(params.responseCode).toBe(201);
    // base64 of '{"ok":true}' is 'eyJvayI6dHJ1ZX0='.
    expect(params.body).toBe('eyJvayI6dHJ1ZX0=');
    // bodyJson auto-set Content-Type:application/json.
    expect(params.responseHeaders).toEqual(
      expect.arrayContaining([{ name: 'Content-Type', value: 'application/json' }]),
    );
  });

  it('respects caller-supplied content-type over bodyJson default', async () => {
    await exec({
      action: 'register',
      urlPattern: '/x',
      bodyJson: { a: 1 },
      headers: { 'content-type': 'application/vnd.api+json' },
    });
    sendCommandMock.mockClear();
    await firePaused('req-2', 'https://example.com/x');
    const fulfill = sendCommandMock.mock.calls.find((c) => (c as unknown[])[1] === 'Fetch.fulfillRequest');
    const params = (fulfill as unknown[])![2] as any;
    // The lowercase content-type the caller supplied is the one that survived.
    const ct = params.responseHeaders.find(
      (h: any) => h.name.toLowerCase() === 'content-type',
    );
    expect(ct.value).toBe('application/vnd.api+json');
    // And the default 'Content-Type:application/json' is NOT also present.
    expect(
      params.responseHeaders.filter((h: any) => h.name.toLowerCase() === 'content-type'),
    ).toHaveLength(1);
  });

  it('method filter — only matches when method matches (case-insensitive)', async () => {
    await exec({
      action: 'register',
      urlPattern: '/x',
      method: 'POST',
      body: '{}',
    });
    sendCommandMock.mockClear();
    await firePaused('req-3', 'https://example.com/x', 'GET');
    // GET should pass through (continueRequest), not fulfill.
    expect(sendCommandMock.mock.calls.some((c) => (c as unknown[])[1] === 'Fetch.fulfillRequest')).toBe(false);
    expect(sendCommandMock.mock.calls.some((c) => (c as unknown[])[1] === 'Fetch.continueRequest')).toBe(true);

    sendCommandMock.mockClear();
    await firePaused('req-4', 'https://example.com/x', 'post');
    expect(sendCommandMock.mock.calls.some((c) => (c as unknown[])[1] === 'Fetch.fulfillRequest')).toBe(true);
  });

  it('non-matching URL is allowed through via Fetch.continueRequest', async () => {
    await exec({ action: 'register', urlPattern: '/api/users', body: 'mock' });
    sendCommandMock.mockClear();
    await firePaused('req-5', 'https://example.com/unrelated');
    expect(sendCommandMock.mock.calls.some((c) => (c as unknown[])[1] === 'Fetch.fulfillRequest')).toBe(false);
    expect(sendCommandMock.mock.calls.some((c) => (c as unknown[])[1] === 'Fetch.continueRequest')).toBe(true);
  });

  it('once:true auto-unregisters after first match + detaches CDP', async () => {
    await exec({ action: 'register', urlPattern: '/x', body: 'one', once: true });
    sendCommandMock.mockClear();

    await firePaused('req-6', 'https://example.com/x');
    expect(sendCommandMock.mock.calls.some((c) => (c as unknown[])[1] === 'Fetch.fulfillRequest')).toBe(true);
    // The handler should be gone — list_mocks returns 0.
    const list = parseBody(await exec({ action: 'list_mocks' }));
    expect(list.count).toBe(0);
    // Fetch.disable + detach were issued when handler count hit zero.
    expect(sendCommandMock.mock.calls.some((c) => (c as unknown[])[1] === 'Fetch.disable')).toBe(true);
    expect(detachMock).toHaveBeenCalledWith(TAB_ID, 'mock-response');
  });

  it('once:false keeps fulfilling across multiple matches', async () => {
    await exec({ action: 'register', urlPattern: '/x', body: 'persistent', once: false });
    sendCommandMock.mockClear();
    await firePaused('a', 'https://example.com/x');
    await firePaused('b', 'https://example.com/x');
    const fulfills = sendCommandMock.mock.calls.filter((c) => (c as unknown[])[1] === 'Fetch.fulfillRequest');
    expect(fulfills).toHaveLength(2);
  });
});

describe('chrome_mock_response — list / unregister / clear', () => {
  it('list_mocks echoes registered handlers + matchCount', async () => {
    const reg = parseBody(await exec({ action: 'register', urlPattern: '/x', body: 'a', once: false }));
    await firePaused('rq', 'https://example.com/x');
    const list = parseBody(await exec({ action: 'list_mocks' }));
    expect(list.count).toBe(1);
    expect(list.mocks[0].handlerId).toBe(reg.handlerId);
    expect(list.mocks[0].matchCount).toBe(1);
  });

  it('unregister_mock drops the specific handler', async () => {
    const a = parseBody(await exec({ action: 'register', urlPattern: '/a', body: 'a', once: false }));
    const b = parseBody(await exec({ action: 'register', urlPattern: '/b', body: 'b', once: false }));
    const res = parseBody(await exec({ action: 'unregister_mock', handlerId: a.handlerId }));
    expect(res.removed).toBe(true);
    const list = parseBody(await exec({ action: 'list_mocks' }));
    expect(list.count).toBe(1);
    expect(list.mocks[0].handlerId).toBe(b.handlerId);
  });

  it('unregister_mock on unknown handlerId is a no-op (removed:false)', async () => {
    await exec({ action: 'register', urlPattern: '/x', body: 'a' });
    const res = parseBody(await exec({ action: 'unregister_mock', handlerId: 'mock_unknown' }));
    expect(res.removed).toBe(false);
  });

  it('clear drops all handlers + detaches CDP', async () => {
    await exec({ action: 'register', urlPattern: '/a', body: 'a', once: false });
    await exec({ action: 'register', urlPattern: '/b', body: 'b', once: false });
    const res = parseBody(await exec({ action: 'clear' }));
    expect(res.cleared).toBe(2);
    expect(sendCommandMock.mock.calls.some((c) => (c as unknown[])[1] === 'Fetch.disable')).toBe(true);
    expect(detachMock).toHaveBeenCalledWith(TAB_ID, 'mock-response');
  });

  it('clear with no handlers returns cleared:0 and does not touch CDP', async () => {
    sendCommandMock.mockClear();
    detachMock.mockClear();
    const res = parseBody(await exec({ action: 'clear' }));
    expect(res.cleared).toBe(0);
    expect(detachMock).not.toHaveBeenCalled();
  });
});

describe('chrome_mock_response — CDP errors', () => {
  it('classifies "Another debugger" as CDP_BUSY', async () => {
    attachMock.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const res = await exec({ action: 'register', urlPattern: '/x', body: '{}' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });
});
