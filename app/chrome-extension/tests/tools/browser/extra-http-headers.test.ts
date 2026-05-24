/**
 * chrome_set_extra_http_headers tests (IMP-0142).
 *
 * Covers: arg validation, set+get roundtrip, clear unwinds the tab from
 * the in-memory map AND issues CDP setExtraHTTPHeaders({}), two-tab
 * independence, forbidden-header rejection (with details.header so the
 * caller knows which line tripped), CDP_BUSY classification, list_tabs
 * empty + populated, and chrome.tabs.onRemoved eviction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendCommandMock = vi.fn();
const withSessionMock = vi.fn(
  async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn(),
);

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: (...args: unknown[]) => sendCommandMock(...args),
    withSession: (...args: unknown[]) =>
      withSessionMock(
        args[0] as number,
        args[1] as string,
        args[2] as () => Promise<unknown>,
      ),
  },
}));

import {
  extraHttpHeadersTool,
  _resetExtraHeadersForTests,
} from '@/entrypoints/background/tools/browser/extra-http-headers';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'extra-headers-test-client';
const TAB_ID = 7;

type OnRemovedListener = (tabId: number) => void;
let onRemovedListeners: OnRemovedListener[] = [];

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => extraHttpHeadersTool.execute(args));
}

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  _resetClientStateForTests();
  _resetExtraHeadersForTests();
  onRemovedListeners = [];
  sendCommandMock.mockReset();
  sendCommandMock.mockResolvedValue(undefined);
  withSessionMock.mockClear();

  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: {
        addListener: (cb: OnRemovedListener) => {
          onRemovedListeners.push(cb);
        },
        removeListener: () => undefined,
      },
    },
    windows: { onRemoved: { addListener: () => undefined } },
    runtime: { lastError: undefined },
  };

  claimTabForClient(TEST_CLIENT, TAB_ID, 1);
});

afterEach(() => {
  _resetClientStateForTests();
  _resetExtraHeadersForTests();
});

describe('chrome_set_extra_http_headers — validation', () => {
  it('rejects an invalid action', async () => {
    const res = await exec({ action: 'invalid' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('action');
  });

  it('action=set rejects missing headers map', async () => {
    const res = await exec({ action: 'set' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('headers');
  });

  it('action=set rejects an empty headers map (use clear instead)', async () => {
    const res = await exec({ action: 'set', headers: {} });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('cannot be empty');
  });

  it('action=set rejects non-string values', async () => {
    const res = await exec({ action: 'set', headers: { 'X-Foo': 42 as any } });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.header).toBe('X-Foo');
  });

  it('rejects forbidden headers (case-insensitive) with details.header', async () => {
    const res = await exec({
      action: 'set',
      headers: { Authorization: 'Bearer t', 'CONTENT-Length': '0' },
    });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.details?.header).toBe('CONTENT-Length');
  });
});

describe('chrome_set_extra_http_headers — happy paths', () => {
  it('set installs the CDP override and reflects via get', async () => {
    const setRes = await exec({
      action: 'set',
      headers: { Authorization: 'Bearer xyz', 'X-Csrf-Token': 'abc' },
    });
    expect(setRes.isError).toBe(false);
    const setBody = parseBody(setRes);
    expect(setBody.tabId).toBe(TAB_ID);
    expect(setBody.headerCount).toBe(2);
    expect(sendCommandMock).toHaveBeenCalledWith(TAB_ID, 'Network.enable', {});
    expect(sendCommandMock).toHaveBeenCalledWith(TAB_ID, 'Network.setExtraHTTPHeaders', {
      headers: { Authorization: 'Bearer xyz', 'X-Csrf-Token': 'abc' },
    });

    const getRes = await exec({ action: 'get' });
    const getBody = parseBody(getRes);
    expect(getBody.headers).toEqual({ Authorization: 'Bearer xyz', 'X-Csrf-Token': 'abc' });
  });

  it('clear drops the entry AND sends Network.setExtraHTTPHeaders({})', async () => {
    await exec({ action: 'set', headers: { Authorization: 'Bearer xyz' } });
    sendCommandMock.mockClear();

    const clearRes = await exec({ action: 'clear' });
    expect(parseBody(clearRes).cleared).toBe(true);
    expect(sendCommandMock).toHaveBeenCalledWith(TAB_ID, 'Network.setExtraHTTPHeaders', {
      headers: {},
    });

    // A subsequent get returns an empty map.
    const getRes = await exec({ action: 'get' });
    expect(parseBody(getRes).headers).toEqual({});
  });

  it('clear with no prior set is a no-op (cleared:false, no CDP call)', async () => {
    const res = await exec({ action: 'clear' });
    expect(parseBody(res).cleared).toBe(false);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('list_tabs returns every tab carrying overrides', async () => {
    // Empty case
    let res = await exec({ action: 'list_tabs' });
    expect(parseBody(res).tabs).toEqual([]);

    // Populate one
    await exec({ action: 'set', headers: { 'X-One': '1' } });
    res = await exec({ action: 'list_tabs' });
    const body = parseBody(res);
    expect(body.count).toBe(1);
    expect(body.tabs[0]).toEqual({ tabId: TAB_ID, headerCount: 1 });
  });

  it('two tabs are independent (get on tab A does not see tab B)', async () => {
    const SECOND = 99;
    claimTabForClient(TEST_CLIENT, SECOND, 1);

    await exec({ action: 'set', tabId: TAB_ID, headers: { 'X-A': 'A' } });
    await exec({ action: 'set', tabId: SECOND, headers: { 'X-B': 'B' } });

    expect(parseBody(await exec({ action: 'get', tabId: TAB_ID })).headers).toEqual({ 'X-A': 'A' });
    expect(parseBody(await exec({ action: 'get', tabId: SECOND })).headers).toEqual({ 'X-B': 'B' });

    const list = parseBody(await exec({ action: 'list_tabs' }));
    expect(list.count).toBe(2);
  });
});

describe('chrome_set_extra_http_headers — error classification', () => {
  it('classifies "another debugger is already attached" as CDP_BUSY', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const res = await exec({ action: 'set', headers: { Authorization: 'Bearer x' } });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });
});

describe('chrome_set_extra_http_headers — cleanup', () => {
  it('chrome.tabs.onRemoved evicts the per-tab entry', async () => {
    await exec({ action: 'set', headers: { 'X-One': '1' } });
    expect(parseBody(await exec({ action: 'list_tabs' })).count).toBe(1);

    // Fire the onRemoved listener installed at first-call time.
    expect(onRemovedListeners.length).toBeGreaterThan(0);
    for (const cb of onRemovedListeners) cb(TAB_ID);

    expect(parseBody(await exec({ action: 'list_tabs' })).count).toBe(0);
  });
});
