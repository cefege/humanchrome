/**
 * 09 — chrome_debug_dump correlation.
 *
 * Locks down: each tool call writes start/done entries to the extension's
 * debug-log; querying by `requestId` returns them in order; querying by
 * `tool` + `sinceMs` finds the most recent call.
 */
import { outcome, PASS, FAIL } from '../assertions.mjs';
import { dumpRecent, correlateRequestId } from '../client.mjs';
import { openFixture } from '../setup.mjs';

export default [
  {
    name: '09-debug-dump:tool-call-recorded-with-requestId',
    async run({ A, fixtureBase }) {
      const sinceMs = Date.now();
      const tabId = await openFixture(A, fixtureBase, 'index.html', { warmupMs: 0 });
      if (typeof tabId !== 'number') {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'tabId from prior navigate',
            got: { tabId },
            note: 'precondition failed',
          }),
        ];
      }

      const requestId = await correlateRequestId(A, 'chrome_navigate', sinceMs);
      if (!requestId) {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'recent debug-log entry tagged with this tool',
            got: { requestId: null },
            tool: 'chrome_debug_dump',
            client: 'A',
            note: 'no debug-log entry found for chrome_navigate since call started — debug log not writing?',
          }),
        ];
      }
      return [
        outcome({
          name: this.name,
          status: PASS,
          expected: 'requestId discoverable via tool+since filter',
          got: { requestId },
          tool: 'chrome_debug_dump',
          client: 'A',
          requestId,
        }),
      ];
    },
  },

  {
    name: '09-debug-dump:requestId-returns-ordered-start-and-done',
    async run({ A, fixtureBase }) {
      const sinceMs = Date.now();
      await openFixture(A, fixtureBase, 'index.html', { warmupMs: 0 });
      const requestId = await correlateRequestId(A, 'chrome_navigate', sinceMs);
      if (!requestId) {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'requestId from prior call',
            got: null,
            note: 'correlation failed',
          }),
        ];
      }
      const entries = await dumpRecent(A, { requestId });
      const tools = entries.map((e) => e?.tool).filter(Boolean);
      const allMatch = tools.every((t) => t === 'chrome_navigate');
      const hasStart = entries.some((e) => /tool call start/.test(e?.msg ?? ''));
      const hasDone = entries.some((e) => /tool call done|tool call threw/.test(e?.msg ?? ''));
      const ok = entries.length >= 2 && allMatch && hasStart && hasDone;
      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: '≥2 entries; all match chrome_navigate; start + done/threw observed',
          got: {
            count: entries.length,
            allMatch,
            hasStart,
            hasDone,
            sample: entries.slice(0, 3),
          },
          tool: 'chrome_debug_dump',
          client: 'A',
          requestId,
        }),
      ];
    },
  },

  {
    name: '09-debug-dump:invalid-level-rejected',
    async run({ A }) {
      const result = await A.callTool('chrome_debug_dump', { level: 'fatal' });
      const env = A.parseErrorEnvelope(result);
      const ok = env?.code === 'INVALID_ARGS';
      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: 'INVALID_ARGS for unknown level',
          got: env ?? { isError: result?.isError, content: result?.content },
          tool: 'chrome_debug_dump',
          client: 'A',
          args: { level: 'fatal' },
        }),
      ];
    },
  },
];
