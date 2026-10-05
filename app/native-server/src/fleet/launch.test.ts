import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.HC_FLEET_ROOT = mkdtempSync(path.join(tmpdir(), 'hc-launch-test-'));

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { launchProfileWithExtension, profileEnvironment } from './launch';
import type { ChromeChild } from './cdp';
import type * as cdpExports from './cdp';
import type { FleetConfig } from './config';

const spawnArgs: Array<{ chromePath: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
const childEvents: string[] = [];
let killed: Array<[number, string]> = [];
let sent: string[] = [];
let manifestKey: string | undefined = 'a-key';
let loadUnpackedFails = false;
let disposeCount = 0;

jest.mock('./cdp', () => {
  const actual = jest.requireActual<typeof cdpExports>('./cdp');
  return {
    ...actual,
    readExtensionManifest: async () => ({ key: manifestKey }),
    killChromeGroup: (pid: number, signal: NodeJS.Signals) => {
      killed.push([pid, signal]);
    },
    spawnWithCdpPipe: (chromePath: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawnArgs.push({ chromePath, args, env: options.env });
      return {
        pid: 4321,
        stdio: [null, null, null, { write: () => true }, {}],
        unref: () => undefined,
        once: (event: string) => {
          childEvents.push(event);
        },
        kill: () => true,
      } as unknown as ChromeChild;
    },
    CdpPipe: class {
      send = async (method: string) => {
        sent.push(method);
        return { result: {} };
      };
      loadUnpacked = async () => {
        sent.push('Extensions.loadUnpacked');
        if (loadUnpackedFails) throw new Error('Extensions.loadUnpacked failed: bad dir');
        return 'dhabpgnpajocncnoigibmocmfjnhlmhe';
      };
      dispose = () => {
        disposeCount += 1;
      };
    },
  };
});

const config: FleetConfig = {
  version: 1,
  gateway: { host: '127.0.0.1', port: 12300 },
  token: null,
  bridgeToken: 'b'.repeat(64),
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  extensionDir: '/tmp/extension',
  basePort: 12500,
  leaseIdleTtlSec: 900,
  nodeId: 'test',
  nodes: [],
  parked: false,
  profiles: [],
};

const scratchDir = (): string => mkdtempSync(path.join(tmpdir(), 'hc-launch-dir-'));

/** A profile that already holds a login, so a session replay is attempted. */
function dirWithSession(): string {
  const dir = scratchDir();
  writeFileSync(
    path.join(dir, '.hc-session.json'),
    JSON.stringify({ cookies: [{ name: 'a', value: 'b' }] }),
  );
  return dir;
}

beforeEach(() => {
  spawnArgs.length = 0;
  childEvents.length = 0;
  killed = [];
  sent = [];
  disposeCount = 0;
  manifestKey = 'a-key';
  loadUnpackedFails = false;
});

describe('launchProfileWithExtension', () => {
  test('replays cookies before the extension can navigate', async () => {
    await launchProfileWithExtension(config, 'p01', dirWithSession(), 12500);
    // Order is load-bearing: cookies must be in place before any site page
    // loads, or the first request goes out unauthenticated.
    expect(sent).toContain('Storage.setCookies');
    expect(sent.indexOf('Storage.setCookies')).toBeLessThan(
      sent.indexOf('Extensions.loadUnpacked'),
    );
  });

  test('a loadUnpacked failure disposes the pipe and kills the browser', async () => {
    loadUnpackedFails = true;
    await expect(launchProfileWithExtension(config, 'p01', scratchDir(), 12500)).rejects.toThrow(
      /loadUnpacked/,
    );
    // Leaving either behind is an orphan Chrome holding the profile's
    // SingletonLock, which the next launch then fails on.
    expect(disposeCount).toBe(1);
    expect(killed).toEqual([[4321, 'SIGKILL']]);
  });

  test('rejects a keyless extension build before spawning anything', async () => {
    manifestKey = undefined;
    await expect(launchProfileWithExtension(config, 'p01', scratchDir(), 12500)).rejects.toThrow(
      /keyless/,
    );
    expect(spawnArgs).toEqual([]);
  });

  test('attaches an error listener to the unref-ed child', async () => {
    await launchProfileWithExtension(config, 'p01', scratchDir(), 12500);
    // Without it a bad chromePath emits an unobserved 'error' event, and an
    // unhandled one takes the whole serve process down.
    expect(childEvents).toContain('error');
  });

  test('reports the extension id it loaded', async () => {
    const launched = await launchProfileWithExtension(config, 'p01', scratchDir(), 12500);
    expect(launched.extensionId).toBe('dhabpgnpajocncnoigibmocmfjnhlmhe');
  });
});

describe('profileEnvironment', () => {
  test('carries exactly the five variables a profile bridge needs', () => {
    const env = profileEnvironment(config, 'p01', 12500);
    const fleet = Object.fromEntries(
      Object.entries(env).filter(
        // HC_FLEET_ROOT is this process's own, not the profile's.
        ([key]) =>
          (key.startsWith('HC_') && key !== 'HC_FLEET_ROOT') || key === 'HUMANCHROME_TOKEN',
      ),
    );
    expect(fleet).toEqual({
      HC_BRIDGE_PORT: '12500',
      HC_INSTANCE_REGISTRY_DIR: path.join(process.env.HC_FLEET_ROOT!, 'registry', 'instances'),
      HC_BRIDGE_DAEMON_SOCKET: path.join(process.env.HC_FLEET_ROOT!, 'run', 'p01.sock'),
      // The gateway's own token may be off; the bridge credential never is.
      HUMANCHROME_TOKEN: config.bridgeToken,
      HC_FLEET_PROFILE: 'p01',
    });
  });

  test('inherits the rest of the process environment', () => {
    process.env.HC_LAUNCH_TEST_MARKER = 'kept';
    try {
      expect(profileEnvironment(config, 'p01', 12500).HC_LAUNCH_TEST_MARKER).toBe('kept');
    } finally {
      delete process.env.HC_LAUNCH_TEST_MARKER;
    }
  });
});

describe('spawned chrome', () => {
  test('is launched with the profile directory and a stdio debug pipe', async () => {
    const dir = scratchDir();
    await launchProfileWithExtension(config, 'p01', dir, 12500);
    const spawn = spawnArgs[0]!;
    expect(spawn.chromePath).toBe(config.chromePath);
    expect(spawn.args).toContain(`--user-data-dir=${dir}`);
    // No debugging port: the DevTools pipe is on stdio, so nothing on the LAN
    // can reach the browser.
    expect(spawn.args).toContain('--remote-debugging-pipe');
    expect(spawn.args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false);
  });

  test('is spawned as a detached group leader with pipes on fd 3 and 4', async () => {
    await launchProfileWithExtension(config, 'p01', scratchDir(), 12500);
    // `spawnWithCdpPipe` owns detached + stdio; this pins the environment the
    // child is handed, which is where the fleet wiring actually lives.
    expect(spawnArgs[0]?.env.HC_FLEET_PROFILE).toBe('p01');
    expect(spawnArgs[0]?.env.HUMANCHROME_TOKEN).toBe(config.bridgeToken);
  });
});
