/**
 * IMP-0099 — recorder.js SelectorEngine delegation.
 *
 * Validates that the recorder's `SelectorEngine.buildTarget` (in
 * `inject-scripts/recorder.js`) delegates to the shared selector engine
 * bundle. We load both files into jsdom in order (bundle → recorder), then
 * exercise the SelectorEngine via the recorder's exposed singleton.
 *
 * Goal: prove the recorder NO LONGER emits brittle nth-of-type CSS as the
 * primary candidate for elements that have richer identifiers.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUNDLE_PATH = resolve(__dirname, '../../inject-scripts/selector-engine-bundle.js');
const RECORDER_PATH = resolve(__dirname, '../../inject-scripts/recorder.js');

interface RecorderControlListener {
  (
    request: {
      action: string;
      cmd?: string;
      meta?: unknown;
      requireAck?: boolean;
      type?: string;
      payload?: unknown;
    },
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ): boolean | void;
}

const onMessageListeners: RecorderControlListener[] = [];
const sentMessages: Array<{ type: string; payload?: { kind?: string; steps?: any[] } }> = [];

function installChromeMocks() {
  (globalThis as any).chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: {
        addListener: (fn: RecorderControlListener) => {
          onMessageListeners.push(fn);
        },
        removeListener: (fn: RecorderControlListener) => {
          const i = onMessageListeners.indexOf(fn);
          if (i >= 0) onMessageListeners.splice(i, 1);
        },
      },
      sendMessage: vi.fn((message: { type: string; payload?: any }, cb?: (resp: any) => void) => {
        sentMessages.push(message);
        if (cb) cb({ ok: true });
        return Promise.resolve({ ok: true });
      }),
      lastError: undefined,
    },
  };
}

function dispatch(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve) => {
    if (onMessageListeners.length === 0) {
      resolve(undefined);
      return;
    }
    const listener = onMessageListeners[0];
    const reply = (resp: unknown) => resolve(resp);
    listener({ action, ...extra } as any, null, reply);
  });
}

beforeAll(async () => {
  installChromeMocks();
  const bundle = await fs.readFile(BUNDLE_PATH, 'utf8');
  const recorder = await fs.readFile(RECORDER_PATH, 'utf8');
  // Load bundle (registers window.__rrSelectorEngine).
  new Function(bundle).call(globalThis);
  // Load recorder (registers chrome.runtime.onMessage listener + uses the engine).
  new Function(recorder).call(globalThis);
});

beforeEach(async () => {
  document.body.innerHTML = '';
  // Stop first to drain any pending lastFill from the prior test into the
  // sendMessage queue; THEN clear sentMessages so test assertions only see
  // events triggered by this test's body.
  await dispatch('rr_recorder_control', { cmd: 'stop' });
  await dispatch('rr_recorder_control', { cmd: 'start', meta: { name: 'test' } });
  sentMessages.length = 0;
});

async function waitForBatchFlush(): Promise<void> {
  // Recorder batches with BATCH_SEND_MS = 100ms; allow a generous timeout
  // for the flush + scroll debounce.
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

function recordedSteps(): any[] {
  const steps: any[] = [];
  for (const msg of sentMessages) {
    if (msg?.payload?.kind === 'steps' && Array.isArray(msg.payload.steps)) {
      steps.push(...msg.payload.steps);
    }
  }
  return steps;
}

describe('IMP-0099 recorder: SelectorEngine delegates to shared bundle', () => {
  it('clicking a button with data-testid records testid as primary', async () => {
    document.body.innerHTML = `
      <div class="card">
        <button data-testid="confirm-btn" class="btn primary">Confirm</button>
      </div>
    `;
    const btn = document.querySelector('button')!;
    btn.click();

    await waitForBatchFlush();

    const steps = recordedSteps();
    const click = steps.find((s) => s.type === 'click');
    expect(click).toBeDefined();
    expect(click.target.selector).toBe('[data-testid="confirm-btn"]');
    expect(click.target.candidates[0].value).toBe('[data-testid="confirm-btn"]');
    expect(click.target.candidates[0].strategy).toBe('testid');
  });

  it('clicking a button with only text records text as the primary candidate', async () => {
    document.body.innerHTML = `
      <div>
        <button>Cancel</button>
        <button>Sign in</button>
      </div>
    `;
    const btns = document.querySelectorAll('button');
    btns[1].click();

    await waitForBatchFlush();

    const steps = recordedSteps();
    const click = steps.find((s) => s.type === 'click');
    expect(click).toBeDefined();
    // candidates[0] is the highest-priority match; for a button with no other
    // identifiers, that's the text candidate.
    const first = click.target.candidates[0];
    expect(first.strategy).toBe('text');
    expect(first.value).toBe('Sign in');
    // The structural css-path is also emitted — sibling buttons force
    // :nth-of-type into the structural fallback. Verify it's there but NOT
    // chosen as the primary candidate, which is the IMP-0099 regression
    // target (recorder pre-IMP-0099 picked nth-of-type as primary).
    const hasNthOfType = click.target.candidates.some(
      (c: any) => typeof c.value === 'string' && c.value.includes(':nth-of-type'),
    );
    expect(hasNthOfType).toBe(true);
    expect(click.target.candidates[0].value).not.toContain(':nth-of-type');
  });

  it('filling an input with a <label for=...> records label as the primary candidate', async () => {
    document.body.innerHTML = `
      <label for="company">Company name</label>
      <input id="company" />
    `;
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    input.value = 'Acme Co';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await waitForBatchFlush();

    const steps = recordedSteps();
    const fill = steps.find((s) => s.type === 'fill');
    expect(fill).toBeDefined();
    expect(fill.value).toBe('Acme Co');
    // The first candidate must be the label-derived locator.
    const first = fill.target.candidates[0];
    expect(first.strategy).toBe('label');
    expect(first.value).toContain('Company name');
  });

  it('filling an input with placeholder records placeholder as the primary candidate', async () => {
    document.body.innerHTML = `<input placeholder="search" />`;
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    input.value = 'user@example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await waitForBatchFlush();

    const steps = recordedSteps();
    const fill = steps.find((s) => s.type === 'fill');
    expect(fill).toBeDefined();
    expect(fill.target.candidates[0].strategy).toBe('placeholder');
    expect(fill.target.candidates[0].value).toBe('[placeholder="search"]');
    expect(fill.target.selector).toBe('[placeholder="search"]');
  });

  it('carries fingerprint + domPath in recorded target (Phase 1.2 contract)', async () => {
    document.body.innerHTML = `<button data-testid="x">Y</button>`;
    document.querySelector('button')!.click();
    await waitForBatchFlush();

    const steps = recordedSteps();
    const click = steps.find((s) => s.type === 'click');
    expect(click).toBeDefined();
    expect(typeof click.target.fingerprint).toBe('string');
    expect(click.target.fingerprint).toContain('button');
    expect(Array.isArray(click.target.domPath)).toBe(true);
  });
});
