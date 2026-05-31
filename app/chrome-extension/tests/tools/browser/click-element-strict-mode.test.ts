/**
 * chrome_click_element strict-mode + Playwright-locator tests (IMP-0098).
 *
 * Verifies the new selector pipeline end-to-end inside the tool boundary:
 *
 *   1. structured selectorType (role / label / placeholder / alt / title /
 *      testid) routes through the accessibility-tree-helper resolver
 *      (`ensureRefForSelector` with `selectorKind`).
 *   2. multi-match without `index` / `multi:true` produces an INVALID_ARGS
 *      envelope carrying `details: {matchCount, samples}` — the strict-mode
 *      contract.
 *   3. multi-match WITH `multi: true` is accepted.
 *   4. multi-match WITH `index: N` is accepted and forwarded.
 *   5. raw-CSS fast path also routes through strict mode (helper returns
 *      strict envelope; tool surfaces it as INVALID_ARGS).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Bug-002: ClickTool now dispatches via CDP after the helper returns coords.
const sendCommandMock = vi.fn(async () => undefined);
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
  /** Override what ensureRefForSelector returns. */
  ensureResponse?: any;
  /** Override what clickElement returns. */
  clickResponse?: any;
  /** Capture sent messages for assertion. */
  capture?: any[];
}

function installChrome(overrides: ChromeInstall = {}) {
  const tabId = overrides.tabId ?? 5;
  const tab: chrome.tabs.Tab = {
    id: tabId,
    windowId: 1,
    url: overrides.url ?? 'https://example.com/',
    title: 'Example',
  } as any;

  const capture = overrides.capture ?? [];

  const sendMessage = vi.fn(async (_tid: number, msg: any) => {
    capture.push(msg);
    if (typeof msg.action === 'string' && msg.action.endsWith('_ping')) {
      return { status: 'pong' };
    }
    if (msg.action === 'ensureRefForSelector') {
      return (
        overrides.ensureResponse ?? {
          success: true,
          ref: 'ref_42',
          center: { x: 10, y: 20 },
          matchCount: 1,
        }
      );
    }
    if (msg.action === 'clickElement') {
      // Bug-002: default success envelope returns helper-resolved coords +
      // `cdpReady` so ClickTool can dispatch via CDP.
      return (
        overrides.clickResponse ?? {
          success: true,
          message: 'Click coords resolved for CDP dispatch',
          elementInfo: { clickMethod: 'ref' },
          cdpReady: true,
          clickX: 10,
          clickY: 20,
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
    windows: { update: vi.fn(), onRemoved: { addListener: vi.fn() } },
    scripting: { executeScript: vi.fn(async () => [{ result: undefined }]) },
    webNavigation: {
      getFrame: vi.fn(async () => ({
        url: overrides.url ?? 'https://example.com/',
        documentId: 'doc-1',
      })),
    },
  };
  return { tab, sendMessage, capture };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('chrome_click_element — Playwright-style selectors (IMP-0098)', () => {
  it('role: prefix routes through ensureRefForSelector with selectorKind=role', async () => {
    const capture: any[] = [];
    installChrome({ capture });
    const res = await clickTool.execute({
      selector: 'role:button[name="Submit"]',
      tabId: 5,
    });
    expect(res.isError).toBe(false);
    const ensure = capture.find((m) => m.action === 'ensureRefForSelector');
    expect(ensure).toBeDefined();
    expect(ensure.selectorKind).toBe('role');
    expect(ensure.role).toBe('button');
    expect(ensure.name).toBe('Submit');
  });

  it('explicit selectorType=label dispatches label kind', async () => {
    const capture: any[] = [];
    installChrome({ capture });
    const res = await clickTool.execute({
      selector: 'Email Address',
      selectorType: 'label',
      tabId: 5,
    });
    expect(res.isError).toBe(false);
    const ensure = capture.find((m) => m.action === 'ensureRefForSelector');
    expect(ensure.selectorKind).toBe('label');
    expect(ensure.text).toBe('Email Address');
  });

  it('testid: prefix forwards text for the helper to match against attrs', async () => {
    const capture: any[] = [];
    installChrome({ capture });
    await clickTool.execute({ selector: 'testid:submit-btn', tabId: 5 });
    const ensure = capture.find((m) => m.action === 'ensureRefForSelector');
    expect(ensure.selectorKind).toBe('testid');
    expect(ensure.text).toBe('submit-btn');
  });
});

describe('chrome_click_element — strict mode (IMP-0098)', () => {
  it('structured selector with multi-match returns INVALID_ARGS + samples', async () => {
    installChrome({
      ensureResponse: {
        success: false,
        error: 'role:button matched 2 or more elements',
        strict: {
          matchCount: 3,
          samples: [
            { tag: 'button', text: 'Save' },
            { tag: 'button', text: 'Save & Exit' },
            { tag: 'button', text: 'Save and Close' },
          ],
        },
      },
    });
    const res = await clickTool.execute({ selector: 'role:button', tabId: 5 });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.error.code).toBe('INVALID_ARGS');
    expect(body.error.details.matchCount).toBe(3);
    expect(body.error.details.samples).toHaveLength(3);
  });

  it('structured selector with multi:true is allowed (first match wins)', async () => {
    const capture: any[] = [];
    installChrome({ capture });
    const res = await clickTool.execute({
      selector: 'role:button',
      tabId: 5,
      multi: true,
    });
    expect(res.isError).toBe(false);
    const ensure = capture.find((m) => m.action === 'ensureRefForSelector');
    expect(ensure.allowMultiple).toBe(true);
  });

  it('structured selector with explicit index forwards the index', async () => {
    const capture: any[] = [];
    installChrome({ capture });
    const res = await clickTool.execute({
      selector: 'role:button',
      tabId: 5,
      index: 2,
    });
    expect(res.isError).toBe(false);
    const ensure = capture.find((m) => m.action === 'ensureRefForSelector');
    expect(ensure.index).toBe(2);
    expect(ensure.allowMultiple).toBe(true);
  });

  it('raw-CSS multi-match with index forwards index to click-helper (IMP-0117)', async () => {
    // Regression: pre-IMP-0117, the SW didn't forward `index` to click-helper
    // so the strict-mode probe always fired and returned the multi-match
    // error even when the caller had explicitly asked for the Nth match.
    const capture: any[] = [];
    installChrome({ capture });
    const res = await clickTool.execute({ selector: '.row-btn', tabId: 5, index: 1 });
    expect(res.isError).toBe(false);
    const click = capture.find((m) => m.action === 'clickElement');
    expect(click.index).toBe(1);
  });

  it('raw-CSS multi-match via click-helper returns strict envelope -> INVALID_ARGS', async () => {
    installChrome({
      clickResponse: {
        error: 'Selector "button" matched 2 or more elements',
        strict: {
          matchCount: 2,
          samples: [
            { tag: 'button', text: 'Save' },
            { tag: 'button', text: 'Cancel' },
          ],
        },
      },
    });
    const res = await clickTool.execute({ selector: 'button', tabId: 5 });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.error.code).toBe('INVALID_ARGS');
    expect(body.error.details.matchCount).toBe(2);
    expect(body.error.details.samples).toHaveLength(2);
  });
});
