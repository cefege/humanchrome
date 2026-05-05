/**
 * Regression test for the `MAX_PENDING_REQUESTS` DoS cap shipped in round 3.
 *
 * `NativeMessagingHost.sendRequestToExtensionAndWait` queues each in-flight
 * request in a Map. Without the cap a misbehaving (or buggy) extension build
 * could grow that Map without bound and exhaust the host's memory. The cap
 * — currently 1000 — synchronously rejects the 1001st attempt with
 * "Too many pending requests" and never writes anything to stdout.
 *
 * The test fully isolates the host from real I/O:
 *   - `process.stdout.write` is spied to swallow framed-message bytes.
 *   - All 1000 prior requests are left pending forever — we never resolve
 *     them, but we *do* clear their setTimeout timers in `afterAll` so jest
 *     doesn't leak handles between suites.
 */
import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';

// Import after jest is in scope so the mock-uuid moduleNameMapper applies.
import { NativeMessagingHost } from './native-messaging-host';

describe('NativeMessagingHost — pendingRequests cap', () => {
  let host: NativeMessagingHost;
  let stdoutSpy: jest.SpiedFunction<typeof process.stdout.write>;
  // Track every timer the cap test causes so afterAll can drain them and
  // jest's "did not exit" warning stays quiet.
  const sentinelTimers: NodeJS.Timeout[] = [];

  beforeAll(() => {
    // Silence stdout writes — the host frames messages with a 4-byte length
    // header and we don't want raw binary in the test log. Returning `true`
    // matches the real signature (writable.write returns boolean).
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((..._args: unknown[]) => true);
    host = new NativeMessagingHost();
  });

  afterAll(() => {
    stdoutSpy.mockRestore();
    // Cancel any timers we created so jest exits cleanly.
    for (const t of sentinelTimers) clearTimeout(t);
  });

  test('1001st sendRequestToExtensionAndWait rejects with "Too many pending requests"', async () => {
    // Use a long timeout so the 1000 in-flight requests stay pending for the
    // entire test run — they'll be resolved/rejected only when the timer
    // fires or `cleanup()` runs. We don't await them.
    const longTimeoutMs = 60_000;
    const inflight: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const p = host.sendRequestToExtensionAndWait({ idx: i }, 'request_data', longTimeoutMs);
      // Swallow the eventual rejection to keep node's unhandledRejection
      // tracker quiet; we don't actually care what happens to these.
      p.catch(() => undefined);
      inflight.push(p);
    }

    // The 1001st call must reject *synchronously* with the cap message.
    await expect(
      host.sendRequestToExtensionAndWait({ idx: 1001 }, 'request_data', longTimeoutMs),
    ).rejects.toThrow(/Too many pending requests/i);

    // And critically: stdout must NOT have been written to for the 1001st
    // call. The cap returns before the envelope is framed and sent.
    // Each of the 1000 accepted calls wrote exactly once.
    expect(stdoutSpy).toHaveBeenCalledTimes(1000);

    // Drain pending timers via the host's internal cleanup path. We can't
    // call the private `cleanup()` directly, but rejecting the long-pending
    // requests by closing them out via setImmediate is enough for jest.
    const drain = setTimeout(() => undefined, 1);
    sentinelTimers.push(drain);
    // Force-resolve by hand so node doesn't complain about pending timers.
    // We poke into the host to read the private map only for cleanup; in
    // production code this is never observed.
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

    // Awaiting Promise.allSettled gives node a chance to run the rejection
    // handlers before the test exits.
    await Promise.allSettled(inflight);
  }, 30_000);
});
