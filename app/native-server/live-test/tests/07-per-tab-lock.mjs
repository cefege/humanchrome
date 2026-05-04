/**
 * 07 — Per-tab serialization lock.
 *
 * Two parallel mutating calls on the same tab should not overlap. We use
 * chrome_javascript (mutating) with a delay so the first call holds the
 * lock long enough that we can observe queuing.
 *
 * The timeout/recovery half of the lock contract is unit-tested in
 * app/chrome-extension/smoke-test.mjs (T20–T22). Not exposed via tool args
 * intentionally — surfacing a `lockTimeoutMs` knob on every mutating tool
 * just for the test would be a foot-gun.
 */
import { outcome, PASS, FAIL } from '../assertions.mjs';
import { openFixture } from '../setup.mjs';

export default [
  {
    name: '07-per-tab-lock:parallel-js-on-same-tab-is-serialized',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'index.html');
      if (typeof tabId !== 'number') {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'tabId',
            got: { tabId },
            note: 'precondition failed',
          }),
        ];
      }

      // Each call sleeps SLEEP_MS before returning. If the lock serializes,
      // wall-clock time should be ≥ 2 × SLEEP_MS. If they run in parallel
      // (lock not enforced), wall-clock should be close to SLEEP_MS.
      const SLEEP_MS = 350;
      const code = `(async () => { await new Promise(r => setTimeout(r, ${SLEEP_MS})); return Date.now(); })()`;

      const t0 = Date.now();
      const [res1, res2] = await Promise.all([
        A.callTool('chrome_javascript', { tabId, code, timeoutMs: 5000 }),
        A.callTool('chrome_javascript', { tabId, code, timeoutMs: 5000 }),
      ]);
      const elapsed = Date.now() - t0;

      const both = res1?.isError === false && res2?.isError === false;
      // Margin: serialized ≥ 1.6 × SLEEP_MS gives generous overhead headroom
      // while still rejecting the parallel case (~1.0 × SLEEP_MS).
      const serialized = elapsed >= SLEEP_MS * 1.6;
      const ok = both && serialized;
      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: `both calls succeed AND elapsed ≥ ${SLEEP_MS * 1.6}ms (serialization)`,
          got: {
            elapsedMs: elapsed,
            sleepMs: SLEEP_MS,
            serialized,
            res1Ok: !res1?.isError,
            res2Ok: !res2?.isError,
            res1Env: res1?.isError ? A.parseErrorEnvelope(res1) : null,
            res2Env: res2?.isError ? A.parseErrorEnvelope(res2) : null,
          },
          tool: 'chrome_javascript x2',
          client: 'A',
          args: { tabId },
        }),
      ];
    },
  },
];
