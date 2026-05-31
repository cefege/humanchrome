/**
 * chrome_typeahead_probe tests — Bug-008 follow-up.
 *
 * Covers arg validation, the install/click/type/wait/readback choreography,
 * the summary derivation (keydownFired / inputFired / lookupFetchFired),
 * NOT_ACTIONABLE classification, CDP_BUSY classification, and the
 * networkUrlPattern filter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Two MAIN-world `Runtime.evaluate` calls now feed the probe — the
// install shim returns `{ok:true}` and the readback shim returns the
// captured events + fetches. Default mocks resolve them via a
// per-method dispatcher so individual tests can override either.
type ReadbackPayload = {
  ok: boolean;
  inputValueAfter: string;
  ariaExpanded: string;
  ariaControls: string | null;
  listboxFound: boolean;
  listboxOptionCount: number;
  listboxSampleOpts: string[];
  events: Array<Record<string, unknown>>;
  fetches: Array<Record<string, unknown>>;
};
let mainInstallResp: { result: { value: { ok: boolean; message?: string } } } = {
  result: { value: { ok: true } },
};
let mainReadbackResp: { result: { value: ReadbackPayload } } | { result: { value: undefined } } = {
  result: {
    value: {
      ok: true,
      inputValueAfter: 'a',
      ariaExpanded: 'true',
      ariaControls: null,
      listboxFound: false,
      listboxOptionCount: 0,
      listboxSampleOpts: [],
      events: [],
      fetches: [],
    },
  },
};

const sendCommandMock = vi.fn(
  async (_tabId: number, method: string, params?: Record<string, unknown>) => {
    if (method !== 'Runtime.evaluate') return undefined;
    const expr = String(params?.expression ?? '');
    // First Runtime.evaluate call is the install shim; second is the
    // readback. Distinguish by checking which function name is baked into
    // the IIFE expression.
    if (expr.includes('installCaptureInMainWorld')) return mainInstallResp;
    if (expr.includes('readCaptureFromMainWorld')) return mainReadbackResp;
    return undefined;
  },
);
const withSessionMock = vi.fn(
  async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn(),
);
vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: (...args: unknown[]) =>
      sendCommandMock(args[0] as number, args[1] as string, args[2] as any),
    withSession: (...args: unknown[]) =>
      withSessionMock(
        args[0] as number,
        args[1] as string,
        args[2] as () => Promise<unknown>,
      ),
  },
}));

import { typeaheadProbeTool } from '@/entrypoints/background/tools/browser/typeahead-probe';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'typeahead-probe-test-client';
const TAB_ID = 21;

let executeScriptMock: ReturnType<typeof vi.fn>;

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => typeaheadProbeTool.execute(args));
}
function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

// Resolve shim (ISOLATED, executeScript) — returns coords + initial aria.
const RESOLVE_OK = {
  result: {
    ok: true,
    tagName: 'input',
    bbox: { x: 100, y: 100, width: 200, height: 30 },
    point: { x: 200, y: 115 },
    inputValue: '',
    ariaExpanded: 'false',
    ariaControls: null,
  },
};

function setReadback(
  overrides: Partial<{
    events: any[];
    fetches: any[];
    inputValue: string;
    ariaExpanded: string;
    ariaControls: string;
    listboxFound: boolean;
    optCount: number;
    sampleOpts: string[];
  }> = {},
) {
  mainReadbackResp = {
    result: {
      value: {
        ok: true,
        inputValueAfter: overrides.inputValue ?? 'a',
        ariaExpanded: overrides.ariaExpanded ?? 'true',
        ariaControls: overrides.ariaControls ?? null,
        listboxFound: overrides.listboxFound ?? false,
        listboxOptionCount: overrides.optCount ?? 0,
        listboxSampleOpts: overrides.sampleOpts ?? [],
        events: overrides.events ?? [],
        fetches: overrides.fetches ?? [],
      },
    },
  };
}

beforeEach(() => {
  _resetClientStateForTests();
  sendCommandMock.mockClear();
  withSessionMock.mockClear();
  // Reset to default install + empty readback per test.
  mainInstallResp = { result: { value: { ok: true } } };
  setReadback({});
  executeScriptMock = vi.fn();
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: { addListener: () => undefined },
    },
    scripting: { executeScript: executeScriptMock },
    windows: { onRemoved: { addListener: () => undefined } },
    runtime: { lastError: undefined },
  };
  claimTabForClient(TEST_CLIENT, TAB_ID, 1);
});

afterEach(() => {
  _resetClientStateForTests();
});

describe('chrome_typeahead_probe — validation', () => {
  it('rejects missing selector and ref', async () => {
    const res = await exec({});
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('selector|ref');
  });

  it('rejects both selector and ref', async () => {
    const res = await exec({ selector: '#x', ref: 'r1' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('selector|ref');
  });

  it('rejects sample > 16 chars', async () => {
    const res = await exec({ selector: '#x', sample: 'a'.repeat(17) });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('sample');
  });
});

describe('chrome_typeahead_probe — happy path', () => {
  it('focuses via CDP click, types sample, returns events + fetches + summary', async () => {
    executeScriptMock.mockResolvedValueOnce([RESOLVE_OK]); // ISOLATED resolve
    setReadback({
      events: [
        { scope: 'input', type: 'beforeinput', isTrusted: true, data: 'a' },
        { scope: 'input', type: 'input', isTrusted: true, data: 'a' },
      ],
      fetches: [{ url: 'https://example.com/typeahead?q=a', method: 'GET', ts: 1 }],
      inputValue: 'a',
    });

    const res = await exec({
      selector: 'input[aria-label="Skill*"]',
      sample: 'a',
      watchMs: 100,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.sample).toBe('a');
    expect(body.inputValueAfter).toBe('a');
    expect(body.eventCount).toBe(2);
    expect(body.fetchCount).toBe(1);
    expect(body.summary.inputFired).toBe(true);
    expect(body.summary.keydownFired).toBe(false); // no keydown in our mock events
    expect(body.summary.lookupFetchFired).toBe(true); // url matches /typeahead/

    // CDP mouse: move + press + release.
    const mouseCalls = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchMouseEvent',
    );
    expect(mouseCalls).toHaveLength(3);
    expect(mouseCalls[0][2]).toMatchObject({ type: 'mouseMoved', x: 200, y: 115 });
    expect(mouseCalls[1][2]).toMatchObject({
      type: 'mousePressed',
      x: 200,
      y: 115,
      button: 'left',
    });

    // Two Runtime.evaluate calls: install (MAIN) + readback (MAIN).
    const evalCalls = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Runtime.evaluate',
    );
    expect(evalCalls).toHaveLength(2);
    expect(String(evalCalls[0][2]?.expression ?? '')).toContain('installCaptureInMainWorld');
    expect(String(evalCalls[1][2]?.expression ?? '')).toContain('readCaptureFromMainWorld');
  });

  it('summary.keydownFired is true when a trusted keydown shows up', async () => {
    executeScriptMock.mockResolvedValueOnce([RESOLVE_OK]);
    setReadback({
      events: [{ scope: 'window', type: 'keydown', isTrusted: true, key: 'a' }],
    });
    const res = await exec({ selector: '#x', sample: 'a', watchMs: 100 });
    expect(parseBody(res).summary.keydownFired).toBe(true);
  });

  it('summary.keydownFired is false when only untrusted keydown shows up', async () => {
    executeScriptMock.mockResolvedValueOnce([RESOLVE_OK]);
    setReadback({
      events: [{ scope: 'window', type: 'keydown', isTrusted: false, key: 'a' }],
    });
    const res = await exec({ selector: '#x', sample: 'a', watchMs: 100 });
    expect(parseBody(res).summary.keydownFired).toBe(false);
  });

  it('networkUrlPattern lets summary.lookupFetchFired use the caller pattern', async () => {
    executeScriptMock.mockResolvedValueOnce([RESOLVE_OK]);
    setReadback({
      fetches: [{ url: 'https://example.com/random-endpoint?q=a', method: 'GET', ts: 1 }],
    });
    const res = await exec({
      selector: '#x',
      sample: 'a',
      watchMs: 100,
      networkUrlPattern: 'random-endpoint',
    });
    // networkUrlPattern flips the summary heuristic — any fetch returned
    // (post-filter) counts as the lookup having fired.
    expect(parseBody(res).summary.lookupFetchFired).toBe(true);
  });

  it('clearFirst:false skips Ctrl+A + Delete', async () => {
    executeScriptMock.mockResolvedValueOnce([RESOLVE_OK]);
    await exec({ selector: '#x', sample: 'a', clearFirst: false, watchMs: 100 });

    const keyEvents = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchKeyEvent',
    );
    // 2 (sendChar keyDown+keyUp). Without clear there's no Ctrl+A / Delete.
    expect(keyEvents).toHaveLength(2);
  });

  it('clearFirst:true (default) sends Ctrl+A + Delete before typing', async () => {
    executeScriptMock.mockResolvedValueOnce([RESOLVE_OK]);
    await exec({ selector: '#x', sample: 'a', watchMs: 100 });

    const keyEvents = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchKeyEvent',
    );
    // 4 (Ctrl+A down/up, Delete down/up) + 2 (char keyDown/keyUp) = 6.
    expect(keyEvents).toHaveLength(6);
    expect(keyEvents[0][2]).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 2 });
    expect(keyEvents[2][2]).toMatchObject({ type: 'keyDown', key: 'Delete' });
  });
});

describe('chrome_typeahead_probe — error classification', () => {
  it('resolve shim notActionable → NOT_ACTIONABLE', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'input is disabled',
          notActionable: true,
          failures: ['disabled'],
        },
      },
    ]);
    const res = await exec({ selector: '#x' });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('NOT_ACTIONABLE');
    expect(body.error.details.failures).toEqual(['disabled']);
    // No CDP traffic when resolve shim refused.
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('resolve shim ok:false without notActionable → UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'selector "#nope" matched no element' } },
    ]);
    const res = await exec({ selector: '#nope' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('UNKNOWN');
  });

  it('classifies "Another debugger" as CDP_BUSY', async () => {
    executeScriptMock.mockResolvedValueOnce([RESOLVE_OK]);
    withSessionMock.mockImplementationOnce(async () => {
      throw new Error('Another debugger is already attached');
    });
    const res = await exec({ selector: '#x', sample: 'a', watchMs: 100 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });

  it('MAIN-world install failure surfaces as UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([RESOLVE_OK]);
    mainInstallResp = {
      result: { value: { ok: false, message: 'element not found in MAIN world' } },
    };
    const res = await exec({ selector: '#x', sample: 'a', watchMs: 100 });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('UNKNOWN');
    expect(body.error.message).toContain('element not found in MAIN world');
  });
});
