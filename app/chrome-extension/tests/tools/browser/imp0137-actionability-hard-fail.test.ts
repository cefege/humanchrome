/**
 * IMP-0137: hard-fail when actionability primitive isn't loaded.
 *
 * Pre-fix, click-helper.js + fill-helper.js silently fell back to
 * `{ok: true}` when `window.__actionability` was missing — a single
 * console.warn and every pre-action check (visible/stable/enabled/editable/
 * hit-test) was silently skipped, exactly as if `force: true` had been set
 * everywhere. Symptom: pages regressed to pre-IMP-0097 silent-click-on-overlay
 * the moment actionability.js failed to inject (build dropped the file,
 * CSP blocked it, race with cleanup).
 *
 * Post-fix:
 *   1. Both helpers return `{ok: false, failures: ['actionability_unavailable']}`
 *      when the primitive isn't present — the existing notActionable envelope
 *      then surfaces NOT_ACTIONABLE at the tool boundary with a clear token.
 *   2. The tool dispatcher (`interaction.ts`) calls `assertHelperPresent` after
 *      `injectContentScript` to verify `actionability_ping` returns pong;
 *      build-misconfiguration (file missing from output) surfaces as
 *      INJECTION_FAILED with a clear message instead of a per-element
 *      NOT_ACTIONABLE on every click/fill.
 *
 * Coverage matrix:
 *   - click-helper inline: ref path returns the failure token when
 *     window.__actionability is absent
 *   - fill-helper inline: same, against an input
 *   - interaction.ts dispatcher: ClickTool surfaces NOT_ACTIONABLE with the
 *     actionability_unavailable token when click-helper returns it
 *   - interaction.ts dispatcher: FillTool same
 *   - interaction.ts dispatcher: ClickTool throws INJECTION_FAILED when
 *     actionability_ping never returns pong (build-misconfig case)
 *   - interaction.ts dispatcher: FillTool same
 *   - interaction.ts dispatcher: actionability_ping pong path → click/fill
 *     proceed normally (no regression on the happy path)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clickTool, fillTool } from '@/entrypoints/background/tools/browser/interaction';

// ---------------------------------------------------------------------------
// Inline helper tests — load the actual click-helper.js / fill-helper.js
// source into the test sandbox and assert their `runActionability` fallback.
// ---------------------------------------------------------------------------

const CLICK_HELPER_SRC = readFileSync(
  resolve(__dirname, '../../../inject-scripts/click-helper.js'),
  'utf-8',
);
const FILL_HELPER_SRC = readFileSync(
  resolve(__dirname, '../../../inject-scripts/fill-helper.js'),
  'utf-8',
);

type ClickHelper = {
  clickElement: (
    selector: string | null,
    waitForNavigation: boolean,
    timeout: number,
    coordinates: { x: number; y: number } | null,
    ref: string | null,
    double: boolean,
    options: Record<string, unknown>,
  ) => Promise<any>;
};

type FillHelper = {
  fillElement: (
    selector: string | null,
    value: unknown,
    ref: string | null,
    opts?: Record<string, unknown>,
  ) => Promise<any>;
};

/**
 * Set up a fake DOM target the inject-scripts can navigate via ref. The
 * helpers resolve ref through window.__claudeElementMap[ref].deref().
 */
function makeRefTarget(
  tag: string,
  overrides: Partial<{ type: string; value: string; getBoundingClientRect: () => DOMRect }> = {},
): Element {
  const rect: DOMRect = {
    x: 10,
    y: 10,
    width: 100,
    height: 30,
    top: 10,
    left: 10,
    right: 110,
    bottom: 40,
    toJSON: () => rect,
  };
  return {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    type: overrides.type ?? null,
    value: overrides.value ?? '',
    href: null,
    textContent: '',
    isConnected: true,
    getBoundingClientRect: overrides.getBoundingClientRect ?? (() => rect),
    dispatchEvent: () => true,
    focus: () => {},
    blur: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    options: [],
    closest: () => null,
    getAttribute: () => null,
  } as unknown as Element;
}

