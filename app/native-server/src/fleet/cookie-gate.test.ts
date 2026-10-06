import { mkdtempSync, promises as fs, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Before the imports below: FLEET_ROOT and the register-check manifest path are
// both fixed when their modules load.
const home = mkdtempSync(path.join(tmpdir(), 'hc-gate-home-'));
process.env.HOME = home;
process.env.HC_FLEET_ROOT = path.join(home, 'fleet');

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type * as cdpExports from './cdp';
import { createDefaultConfig, FLEET_ROOT, loadConfig, saveConfig } from './config';
import {
  addProfile,
  cookieLoss,
  COOKIE_KEEP_RATIO,
  countCopiedCookies,
  countLiveCookies,
} from './provision';
import type { CdpPipe } from './cdp';

/** What the launched browser reports from `Storage.getCookies`. */
let liveCookies: unknown[] = [];
let keychainLocked = false;
const launches: string[] = [];

const hostScript = path.join(home, 'run_host.sh');
writeFileSync(hostScript, '#!/bin/sh\n');

jest.mock('../scripts/utils', () => ({
  createManifestContent: async () => ({ name: 'com.humanchrome.nativehost', path: hostScript }),
}));
jest.mock('./window-label', () => ({ applyWindowLabel: async () => undefined }));
jest.mock('./cdp', () => {
  const actual = jest.requireActual<typeof cdpExports>('./cdp');
  return {
    ...actual,
    readExtensionManifest: async () => ({ key: 'a-key' }),
    terminateChrome: async () => undefined,
    assertKeychainReadable: async () => {
      if (keychainLocked) throw new Error('this session cannot read the login Keychain');
    },
  };
});
jest.mock('./launch', () => ({
  launchProfileWithExtension: async (_config: unknown, name: string) => {
    launches.push(name);
    return {
      child: { pid: undefined },
      cdp: {
        send: async (method: string) =>
          method === 'Storage.getCookies' ? { result: { cookies: liveCookies } } : { result: {} },
        dispose: () => undefined,
      },
      extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
    };
  },
}));

const HOUR_S = 3_600;
const nowS = (): number => Math.floor(Date.now() / 1000);
/** Chrome stores cookie expiry as microseconds since 1601-01-01. */
const chromeTime = (unixSeconds: number): bigint =>
  (BigInt(unixSeconds) + 11_644_473_600n) * 1_000_000n;

interface Row {
  host: string;
  persistent?: boolean;
  expiresS?: number;
  partition?: string;
}

/** A Chrome user-data-dir whose cookie store holds exactly `rows`. */
async function seedWithCookies(rows: Row[]): Promise<string> {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'hc-gate-seed-')), 'Chrome');
  await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
  await fs.writeFile(path.join(dir, 'Local State'), '{}');
  const db = new Database(path.join(dir, 'Default', 'Cookies'));
  db.exec(
    `CREATE TABLE cookies (host_key TEXT, name TEXT, is_persistent INTEGER,
       expires_utc INTEGER, top_frame_site_key TEXT)`,
  );
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?)');
  rows.forEach((row, index) =>
    insert.run(
      row.host,
      `c${index}`,
      row.persistent === false ? 0 : 1,
      chromeTime(row.expiresS ?? nowS() + HOUR_S),
      row.partition ?? '',
    ),
  );
  db.close();
  return dir;
}

/** The CDP view of a persistent cookie that survived the launch. */
const live = (domain: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'x',
  domain,
  session: false,
  expires: nowS() + HOUR_S,
  ...extra,
});

const manyRows = (count: number, host: string): Row[] =>
  Array.from({ length: count }, () => ({ host }));

beforeAll(async () => {
  const manifest = path.join(
    home,
    'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.humanchrome.nativehost.json',
  );
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.writeFile(manifest, '{}');
  await saveConfig(createDefaultConfig());
  jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ status: 'ok' })));
});

beforeEach(() => {
  liveCookies = [];
  keychainLocked = false;
  launches.length = 0;
});

describe('countCopiedCookies', () => {
  test('counts persistent, unexpired, unpartitioned cookies and google.com apart', async () => {
    const dir = await seedWithCookies([
      { host: '.google.com' },
      { host: 'accounts.google.com' },
      { host: 'google.com' },
      { host: '.linkedin.com' },
      { host: '.notgoogle.com' },
      { host: '.example.com', persistent: false },
      { host: '.example.com', expiresS: nowS() - HOUR_S },
      { host: '.example.com', partition: 'https://example.org' },
    ]);
    expect(countCopiedCookies(dir)).toEqual({ persistent: 5, google: 3 });
  });

  test('a profile without a cookie store was given nothing', () => {
    expect(countCopiedCookies(mkdtempSync(path.join(tmpdir(), 'hc-gate-empty-')))).toEqual({
      persistent: 0,
      google: 0,
    });
  });
});

