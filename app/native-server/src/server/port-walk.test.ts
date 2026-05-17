/**
 * IMP-0114: Server.start() walks ports on EADDRINUSE so two humanchrome
 * bridge processes (one per Chrome instance) can coexist instead of the
 * second silently failing to bind 12306.
 */
import { describe, test, expect } from '@jest/globals';
import net from 'node:net';
import { Server } from './index';

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', () => resolve(blocker));
  });
}

async function stopQuietly(s: Server) {
  try {
    await s.stop();
  } catch {
    /* already stopped */
  }
}

describe('Server.start() port walk (IMP-0114)', () => {
  // Each test uses a fresh Server (and its own Fastify instance) because
  // a closed Fastify can't be reopened. Server.stop() doesn't matter much
  // here — we just need the instance to be GC'd after the test.

  test('binds requested port when free', async () => {
    const s = new Server();
    try {
      const actual = await s.start(13501, {} as any, 10);
      expect(actual).toBe(13501);
    } finally {
      await stopQuietly(s);
    }
  }, 30_000);

  test('walks to next free port when requested is occupied', async () => {
    const blocker = await occupy(13510);
    const s = new Server();
    try {
      const actual = await s.start(13510, {} as any, 10);
      expect(actual).toBe(13511);
    } finally {
      await stopQuietly(s);
      blocker.close();
    }
  }, 30_000);

  test('throws when no port is free within the walk window', async () => {
    const blockers = await Promise.all([occupy(13520), occupy(13521), occupy(13522)]);
    const s = new Server();
    try {
      await expect(s.start(13520, {} as any, 2)).rejects.toThrow();
    } finally {
      await stopQuietly(s);
      for (const b of blockers) b.close();
    }
  }, 30_000);
});
