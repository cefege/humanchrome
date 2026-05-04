/**
 * 08 — Truncation envelope round-trip.
 *
 * read-page is covered in 02. This file focuses on chrome_console
 * (Phase 3.1 unified envelope) and chrome_javascript output capping.
 */
import { outcome, PASS, FAIL } from '../assertions.mjs';
import { correlateRequestId } from '../client.mjs';
import { openFixture } from '../setup.mjs';

export default [
  {
    name: '08-truncation:console-args-truncated-then-raw-untruncated',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'long-page.html');
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
      // Wait for the long-page script to finish emitting console messages.
      await new Promise((r) => setTimeout(r, 300));

      // Re-emit the wide/deep objects so they're freshly captured by snapshot mode.
      await A.callTool('chrome_javascript', {
        tabId,
        code:
          'const big = {level0: {}}; let c = big.level0;' +
          'for (let i = 0; i < 6; i++) { c.next = { idx: i, blob: "x".repeat(50) }; c = c.next; }' +
          'const wide = {}; for (let i = 0; i < 250; i++) wide["k"+i] = i;' +
          'console.log("nested probe", big); console.log("wide probe", wide);',
      });
      await new Promise((r) => setTimeout(r, 200));

      const sinceMs = Date.now();
      const previewArgs = { tabId, mode: 'snapshot', includeExceptions: false };
      const previewResult = await A.callTool('chrome_console', previewArgs);
      const requestId = await correlateRequestId(A, 'chrome_console', sinceMs);
      const preview = A.parseTextPayload(previewResult);
      const t = preview?.truncation;
      const okPreview = !!t && t.argsTruncated === true;
      const previewOutcome = outcome({
        name: this.name + ':preview-argsTruncated',
        status: okPreview ? PASS : FAIL,
        expected: { argsTruncated: true, rawAvailable: true },
        got: t ?? { truncation: null },
        tool: 'chrome_console',
        client: 'A',
        args: previewArgs,
        requestId,
      });

      // Now retry with raw=true.
      const rawArgs = { tabId, mode: 'snapshot', raw: true, includeExceptions: false };
      const rawResult = await A.callTool('chrome_console', rawArgs);
      const raw = A.parseTextPayload(rawResult);
      const rt = raw?.truncation;
      // After raw=true the per-arg serializer no longer truncates, so
      // argsTruncated should drop to false (assuming the test data fits the
      // raw caps). rawAvailable goes to false too because there's no further
      // escape hatch.
      const okRaw = !!rt && rt.argsTruncated === false;
      const rawOutcome = outcome({
        name: this.name + ':raw-resolves-argsTruncated',
        status: okRaw ? PASS : FAIL,
        expected: { argsTruncated: false },
        got: rt ?? { truncation: null },
        tool: 'chrome_console',
        client: 'A',
        args: rawArgs,
      });

      return [previewOutcome, rawOutcome];
    },
  },

  {
    name: '08-truncation:javascript-output-cap-emits-truncated-flag',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'long-page.html');
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
      await new Promise((r) => setTimeout(r, 200));

      const args = {
        tabId,
        // Emit a string clearly above the default 51200-byte cap.
        code: '"x".repeat(200000)',
        maxOutputBytes: 1024,
      };
      const result = await A.callTool('chrome_javascript', args);
      const payload = A.parseTextPayload(result);
      const ok = result?.isError === false && payload?.truncated === true;
      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: { truncated: true },
          got: { truncated: payload?.truncated, success: payload?.success, isError: result?.isError },
          tool: 'chrome_javascript',
          client: 'A',
          args,
        }),
      ];
    },
  },
];
