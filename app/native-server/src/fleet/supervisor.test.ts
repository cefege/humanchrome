import { existsSync, mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.HC_FLEET_ROOT = mkdtempSync(path.join(tmpdir(), 'hc-fleet-test-'));

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProfileLauncher, ProfileSupervisor } from './supervisor';
import type { FleetConfig } from './config';
import type { LaunchedProfile } from './launch';
import type { CdpPipe, ChromeChild } from './cdp';
import type * as cdpExports from './cdp';

let livePids: number[] = [];
let terminated: Array<[number, number]> = [];
/** Signal-level kills, so the escalation ladder is asserted where it now lives. */
let killed: Array<[number, string]> = [];
jest.mock('./cdp', () => {
  const actual = jest.requireActual<typeof cdpExports>('./cdp');
  return {
    ...actual,
    findChromeForProfile: async (_chromePath: string, userDataDir: string) =>
      userDataDir.endsWith('p01') ? livePids : [],
    terminateChrome: async (pid: number, graceMs = 5_000) => {
      terminated.push([pid, graceMs]);
      killed.push([pid, 'SIGTERM']);
      // A killed browser is gone: the orphan scan must stop reporting it, or
      // the supervisor would "adopt" what it just terminated.
      livePids = livePids.filter((live) => live !== pid);
    },
  };
});

const BASE: FleetConfig = {
  version: 1,
  gateway: { host: '127.0.0.1', port: 0 },
  token: 'a'.repeat(64),
  bridgeToken: 'b'.repeat(64),
  chromePath: '/nonexistent/chrome',
  extensionDir: '/nonexistent/extension',
  basePort: 12500,
  leaseIdleTtlSec: 900,
  nodeId: 'test-node',
  nodes: [],
  parked: false,
  profiles: [
    { name: 'p01', port: 12500, labels: ['google'], enabled: true },
    { name: 'p02', port: 12501, labels: ['google'], enabled: true },
  ],
};

interface LaunchCall {
  name: string;
  dir: string;
  port: number;
}

const supervisors: ProfileSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
});
const RESTART_MARKER = path.join(process.env.HC_FLEET_ROOT!, 'run', 'supervisor-restart.marker');

beforeEach(async () => {
  livePids = [];
  killed = [];
  terminated = [];
  // Every test shuts its supervisor down, and a real shutdown leaves this
  // marker behind for the next supervisor. Each test starts without one, the
  // way a supervisor that crashed or was never started would.
  await fs.rm(RESTART_MARKER, { force: true });
});

function fakeLaunch(pid: number | undefined): {
  launched: LaunchCall[];
  launcher: ProfileLauncher;
} {
  const launched: LaunchCall[] = [];
  const launcher: ProfileLauncher = async (
    _config: FleetConfig,
    name: string,
    dir: string,
    port: number,
  ): Promise<LaunchedProfile> => {
    launched.push({ name, dir, port });
    return {
      child: { pid, kill: () => true } as unknown as ChromeChild,
      cdp: { dispose: () => undefined } as unknown as CdpPipe,
      extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
    };
  };
  return { launched, launcher };
}

function build(
  config: FleetConfig,
  launcher: ProfileLauncher,
  bridgeProbe: (port: number) => Promise<boolean> = async () => false,
): ProfileSupervisor {
  const supervisor = new ProfileSupervisor(config, launcher, bridgeProbe);
  supervisors.push(supervisor);
  return supervisor;
}

interface RuntimeView {
  pid: number | null;
  state: string;
  backoffMs: number;
}
function runtimeOf(supervisor: ProfileSupervisor, name: string): RuntimeView {
  const profiles = (supervisor as unknown as { profiles: Map<string, RuntimeView> }).profiles;
  return profiles.get(name)!;
}
function monitor(supervisor: ProfileSupervisor): Promise<void> {
  return (supervisor as unknown as { monitor(): Promise<void> }).monitor();
}

