import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';
import { captureSession, restoreSession, SESSION_FILE } from './session';
import type { CdpPipe } from './cdp';

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function pipe(result: unknown, error?: { message: string }): { cdp: CdpPipe; calls: Call[] } {
  const calls: Call[] = [];
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return error ? { error } : { result };
    },
  } as unknown as CdpPipe;
  return { cdp, calls };
}

function webCookie(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'hc_probe',
    value: '1',
    domain: '127.0.0.1',
    path: '/',
    sourceScheme: 'NonSecure',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
    session: true,
    ...overrides,
  };
}

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'hc-session-'));
  return path.join(dir, SESSION_FILE);
}

describe('captureSession', () => {
  test('writes 0600 and keeps only web cookies, returning the count', async () => {
    const file = await tempFile();
    const { cdp, calls } = pipe({
      cookies: [
        webCookie(),
        webCookie({ name: 'other' }),
        webCookie({ name: 'ext', sourceScheme: 'Unset' }),
        webCookie({ name: 'devtools', sourceScheme: 'Unset' }),
        webCookie({ name: 'file', sourceScheme: 'Unset' }),
        webCookie({ name: 'https', sourceScheme: 'Secure' }),
      ],
    });
    expect(await captureSession(cdp, file)).toBe(3);
    expect(calls[0].method).toBe('Storage.getCookies');
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
      capturedAt: string;
      cookies: Array<Record<string, unknown>>;
    };
    expect(saved.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(saved.cookies.map((cookie) => cookie.name)).toEqual(['hc_probe', 'other', 'https']);
  });

  test('copies exactly the eight stored fields', async () => {
    const file = await tempFile();
    const { cdp } = pipe({
      cookies: [
        webCookie({
          expires: 1893456000,
          httpOnly: true,
          secure: true,
          sameSite: 'None',
          session: false,
          sourcePort: 4174,
          priority: 'High',
        }),
      ],
    });
    await captureSession(cdp, file);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
      cookies: Array<Record<string, unknown>>;
    };
    expect(Object.keys(saved.cookies[0]).sort()).toEqual([
      'domain',
      'expires',
      'httpOnly',
      'name',
      'path',
      'sameSite',
      'secure',
      'value',
    ]);
    expect(saved.cookies[0]).toEqual({
      name: 'hc_probe',
      value: '1',
      domain: '127.0.0.1',
      path: '/',
      expires: 1893456000,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
  });

  test('drops a cookie whose sourceScheme is not a CDP web-scheme enum', async () => {
    const file = await tempFile();
    const { cdp } = pipe({
      cookies: [
        webCookie({ name: 'raw-url', sourceScheme: 'http' }),
        webCookie({ name: 'no-scheme', sourceScheme: undefined }),
      ],
    });
    expect(await captureSession(cdp, file)).toBe(0);
  });

  test('drops a cookie whose sameSite is not one of the three literals', async () => {
    const file = await tempFile();
    const { cdp } = pipe({
      cookies: [webCookie({ sameSite: 'Lax ' }), webCookie({ sameSite: 1 })],
    });
    expect(await captureSession(cdp, file)).toBe(0);
  });

  test('a session cookie stays a session cookie in the snapshot', async () => {
    const file = await tempFile();
    const { cdp } = pipe({ cookies: [webCookie({ expires: -1 })] });
    await captureSession(cdp, file);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
      cookies: Array<{ expires: number }>;
    };
    expect(saved.cookies[0].expires).toBe(-1);
  });

  test('a CDP error rejects rather than writing an empty snapshot', async () => {
    const file = await tempFile();
    const { cdp } = pipe(undefined, { message: "'Storage.getCookies' wasn't found" });
    await expect(captureSession(cdp, file)).rejects.toThrow(/Storage.getCookies/);
  });
});

describe('restoreSession', () => {
  test('sends exactly the stored cookies and returns the count', async () => {
    const file = await tempFile();
    const cookies = [
      {
        name: 'hc_probe',
        value: '1',
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ];
    await fs.writeFile(file, JSON.stringify({ capturedAt: 'now', cookies }));
    const { cdp, calls } = pipe({});
    expect(await restoreSession(cdp, file)).toBe(1);
    expect(calls).toEqual([{ method: 'Storage.setCookies', params: { cookies } }]);
  });

  test('a missing snapshot is not an error and never reaches CDP', async () => {
    const { cdp, calls } = pipe({});
    expect(
      await restoreSession(cdp, path.join(mkdtempSync(path.join(tmpdir(), 'hc-x-')), 'none')),
    ).toBe(0);
    expect(calls).toEqual([]);
  });

  test('a setter rejection is logged once and never blocks a launch', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = await tempFile();
    await fs.writeFile(file, JSON.stringify({ cookies: [{ name: 'a', value: 'b' }] }));
    const { cdp } = pipe(undefined, { message: 'invalid cookie' });
    expect(await restoreSession(cdp, file, 'p01')).toBe(0);
    expect(errors).toHaveBeenCalledWith(
      'fleet: session restore skipped for p01 (setCookies): invalid cookie',
    );
    errors.mockRestore();
  });

  test('a corrupt snapshot is skipped, not thrown', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = await tempFile();
    await fs.writeFile(file, 'not json');
    const { cdp, calls } = pipe({});
    expect(await restoreSession(cdp, file, 'p02')).toBe(0);
    expect(calls).toEqual([]);
    // The stage is in the message so a read failure and a CDP failure no longer
    // share one string.
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('session restore skipped for p02 (read)'),
    );
    errors.mockRestore();
  });

  test('a send that throws is caught', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = await tempFile();
    await fs.writeFile(file, JSON.stringify({ cookies: [{ name: 'a', value: 'b' }] }));
    const cdp = {
      send: async () => {
        throw new Error('cdp pipe closed');
      },
    } as unknown as CdpPipe;
    expect(await restoreSession(cdp, file, 'p03')).toBe(0);
    expect(errors).toHaveBeenCalledWith(
      'fleet: session restore skipped for p03 (setCookies): cdp pipe closed',
    );
    errors.mockRestore();
  });
});
