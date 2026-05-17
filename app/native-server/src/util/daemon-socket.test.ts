/**
 * IMP-0120: daemon UDS plumbing tests.
 *
 * Covers:
 *  - first acquire succeeds (no UDS yet)
 *  - second acquire returns null (live primary)
 *  - stale-socket cleanup (file exists, no listener) → acquire succeeds
 *  - connectAsRelay round-trip writes/reads bytes
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';

import { tryAcquireDaemonLock, connectAsRelay } from './daemon-socket';

describe('daemon-socket — primary/relay UDS lifecycle', () => {
  let tmp: string;
  let socketPath: string;
  let servers: Server[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hc-daemon-'));
    socketPath = join(tmp, 'bridge-daemon.sock');
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((res) => s.close(() => res()));
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test('first acquire returns a listening server', async () => {
    const server = await tryAcquireDaemonLock(socketPath);
    expect(server).not.toBeNull();
    servers.push(server!);
    expect(existsSync(socketPath)).toBe(true);
  });

  test('second acquire while primary is live returns null', async () => {
    const primary = await tryAcquireDaemonLock(socketPath);
    expect(primary).not.toBeNull();
    servers.push(primary!);

    const second = await tryAcquireDaemonLock(socketPath);
    expect(second).toBeNull();
  });

  test('stale socket file (no listener) is unlinked and acquire succeeds', async () => {
    // Simulate a crashed previous primary by writing a bogus file at the
    // socket path — bind() will see EADDRINUSE and the probe connect
    // will fail (no listener), so tryAcquireDaemonLock should unlink
    // and re-bind.
    writeFileSync(socketPath, '');
    expect(existsSync(socketPath)).toBe(true);

    const server = await tryAcquireDaemonLock(socketPath);
    expect(server).not.toBeNull();
    servers.push(server!);
  });

  test('connectAsRelay round-trips bytes through the daemon UDS', async () => {
    const server = await tryAcquireDaemonLock(socketPath);
    expect(server).not.toBeNull();
    servers.push(server!);

    const incoming = new Promise<Buffer>((resolve) => {
      server!.on('connection', (socket) => {
        socket.on('data', (chunk) => {
          resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          socket.write(Buffer.from('pong'));
        });
      });
    });

    const client = await connectAsRelay(socketPath);
    client.write(Buffer.from('ping'));
    const recv = await incoming;
    expect(recv.toString()).toBe('ping');

    const echo = await new Promise<Buffer>((resolve) => {
      client.once('data', (chunk) => resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    });
    expect(echo.toString()).toBe('pong');

    client.destroy();
  });

  test('connectAsRelay rejects when no daemon is listening', async () => {
    await expect(connectAsRelay(socketPath, 500)).rejects.toThrow();
  });
});