function loadClickHelper(target: Element): ClickHelper {
  // Reset the IIFE guard so we re-eval into the current global scope.
  (globalThis as any).window = (globalThis as any).window ?? {};
  delete (globalThis as any).window.__CLICK_HELPER_INITIALIZED__;

  (globalThis as any).window = {
    ...((globalThis as any).window || {}),
    addEventListener: () => {},
    removeEventListener: () => {},
    innerHeight: 600,
    innerWidth: 800,
    getComputedStyle: () => ({}),
    // Deliberately NOT setting window.__actionability — that's the bug scenario.
    __claudeElementMap: {
      'r-test': { deref: () => target },
    },
  };
  (globalThis as any).document = {
    elementFromPoint: () => target,
    querySelector: () => target,
  };
  (globalThis as any).Element = function Element() {} as any;
  // Make the target pass `target instanceof Element` — easier than a real
  // prototype-chain mock.
  Object.setPrototypeOf(target, (globalThis as any).Element.prototype);
  (globalThis as any).chrome = {
    runtime: { onMessage: { addListener: () => {} } },
  };
  if (typeof (globalThis as any).MouseEvent === 'undefined') {
    (globalThis as any).MouseEvent = class {
      constructor(_type: string, _init?: any) {}
    };
  }

  const captured: Partial<ClickHelper> = {};
  const injected = CLICK_HELPER_SRC.replace(
    /(\n\s*chrome\.runtime\.onMessage\.addListener\b)/,
    '\n  __captured.clickElement = clickElement;\n$1',
  );
  if (injected === CLICK_HELPER_SRC) {
    throw new Error('failed to inject capture line into click-helper.js source');
  }
  new Function('__captured', injected)(captured);
  return captured as ClickHelper;
}

function loadFillHelper(target: Element): FillHelper {
  (globalThis as any).window = (globalThis as any).window ?? {};
  delete (globalThis as any).window.__FILL_HELPER_INITIALIZED__;

  (globalThis as any).window = {
    ...((globalThis as any).window || {}),
    addEventListener: () => {},
    removeEventListener: () => {},
    innerHeight: 600,
    innerWidth: 800,
    getComputedStyle: () => ({}),
    // Deliberately NO window.__actionability — the bug scenario.
    __claudeElementMap: {
      'r-test': { deref: () => target },
    },
  };
  (globalThis as any).document = {
    elementFromPoint: () => target,
    querySelector: () => target,
  };
  (globalThis as any).Element = function Element() {} as any;
  Object.setPrototypeOf(target, (globalThis as any).Element.prototype);
  (globalThis as any).chrome = {
    runtime: { onMessage: { addListener: () => {} } },
  };
  if (typeof (globalThis as any).Event === 'undefined') {
    (globalThis as any).Event = class {
      constructor(_type: string, _init?: any) {}
    };
  }
  // fill-helper's setNativeValue reaches HTMLInputElement.prototype — stub it.
  (globalThis as any).HTMLInputElement = function HTMLInputElement() {} as any;
  (globalThis as any).HTMLTextAreaElement = function HTMLTextAreaElement() {} as any;
  (globalThis as any).HTMLSelectElement = function HTMLSelectElement() {} as any;

  const captured: Partial<FillHelper> = {};
  const injected = FILL_HELPER_SRC.replace(
    /(\n\s*chrome\.runtime\.onMessage\.addListener\b)/,
    '\n  __captured.fillElement = fillElement;\n$1',
  );
  if (injected === FILL_HELPER_SRC) {
    throw new Error('failed to inject capture line into fill-helper.js source');
  }
  new Function('__captured', injected)(captured);
  return captured as FillHelper;
}