describe('ProfileSupervisor parked fleet', () => {
  test('starts no browser while parked and reports every profile stopped', async () => {
    const { launched, launcher } = fakeLaunch(4242);
    const supervisor = build({ ...BASE, parked: true }, launcher);
    await supervisor.start();
    expect(launched).toEqual([]);
    expect(supervisor.snapshot().map((profile) => profile.state)).toEqual(['stopped', 'stopped']);
  });

  test('updating the config to parked stops every running profile', async () => {
    const { launched, launcher } = fakeLaunch(undefined);
    const supervisor = build(BASE, launcher);
    await supervisor.start();
    expect(launched).toHaveLength(2);
    expect(supervisor.snapshot().every((profile) => profile.state === 'running')).toBe(true);

    await supervisor.reload({ ...BASE, parked: true });
    expect(supervisor.snapshot().map((profile) => profile.state)).toEqual(['stopped', 'stopped']);
  });

  test('unparking starts the enabled profiles again', async () => {
    const { launched, launcher } = fakeLaunch(undefined);
    const supervisor = build({ ...BASE, parked: true }, launcher);
    await supervisor.start();
    expect(launched).toHaveLength(0);

    await supervisor.reload(BASE);
    expect(launched.map((call) => call.name)).toEqual(['p01', 'p02']);
    expect(supervisor.snapshot().every((profile) => profile.state === 'running')).toBe(true);
  });

  test('skips disabled profiles', async () => {
    const { launched, launcher } = fakeLaunch(undefined);
    const supervisor = build(
      {
        ...BASE,
        profiles: [{ ...BASE.profiles[0], enabled: false }, BASE.profiles[1]],
      },
      launcher,
    );
    await supervisor.start();
    expect(launched.map((call) => call.name)).toEqual(['p02']);
  });

  test('a fleet unparked by reload alone still runs the monitor and session timers', async () => {
    const { launched, launcher } = fakeLaunch(undefined);
    const supervisor = build({ ...BASE, parked: true }, launcher);
    const timers = () =>
      supervisor as unknown as {
        monitorTimer: NodeJS.Timeout | null;
        healthTimer: NodeJS.Timeout | null;
        sessionTimer: NodeJS.Timeout | null;
      };
    // `serve` reloads on SIGHUP for every CLI mutation, so an unpark can arrive
    // without start() ever having run: the timers must exist afterwards or a
    // running fleet is unsupervised and its sessions are never captured.
    expect(timers().sessionTimer).toBeNull();

    await supervisor.reload(BASE);

    expect(launched.map((call) => call.name)).toEqual(['p01', 'p02']);
    expect(timers().monitorTimer).not.toBeNull();
    expect(timers().healthTimer).not.toBeNull();
    expect(timers().sessionTimer).not.toBeNull();
  });
});

describe('ProfileSupervisor launch failures', () => {
  test('a launcher rejection surfaces as backoff instead of a running profile', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const supervisor = build(BASE, async () => {
      throw new Error('extension build missing at /nonexistent/extension');
    });
    await supervisor.start();
    const [first] = supervisor.snapshot();
    expect(first.state).toBe('backoff');
    expect(first.pid).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('extension build missing at /nonexistent/extension'),
    );
    errors.mockRestore();
  });
});

const P01: FleetConfig = { ...BASE, profiles: [BASE.profiles[0]] };
describe('ProfileSupervisor browser adoption', () => {
  test('adopts a healthy orphan instead of launching a duplicate', async () => {
    livePids = [4242];
    killed = [];
    const { launched, launcher } = fakeLaunch(1111);
    const logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const supervisor = build(P01, launcher, async () => true);
    await supervisor.start();
    expect(launched).toEqual([]);
    expect(killed).toEqual([]);
    const [first] = supervisor.snapshot();
    expect(first.pid).toBe(4242);
    expect(first.state).toBe('running');
    expect(logs).toHaveBeenCalledWith('fleet: adopted running browser for p01 (pid 4242)');
    logs.mockRestore();
  });

  test('adopts from the monitor when the recorded pid is gone', async () => {
    livePids = [4242];
    killed = [];
    const { launched, launcher } = fakeLaunch(1111);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const supervisor = build(P01, launcher, async () => true);
    await supervisor.start();
    launched.length = 0;
    runtimeOf(supervisor, 'p01').pid = 999_999;
    await monitor(supervisor);
    expect(launched).toEqual([]);
    expect(killed).toEqual([]);
    expect(supervisor.snapshot()[0]?.pid).toBe(4242);
  });

  test('leaves a profile alone while its launch is still in flight', async () => {
    livePids = [];
    const { launched, launcher } = fakeLaunch(1111);
    const supervisor = build(P01, launcher, async () => false);
    await supervisor.start();
    launched.length = 0;
    runtimeOf(supervisor, 'p01').state = 'starting';
    await monitor(supervisor);
    expect(launched).toEqual([]);
    expect(killed).toEqual([]);
  });

  test('stops an orphan whose bridge does not answer and launches a clean one', async () => {
    livePids = [4242];
    killed = [];
    const { launched, launcher } = fakeLaunch(1111);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const supervisor = build(P01, launcher, async () => false);
    await supervisor.start();
    expect(terminated).toEqual([[4242, 5_000]]);
    expect(launched.map((call) => call.name)).toEqual(['p01']);
    expect(supervisor.snapshot()[0]?.pid).toBe(1111);
  });

  test('stops every duplicate beyond the lowest pid', async () => {
    livePids = [700, 800, 900];
    killed = [];
    const { launcher } = fakeLaunch(1111);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await build(P01, launcher, async () => true).start();
    expect(terminated).toEqual([
      [800, 5_000],
      [900, 5_000],
    ]);
  });

  test('a browser that refuses to exit is terminated through one shared ladder', async () => {
    livePids = [4242];
    await build(P01, fakeLaunch(1111).launcher, async () => false).start();
    // One entry per browser, with the grace period the supervisor uses — the
    // SIGTERM/poll/SIGKILL ladder itself is asserted in cdp.test.ts.
    expect(terminated).toEqual([[4242, 5_000]]);
  });
});

