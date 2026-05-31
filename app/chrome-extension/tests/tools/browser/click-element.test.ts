/**
 * chrome_click coordinate-mode tests (IMP-0092).
 *
 * Before IMP-0092 the helper returned `{success: true, ..., elementInfo: {warning: ...}}`
 * when `elementFromPoint` found nothing at the supplied coordinates — agents
 * had no signal that the click never fired. We now surface an explicit error
 * envelope so `sendMessageToTab` re-throws and `clickTool.execute` produces an
 * `isError: true` ToolResult.
 *
 * Coverage:
 *   1. Boundary test — `clickTool.execute` returns an error envelope when the
 *      content-script helper reports "no element at coordinates". This is the
 *      contract the LLM sees, exercised across single-click, double-click,
 *      and right-click (button=='right') variants.
 *   2. Direct test of the injected helper script — confirms the helper itself
 *      now returns `{error}` instead of `{success:true, warning}` in the
 *      coord-mode-empty-space scenario, and likewise when the page shifts
 *      between the initial `elementFromPoint` check and the
 *      `simulateClick`/`simulateDoubleClick` re-resolution (the TOCTOU race
 *      called out in the Notes section of the spec).
 *   3. Sanity — the happy path (element under the cursor) still returns
 *      success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Bug-002: ClickTool now dispatches via CDP `Input.dispatchMouseEvent` after
// the helper returns coords. Mock cdpSessionManager so unit tests can assert
// the CDP path is exercised + capture the dispatched arguments.
const sendCommandMock = vi.fn(
  async (_tabId: number, _method: string, _params?: Record<string, unknown>) => undefined,
);
const withSessionMock = vi.fn(
  async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn(),
);
vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: (...args: unknown[]) => sendCommandMock(...(args as [any, any, any])),
    withSession: (...args: unknown[]) =>
      withSessionMock(
        args[0] as number,
        args[1] as string,
        args[2] as () => Promise<unknown>,
      ),
  },
}));

import { clickTool } from '@/entrypoints/background/tools/browser/interaction';

interface ChromeInstall {
  url?: string;
  tabId?: number;
  helperResponse?: any;
}

function installChrome(overrides: ChromeInstall = {}) {
  const tabId = overrides.tabId ?? 5;
  const tab: chrome.tabs.Tab = {
    id: tabId,
    windowId: 1,
    url: overrides.url ?? 'https://example.com/',
    title: 'Example',
  } as any;

  const sendMessage = vi.fn(async (_tid: number, msg: any) => {
    if (typeof msg.action === 'string' && msg.action.endsWith('_ping')) {
      return { status: 'pong' };
    }
    if (msg.action === 'clickElement') {
      // Bug-002: default success envelope mirrors the new helper return
      // shape (resolved coords + cdpReady), so the ClickTool can proceed
      // to its CDP dispatch step.
      return (
        overrides.helperResponse ?? {
          success: true,
          message: 'Element clicked successfully',
          elementInfo: { clickMethod: 'coordinates', clickPosition: { x: 100, y: 100 } },
          cdpReady: true,
          clickX: 100,
          clickY: 100,
          isDouble: msg.double === true,
        }
      );
    }
    return { success: true };
  });

  (globalThis as unknown as { chrome: any }).chrome = {
    runtime: {
      id: 'test',
      sendMessage: vi.fn(),
      getURL: (p: string) => `chrome-extension://test${p}`,
    },
    tabs: {
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
      sendMessage,
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      update: vi.fn(),
      onRemoved: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: undefined }]),
    },
    webNavigation: {
      getFrame: vi.fn(async () => ({
        url: overrides.url ?? 'https://example.com/',
        documentId: 'doc-1',
      })),
    },
  };
  return { tab, sendMessage };
}

beforeEach(() => {
  sendCommandMock.mockClear();
  withSessionMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('chrome_click coordinate mode — IMP-0092 boundary', () => {
  it('returns an error envelope when helper reports no element at coordinates (single click)', async () => {
    installChrome({
      helperResponse: { error: 'No element at coordinates (100, 100)' },
    });
    const res = await clickTool.execute({
      coordinates: { x: 100, y: 100 },
      tabId: 5,
    });

    expect(res.isError).toBe(true);
    const body = (res.content[0] as any).text as string;
    expect(body).toMatch(/No element at coordinates \(100, 100\)/);
    // The structured error envelope wraps the message — JSON-parseable per
    // serializeToolError contract.
    const parsed = JSON.parse(body);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toMatch(/No element at coordinates/);
  });

  it('returns an error envelope on double-click into empty space', async () => {
    installChrome({
      helperResponse: { error: 'No element at coordinates (250, 400)' },
    });
    const res = await clickTool.execute({
      coordinates: { x: 250, y: 400 },
      double: true,
      tabId: 5,
    });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/No element at coordinates \(250, 400\)/);
  });

  it('returns an error envelope on right-click into empty space', async () => {
    installChrome({
      helperResponse: { error: 'No element at coordinates (10, 20)' },
    });
    const res = await clickTool.execute({
      coordinates: { x: 10, y: 20 },
      button: 'right',
      tabId: 5,
    });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/No element at coordinates \(10, 20\)/);
  });

  it('happy path: coord-click on an element still returns success', async () => {
    installChrome(); // default helperResponse is a success envelope
    const res = await clickTool.execute({
      coordinates: { x: 100, y: 100 },
      tabId: 5,
    });

    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.success).toBe(true);
    expect(body.clickMethod).toBe('coordinates');
  });

  // Bug-002: assert ClickTool now dispatches the trusted CDP click instead
  // of relying on the helper's synthetic `dispatchEvent`. Helper returns
  // resolved coords; BG fires `Input.dispatchMouseEvent` mousePressed +
  // mouseReleased through cdpSessionManager.
  it('Bug-002: dispatches via CDP Input.dispatchMouseEvent at helper-resolved coords', async () => {
    const { sendMessage } = installChrome({
      helperResponse: {
        success: true,
        message: 'Click coords resolved for CDP dispatch',
        elementInfo: { clickMethod: 'ref', ref: 'r1' },
        cdpReady: true,
        clickX: 250,
        clickY: 400,
        isDouble: false,
      },
    });
    const res = await clickTool.execute({ ref: 'r1', tabId: 5 });
    expect(res.isError).toBe(false);

    // Helper got the cdpDispatch flag (so it skipped synthetic dispatch).
    const clickMsg = sendMessage.mock.calls.find(
      (c: any[]) => c[1]?.action === 'clickElement',
    )?.[1];
    expect(clickMsg?.cdpDispatch).toBe(true);

    // CDP move + press + release at the helper-resolved coords.
    const cdpCalls = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchMouseEvent',
    );
    expect(cdpCalls).toHaveLength(3);
    expect(cdpCalls[0][2]).toMatchObject({
      type: 'mouseMoved',
      x: 250,
      y: 400,
      button: 'none',
      buttons: 0,
    });
    expect(cdpCalls[1][2]).toMatchObject({
      type: 'mousePressed',
      x: 250,
      y: 400,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    expect(cdpCalls[2][2]).toMatchObject({
      type: 'mouseReleased',
      x: 250,
      y: 400,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  });

  it('Bug-002: double-click sends two press+release pairs with clickCount=2', async () => {
    installChrome({
      helperResponse: {
        success: true,
        message: 'Click coords resolved for CDP dispatch',
        elementInfo: { clickMethod: 'ref', ref: 'r1' },
        cdpReady: true,
        clickX: 10,
        clickY: 20,
        isDouble: true,
      },
    });
    const res = await clickTool.execute({ ref: 'r1', double: true, tabId: 5 });
    expect(res.isError).toBe(false);

    const cdpCalls = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchMouseEvent',
    );
    // move + (press + release) + (press + release) = 5
    expect(cdpCalls).toHaveLength(5);
    // mouseMoved doesn't carry clickCount; the 4 press/release events do.
    const pressRelease = cdpCalls.filter(
      (c) => (c[2] as { type?: string }).type !== 'mouseMoved',
    );
    expect(pressRelease).toHaveLength(4);
    expect(pressRelease.every((c) => (c[2] as { clickCount?: number }).clickCount === 2)).toBe(true);
  });

  it('Bug-002: right-click sends button:right with buttons:2', async () => {
    installChrome();
    await clickTool.execute({
      coordinates: { x: 100, y: 100 },
      button: 'right',
      tabId: 5,
    });
    const cdpCalls = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchMouseEvent',
    );
    // move + press + release = 3
    expect(cdpCalls).toHaveLength(3);
    // First call is mouseMoved (button:'none'), second is mousePressed (button:'right').
    expect(cdpCalls[1][2]).toMatchObject({ button: 'right', buttons: 2 });
  });

  it('Bug-002: passes modifier bitmask (Shift=8, Ctrl=2, etc.) to CDP', async () => {
    installChrome();
    await clickTool.execute({
      coordinates: { x: 100, y: 100 },
      modifiers: { shiftKey: true, ctrlKey: true },
      tabId: 5,
    });
    const cdpCalls = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchMouseEvent',
    );
    // Modifier bitmask passes through every event in the chain.
    expect(cdpCalls.every((c) => (c[2] as { modifiers?: number }).modifiers === (8 | 2))).toBe(
      true,
    );
  });

  it('Bug-002: CDP_BUSY is surfaced when debugger is attached elsewhere', async () => {
    installChrome();
    withSessionMock.mockImplementationOnce(async () => {
      throw new Error('Another debugger is already attached to this tab');
    });
    const res = await clickTool.execute({ coordinates: { x: 100, y: 100 }, tabId: 5 });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.error.code).toBe('CDP_BUSY');
  });
});

/**
 * Direct test of the injected helper script. We load the file, expose its
 * `clickElement` plus the simulate helpers, and exercise the coord-mode
 * branches in isolation. This is the only way to assert the helper's *own*
 * return shape (the boundary tests above stub the IPC response).
 */