describe('IMP-0137: click-helper hard-fails when window.__actionability missing', () => {
  it('ref path returns notActionable with actionability_unavailable token', async () => {
    const target = makeRefTarget('button');
    const helper = loadClickHelper(target);
    const res = await helper.clickElement(null, false, 5000, null, 'r-test', false, {});
    expect(res.notActionable).toBe(true);
    expect(res.failures).toEqual(['actionability_unavailable']);
    expect(res.error).toContain('actionability_unavailable');
    expect(res.success).toBeUndefined();
  });

  it('coords path returns notActionable with actionability_unavailable token', async () => {
    const target = makeRefTarget('button');
    const helper = loadClickHelper(target);
    const res = await helper.clickElement(null, false, 5000, { x: 50, y: 50 }, null, false, {});
    expect(res.notActionable).toBe(true);
    expect(res.failures).toEqual(['actionability_unavailable']);
  });

  it('force:true short-circuits past the actionability_unavailable failure (caller explicitly opted out)', async () => {
    // IMP-0137 wrapper-level escape hatch: a caller passing force:true has
    // already declared they don't want the suite, so we don't surface
    // actionability_unavailable to them. They still get a click (or, if
    // dispatch finds no target element, the usual coord-mode error).
    const target = makeRefTarget('button');
    const helper = loadClickHelper(target);
    const res = await helper.clickElement(null, false, 5000, null, 'r-test', false, {
      force: true,
    });
    // The KEY assertion: notActionable is NOT set — the wrapper let us
    // through despite the missing primitive. The test sandbox can't run
    // a full click-and-dispatch (jsdom mocks are partial), so we don't
    // strictly assert `success: true` — we only verify the IMP-0137
    // failure token was bypassed.
    expect(res.notActionable).toBeUndefined();
    expect(res.failures).toBeUndefined();
  });
});

describe('IMP-0137: fill-helper hard-fails when window.__actionability missing', () => {
  it('ref path returns notActionable with actionability_unavailable token', async () => {
    const target = makeRefTarget('input', { type: 'text' });
    const helper = loadFillHelper(target);
    const res = await helper.fillElement(null, 'hello', 'r-test', {});
    expect(res.notActionable).toBe(true);
    expect(res.failures).toEqual(['actionability_unavailable']);
    expect(res.error).toContain('actionability_unavailable');
    expect(res.success).toBeUndefined();
  });

  it('force:true short-circuits past the failure (caller opted out of the suite)', async () => {
    // Same escape hatch as click-helper: a caller passing force:true
    // explicitly waived the actionability suite. We don't surface
    // actionability_unavailable to them — the helper proceeds past the
    // gate (whether the partial test sandbox can complete the actual
    // fill is incidental — the IMP-0137 failure token is what matters).
    const target = makeRefTarget('input', { type: 'text' });
    const helper = loadFillHelper(target);
    const res = await helper.fillElement(null, 'hello', 'r-test', { force: true });
    expect(res.notActionable).toBeUndefined();
    expect(res.failures).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool-dispatcher tests — verify ClickTool / FillTool map the new failure
// token to NOT_ACTIONABLE with the right details payload, AND verify the
// new assertHelperPresent self-test catches the missing-primitive case
// at the contract boundary (INJECTION_FAILED).
// ---------------------------------------------------------------------------

let sendMessageMock: ReturnType<typeof vi.fn>;
let executeScriptMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;
let getTabMock: ReturnType<typeof vi.fn>;
let webNavGetFrameMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendMessageMock = vi.fn(async (_tabId, msg) => {
    // Default: ALL pings return pong (both tool-name pings AND actionability_ping).
    if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
    return { success: true };
  });
  executeScriptMock = vi.fn().mockResolvedValue([{ result: undefined }]);
  queryMock = vi.fn().mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  getTabMock = vi.fn().mockResolvedValue({ id: 7, url: 'https://example.com' });
  webNavGetFrameMock = vi.fn().mockResolvedValue({ url: 'https://example.com', documentId: 'd1' });

  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
    get: getTabMock,
    sendMessage: sendMessageMock,
  };

  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };

  (globalThis.chrome as any).webNavigation = {
    ...(globalThis.chrome as any).webNavigation,
    getFrame: webNavGetFrameMock,
  };
});

afterEach(() => {
  // chrome.* persists across tests; reset is via beforeEach.
});

function parseEnvelope(res: { content: Array<{ text: string }>; isError: boolean }): {
  error: { code: string; message: string; details?: Record<string, unknown> };
} {
  return JSON.parse(res.content[0].text);
}

