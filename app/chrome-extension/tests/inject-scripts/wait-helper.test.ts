/**
 * IMP-0138 — wait-helper.js TDZ regression.
 *
 * The wait-helper executor wraps each `waitForX` function in a Promise. Inside
 * that executor, `done()` references `timer` / `poller` lexical bindings that
 * were originally declared with `const` AFTER the initial synchronous
 * `check()` call. When the predicate was already satisfied on first poll —
 * the exact case the JS wait was designed for (`document.readyState === 'complete'`
 * against a fully-loaded page) — `done()` ran while those bindings were still
 * in TDZ. The resulting ReferenceError escaped the executor, the Promise
 * rejected with no payload, the SW message router got nothing back, and the
 * caller observed a 120s MCP transport timeout instead of the requested
 * timeoutMs.
 *
 * These tests drive the script the same way the SW does: load the IIFE into
 * jsdom, capture the `chrome.runtime.onMessage` listener it installs, then
 * invoke the listener with a `waitForX` request and assert the sendResponse
 * callback fires with the expected envelope (NOT a rejected/empty response
 * and NOT after timeoutMs has elapsed).
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HELPER_PATH = resolve(__dirname, '../../inject-scripts/wait-helper.js');

type WaitListener = (
  request: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | void;

const onMessageListeners: WaitListener[] = [];

/** Replace globalThis.chrome with a minimal shim that lets us capture the
 *  IIFE's onMessage listener. The default setupFiles mock uses `vi.fn()` for
 *  `addListener`, which silently drops the callback — we need a real array. */
function installChromeMocks(): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: {
        addListener: (fn: WaitListener) => {
          onMessageListeners.push(fn);
        },
        removeListener: (fn: WaitListener) => {
          const i = onMessageListeners.indexOf(fn);
          if (i >= 0) onMessageListeners.splice(i, 1);
        },
      },
    },
  };
}

/** Send a request through the captured listener and resolve with the
 *  sendResponse payload. Returns undefined if the listener returned
 *  synchronously (e.g. validation errors call sendResponse + return true,
 *  async paths call sendResponse from a .then() — both work here). */
function dispatch(request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    if (onMessageListeners.length === 0) {
      resolve(undefined);
      return;
    }
    const listener = onMessageListeners[0];
    let settled = false;
    const reply = (resp: unknown) => {
      if (settled) return;
      settled = true;
      resolve(resp as Record<string, unknown> | undefined);
    };
    // Per chrome.runtime semantics: returning truthy from the listener means
    // sendResponse will be called asynchronously. Sync returns are allowed
    // but rare in this helper.
    listener(request, null, reply);
  });
}

beforeAll(async () => {
  installChromeMocks();
  const helper = await fs.readFile(HELPER_PATH, 'utf8');
  // Eval into the global scope so `chrome.runtime.onMessage.addListener` and
  // `window.__WAIT_HELPER_INITIALIZED__` resolve against our mocks.
  new Function(helper).call(globalThis);
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  // Make sure fake timers don't leak between tests (only some tests opt in).
  vi.useRealTimers();
});

