/**
 * chrome_basic_auth tests (IMP-0145).
 *
 * Covers arg validation, register installs handler + attaches CDP +
 * enables Fetch with handleAuthRequests:true, listener responds with
 * ProvideCredentials on origin match, "*" wildcard fallback,
 * scheme filter, unmatched origin → Default response, list/unregister/
 * clear actions, password never echoed in success or error envelopes,
 * CDP_BUSY classification.
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
  basicAuthTool,
  _resetBasicAuthForTests,
} from '@/entrypoints/background/tools/browser/basic-auth';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'basic-auth-test-client';
const TAB_ID = 7;
const SECRET = 'hunter2-secret-do-not-leak';

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => basicAuthTool.execute(args));
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
  _resetBasicAuthForTests();
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
  _resetBasicAuthForTests();
});

function fireAuthRequired(
  requestId: string,
  url: string,
  scheme = 'basic',
): Promise<void> {
  const listener = cdpListeners[0];
  if (!listener) throw new Error('no CDP listener installed');
  listener(
    { tabId: TAB_ID } as chrome.debugger.Debuggee,
    'Fetch.authRequired',
    { requestId, request: { url }, authChallenge: { scheme } },
  );
  return new Promise((r) => setImmediate(r));
}

function findCommand(method: string): unknown[] | undefined {
  return sendCommandMock.mock.calls.find((c) => (c as unknown[])[1] === method) as
    | unknown[]
    | undefined;
}

describe('chrome_basic_auth — validation', () => {
  it('rejects unknown action', async () => {
    const res = await exec({ action: 'login' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('action');
  });

  it('register requires origin', async () => {
    const res = await exec({ action: 'register', username: 'u', password: 'p' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('origin');
  });

  it('register requires username', async () => {
    const res = await exec({ action: 'register', origin: 'https://x', password: 'p' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('username');
  });

  it('register requires password', async () => {
    const res = await exec({ action: 'register', origin: 'https://x', username: 'u' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('password');
  });

  it('register rejects unknown scheme', async () => {
    const res = await exec({
      action: 'register',
      origin: 'https://x',
      username: 'u',
      password: 'p',
      scheme: 'oauth' as any,
    });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('scheme');
  });

  it('unregister requires origin', async () => {
    const res = await exec({ action: 'unregister' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('origin');
  });
});

describe('chrome_basic_auth — register + match', () => {
  it('installs handler + attaches CDP + Fetch.enable with handleAuthRequests:true', async () => {
    const res = await exec({
      action: 'register',
      origin: 'https://api.example.com',
      username: 'alice',
      password: SECRET,
    });
    expect(res.isError).toBe(false);
    expect(attachMock).toHaveBeenCalledWith(TAB_ID, 'basic-auth');
    const enableCall = findCommand('Fetch.enable');
    expect(enableCall?.[2]).toMatchObject({
      handleAuthRequests: true,
      patterns: [{ requestStage: 'Request' }],
    });
  });

  it('register response does NOT echo password', async () => {
    const res = await exec({
      action: 'register',
      origin: 'https://api.example.com',
      username: 'alice',
      password: SECRET,
    });
    const text = (res.content[0] as any).text as string;
    expect(text).not.toContain(SECRET);
    const body = parseBody(res);
    expect(body.hasCredential).toBe(true);
    expect(body.username).toBe('alice');
    expect(body.password).toBeUndefined();
  });

  it('exact origin match → continueWithAuth ProvideCredentials', async () => {
    await exec({
      action: 'register',
      origin: 'https://api.example.com',
      username: 'alice',
      password: SECRET,
    });
    sendCommandMock.mockClear();
    await fireAuthRequired('req-1', 'https://api.example.com/secret');
    const call = findCommand('Fetch.continueWithAuth');
    expect(call).toBeDefined();
    const params = call![2] as any;
    expect(params.authChallengeResponse).toEqual({
      response: 'ProvideCredentials',
      username: 'alice',
      password: SECRET,
    });
  });

  it('non-matching origin → continueWithAuth Default (falls through to native dialog)', async () => {
    await exec({
      action: 'register',
      origin: 'https://api.example.com',
      username: 'alice',
      password: SECRET,
    });
    sendCommandMock.mockClear();
    await fireAuthRequired('req-2', 'https://other.example.org/x');
    const call = findCommand('Fetch.continueWithAuth');
    expect(call).toBeDefined();
    const params = call![2] as any;
    expect(params.authChallengeResponse).toEqual({ response: 'Default' });
  });

  it('wildcard "*" matches any origin (when exact misses)', async () => {
    await exec({
      action: 'register',
      origin: '*',
      username: 'fallback',
      password: SECRET,
    });
    sendCommandMock.mockClear();
    await fireAuthRequired('req-3', 'https://anywhere.test/x');
    const call = findCommand('Fetch.continueWithAuth');
    expect(call).toBeDefined();
    const params = call![2] as any;
    expect(params.authChallengeResponse.username).toBe('fallback');
  });

  it('scheme filter — basic-only does not match digest challenge', async () => {
    await exec({
      action: 'register',
      origin: 'https://x.test',
      username: 'a',
      password: SECRET,
      scheme: 'basic',
    });
    sendCommandMock.mockClear();
    await fireAuthRequired('req-4', 'https://x.test/y', 'digest');
    const params = findCommand('Fetch.continueWithAuth')![2] as any;
    expect(params.authChallengeResponse).toEqual({ response: 'Default' });
  });
});

describe('chrome_basic_auth — list / unregister / clear', () => {
  it('list echoes registered origins WITHOUT passwords', async () => {
    await exec({
      action: 'register',
      origin: 'https://api.example.com',
      username: 'alice',
      password: SECRET,
    });
    const listRes = await exec({ action: 'list' });
    const text = (listRes.content[0] as any).text as string;
    expect(text).not.toContain(SECRET);
    const body = parseBody(listRes);
    expect(body.count).toBe(1);
    expect(body.credentials[0]).toMatchObject({
      origin: 'https://api.example.com',
      hasCredential: true,
      scheme: 'any',
    });
    expect(body.credentials[0].password).toBeUndefined();
  });

  it('list increments matchCount per fired auth challenge', async () => {
    await exec({
      action: 'register',
      origin: 'https://api.test',
      username: 'a',
      password: 'p',
    });
    await fireAuthRequired('rq1', 'https://api.test/a');
    await fireAuthRequired('rq2', 'https://api.test/b');
    const list = parseBody(await exec({ action: 'list' }));
    expect(list.credentials[0].matchCount).toBe(2);
  });

  it('unregister drops one origin', async () => {
    await exec({ action: 'register', origin: 'https://a.test', username: 'a', password: '1' });
    await exec({ action: 'register', origin: 'https://b.test', username: 'b', password: '2' });
    const res = parseBody(await exec({ action: 'unregister', origin: 'https://a.test' }));
    expect(res.removed).toBe(true);
    const list = parseBody(await exec({ action: 'list' }));
    expect(list.count).toBe(1);
  });

  it('unregister of unknown origin is no-op (removed:false)', async () => {
    await exec({ action: 'register', origin: 'https://a.test', username: 'a', password: '1' });
    const res = parseBody(await exec({ action: 'unregister', origin: 'https://unknown.test' }));
    expect(res.removed).toBe(false);
  });

  it('clear drops all + Fetch.disable + detach', async () => {
    await exec({ action: 'register', origin: 'https://a.test', username: 'a', password: '1' });
    await exec({ action: 'register', origin: 'https://b.test', username: 'b', password: '2' });
    const res = parseBody(await exec({ action: 'clear' }));
    expect(res.cleared).toBe(2);
    expect(findCommand('Fetch.disable')).toBeDefined();
    expect(detachMock).toHaveBeenCalledWith(TAB_ID, 'basic-auth');
  });
});

describe('chrome_basic_auth — security + errors', () => {
  it('classifies "Another debugger" as CDP_BUSY', async () => {
    attachMock.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const res = await exec({
      action: 'register',
      origin: 'https://x',
      username: 'a',
      password: SECRET,
    });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
    // Error envelope must not leak the password.
    expect((res.content[0] as any).text).not.toContain(SECRET);
  });

  it('error message redacts the password verbatim string', async () => {
    attachMock.mockRejectedValueOnce(new Error(`some failure including ${SECRET} in the middle`));
    const res = await exec({
      action: 'register',
      origin: 'https://x',
      username: 'a',
      password: SECRET,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('<redacted>');
    expect((res.content[0] as any).text).not.toContain(SECRET);
  });
});