describe('IMP-0137: ClickTool surfaces actionability_unavailable token as NOT_ACTIONABLE', () => {
  it('classifies a helper-returned actionability_unavailable as NOT_ACTIONABLE', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      // Click-helper post-IMP-0137 fallback shape when primitive missing.
      return {
        error: 'Element is not actionable: actionability_unavailable',
        notActionable: true,
        failures: ['actionability_unavailable'],
        method: 'ref',
        ref: 'r-1',
      };
    });

    const res = await clickTool.execute({ ref: 'r-1', tabId: 7 });
    expect(res.isError).toBe(true);
    const env = parseEnvelope(res as any);
    expect(env.error.code).toBe('NOT_ACTIONABLE');
    expect(env.error.message).toContain('actionability_unavailable');
    expect(env.error.details?.failures).toEqual(['actionability_unavailable']);
  });
});

describe('IMP-0137: FillTool surfaces actionability_unavailable token as NOT_ACTIONABLE', () => {
  it('classifies a helper-returned actionability_unavailable as NOT_ACTIONABLE', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return {
        error: 'Element is not actionable: actionability_unavailable',
        notActionable: true,
        failures: ['actionability_unavailable'],
        elementInfo: { tagName: 'INPUT' },
      };
    });

    const res = await fillTool.execute({ ref: 'r-1', value: 'x', tabId: 7 });
    expect(res.isError).toBe(true);
    const env = parseEnvelope(res as any);
    expect(env.error.code).toBe('NOT_ACTIONABLE');
    expect(env.error.message).toContain('actionability_unavailable');
    expect(env.error.details?.failures).toEqual(['actionability_unavailable']);
  });
});

describe('IMP-0137: assertHelperPresent — ClickTool catches missing actionability.js', () => {
  it('throws INJECTION_FAILED when actionability_ping never returns pong (build dropped the file)', async () => {
    // Click-helper's ping responds (loaded), but actionability_ping is silent
    // — exactly the regression scenario: someone refactored the inject list
    // and removed actionability.js. The tool-name ping passes; the
    // actionability_ping self-test fails.
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action === 'actionability_ping') return undefined; // not loaded
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return { success: true };
    });

    const res = await clickTool.execute({ ref: 'r-1', tabId: 7 });
    expect(res.isError).toBe(true);
    const env = parseEnvelope(res as any);
    expect(env.error.code).toBe('INJECTION_FAILED');
    expect(env.error.message).toContain('actionability.js');
    expect(env.error.message).toContain('actionability_ping');
  });

  it('throws INJECTION_FAILED when actionability_ping responds with wrong status', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action === 'actionability_ping') return { status: 'nope' };
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return { success: true };
    });

    const res = await clickTool.execute({ ref: 'r-1', tabId: 7 });
    expect(res.isError).toBe(true);
    const env = parseEnvelope(res as any);
    expect(env.error.code).toBe('INJECTION_FAILED');
  });

  it('proceeds normally when actionability_ping returns pong (happy path)', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return { success: true, message: 'ok', elementInfo: { tagName: 'BUTTON' } };
    });

    const res = await clickTool.execute({ ref: 'r-1', tabId: 7 });
    expect(res.isError).toBe(false);
  });
});

describe('IMP-0137: assertHelperPresent — FillTool catches missing actionability.js', () => {
  it('throws INJECTION_FAILED when actionability_ping never returns pong', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action === 'actionability_ping') return undefined;
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return { success: true };
    });

    const res = await fillTool.execute({ ref: 'r-1', value: 'x', tabId: 7 });
    expect(res.isError).toBe(true);
    const env = parseEnvelope(res as any);
    expect(env.error.code).toBe('INJECTION_FAILED');
    expect(env.error.message).toContain('actionability.js');
  });

  it('proceeds normally when actionability_ping returns pong', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return { success: true, message: 'ok', elementInfo: { tagName: 'INPUT' } };
    });

    const res = await fillTool.execute({ ref: 'r-1', value: 'x', tabId: 7 });
    expect(res.isError).toBe(false);
  });
});
