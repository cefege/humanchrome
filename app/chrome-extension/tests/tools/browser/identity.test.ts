/**
 * chrome_identity tests.
 *
 * Wraps chrome.identity.{getAuthToken, removeCachedAuthToken,
 * getProfileUserInfo}. Tests stub the API and assert the contract,
 * including the placeholder-client_id detection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { identityTool } from '@/entrypoints/background/tools/browser/identity';

let getAuthTokenMock: ReturnType<typeof vi.fn>;
let removeCachedAuthTokenMock: ReturnType<typeof vi.fn>;
let getProfileUserInfoMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getAuthTokenMock = vi
    .fn()
    .mockImplementation((_opts: any, cb: (t: string | { token: string }) => void) =>
      cb('ya29.test-token'),
    );
  removeCachedAuthTokenMock = vi.fn().mockImplementation((_opts: any, cb: () => void) => cb());
  getProfileUserInfoMock = vi
    .fn()
    .mockImplementation((_opts: any, cb: (i: any) => void) =>
      cb({ email: 'agent@example.com', id: 'abc123' }),
    );

  (globalThis.chrome as any).identity = {
    getAuthToken: getAuthTokenMock,
    removeCachedAuthToken: removeCachedAuthTokenMock,
    getProfileUserInfo: getProfileUserInfoMock,
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    lastError: undefined,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).identity;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_identity', () => {
  it('rejects unknown action', async () => {
    const res = await identityTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.identity is undefined', async () => {
    delete (globalThis.chrome as any).identity;
    const res = await identityTool.execute({ action: 'get_profile' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.identity is unavailable');
  });

  it('get_token forwards scopes + interactive=false by default', async () => {
    await identityTool.execute({
      action: 'get_token',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    expect(getAuthTokenMock).toHaveBeenCalledWith(
      {
        interactive: false,
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      },
      expect.any(Function),
    );
  });

  it('get_token forwards interactive=true', async () => {
    await identityTool.execute({ action: 'get_token', interactive: true });
    expect(getAuthTokenMock).toHaveBeenCalledWith({ interactive: true }, expect.any(Function));
  });

  it('get_token returns the token', async () => {
    const body = parseBody(await identityTool.execute({ action: 'get_token' }));
    expect(body.token).toBe('ya29.test-token');
  });

  it('get_token unwraps the {token} object form', async () => {
    getAuthTokenMock.mockImplementationOnce((_o: any, cb: (t: any) => void) =>
      cb({ token: 'unwrapped' }),
    );
    const body = parseBody(await identityTool.execute({ action: 'get_token' }));
    expect(body.token).toBe('unwrapped');
  });

  it('classifies "OAuth2 not granted" as INVALID_ARGS pointing at oauth2.client_id', async () => {
    getAuthTokenMock.mockImplementationOnce((_o: any, _cb: any) => {
      (globalThis.chrome as any).runtime.lastError = { message: 'OAuth2 not granted or revoked.' };
      _cb(undefined);
    });
    const res = await identityTool.execute({ action: 'get_token' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('OAuth2 client_id is not configured');
    expect(text).toContain('HUMANCHROME_OAUTH_CLIENT_ID');
  });

  it('classifies the placeholder client_id error as INVALID_ARGS', async () => {
    getAuthTokenMock.mockImplementationOnce((_o: any, _cb: any) => {
      (globalThis.chrome as any).runtime.lastError = {
        message: 'Bad client_id: __SET_HUMANCHROME_OAUTH_CLIENT_ID__',
      };
      _cb(undefined);
    });
    const res = await identityTool.execute({ action: 'get_token' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('OAuth2 client_id is not configured');
  });

  it('remove_token requires token', async () => {
    const res = await identityTool.execute({ action: 'remove_token' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('token');
  });

  it('remove_token forwards the token to removeCachedAuthToken', async () => {
    await identityTool.execute({ action: 'remove_token', token: 'ya29.x' });
    expect(removeCachedAuthTokenMock).toHaveBeenCalledWith(
      { token: 'ya29.x' },
      expect.any(Function),
    );
  });

  it('get_profile returns email + id', async () => {
    const body = parseBody(await identityTool.execute({ action: 'get_profile' }));
    expect(body.email).toBe('agent@example.com');
    expect(body.id).toBe('abc123');
    expect(getProfileUserInfoMock).toHaveBeenCalledWith(
      { accountStatus: 'ANY' },
      expect.any(Function),
    );
  });

  it('get_profile returns empty strings when the API returns blanks', async () => {
    getProfileUserInfoMock.mockImplementationOnce((_o: any, cb: (i: any) => void) => cb({}));
    const body = parseBody(await identityTool.execute({ action: 'get_profile' }));
    expect(body.email).toBe('');
    expect(body.id).toBe('');
  });
});
