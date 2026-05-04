/**
 * 01 — chrome_navigate happy path.
 *
 * Locks down: bridge reachable → tool dispatched → extension navigates →
 * response carries a tabId we can use downstream.
 */
import { expectOk, expectField, outcome, PASS, FAIL } from '../assertions.mjs';
import { correlateRequestId } from '../client.mjs';

export default [
  {
    name: '01-navigate:open-fixture-index',
    async run({ A, fixtureBase }) {
      const sinceMs = Date.now();
      const result = await A.callTool('chrome_navigate', {
        url: `${fixtureBase}/index.html`,
      });
      const requestId = await correlateRequestId(A, 'chrome_navigate', sinceMs);
      const okOutcome = expectOk(this.name + ':isError-false', result, {
        tool: 'chrome_navigate',
        client: 'A',
        args: { url: `${fixtureBase}/index.html` },
        requestId,
      });
      if (okOutcome.status !== PASS) return [okOutcome];

      const payload = A.parseTextPayload(result);
      const tabId = payload?.tabId ?? payload?.tab?.id;
      const hasTab = typeof tabId === 'number';
      return [
        okOutcome,
        outcome({
          name: this.name + ':response-includes-tabId',
          status: hasTab ? PASS : FAIL,
          expected: 'response payload contains numeric tabId',
          got: hasTab ? { tabId } : { payload },
          tool: 'chrome_navigate',
          client: 'A',
          requestId,
        }),
      ];
    },
  },

  {
    name: '01-navigate:invalid-tabId-returns-error',
    async run({ A, fixtureBase }) {
      const sinceMs = Date.now();
      // Pick a tabId we know doesn't exist.
      const result = await A.callTool('chrome_navigate', {
        url: `${fixtureBase}/index.html`,
        tabId: 9_999_999,
      });
      const requestId = await correlateRequestId(A, 'chrome_navigate', sinceMs);
      const env = A.parseErrorEnvelope(result);
      // Either the tool refused (isError: true) OR it silently fell back.
      // We don't lock the exact code here — different fallback strategies
      // are acceptable. We only assert that bogus tabIds don't silently
      // succeed against an unrelated tab.
      if (result?.isError && env?.code) {
        return [
          outcome({
            name: this.name,
            status: PASS,
            expected: 'structured error envelope',
            got: env,
            tool: 'chrome_navigate',
            client: 'A',
            requestId,
            args: { tabId: 9999999 },
          }),
        ];
      }
      const payload = A.parseTextPayload(result);
      const respondedTabId = payload?.tabId ?? payload?.tab?.id;
      // If it succeeded, it must NOT have used the active tab masquerading
      // as 9999999. We can't fully verify post-hoc; flag for human review.
      return [
        outcome({
          name: this.name,
          status: FAIL,
          expected: 'isError:true with structured code',
          got: { isError: !!result?.isError, respondedTabId, payload },
          tool: 'chrome_navigate',
          client: 'A',
          requestId,
          args: { tabId: 9999999 },
          note: 'invalid tabId did not surface a typed error',
        }),
      ];
    },
  },
];
