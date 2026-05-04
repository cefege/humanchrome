/**
 * 04 — typed error codes from the Phase 1.1 envelope.
 *
 * Covers: TAB_NOT_FOUND, INVALID_ARGS, INJECTION_FAILED.
 * (CDP_BUSY and INJECTION_TIMEOUT are manual-flag-gated in 04-error-codes-manual.mjs.)
 */
import { expectErrorCode, outcome, FAIL } from '../assertions.mjs';
import { correlateRequestId } from '../client.mjs';

export default [
  {
    name: '04-error:TAB_NOT_FOUND-when-tabId-bogus',
    async run({ A }) {
      const sinceMs = Date.now();
      const args = { tabId: 9_999_999, code: 'document.title' };
      const result = await A.callTool('chrome_javascript', args);
      const requestId = await correlateRequestId(A, 'chrome_javascript', sinceMs);
      return [
        expectErrorCode(this.name, result, 'TAB_NOT_FOUND', {
          tool: 'chrome_javascript',
          client: 'A',
          args,
          requestId,
        }),
      ];
    },
  },

  {
    name: '04-error:INVALID_ARGS-when-required-arg-missing',
    async run({ A }) {
      const sinceMs = Date.now();
      // chrome_javascript requires `code`.
      const args = {};
      const result = await A.callTool('chrome_javascript', args);
      const requestId = await correlateRequestId(A, 'chrome_javascript', sinceMs);
      return [
        expectErrorCode(this.name, result, 'INVALID_ARGS', {
          tool: 'chrome_javascript',
          client: 'A',
          args,
          requestId,
        }),
      ];
    },
  },

  {
    name: '04-error:INJECTION_FAILED-on-restricted-url',
    async run({ A }) {
      // Open chrome://newtab/ — content scripts cannot be injected.
      const navResult = await A.callTool('chrome_navigate', { url: 'chrome://newtab/' });
      const tabId = A.parseTextPayload(navResult)?.tabId;
      if (typeof tabId !== 'number') {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'tabId from chrome:// navigate',
            got: { tabId },
            note: 'precondition: chrome_navigate to chrome://newtab/ should return a tabId',
          }),
        ];
      }
      await new Promise((r) => setTimeout(r, 200));
      const sinceMs = Date.now();
      const args = { tabId, code: 'document.title' };
      const result = await A.callTool('chrome_javascript', args);
      const requestId = await correlateRequestId(A, 'chrome_javascript', sinceMs);
      // INJECTION_FAILED is the contract; PERMISSION_DENIED is also acceptable
      // since some Chrome versions refuse chrome:// pages with that wording
      // and the JS-tool's classifier may map it differently in future.
      const env = A.parseErrorEnvelope(result);
      const ok = env?.code === 'INJECTION_FAILED' || env?.code === 'PERMISSION_DENIED';
      return [
        outcome({
          name: this.name,
          status: ok ? 'pass' : 'fail',
          expected: 'INJECTION_FAILED (or PERMISSION_DENIED)',
          got: env ?? { isError: result?.isError, payload: A.parseTextPayload(result) },
          tool: 'chrome_javascript',
          client: 'A',
          args,
          requestId,
        }),
      ];
    },
  },

  {
    name: '04-error:UNKNOWN-tool-name',
    async run({ A }) {
      const args = { foo: 1 };
      const result = await A.callTool('not_a_real_tool', args);
      return [
        expectErrorCode(this.name, result, 'INVALID_ARGS', {
          tool: 'not_a_real_tool',
          client: 'A',
          args,
        }),
      ];
    },
  },
];
