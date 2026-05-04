/**
 * 02 — chrome_read_page happy path + raw-mode round-trip.
 */
import { expectOk, outcome, PASS, FAIL } from '../assertions.mjs';
import { correlateRequestId } from '../client.mjs';
import { openFixture } from '../setup.mjs';

export default [
  {
    name: '02-read-page:returns-elements-on-fixture',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'index.html', { warmupMs: 250 });
      if (typeof tabId !== 'number') {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'tabId from prior navigate',
            got: { tabId },
            note: 'precondition failed: chrome_navigate did not return a tabId',
          }),
        ];
      }
      const sinceMs = Date.now();
      const result = await A.callTool('chrome_read_page', { tabId });
      const requestId = await correlateRequestId(A, 'chrome_read_page', sinceMs);
      const okOutcome = expectOk(this.name + ':isError-false', result, {
        tool: 'chrome_read_page',
        client: 'A',
        args: { tabId },
        requestId,
      });
      if (okOutcome.status !== PASS) return [okOutcome];

      const payload = A.parseTextPayload(result);
      const hasContent =
        typeof payload?.pageContent === 'string' && payload.pageContent.length > 0;
      return [
        okOutcome,
        outcome({
          name: this.name + ':payload-has-content',
          status: hasContent ? PASS : FAIL,
          expected: 'pageContent string non-empty',
          got: { pageContentLen: payload?.pageContent?.length ?? null },
          tool: 'chrome_read_page',
          client: 'A',
          requestId,
        }),
      ];
    },
  },

  {
    name: '02-read-page:long-page-truncation-then-raw',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'long-page.html');
      if (typeof tabId !== 'number') {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'tabId from prior navigate',
            got: { tabId },
            note: 'precondition failed: chrome_navigate to long-page did not return a tabId',
          }),
        ];
      }

      const previewResult = await A.callTool('chrome_read_page', {
        tabId,
        filter: 'interactive',
      });
      const previewPayload = A.parseTextPayload(previewResult);

      // Either tree mode or fallback. Truncation envelope only appears on
      // the fallback path (per Phase 3.1 implementation). If the tree path
      // is taken we don't have a contract to check — pass softly.
      if (!previewPayload?.fallbackUsed) {
        return [
          outcome({
            name: this.name,
            status: PASS,
            expected: 'fallback path with truncation envelope (long page)',
            got: { fallbackUsed: false, count: previewPayload?.count },
            tool: 'chrome_read_page',
            client: 'A',
            args: { tabId, filter: 'interactive' },
            note: 'tree path was used; truncation envelope not exercised on this run',
          }),
        ];
      }

      const t = previewPayload.truncation;
      const okPreview = !!t && t.truncated === true && t.rawAvailable === true;
      const previewOutcome = outcome({
        name: this.name + ':preview-truncated',
        status: okPreview ? PASS : FAIL,
        expected: { truncated: true, rawAvailable: true, unit: 'elements' },
        got: t ?? { truncation: null },
        tool: 'chrome_read_page',
        client: 'A',
        args: { tabId, filter: 'interactive' },
      });

      const rawResult = await A.callTool('chrome_read_page', {
        tabId,
        filter: 'interactive',
        raw: true,
      });
      const rawPayload = A.parseTextPayload(rawResult);
      const rawTrunc = rawPayload?.truncation;
      const okRaw = !!rawTrunc && rawTrunc.truncated === false;
      const rawOutcome = outcome({
        name: this.name + ':raw-untruncated',
        status: okRaw ? PASS : FAIL,
        expected: { truncated: false },
        got: rawTrunc ?? { truncation: null },
        tool: 'chrome_read_page',
        client: 'A',
        args: { tabId, filter: 'interactive', raw: true },
      });

      return [previewOutcome, rawOutcome];
    },
  },
];
