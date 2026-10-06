import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import {
  classifyListAccounts,
  googleSessionLoss,
  probeGoogleSession,
  signinPendingSince,
} from './google-session';

/**
 * One ListAccounts account entry in the shape Google returns; index 9 is the
 * session flag and index 14 the signed-out flag, the indices Chromium reads.
 */
const account = (valid: number | null, signedOut: number | null = null): unknown[] => [
  'gaia.l.a',
  1,
  'Name',
  'user@example.com',
  'https://example.com/photo',
  1,
  1,
  0,
  null,
  valid,
  '123456789012345678901',
  null,
  null,
  null,
  signedOut,
  1,
  'Name',
];
const listAccounts = (...accounts: unknown[][]): string => JSON.stringify(['gaia.l.a.r', accounts]);

describe('classifyListAccounts', () => {
  test('an account with a live session is a session', () => {
    expect(classifyListAccounts(listAccounts(account(1), account(0)))).toEqual({
      state: 'session',
      accounts: 2,
      signedIn: 1,
    });
  });

  test('accounts Google remembers without a session are remembered, not a session', () => {
    // The observed copy of a signed-out daily profile: three accounts, all 0 at index 9.
    expect(classifyListAccounts(listAccounts(account(0), account(0), account(0)))).toEqual({
      state: 'remembered',
      accounts: 3,
      signedIn: 0,
    });
  });

  test('a valid session that Google marks signed out does not count', () => {
    expect(classifyListAccounts(listAccounts(account(1, 1))).state).toBe('remembered');
  });

  test('an account that does not state its session is never counted as signed in', () => {
    expect(classifyListAccounts(listAccounts(account(null))).state).toBe('remembered');
    expect(classifyListAccounts(listAccounts(['gaia.l.a', 1, 'Name'])).state).toBe('remembered');
  });

  test('no account is none', () => {
    expect(classifyListAccounts('["gaia.l.a.r",[]]')).toEqual({
      state: 'none',
      accounts: 0,
      signedIn: 0,
    });
  });

  test('an anti-XSSI prefix before the JSON is tolerated', () => {
    expect(classifyListAccounts(`)]}'\n${listAccounts(account(1))}`).state).toBe('session');
  });

  test('anything that is not a ListAccounts answer throws instead of passing', () => {
    expect(() => classifyListAccounts('<html>Error 400</html>')).toThrow(/unrecognized format/);
    expect(() => classifyListAccounts('["something.else",[]]')).toThrow(/unrecognized format/);
    expect(() => classifyListAccounts('')).toThrow(/unrecognized format/);
  });
});

describe('googleSessionLoss', () => {
  const remembered = { state: 'remembered', accounts: 3, signedIn: 0 } as const;

  test('a live session is never a loss', () => {
    expect(googleSessionLoss(true, { state: 'session', accounts: 1, signedIn: 1 })).toBeNull();
  });

  test('a profile that was not given a Google login is never gated on one', () => {
    expect(googleSessionLoss(false, remembered)).toBeNull();
    expect(googleSessionLoss(false, { state: 'none', accounts: 0, signedIn: 0 })).toBeNull();
  });

  test('a remembered-but-signed-out copy is a loss, with the state named', () => {
    expect(googleSessionLoss(true, remembered)).toBe(
      'its copied Google login is not live (remembered: Google remembers 3 account(s) but none has a live session)',
    );
  });

  test('a copy Google does not recognize at all is a loss', () => {
    expect(googleSessionLoss(true, { state: 'none', accounts: 0, signedIn: 0 })).toMatch(
      /^its copied Google login is not live \(none: Google lists no account at all\)$/,
    );
  });

  test('a signed-out source is named as the cause', () => {
    expect(googleSessionLoss(true, remembered, '2026-10-06T22:03:53.015Z')).toMatch(
      /seed Chrome itself has shown Google sign-in pending since 2026-10-06T22:03:53.015Z/,
    );
  });
});

describe('signinPendingSince', () => {
  const profileWith = (prefs: unknown): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hc-pending-'));
    mkdirSync(path.join(dir, 'Default'));
    writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(prefs));
    return dir;
  };

  test('converts Chrome time to ISO', () => {
    // 13435797833015876 µs since 1601 is the m1-us daily Chrome's own value.
    expect(
      signinPendingSince(
        profileWith({ signin: { signin_pending_start_time: '13435797833015876' } }),
      ),
    ).toBe('2026-10-06T22:03:53.015Z');
  });

  test('a profile that is not pending, or has no readable prefs, is null', () => {
    expect(signinPendingSince(profileWith({ signin: {} }))).toBeNull();
    expect(signinPendingSince(profileWith({}))).toBeNull();
    expect(signinPendingSince(mkdtempSync(path.join(tmpdir(), 'hc-pending-')))).toBeNull();
  });
});

describe('probeGoogleSession', () => {
  /** A bridge that answers each tool with the payload the real one returns. */
  const bridge = (listAccountsAnswer: { status: number; body: string }) => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ name, args });
      if (name === 'chrome_navigate_batch') return { tabs: [{ tabId: 41, url: args.urls }] };
      if (name === 'chrome_javascript') {
        return { success: true, tabId: 41, result: JSON.stringify(listAccountsAnswer) };
      }
      return { success: true };
    };
    return { call, calls };
  };

  test('runs ListAccounts in a background accounts.google.com tab and closes it', async () => {
    const { call, calls } = bridge({ status: 200, body: listAccounts(account(1)) });
    expect(await probeGoogleSession(call)).toEqual({ state: 'session', accounts: 1, signedIn: 1 });
    expect(calls.map((entry) => entry.name)).toEqual([
      'chrome_navigate_batch',
      'chrome_wait_for',
      'chrome_javascript',
      'chrome_close_tabs',
    ]);
    expect(calls[0].args).toEqual({
      urls: ['https://accounts.google.com/robots.txt'],
      background: true,
    });
    expect(String(calls[2].args.code)).toContain("fetch('/ListAccounts?");
    expect(calls[3].args).toEqual({ action: 'ids', tabIds: [41] });
  });

  test('an HTTP error from Google throws and still closes the tab', async () => {
    const { call, calls } = bridge({ status: 400, body: '' });
    await expect(probeGoogleSession(call)).rejects.toThrow('ListAccounts answered HTTP 400');
    expect(calls.at(-1)?.name).toBe('chrome_close_tabs');
  });

  test('a bridge that opened no tab fails before running anything', async () => {
    const calls: string[] = [];
    const call = async (name: string): Promise<unknown> => {
      calls.push(name);
      return { tabs: [] };
    };
    await expect(probeGoogleSession(call)).rejects.toThrow('the bridge opened no probe tab');
    expect(calls).toEqual(['chrome_navigate_batch']);
  });
});