describe('ProfileSupervisor unreachable bridge', () => {
  /** `checkHealth` is private; in production only the health timer calls it. */
  type HealthRunner = { checkHealth(): Promise<void> };
  function health(supervisor: ProfileSupervisor): Promise<void> {
    const runner = supervisor as unknown as HealthRunner;
    return runner.checkHealth();
  }

  /** A launcher whose pipe answers `Storage.getCookies`, so a capture can run. */
  function launchable(pid: number): { launched: LaunchCall[]; launcher: ProfileLauncher } {
    const launched: LaunchCall[] = [];
    const launcher: ProfileLauncher = async (_config, name, dir, port) => {
      launched.push({ name, dir, port });
      return {
        child: { pid, kill: () => true } as unknown as ChromeChild,
        cdp: {
          dispose: () => undefined,
          send: async () => ({ result: { cookies: [] } }),
        } as unknown as CdpPipe,
        extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
      };
    };
    return { launched, launcher };
  }

  test('replaces a live browser whose bridge never answers', async () => {
    livePids = [];
    const { launched, launcher } = launchable(1111);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const supervisor = build(P01, launcher, async () => true);
    await supervisor.start();
    launched.length = 0;
    terminated.length = 0;

    // Chrome is up and nothing is listening on its port: what a dead extension
    // service worker leaves behind, and what `monitor` never notices because
    // the pid is alive.
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    for (let tick = 0; tick < 5; tick += 1) await health(supervisor);
    expect(terminated).toEqual([]);
    expect(launched).toEqual([]);

    await health(supervisor);

    expect(terminated).toEqual([[1111, 5_000]]);
    expect(launched.map((call) => call.name)).toEqual(['p01']);
    expect(supervisor.snapshot()[0]).toMatchObject({ state: 'running', pid: 1111 });
    fetchSpy.mockRestore();
  });

  test('keeps a browser whose bridge answers again inside the grace window', async () => {
    livePids = [];
    const { launched, launcher } = launchable(1111);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const supervisor = build(P01, launcher, async () => true);
    await supervisor.start();
    launched.length = 0;

    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' })));
    await health(supervisor);
    await health(supervisor);

    expect(launched).toEqual([]);
    expect(terminated).toEqual([]);
    expect(supervisor.snapshot()[0]).toMatchObject({ state: 'healthy', pid: 1111 });
    fetchSpy.mockRestore();
  });

  test('does not adopt a pid-file browser whose bridge is silent', async () => {
    livePids = [process.pid];
    const { launched, launcher } = launchable(1111);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const supervisor = build(P01, launcher, async () => false);
    const dir = path.join(process.env.HC_FLEET_ROOT!, 'profiles', 'p01');
    Object.assign(supervisor, {
      commandLine: async () => `Google Chrome --user-data-dir=${dir}`,
    });
    const pidPath = path.join(process.env.HC_FLEET_ROOT!, 'run', 'p01.pid');
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, String(process.pid));

    await supervisor.start();

    // Adopting it by pid alone is how a dead bridge stayed dead for a day.
    expect(launched.map((call) => call.name)).toEqual(['p01']);
    expect(terminated).toEqual([[process.pid, 5_000]]);
  });
});

