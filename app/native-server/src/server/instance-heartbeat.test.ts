/**
 * The bridge must keep its own registry record fresh for as long as it
 * serves HTTP.
 *
 * listInstances() unlinks any record whose mtime is older than the staleness
 * window, so a bridge that wrote its record once at bind time was erased
 * from the registry while still healthy. Every HTTP client that discovers
 * the bridge by reading the registry then reported "No live humanchrome
 * bridge found" — the exact failure that blocked the career pipeline.
 *
 * Deterministic time control is not usable here: the heartbeat interval is
 * created inside Server.start(), and replacing the global timer functions
 * before or after that call either breaks Fastify's bind or fails to capture
 * the already-armed real interval. So the cadence is shortened via
 * HC_HEARTBEAT_INTERVAL_MS and each assertion polls for the observed effect
 * against a deadline, rather than sleeping a guessed duration.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { NativeMessagingHost } from '../native-messaging-host';
import { listInstances } from '../util/instance-registry';
import { Server } from './index';

const HEARTBEAT_MS = 15;
const DEADLINE_MS = 5_000;
const POLL_MS = 5;

let tmp: string;
let prevHeartbeat: string | undefined;
let prevSocket: string | undefined;

/** `start()` only reads these two optional identity accessors off the host. */
function stubNativeHost(): NativeMessagingHost {
  const stub = {
    getRemoteExtensionId: () => 'hbdg-test',
    getRemoteInstanceId: () => 'test-instance',
  };
  return stub as unknown as NativeMessagingHost;
}

function recordPath(pid: number): string {
  return resolve(tmp, `${pid}.json`);
}

/**
 * The Server constructor pulls in the native-messaging host and MCP server,
 * which register process-level side effects, so the daemon socket is
 * redirected too (see beforeAll) — this suite must never contend with the
 * live bridge holding the user's Chrome session.
 */

/** Age the record past the registry's staleness window without killing the pid. */
function ageRecordOut(pid: number): void {
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(recordPath(pid), old, old);
}

/** Await the heartbeat's observable effect, or fail naming what never happened. */
async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out after ${DEADLINE_MS}ms waiting for: ${what}`);
}

beforeAll(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'hc-server-heartbeat-'));
  process.env.HC_INSTANCE_REGISTRY_DIR = tmp;
  prevSocket = process.env.HC_BRIDGE_DAEMON_SOCKET;
  process.env.HC_BRIDGE_DAEMON_SOCKET = resolve(tmp, 'bridge-daemon.sock');
  prevHeartbeat = process.env.HC_HEARTBEAT_INTERVAL_MS;
  process.env.HC_HEARTBEAT_INTERVAL_MS = String(HEARTBEAT_MS);
});

afterAll(() => {
  delete process.env.HC_INSTANCE_REGISTRY_DIR;
  if (prevSocket === undefined) {
    delete process.env.HC_BRIDGE_DAEMON_SOCKET;
  } else {
    process.env.HC_BRIDGE_DAEMON_SOCKET = prevSocket;
  }
  if (prevHeartbeat === undefined) {
    delete process.env.HC_HEARTBEAT_INTERVAL_MS;
  } else {
    process.env.HC_HEARTBEAT_INTERVAL_MS = prevHeartbeat;
  }
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});

describe('Server registry heartbeat', () => {
  test('a bound server publishes a discoverable record', async () => {
    const s = new Server();
    try {
      await s.start(13540, stubNativeHost(), 10);
      const live = listInstances();
      expect(live).toHaveLength(1);
      expect(live[0].port).toBe(13540);
    } finally {
      await s.stop().catch(() => undefined);
    }
  }, 30_000);

  test('the heartbeat keeps a long-running server discoverable', async () => {
    const s = new Server();
    try {
      await s.start(13541, stubNativeHost(), 10);
      expect(listInstances()).toHaveLength(1);

      // A record nothing refreshes ages out and is unlinked while the server
      // is still serving. That is the pre-fix failure.
      ageRecordOut(process.pid);
      expect(listInstances()).toHaveLength(0);

      // The heartbeat revives it, and it stays listed across repeated
      // staleness windows for as long as the server is up.
      for (let round = 0; round < 3; round += 1) {
        await waitFor(`heartbeat to rewrite the record (round ${round})`, () =>
          listInstances().some((r) => r.pid === process.pid),
        );
        ageRecordOut(process.pid);
      }
    } finally {
      await s.stop().catch(() => undefined);
    }
  }, 60_000);

  test('a tick advances the record mtime', async () => {
    const s = new Server();
    try {
      await s.start(13542, stubNativeHost(), 10);
      ageRecordOut(process.pid);
      const aged = statSync(recordPath(process.pid)).mtimeMs;

      await waitFor('the record mtime to advance', () => {
        if (!existsSync(recordPath(process.pid))) {
          return false;
        }
        return statSync(recordPath(process.pid)).mtimeMs > aged;
      });
    } finally {
      await s.stop().catch(() => undefined);
    }
  }, 30_000);

  test('stopping the server unlinks the record and no tick revives it', async () => {
    const s = new Server();
    try {
      await s.start(13543, stubNativeHost(), 10);
      expect(listInstances()).toHaveLength(1);

      await s.stop();
      expect(existsSync(recordPath(process.pid))).toBe(false);
      expect(listInstances()).toHaveLength(0);

      // A cleared interval must not write the record back after shutdown.
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 10));
      expect(existsSync(recordPath(process.pid))).toBe(false);
    } finally {
      await s.stop().catch(() => undefined);
    }
  }, 30_000);
});
