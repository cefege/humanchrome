/**
 * 03 — chrome_click_element + chrome_fill_or_select happy paths.
 */
import { outcome, PASS, FAIL } from '../assertions.mjs';
import { correlateRequestId } from '../client.mjs';
import { openFixture } from '../setup.mjs';

export default [
  {
    name: '03-click-fill:click-by-selector-runs-on-page',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'index.html', { warmupMs: 250 });
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
      const sinceMs = Date.now();
      const args = { tabId, selector: '#primary-btn' };
      const result = await A.callTool('chrome_click_element', args);
      const requestId = await correlateRequestId(A, 'chrome_click_element', sinceMs);
      if (!result || result.isError) {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'click ok',
            got: { isError: result?.isError, envelope: A.parseErrorEnvelope(result), content: result?.content },
            tool: 'chrome_click_element',
            client: 'A',
            args,
            requestId,
          }),
        ];
      }
      // Verify the click actually fired in-page by reading data-clicked.
      const verifyResult = await A.callTool('chrome_javascript', {
        tabId,
        code: 'document.getElementById("result").dataset.clicked',
      });
      const clicked = A.parseTextPayload(verifyResult)?.result;
      const ok = String(clicked) === '"1"' || String(clicked) === '1' || clicked === '1';
      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: '#result.dataset.clicked === "1" after one click',
          got: { clicked, verifyPayload: A.parseTextPayload(verifyResult) },
          tool: 'chrome_click_element',
          client: 'A',
          args,
          requestId,
        }),
      ];
    },
  },

  {
    name: '03-click-fill:fill-text-and-select',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'form.html', { warmupMs: 250 });
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
      await new Promise((r) => setTimeout(r, 250));

      // Fill name + select color.
      const nameRes = await A.callTool('chrome_fill_or_select', {
        tabId,
        selector: '#name',
        value: 'Mihai',
      });
      const colorRes = await A.callTool('chrome_fill_or_select', {
        tabId,
        selector: '#color',
        value: 'green',
      });
      const fails = [];
      for (const [label, r] of [
        ['fill name', nameRes],
        ['select color', colorRes],
      ]) {
        if (r?.isError) fails.push({ label, envelope: A.parseErrorEnvelope(r) });
      }
      if (fails.length) {
        return [
          outcome({
            name: this.name,
            status: FAIL,
            expected: 'both fill ops succeed',
            got: { fails },
            tool: 'chrome_fill_or_select',
            client: 'A',
            args: { tabId, fields: ['#name', '#color'] },
          }),
        ];
      }

      // Verify by reading the input + select values.
      const verify = await A.callTool('chrome_javascript', {
        tabId,
        code: 'JSON.stringify({name: document.getElementById("name").value, color: document.getElementById("color").value})',
      });
      const parsed = A.parseTextPayload(verify)?.result;
      const ok =
        typeof parsed === 'string' &&
        parsed.includes('"name":"Mihai"') &&
        parsed.includes('"color":"green"');
      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: 'name="Mihai" and color="green" after fills',
          got: { parsed },
          tool: 'chrome_fill_or_select',
          client: 'A',
          args: { tabId },
        }),
      ];
    },
  },

  {
    // Regression: prepareFileFromRemote used to hang ~30s on base64/fileUrl
    // because chrome.runtime.sendMessage doesn't deliver intra-context.
    // If this times out (~30s), the sendNativeRequest routing regressed.
    name: '03-upload:base64-roundtrip-completes-quickly',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'form.html', { warmupMs: 250 });
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

      const t0 = Date.now();
      const args = {
        tabId,
        selector: '#upload',
        // "hello\n" base64-encoded — small but real bytes through the
        // download/save/verify path.
        base64Data: 'aGVsbG8K',
        fileName: 'regression-base64.txt',
      };
      const result = await A.callTool('chrome_upload_file', args);
      const elapsed = Date.now() - t0;

      const env = result?.isError ? A.parseErrorEnvelope(result) : null;
      // Pass when: no error, AND elapsed is well under the 30s prepareFile
      // timeout. 5s is generous headroom while still catching a regression
      // where the response never comes back.
      const ok = !result?.isError && elapsed < 5_000;
      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: 'isError:false AND elapsed < 5000ms',
          got: {
            isError: result?.isError ?? null,
            elapsedMs: elapsed,
            envelope: env,
            payload: !env ? A.parseTextPayload(result) : null,
          },
          tool: 'chrome_upload_file',
          client: 'A',
          args,
          note:
            elapsed >= 5_000
              ? 'slow response — likely a regression in prepareFileFromRemote routing'
              : null,
        }),
      ];
    },
  },
];