describe('ProfileSupervisor lastError', () => {
  test('reports the failure message once and clears it on recovery', async () => {
    livePids = [];
    killed = [];
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    let fail = true;
    const supervisor = build(P01, async () => {
      if (fail) throw new Error('extension build missing at /nonexistent/extension');
      return {
        child: { pid: 2222, kill: () => true } as unknown as ChromeChild,
        cdp: { dispose: () => undefined } as unknown as CdpPipe,
        extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
      };
    });
    await supervisor.start();
    expect(supervisor.snapshot()[0]?.lastError).toBe(
      'extension build missing at /nonexistent/extension',
    );
    fail = false;
    await supervisor.startProfile('p01');
    expect(supervisor.snapshot()[0]?.lastError).toBeNull();
    expect(logs).toHaveBeenCalledWith('fleet: profile p01 is up again');
    const launchFailures = () =>
      errors.mock.calls.filter((call) => String(call[0]).includes('failed to launch')).length;
    expect(launchFailures()).toBe(1);
    errors.mockRestore();
    logs.mockRestore();
  });
});

describe('ProfileSupervisor pipe and focus discipline', () => {
  test('disposes the previous pipe exactly once when a browser is replaced', async () => {
    livePids = [];
    const first = { dispose: jest.fn() };
    const second = { dispose: jest.fn() };
    const pipes = [first, second];
    const supervisor = build(
      P01,
      async () => {
        const cdp = pipes.shift()!;
        return {
          child: { pid: 1111, kill: () => true } as unknown as ChromeChild,
          cdp: cdp as unknown as CdpPipe,
          extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
        };
      },
      async () => false,
    );
    await supervisor.start();
    expect(first.dispose).not.toHaveBeenCalled();

    jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    runtimeOf(supervisor, 'p01').backoffMs = 0;
    await monitor(supervisor);
    // The dead browser's pipe is released on the revive path, not left for the
    // next capture to write into.
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  test('two overlapping monitor passes launch a profile exactly once', async () => {
    livePids = [];
    const { launched, launcher } = fakeLaunch(1111);
    const supervisor = build(P01, launcher, async () => false);
    await supervisor.start();
    launched.length = 0;

    // The monitor body sleeps for the backoff, so without a per-profile launch
    // guard the next tick passes the same profile while the first is still in it.
    runtimeOf(supervisor, 'p01').backoffMs = 0;
    await Promise.all([monitor(supervisor), monitor(supervisor)]);
    expect(launched.map((call) => call.name)).toEqual(['p01']);
  });

  test('claims focus once per healthy transition, not once per tick', async () => {
    livePids = [];
    const send = jest.fn(async (method: string) =>
      method === 'Target.getTargets' ? { result: { targetInfos: [] } } : { result: {} },
    );
    const cdp = { dispose: jest.fn(), send };
    const supervisor = build(
      P01,
      async () => ({
        child: { pid: 1111, kill: () => true } as unknown as ChromeChild,
        cdp: cdp as unknown as CdpPipe,
        extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
      }),
      async () => false,
    );
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'ok' })));
    await supervisor.start();

    const health = (supervisor as unknown as { checkHealth(): Promise<void> }).checkHealth;
    await health.call(supervisor);
    await health.call(supervisor);
    // One focus round is two getTargets: the label lookup plus the onboarding
    // sweep. Two health ticks must produce one round, not two.
    const focused = send.mock.calls.filter((call) => call[0] === 'Target.getTargets').length;
    expect(focused).toBe(2);
    fetchSpy.mockRestore();
  });

  test('stopProfile disposes the pipe and removes the pid file', async () => {
    livePids = [];
    const cdp = { dispose: jest.fn() };
    const supervisor = build(
      P01,
      async () => ({
        child: { pid: 1111, kill: () => true } as unknown as ChromeChild,
        cdp: cdp as unknown as CdpPipe,
        extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
      }),
      async () => false,
    );
    await supervisor.start();
    const pidPath = path.join(process.env.HC_FLEET_ROOT!, 'run', 'p01.pid');
    expect(await fs.readFile(pidPath, 'utf8')).toBe('1111');

    await supervisor.stopProfile('p01');

    expect(cdp.dispose).toHaveBeenCalledTimes(1);
    expect(existsSync(pidPath)).toBe(false);
    expect(supervisor.snapshot()[0]).toMatchObject({ state: 'stopped', pid: null });
  });

  test('a malformed pid file is removed instead of read forever', async () => {
    livePids = [];
    const pidPath = path.join(process.env.HC_FLEET_ROOT!, 'run', 'p01.pid');
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, 'not-a-pid');
    const supervisor = build(P01, fakeLaunch(1111).launcher, async () => false);

    await supervisor.stopProfile('p01');

    expect(existsSync(pidPath)).toBe(false);
    expect(supervisor.snapshot()[0]).toMatchObject({ state: 'stopped' });
  });

  test('a disabled profile reports enabled:false after a reload', async () => {
    livePids = [];
    const { launcher } = fakeLaunch(1111);
    const supervisor = build(P01, launcher, async () => false);
    await supervisor.start();

    await supervisor.reload({
      ...P01,
      profiles: [{ ...P01.profiles[0], enabled: false }],
    });

    expect(supervisor.snapshot()[0]?.enabled).toBe(false);
  });

  test('reloading one profile does not strand the others when a stop fails', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const supervisor = build(BASE, fakeLaunch(1111).launcher, async () => false);
    await supervisor.start();
    const stop = jest
      .spyOn(supervisor, 'stopProfile')
      .mockRejectedValueOnce(new Error('kill failed'));

    await supervisor.reload({ ...BASE, profiles: [BASE.profiles[1]] });

    expect(errors).toHaveBeenCalledWith('fleet: could not stop p01: kill failed');
    expect(supervisor.state('p02')).toBe('running');
    stop.mockRestore();
    errors.mockRestore();
  });
});

