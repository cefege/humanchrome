/**
 * IMP-0120: end-to-end test of the primary/relay daemon split.
 *
 * Scenario walks the regression that motivated this fix:
 *  1. Spin up a primary bridge by pointing the orchestrator at a fresh
 *     temp UDS path. The primary's NM source is a piped Readable/Writable
 *     pair masquerading as the SW connection.
 *  2. Acquire-then-close that primary source (simulates SW reload from
 *     IMP-0119's self-update watcher).
 *  3. Open a second NM source pair AND wire it through to a UDS relay
 *     socket. The primary should pick up the relay automatically and
 *     answer tool-call requests on the new source — the HTTP server
 *     (represented here by `sendRequestToExtensionAndWait`) never had
 *     to be torn down or rebound.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createConnection, Socket } from 'node:net';

import { NativeMessagingHost } from './native-messaging-host';
import { tryAcquireDaemonLock } from './util/daemon-socket';
import { runAsPrimary } from './bridge-orchestrator';

function framed(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function readFramedOnce(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      stream.removeListener('data', onData as any);
      try {
        resolve(JSON.parse(body.toString()));
      } catch (err) {
        reject(err);
      }
    };
    stream.on('data', onData as any);
  });
}

describe('bridge-orchestrator — primary survives source-swap (IMP-0120)', () => {
  let tmp: string;
  let socketPath: string;
  let cleanup: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hc-orch-'));
    socketPath = join(tmp, 'bridge-daemon.sock');
    cleanup = [];
  });

  afterEach(async () => {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test('primary swaps NM source from initial stream → UDS relay, requests resolve on the new source', async () => {
    const udsServer = await tryAcquireDaemonLock(socketPath);
    expect(udsServer).not.toBeNull();
    cleanup.push(() => new Promise<void>((res) => udsServer!.close(() => res())));

    const host = new NativeMessagingHost();

    // Initial NM source — pretend this is the first SW's stdin/stdout.
    const initialIn = new PassThrough();
    const initialOut = new PassThrough();

    // Patch the orchestrator to use our PassThrough pair instead of
    // process.stdin/stdout. The simplest path is to call setStreams()
    // directly after the orchestrator wires up its source-closed
    // handler, so we replicate the relevant bits of runAsPrimary here
    // — minus the `nativeHost.start(process.stdin, process.stdout)`
    // line that we substitute with our pair.
    let activeRelay: Socket | null = null;
    host.setSourceClosedHandler(() => {
      if (activeRelay) {
        try {
          activeRelay.destroy();
        } catch {
          /* ignore */
        }
        activeRelay = null;
      }
    });
    host.start(initialIn, initialOut);
    udsServer!.on('connection', (socket) => {
      if (activeRelay) {
        try {
          activeRelay.destroy();
        } catch {
          /* ignore */
        }
      }
      activeRelay = socket;
      host.setStreams(socket, socket);
    });

    // 1) Issue a request on the initial source. It should write a framed
    // envelope on initialOut and resolve when we feed the response back
    // on initialIn.
    const req1 = host.sendRequestToExtensionAndWait({ ping: 1 }, 'process_data', 5_000);
    const wire1 = await readFramedOnce(initialOut);
    expect(wire1).toMatchObject({ type: 'process_data', payload: { ping: 1 } });
    initialIn.write(framed({ responseToRequestId: wire1.requestId, payload: { ack: 1 } }));
    await expect(req1).resolves.toMatchObject({ ack: 1 });

    // 2) Simulate SW reload: end the initial source. The source-closed
    // handler runs; HTTP layer would still be alive. New requests should
    // fail fast (no active source).
    initialIn.end();
    await new Promise((res) => setTimeout(res, 20));

    await expect(
      host.sendRequestToExtensionAndWait({ ping: 2 }, 'process_data', 1_000),
    ).rejects.toThrow(/no active native-messaging source/i);

    // 3) New bridge spawns and connects as relay. Use a real UDS client
    // socket — bytes go through the kernel just like in production.
    const relayClient: Socket = await new Promise((resolve, reject) => {
      const s = createConnection(socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    cleanup.push(() => {
      try {
        relayClient.destroy();
      } catch {
        /* ignore */
      }
    });
    // Wait a tick for the server's 'connection' handler to wire up.
    await new Promise((res) => setTimeout(res, 50));

    // 4) Issue a request on the NEW source. The primary should write the
    // framed envelope back through the UDS to the relay client.
    const req2 = host.sendRequestToExtensionAndWait({ ping: 3 }, 'process_data', 5_000);
    const wire2 = await readFramedOnce(relayClient);
    expect(wire2).toMatchObject({ type: 'process_data', payload: { ping: 3 } });
    // Relay forwards the response back through the UDS — primary reads
    // it as if it had come from the SW directly.
    relayClient.write(framed({ responseToRequestId: wire2.requestId, payload: { ack: 3 } }));
    await expect(req2).resolves.toMatchObject({ ack: 3 });
  }, 15_000);

  test('runAsPrimary wires up the UDS connection handler', async () => {
    const udsServer = await tryAcquireDaemonLock(socketPath);
    expect(udsServer).not.toBeNull();
    cleanup.push(() => new Promise<void>((res) => udsServer!.close(() => res())));

    // Smoke test — confirm runAsPrimary doesn't throw and registers a
    // connection listener. We can't easily run it against real
    // process.stdin in jest, so we just confirm the listener count.
    const host = new NativeMessagingHost();
    const before = udsServer!.listenerCount('connection');
    runAsPrimary({ nativeHost: host, server: {} as never }, udsServer!, socketPath);
    expect(udsServer!.listenerCount('connection')).toBe(before + 1);
  });
});