describe('IMP-0138 wait-helper.js TDZ regression', () => {
  // `tookMs` is recorded INSIDE the executor (Date.now() - start, captured
  // inside `check()` BEFORE the setTimeout dispatch), so the tight upper
  // bounds below prove we hit the synchronous fast path rather than the 250ms
  // safety poll or the pre-fix 120s transport fallback. Pre-fix, sendResponse
  // never fired on first-check-true and these tests would hang past vitest's
  // default 5s timeout.
  it('waitForJs resolves immediately when the expression is already truthy on first check', async () => {
    const resp = await dispatch({
      action: 'waitForJs',
      expression: 'true',
      timeout: 200,
    });

    expect(resp).toBeDefined();
    expect(resp).toMatchObject({ success: true });
    expect(typeof (resp as Record<string, unknown>).tookMs).toBe('number');
    expect((resp as { tookMs: number }).tookMs).toBeLessThan(50);
  });

  it('waitForJs resolves on first check for `document.readyState === "complete"` (the canonical regression)', async () => {
    // jsdom's document.readyState is 'complete' once initial parse finishes —
    // mirrors the production scenario in the IMP-0138 backlog entry.
    const resp = await dispatch({
      action: 'waitForJs',
      expression: 'document.readyState === "complete"',
      timeout: 200,
    });

    expect(resp).toMatchObject({ success: true });
    expect((resp as { tookMs: number }).tookMs).toBeLessThan(50);
  });

  it('waitFor (text-presence) resolves immediately when the element is already in the DOM', async () => {
    document.body.innerHTML = `
      <div>
        <button id="confirm" style="display:block;width:100px;height:30px;">Confirm</button>
      </div>
    `;
    // jsdom's getBoundingClientRect returns 0x0 by default — stub the button's
    // rect so isVisible() returns true (the helper rejects 0-size elements).
    const btn = document.getElementById('confirm') as HTMLElement;
    btn.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 10,
        width: 100,
        height: 30,
        top: 10,
        left: 10,
        right: 110,
        bottom: 40,
        toJSON: () => ({}),
      }) as DOMRect;

    const resp = await dispatch({
      action: 'waitForText',
      text: 'Confirm',
      appear: true,
      timeout: 2000,
    });

    expect(resp).toMatchObject({ success: true });
    expect((resp as { matched?: { ref?: string } }).matched?.ref).toMatch(/^ref_/);
    // findElementByText walks the DOM via TreeWalker (slower under jsdom than
    // production Chrome), hence the generous 800ms bound — still well under
    // the 2000ms timeout setTimeout.
    expect((resp as { tookMs: number }).tookMs).toBeLessThan(800);
  });

  it('waitForNetworkIdle resolves once the quiet window elapses on an already-idle page', async () => {
    // jsdom has no working PerformanceObserver, so the helper hits its `catch`
    // branch and falls back to the single-deadline timer. The point of this
    // test is that the executor body doesn't throw a TDZ ReferenceError during
    // setup.
    const resp = await dispatch({
      action: 'waitForNetworkIdle',
      quietMs: 50,
      timeout: 2000,
    });

    expect(resp).toMatchObject({ success: true });
    expect((resp as { quietForMs?: number }).quietForMs).toBeGreaterThanOrEqual(0);
    expect((resp as { tookMs: number }).tookMs).toBeLessThan(1500);
  });

  it('waitForJs eventually resolves after a DOM mutation flips the expression true (no regression on the slow path)', async () => {
    document.body.innerHTML = '<div id="probe"></div>';
    const expression = "document.querySelector('#probe').classList.contains('ready')";

    const waitPromise = dispatch({
      action: 'waitForJs',
      expression,
      timeout: 3000,
    });

    setTimeout(() => {
      document.getElementById('probe')!.classList.add('ready');
    }, 50);

    const resp = await waitPromise;
    expect(resp).toMatchObject({ success: true });
    // Generous upper bound — MutationObserver and the 250ms safety poll
    // combine unpredictably under parallel-test load.
    const tookMs = (resp as { tookMs: number }).tookMs;
    expect(tookMs).toBeGreaterThanOrEqual(40);
    expect(tookMs).toBeLessThan(2500);
  });

  it('waitForJs returns a timeout envelope when the expression never goes true', async () => {
    const resp = await dispatch({
      action: 'waitForJs',
      expression: 'false',
      timeout: 300,
    });

    expect(resp).toMatchObject({ success: false, reason: 'timeout' });
    // Must be at least the requested timeout (no early bail) and not
    // pathologically larger (no fallback to a 120s transport timeout).
    const tookMs = (resp as { tookMs: number }).tookMs;
    expect(tookMs).toBeGreaterThanOrEqual(280);
    expect(tookMs).toBeLessThan(2000);
  });

  it('waitForJs returns a compile-error envelope on a syntactically invalid expression (sanity check)', async () => {
    const resp = await dispatch({
      action: 'waitForJs',
      expression: 'function(){', // unterminated function literal
      timeout: 500,
    });

    expect(resp).toMatchObject({ success: false, reason: 'compile-error' });
    expect(typeof (resp as { error?: string }).error).toBe('string');
  });

  it('wait_helper_ping returns synchronously (proves the IIFE installed its listener correctly)', async () => {
    const resp = await dispatch({ action: 'wait_helper_ping' });
    expect(resp).toEqual({ status: 'pong' });
  });
});
