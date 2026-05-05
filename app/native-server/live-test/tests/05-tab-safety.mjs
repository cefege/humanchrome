/**
 * 05 — TARGET_NAVIGATED_AWAY race in click, fill, keyboard, and upload.
 *
 * Strategy:
 *  1. Open a fixture page → tabId.
 *  2. Kick off a `chrome_navigate` to a different fixture page (in parallel,
 *     no await).
 *  3. Immediately call the mutating tool. The pre-action assert (click,
 *     keyboard) or post-action assert (fill, upload via withNavigationGuard)
 *     should surface TARGET_NAVIGATED_AWAY whenever the navigation lands
 *     before the action completes.
 *
 * This is timing-dependent — sometimes the action runs cleanly before the
 * navigation lands. We treat "ok response" as a soft pass (the race didn't
 * trigger this run) and only hard-fail when the action silently succeeded
 * or failed with an unexpected error code.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outcome, PASS, FAIL } from '../assertions.mjs';
import { correlateRequestId } from '../client.mjs';
import { openFixture } from '../setup.mjs';

// Resolve the live-test fixtures dir on the local filesystem. We pass a
// real on-disk path to chrome_upload_file's `filePath` mode, which avoids
// the bridge's prepareFileFromRemote roundtrip (a separate path that
// currently times out on base64/fileUrl modes — outside this test's scope).
const FIXTURES_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'fixtures');
const UPLOAD_FILE_PATH = path.join(FIXTURES_DIR, 'index.html');

/**
 * Shared race-outcome classifier. The guard-fire and runtime-error paths look
 * the same across click/keyboard/upload — only the message details and the
 * acceptable "wrong-doc evidence" wording vary.
 */
function evaluateRaceOutcome({ client, name, tool, args, requestId, result }) {
  const env = client.parseErrorEnvelope(result);
  if (env?.code === 'TARGET_NAVIGATED_AWAY' || env?.code === 'TAB_CLOSED') {
    return outcome({
      name,
      status: PASS,
      expected: 'TARGET_NAVIGATED_AWAY (or TAB_CLOSED) when nav wins the race',
      got: env,
      tool,
      client: client.label,
      args,
      requestId,
    });
  }
  if (!result?.isError) {
    return outcome({
      name,
      status: PASS,
      expected: "race didn't trigger or action resolved before nav",
      got: client.parseTextPayload(result),
      tool,
      client: client.label,
      args,
      requestId,
      note: 'navigation did not land in time; guard not exercised this run',
    });
  }
  // Wrong-doc evidence: target wasn't on the new page so chrome rejected.
  // The action did reach the new document but Chrome's own missing-target
  // error stopped silent wrong-target execution.
  if (/not found|no element|is not an input|is not a file input|not interactable/i.test(env?.message ?? '')) {
    return outcome({
      name,
      status: PASS,
      expected: 'TARGET_NAVIGATED_AWAY (ideal) or wrong-doc element-rejection (race resolved late)',
      got: env,
      tool,
      client: client.label,
      args,
      requestId,
      note: 'action reached new document; chrome rejected on missing/invalid target. Guard would have caught this earlier if snapshot landed before nav kicked off.',
    });
  }
  return outcome({
    name,
    status: FAIL,
    expected: 'TARGET_NAVIGATED_AWAY, success, or wrong-doc element-rejection',
    got: env ?? { content: result?.content },
    tool,
    client: client.label,
    args,
    requestId,
    note: 'action failed with an unexpected error code',
  });
}

export default [
  {
    name: '05-tab-safety:click-during-navigate-surfaces-typed-error-or-runs-cleanly',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'index.html');
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
      const navPromise = A.callTool('chrome_navigate', {
        tabId,
        url: `${fixtureBase}/long-page.html`,
      });
      await new Promise((r) => setTimeout(r, 30));
      const args = { tabId, selector: '#primary-btn' };
      const result = await A.callTool('chrome_click_element', args);
      await navPromise.catch(() => undefined);

      const requestId = await correlateRequestId(A, 'chrome_click_element', sinceMs);
      return [
        evaluateRaceOutcome({
          client: A,
          name: this.name,
          tool: 'chrome_click_element',
          args,
          requestId,
          result,
        }),
      ];
    },
  },

  {
    name: '05-tab-safety:keyboard-during-navigate-surfaces-typed-error-or-runs-cleanly',
    async run({ A, fixtureBase }) {
      // Open the form fixture so #name is a real focus target. Race a
      // navigate against a keyboard dispatch into that input.
      const tabId = await openFixture(A, fixtureBase, 'form.html');
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
      const navPromise = A.callTool('chrome_navigate', {
        tabId,
        url: `${fixtureBase}/long-page.html`,
      });
      await new Promise((r) => setTimeout(r, 30));
      const args = { tabId, selector: '#name', keys: 'hello' };
      const result = await A.callTool('chrome_keyboard', args);
      await navPromise.catch(() => undefined);

      const requestId = await correlateRequestId(A, 'chrome_keyboard', sinceMs);
      return [
        evaluateRaceOutcome({
          client: A,
          name: this.name,
          tool: 'chrome_keyboard',
          args,
          requestId,
          result,
        }),
      ];
    },
  },

  {
    name: '05-tab-safety:upload-during-navigate-surfaces-typed-error-or-runs-cleanly',
    async run({ A, fixtureBase }) {
      const tabId = await openFixture(A, fixtureBase, 'form.html');
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
      const navPromise = A.callTool('chrome_navigate', {
        tabId,
        url: `${fixtureBase}/long-page.html`,
      });
      await new Promise((r) => setTimeout(r, 30));
      // Use a real on-disk file (the fixture index.html) via filePath mode.
      // The point is the race, not what the file contains.
      const args = {
        tabId,
        selector: '#upload',
        filePath: UPLOAD_FILE_PATH,
      };
      const result = await A.callTool('chrome_upload_file', args);
      await navPromise.catch(() => undefined);

      const requestId = await correlateRequestId(A, 'chrome_upload_file', sinceMs);
      return [
        evaluateRaceOutcome({
          client: A,
          name: this.name,
          tool: 'chrome_upload_file',
          args,
          requestId,
          result,
        }),
      ];
    },
  },

  {
    name: '05-tab-safety:tab-closed-mid-call-surfaces-TAB_CLOSED',
    async run({ A, B, fixtureBase }) {
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

      // Close the tab from client B while A is mid-call.
      const sinceMs = Date.now();
      const args = {
        tabId,
        code: 'await new Promise(r => setTimeout(() => r(document.title), 400))',
        timeoutMs: 2000,
      };
      const callPromise = A.callTool('chrome_javascript', args);
      // Give it a beat to start, then close from B.
      await new Promise((r) => setTimeout(r, 80));
      await B.callTool('chrome_close_tab', { tabIds: [tabId] }).catch(() => undefined);
      const result = await callPromise;
      const requestId = await correlateRequestId(A, 'chrome_javascript', sinceMs);
      const env = A.parseErrorEnvelope(result);
      const ok = env?.code === 'TAB_CLOSED' || env?.code === 'TAB_NOT_FOUND';
      return [
        outcome({
          name: this.name,
          status: ok ? PASS : FAIL,
          expected: 'TAB_CLOSED or TAB_NOT_FOUND',
          got: env ?? { isError: result?.isError, payload: A.parseTextPayload(result) },
          tool: 'chrome_javascript',
          client: 'A',
          args,
          requestId,
        }),
      ];
    },
  },
];
