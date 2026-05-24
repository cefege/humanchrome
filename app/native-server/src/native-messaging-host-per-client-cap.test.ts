/**
 * IMP-0173: per-client backpressure on the NM host's pending-request map.
 *
 * The global `MAX_PENDING_REQUESTS` cap (1000) protects the bridge from a
 * process-wide leak, but does NOT stop one runaway client from
 * monopolizing the entire queue and starving every other MCP session.
 * `MAX_PENDING_PER_CLIENT` (50) blocks a single client from issuing more
 * than 50 concurrent in-flight calls.
 *
 * Test isolates the host the same way `native-messaging-host.test.ts`
 * does: stdout writes are swallowed; long-timeout pending requests stay
 * pending; the private `pendingRequests` Map is drained in `afterAll` so
 * jest exits cleanly.
 */
import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';

import { NativeMessagingHost } from './native-messaging-host';

describe('NativeMessagingHost — per-client backpressure', () => {
  let host: NativeMessagingHost;
  let stdoutSpy: jest.SpiedFunction<typeof process.stdout.write>;
  const sentinelTimers: NodeJS.Timeout[] = [];

  beforeAll(() => {
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((..._args: unknown[]) => true);
    host = new NativeMessagingHost();
  });

  afterAll(() => {
    stdoutSpy.mockRestore();
    for (const t of sentinelTimers) clearTimeout(t);
    const pending = (
      host as unknown as {
        pendingRequests: Map<string, { timeoutId: NodeJS.Timeout; reject: (e: Error) => void }>;
      }
    ).pendingRequests;
    for (const entry of pending.values()) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error('test-shutdown'));
    }
    pending.clear();
  });

  test('51st in-flight call from one client rejects with CLIENT_BUSY; other clients unaffected', async () => {
    const longTimeoutMs = 60_000;
    const inflight: Promise<unknown>[] = [];

    // Queue 50 in-flight calls for "alice" — fills her per-client budget.
    for (let i = 0; i < 50; i += 1) {
      const p = host.sendRequestToExtensionAndWait(
        { idx: i },
        'request_data',
        longTimeoutMs,
        undefined,
        'alice',
      );
      p.catch(() => undefined);
      inflight.push(p);
    }

    // alice's 51st must reject with the per-client cap message.
    await expect(
      host.sendRequestToExtensionAndWait(
        { idx: 51 },
        'request_data',
        longTimeoutMs,
        undefined,
        'alice',
      ),
    ).rejects.toThrow(/CLIENT_BUSY/);

    // bob is a different client — his first call must NOT be blocked by
    // alice's cap. He gets accepted (the global 1000 cap is far from full).
    const bobP = host.sendRequestToExtensionAndWait(
      { idx: 999 },
      'request_data',
      longTimeoutMs,
      undefined,
      'bob',
    );
    bobP.catch(() => undefined);
    inflight.push(bobP);

    // Calls with no clientId (legacy/system) are exempt from the per-client
    // cap. This keeps internal bridge calls (HEARTBEAT, etc.) working even
    // when a misbehaving client is at its cap.
    const sysP = host.sendRequestToExtensionAndWait(
      { idx: 888 },
      'request_data',
      longTimeoutMs,
    );
    sysP.catch(() => undefined);
    inflight.push(sysP);

    // Drain a tick so node's microtask queue runs settled handlers.
    await new Promise<void>((r) => setImmediate(() => r()));
  }, 30_000);
});