describe('countLiveCookies', () => {
  test('counts what the browser kept on the same terms as the copy', async () => {
    liveCookies = [
      live('.google.com'),
      live('accounts.google.com'),
      live('.linkedin.com'),
      live('.example.com', { session: true, expires: -1 }),
      live('.example.com', { expires: nowS() - HOUR_S }),
      live('.example.com', { partitionKey: { topLevelSite: 'https://example.org' } }),
    ];
    const cdp = {
      send: async () => ({ result: { cookies: liveCookies } }),
    } as unknown as CdpPipe;
    expect(await countLiveCookies(cdp)).toEqual({ persistent: 3, google: 2 });
  });

  test('a CDP error is a failure, not an empty jar', async () => {
    const cdp = { send: async () => ({ error: { message: 'boom' } }) } as unknown as CdpPipe;
    await expect(countLiveCookies(cdp)).rejects.toThrow('Storage.getCookies failed: boom');
  });
});

describe('cookieLoss', () => {
  test('the observed wipe, 420 copied and 0 kept, is refused', () => {
    expect(cookieLoss({ persistent: 420, google: 65 }, { persistent: 0, google: 0 })).toBe(
      'Chrome kept 0 of 420 copied cookies (at least 378 required)',
    );
  });

  test(`churn within ${COOKIE_KEEP_RATIO * 100}% passes, beyond it fails`, () => {
    expect(cookieLoss({ persistent: 254, google: 53 }, { persistent: 229, google: 53 })).toBeNull();
    expect(cookieLoss({ persistent: 254, google: 53 }, { persistent: 228, google: 53 })).toMatch(
      /kept 228 of 254/,
    );
  });

  test('losing every google.com cookie fails even when the ratio holds', () => {
    expect(cookieLoss({ persistent: 300, google: 5 }, { persistent: 300, google: 0 })).toBe(
      'Chrome kept none of the 5 copied google.com cookies',
    );
  });

  test('a profile given no cookies has none to lose', () => {
    expect(cookieLoss({ persistent: 0, google: 0 }, { persistent: 0, google: 0 })).toBeNull();
  });
});

describe('addProfile cookie gate', () => {
  const rows = [...manyRows(18, '.linkedin.com'), ...manyRows(2, '.google.com')];

  test('a browser that came up without its cookies is discarded and never registered', async () => {
    const seed = await seedWithCookies(rows);
    liveCookies = [live('.example.com')];
    await expect(addProfile('wiped', [], seed)).rejects.toThrow(
      'wiped lost its seeded cookies: Chrome kept 1 of 20 copied cookies (at least 18 required)',
    );
    await expect(fs.access(path.join(FLEET_ROOT, 'profiles', 'wiped'))).rejects.toThrow();
    await expect(fs.access(path.join(FLEET_ROOT, 'run', 'wiped.pid'))).rejects.toThrow();
    expect((await loadConfig()).profiles.map((profile) => profile.name)).not.toContain('wiped');
  });

  test('a browser that kept its cookies is registered with both counts', async () => {
    const seed = await seedWithCookies(rows);
    liveCookies = [
      ...Array.from({ length: 18 }, () => live('.linkedin.com')),
      ...Array.from({ length: 2 }, () => live('.google.com')),
    ];
    const added = await addProfile('kept', [], seed);
    expect(added.copied).toEqual({ persistent: 20, google: 2 });
    expect(added.kept).toEqual({ persistent: 20, google: 2 });
    const registered = (await loadConfig()).profiles.find((profile) => profile.name === 'kept');
    expect(registered?.seededFrom).toBe(seed);
  });

  test('a session without Keychain access is refused before anything is copied', async () => {
    const seed = await seedWithCookies(rows);
    keychainLocked = true;
    await expect(addProfile('locked', [], seed)).rejects.toThrow(
      'this session cannot read the login Keychain',
    );
    expect(launches).toEqual([]);
    await expect(fs.access(path.join(FLEET_ROOT, 'profiles', 'locked'))).rejects.toThrow();
  });
});