describe('ProfileSupervisor shutdown', () => {
  test('takes a final session snapshot before the pipes go away', async () => {
    livePids = [];
    const send = jest.fn(async (method: string) =>
      method === 'Storage.getCookies' ? { result: { cookies: [] } } : { result: {} },
    );
    const supervisor = build(
      P01,
      async () => ({
        child: { pid: 1111, kill: () => true } as unknown as ChromeChild,
        cdp: { send, dispose: jest.fn() } as unknown as CdpPipe,
        extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
      }),
      async () => false,
    );
    await supervisor.start();
    send.mockClear();

    await supervisor.shutdown();

    // The 60s capture timer may not have fired since the last cookie landed,
    // and this file is the only copy of the fleet's session-cookie logins.
    expect(send.mock.calls.map((call) => call[0])).toContain('Storage.getCookies');
  });

  test('a capture failure during shutdown does not block the exit', async () => {
    livePids = [];
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const supervisor = build(
      P01,
      async () => ({
        child: { pid: 1111, kill: () => true } as unknown as ChromeChild,
        cdp: {
          send: async () => {
            throw new Error('cdp pipe closed');
          },
          dispose: jest.fn(),
        } as unknown as CdpPipe,
        extensionId: 'dhabpgnpajocncnoigibmocmfjnhlmhe',
      }),
      async () => false,
    );
    await supervisor.start();

    await expect(supervisor.shutdown()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('session capture failed for p01'));
    errors.mockRestore();
  });
});

describe('ProfileSupervisor deliberate restart', () => {
  test('replaces a browser the previous supervisor was shutting down', async () => {
    livePids = [4242];
    const logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await fs.mkdir(path.dirname(RESTART_MARKER), { recursive: true });
    await fs.writeFile(RESTART_MARKER, '');
    // The bridge answers, so without the marker this browser would be adopted.
    const { launched, launcher } = fakeLaunch(1111);

    await build(P01, launcher, async () => true).start();

    // Adopting it would leave this supervisor without a DevTools pipe, and
    // with it the label focus and session capture that identify the browser.
    expect(terminated).toEqual([[4242, 5_000]]);
    expect(launched.map((call) => call.name)).toEqual(['p01']);
    expect(logs).toHaveBeenCalledWith(
      'fleet: replaced browser for p01 (pid 4242) from a prior shutdown',
    );
    logs.mockRestore();
  });

  test('adopts a browser left behind by a crash, which writes no marker', async () => {
    livePids = [4242];
    const logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { launched, launcher } = fakeLaunch(1111);

    await build(P01, launcher, async () => true).start();

    // A crashed supervisor's browsers still hold their tabs; adopting them is
    // exactly what they are for.
    expect(launched).toEqual([]);
    expect(supervisorPidOf(4242)).toBe(true);
    expect(logs).toHaveBeenCalledWith('fleet: adopted running browser for p01 (pid 4242)');
    logs.mockRestore();
  });

  test('writes the marker before it starts shutting browsers down', async () => {
    livePids = [];
    const { launcher } = fakeLaunch(1111);
    const supervisor = build(P01, launcher, async () => false);
    await supervisor.start();

    await supervisor.shutdown();

    expect(existsSync(RESTART_MARKER)).toBe(true);
  });
});

function supervisorPidOf(pid: number): boolean {
  return livePids.includes(pid);
}