describe('click-helper.js — coord-mode error shape (IMP-0092)', () => {
  // Cache the helper source so we don't reload from disk every test.
  const helperSource = readFileSync(
    resolve(__dirname, '../../../inject-scripts/click-helper.js'),
    'utf-8',
  );

  type HelperApi = {
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

  function loadHelper(
    opts: {
      elementFromPoint?: (x: number, y: number) => Element | null;
      elementFromPointSequence?: Array<Element | null>;
      installActionability?: boolean;
    } = {},
  ): HelperApi {
    // Reset window flag so the IIFE in the helper re-runs cleanly.
    (globalThis as any).window = (globalThis as any).window ?? {};
    delete (globalThis as any).window.__CLICK_HELPER_INITIALIZED__;

    // Minimal document/window shims. The coord-mode branch only needs
    // elementFromPoint; everything else can stay undefined for these tests.
    let calls = 0;
    const seq = opts.elementFromPointSequence;
    const efp =
      opts.elementFromPoint ??
      ((_x: number, _y: number) => {
        if (seq) {
          const v = seq[calls];
          calls++;
          return v ?? null;
        }
        return null;
      });
    (globalThis as any).document = {
      elementFromPoint: efp,
      querySelector: () => null,
    };
    (globalThis as any).window = {
      ...((globalThis as any).window || {}),
      addEventListener: () => {},
      removeEventListener: () => {},
      innerHeight: 600,
      innerWidth: 800,
      getComputedStyle: () => ({}),
    };
    // IMP-0137: when the helper-side runActionability can't find
    // window.__actionability it now hard-fails with the
    // `actionability_unavailable` token instead of silently degrading.
    // Tests that need to exercise OTHER code paths past the actionability
    // gate must opt into a stubbed primitive that always returns ok.
    if (opts.installActionability !== false) {
      (globalThis as any).window.__actionability = {
        awaitActionable: () => Promise.resolve({ ok: true }),
        ALL_CHECKS: ['visible', 'enabled', 'editable', 'stable', 'hit-test'],
      };
    } else {
      delete (globalThis as any).window.__actionability;
    }
    (globalThis as any).chrome = {
      runtime: { onMessage: { addListener: () => {} } },
    };
    // MouseEvent is needed by dispatchClickSequence. Most JSDOM-ish envs have
    // it; stub a no-op if not.
    if (typeof (globalThis as any).MouseEvent === 'undefined') {
      (globalThis as any).MouseEvent = class {
        constructor(_type: string, _init?: any) {}
      };
    }

    // The helper is wrapped in `if (window.__CLICK_HELPER_INITIALIZED__) {}
    // else { ... }`, so `clickElement` is only in scope inside the else.
    // Inject the capture line at the end of the else block.
    const captured: Partial<HelperApi> = {};
    const injected = helperSource.replace(
      /(\n\s*chrome\.runtime\.onMessage\.addListener\b)/,
      '\n  __captured.clickElement = clickElement;\n$1',
    );
    if (injected === helperSource) {
      throw new Error('failed to inject capture line into click-helper.js source');
    }

    new Function('__captured', injected)(captured);
    return captured as HelperApi;
  }

  it('coord-mode with no element at point returns an error (not success+warning)', async () => {
    const helper = loadHelper({ elementFromPoint: () => null });
    const res = await helper.clickElement(null, false, 5000, { x: 100, y: 100 }, null, false, {});

    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/No element at coordinates \(100, 100\)/);
    expect(res.success).toBeUndefined();
    // Critical: the pre-fix shape had elementInfo.warning. The new shape
    // does NOT report success.
    expect(res.elementInfo?.warning).toBeUndefined();
  });

  it('coord-mode race: element gone between initial check and dispatch returns an error', async () => {
    // First elementFromPoint (inside clickElement) returns an element so we
    // pass the visibility branch; second call (inside simulateClick) returns
    // null, simulating the page shifting mid-call. The dispatch must surface
    // as a no-event error.
    const fakeElement = {
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      }),
      tagName: 'DIV',
      id: '',
      className: '',
      textContent: '',
      dispatchEvent: () => true,
    } as unknown as Element;
    const helper = loadHelper({ elementFromPointSequence: [fakeElement, null, null] });
    const res = await helper.clickElement(null, false, 5000, { x: 50, y: 50 }, null, false, {});

    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/No element at coordinates \(50, 50\)/);
    expect(res.success).toBeUndefined();
  });

  it('coord-mode double-click into empty space returns an error', async () => {
    const helper = loadHelper({ elementFromPoint: () => null });
    const res = await helper.clickElement(null, false, 5000, { x: 12, y: 34 }, null, true, {});

    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/No element at coordinates \(12, 34\)/);
  });

  it('coord-mode right-click (button:right) into empty space returns an error', async () => {
    const helper = loadHelper({ elementFromPoint: () => null });
    const res = await helper.clickElement(null, false, 5000, { x: 7, y: 8 }, null, false, {
      button: 'right',
    });

    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/No element at coordinates \(7, 8\)/);
  });
});
