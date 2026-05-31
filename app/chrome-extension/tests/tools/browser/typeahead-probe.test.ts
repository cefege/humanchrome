/**
 * chrome_typeahead_probe tests — Bug-008 follow-up.
 *
 * Covers arg validation, the install/click/type/wait/readback choreography,
 * the summary derivation (keydownFired / inputFired / lookupFetchFired),
 * NOT_ACTIONABLE classification, CDP_BUSY classification, and the
 * networkUrlPattern filter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendCommandMock = vi.fn(
  async (_tabId: number, _method: string, _params?: Record<string, unknown>) => undefined,
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

const INSTALL_OK = {
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

function readbackOk(overrides: Partial<{ events: any[]; fetches: any[]; inputValue: string; ariaExpanded: string; ariaControls: string; listboxFound: boolean; optCount: number; sampleOpts: string[] }> = {}) {
  return {
    result: {
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
  };
}

beforeEach(() => {
  _resetClientStateForTests();
  sendCommandMock.mockClear();
  withSessionMock.mockClear();
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
    executeScriptMock
      .mockResolvedValueOnce([INSTALL_OK]) // install
      .mockResolvedValueOnce([
        readbackOk({
          events: [
            { scope: 'input', type: 'beforeinput', isTrusted: true, data: 'a' },
            { scope: 'input', type: 'input', isTrusted: true, data: 'a' },
          ],
          fetches: [
            { url: 'https://example.com/typeahead?q=a', method: 'GET', ts: 1 },
          ],
          inputValue: 'a',
        }),
      ]);

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
  });

  it('summary.keydownFired is true when a trusted keydown shows up', async () => {
    executeScriptMock
      .mockResolvedValueOnce([INSTALL_OK])
      .mockResolvedValueOnce([
        readbackOk({
          events: [{ scope: 'window', type: 'keydown', isTrusted: true, key: 'a' }],
        }),
      ]);

    const res = await exec({ selector: '#x', sample: 'a', watchMs: 100 });
    expect(parseBody(res).summary.keydownFired).toBe(true);
  });

  it('summary.keydownFired is false when only untrusted keydown shows up', async () => {
    executeScriptMock
      .mockResolvedValueOnce([INSTALL_OK])
      .mockResolvedValueOnce([
        readbackOk({
          events: [{ scope: 'window', type: 'keydown', isTrusted: false, key: 'a' }],
        }),
      ]);

    const res = await exec({ selector: '#x', sample: 'a', watchMs: 100 });
    expect(parseBody(res).summary.keydownFired).toBe(false);
  });

  it('networkUrlPattern lets summary.lookupFetchFired use the caller pattern', async () => {
    executeScriptMock
      .mockResolvedValueOnce([INSTALL_OK])
      .mockResolvedValueOnce([
        readbackOk({
          fetches: [
            { url: 'https://example.com/random-endpoint?q=a', method: 'GET', ts: 1 },
          ],
        }),
      ]);

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
    executeScriptMock
      .mockResolvedValueOnce([INSTALL_OK])
      .mockResolvedValueOnce([readbackOk({})]);

    await exec({ selector: '#x', sample: 'a', clearFirst: false, watchMs: 100 });

    const keyEvents = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchKeyEvent',
    );
    // 2 (sendChar keyDown+keyUp). Without clear there's no Ctrl+A / Delete.
    expect(keyEvents).toHaveLength(2);
  });

  it('clearFirst:true (default) sends Ctrl+A + Delete before typing', async () => {
    executeScriptMock
      .mockResolvedValueOnce([INSTALL_OK])
      .mockResolvedValueOnce([readbackOk({})]);

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
  it('install shim notActionable → NOT_ACTIONABLE', async () => {
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
    // No CDP traffic when install shim refused.
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('install shim ok:false without notActionable → UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'selector "#nope" matched no element' } },
    ]);
    const res = await exec({ selector: '#nope' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('UNKNOWN');
  });

  it('classifies "Another debugger" as CDP_BUSY', async () => {
    executeScriptMock.mockResolvedValueOnce([INSTALL_OK]);
    withSessionMock.mockImplementationOnce(async () => {
      throw new Error('Another debugger is already attached');
    });
    const res = await exec({ selector: '#x', sample: 'a', watchMs: 100 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });
});
