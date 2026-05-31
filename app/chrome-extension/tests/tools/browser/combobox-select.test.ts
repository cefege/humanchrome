/**
 * chrome_combobox_select tests — bug #007.
 *
 * Mocks chrome.scripting.executeScript (for the bbox shim + the option
 * polling shim) and cdpSessionManager (for the trusted CDP click, key
 * dispatch, and select-all). Covers arg validation, the happy path
 * (focus click → clear → type → poll → arrow-down → enter), no-options
 * timeout, no-match-text classification, clearFirst opt-out,
 * NOT_ACTIONABLE classifications, and CDP_BUSY detection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendCommandMock = vi.fn();
const withSessionMock = vi.fn(
  async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn(),
);

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: (...args: unknown[]) => sendCommandMock(...args),
    withSession: (...args: unknown[]) =>
      withSessionMock(
        args[0] as number,
        args[1] as string,
        args[2] as () => Promise<unknown>,
      ),
  },
}));

import {
  comboboxSelectTool,
  _findMatchIndexForTest as findMatchIndex,
} from '@/entrypoints/background/tools/browser/combobox-select';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'combobox-select-test-client';
const TAB_ID = 11;

let executeScriptMock: ReturnType<typeof vi.fn>;

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => comboboxSelectTool.execute(args));
}
function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

const BBOX_OK = {
  result: {
    ok: true,
    tagName: 'input',
    bbox: { x: 100, y: 100, width: 200, height: 30 },
    point: { x: 200, y: 115 },
  },
};
const PROBE_ONE_MATCH = {
  result: {
    ok: true,
    count: 1,
    options: [{ index: 0, text: 'LangGraph' }],
  },
};

beforeEach(() => {
  _resetClientStateForTests();
  sendCommandMock.mockReset();
  sendCommandMock.mockResolvedValue(undefined);
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

describe('chrome_combobox_select — validation', () => {
  it('rejects missing query', async () => {
    const res = await exec({ comboboxSelector: '#x' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('query');
  });

  it('rejects empty query', async () => {
    const res = await exec({ comboboxSelector: '#x', query: '' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('query');
  });

  it('rejects query exceeding 256 chars', async () => {
    const res = await exec({ comboboxSelector: '#x', query: 'a'.repeat(257) });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('query');
  });

  it('rejects mutex comboboxSelector|ref violation', async () => {
    const res = await exec({ comboboxSelector: '#a', ref: 'r1', query: 'x' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('comboboxSelector|ref');
  });

  it('rejects neither comboboxSelector nor ref', async () => {
    const res = await exec({ query: 'x' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('comboboxSelector|ref');
  });
});

describe('chrome_combobox_select — happy path', () => {
  it('CDP-clicks, clears, types, polls, arrow-downs to match, presses Enter', async () => {
    executeScriptMock
      .mockResolvedValueOnce([BBOX_OK]) // bbox shim
      .mockResolvedValueOnce([{ result: { ok: true, before: '', after: '', forced: false } }]) // forceClearShim
      .mockResolvedValueOnce([PROBE_ONE_MATCH]); // first poll hit

    const res = await exec({
      comboboxSelector: 'input[aria-label="Skill*"]',
      query: 'LangGraph',
      perKeyDelayMs: 0,
      jitterMs: 0,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.typed).toBe(9);
    expect(body.optionCount).toBe(1);
    expect(body.selectedIndex).toBe(0);
    expect(body.selectedText).toBe('LangGraph');
    expect(body.cleared).toBe(true);
    expect(body.arrowDownCount).toBe(1);

    // CDP traffic: 3× Input.dispatchMouseEvent (mouseMoved + mousePressed +
    // mouseReleased), Ctrl+A (rawKeyDown + keyUp), Delete (keyDown + keyUp),
    // 9 chars × 3 (keyDown + char + keyUp), ArrowDown (keyDown + keyUp),
    // Enter (keyDown + keyUp). Plus an executeScript for forceClearShim
    // between the clear-keystrokes and the typing.
    const mouseCalls = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchMouseEvent',
    );
    expect(mouseCalls).toHaveLength(3);
    expect(mouseCalls[0][2]).toMatchObject({ type: 'mouseMoved', x: 200, y: 115, button: 'none' });
    expect(mouseCalls[1][2]).toMatchObject({
      type: 'mousePressed',
      x: 200,
      y: 115,
      button: 'left',
    });
    expect(mouseCalls[2][2]).toMatchObject({ type: 'mouseReleased', x: 200, y: 115 });

    const keyEvents = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchKeyEvent',
    );
    // 4 for clear (Ctrl+A down/up, Delete down/up)
    // + 9*2 for char keyDown/keyUp = 18
    // + 2 for ArrowDown
    // + 2 for Enter
    // = 26
    expect(keyEvents).toHaveLength(26);

    // ArrowDown and Enter are the last 4 key events.
    expect(keyEvents[keyEvents.length - 4][2]).toMatchObject({
      type: 'keyDown',
      key: 'ArrowDown',
      windowsVirtualKeyCode: 40,
    });
    expect(keyEvents[keyEvents.length - 3][2]).toMatchObject({
      type: 'keyUp',
      key: 'ArrowDown',
    });
    expect(keyEvents[keyEvents.length - 2][2]).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    expect(keyEvents[keyEvents.length - 1][2]).toMatchObject({
      type: 'keyUp',
      key: 'Enter',
    });
  });

  it('clearFirst:false skips Ctrl+A + Delete', async () => {
    executeScriptMock
      .mockResolvedValueOnce([BBOX_OK])
      .mockResolvedValueOnce([
        { result: { ok: true, count: 1, options: [{ index: 0, text: 'ab' }] } },
      ]);

    await exec({
      comboboxSelector: '#x',
      query: 'ab',
      clearFirst: false,
      perKeyDelayMs: 0,
      jitterMs: 0,
    });
    const keyEvents = sendCommandMock.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchKeyEvent',
    );
    // 2*2 char + ArrowDown 2 + Enter 2 = 8 (no clear)
    expect(keyEvents).toHaveLength(8);
    // First event is the first char's keyDown, NOT Ctrl+A.
    expect(keyEvents[0][2]).toMatchObject({ type: 'keyDown', key: 'a' });
    expect(keyEvents[0][2]).not.toMatchObject({ modifiers: 2 });
  });

  it('matches a later option and ArrowDowns the right number of times', async () => {
    executeScriptMock
      .mockResolvedValueOnce([BBOX_OK])
      .mockResolvedValueOnce([{ result: { ok: true, before: '', after: '', forced: false } }])
      .mockResolvedValueOnce([
        {
          result: {
            ok: true,
            count: 3,
            options: [
              { index: 0, text: 'Senior AI Engineer' },
              { index: 1, text: 'LLM Engineer' },
              { index: 2, text: 'ML Engineer' },
            ],
          },
        },
      ]);

    const res = await exec({
      comboboxSelector: '#title',
      query: 'engineer',
      matchText: 'LLM Engineer',
      matchMode: 'exact',
      perKeyDelayMs: 0,
      jitterMs: 0,
    });
    const body = parseBody(res);
    expect(body.selectedIndex).toBe(1);
    expect(body.selectedText).toBe('LLM Engineer');
    // index 1 → 2 ArrowDown presses
    expect(body.arrowDownCount).toBe(2);
  });
});

describe('chrome_combobox_select — polling failures', () => {
  it('returns TIMEOUT when options never render', async () => {
    // Bbox ok, force-clear ok, then every probe returns count:0 forever.
    executeScriptMock.mockImplementation(async (call: any) => {
      const fn = call.func;
      if (fn?.name === 'comboboxBboxShim') return [BBOX_OK];
      if (fn?.name === 'forceClearShim') {
        return [{ result: { ok: true, before: '', after: '', forced: false } }];
      }
      return [{ result: { ok: true, count: 0, options: [] } }];
    });

    const res = await exec({
      comboboxSelector: '#x',
      query: 'foo',
      waitForOptionsMs: 200,
      perKeyDelayMs: 0,
      jitterMs: 0,
    });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('TIMEOUT');
    expect(body.error.message).toContain('no options matching');
  });

  it('returns UNKNOWN when options render but none match matchText', async () => {
    executeScriptMock
      .mockResolvedValueOnce([BBOX_OK])
      .mockResolvedValueOnce([{ result: { ok: true, before: '', after: '', forced: false } }])
      .mockResolvedValueOnce([
        {
          result: {
            ok: true,
            count: 2,
            options: [
              { index: 0, text: 'Python' },
              { index: 1, text: 'Rust' },
            ],
          },
        },
      ])
      // poll keeps returning the same non-matching options until timeout.
      .mockResolvedValue([
        {
          result: {
            ok: true,
            count: 2,
            options: [
              { index: 0, text: 'Python' },
              { index: 1, text: 'Rust' },
            ],
          },
        },
      ]);

    const res = await exec({
      comboboxSelector: '#x',
      query: 'LangGraph',
      waitForOptionsMs: 200,
      perKeyDelayMs: 0,
      jitterMs: 0,
    });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('UNKNOWN');
    expect(body.error.message).toContain('none matched');
  });
});

describe('chrome_combobox_select — actionability', () => {
  it('bbox shim notActionable:disabled → NOT_ACTIONABLE', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'combobox is disabled',
          notActionable: true,
          failures: ['disabled'],
        },
      },
    ]);
    const res = await exec({ comboboxSelector: '#x', query: 'foo' });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('NOT_ACTIONABLE');
    expect(body.error.details.failures).toEqual(['disabled']);
    // No CDP traffic when the bbox shim rejected.
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('bbox shim ok:false without notActionable → UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'selector "#nope" matched no element' } },
    ]);
    const res = await exec({ comboboxSelector: '#nope', query: 'foo' });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('UNKNOWN');
    expect(body.error.message).toContain('matched no element');
  });
});

describe('chrome_combobox_select — CDP error classification', () => {
  it('classifies "Another debugger" as CDP_BUSY', async () => {
    executeScriptMock.mockResolvedValueOnce([BBOX_OK]);
    withSessionMock.mockImplementationOnce(async () => {
      throw new Error('Another debugger is already attached');
    });
    const res = await exec({
      comboboxSelector: '#x',
      query: 'foo',
      perKeyDelayMs: 0,
      jitterMs: 0,
    });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });
});

describe('findMatchIndex — pure helper', () => {
  const opts = [
    { index: 0, text: 'Senior AI Engineer' },
    { index: 1, text: 'LLM Engineer' },
    { index: 2, text: 'ML Engineer' },
  ];

  it('exact matches are case-insensitive and pick first hit', () => {
    expect(findMatchIndex(opts, 'llm engineer', 'exact')).toBe(1);
  });

  it('contains is case-insensitive', () => {
    expect(findMatchIndex(opts, 'AI', 'contains')).toBe(0);
  });

  it('startsWith picks the first prefix match', () => {
    expect(findMatchIndex(opts, 'ml', 'startsWith')).toBe(2);
  });

  it('returns -1 when nothing matches', () => {
    expect(findMatchIndex(opts, 'rust', 'contains')).toBe(-1);
  });
});
