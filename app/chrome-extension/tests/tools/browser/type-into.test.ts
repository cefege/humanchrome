/**
 * chrome_type_into tests (IMP-0143).
 *
 * Covers arg validation, focus shim wiring, CDP keystroke sequence
 * (per-char keyDown+keyUp with delay), clearFirst select-all+delete,
 * pressEnter, NOT_ACTIONABLE classifications (disabled, readonly,
 * not_visible), CDP_BUSY classification, finalValue read-back.
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

import { typeIntoTool } from '@/entrypoints/background/tools/browser/type-into';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'type-into-test-client';
const TAB_ID = 7;

let executeScriptMock: ReturnType<typeof vi.fn>;

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => typeIntoTool.execute(args));
}
function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

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

// Helper: queue two executeScript responses — focus shim, then final-value read.
function queueFocusOk(opts: { isContentEditable?: boolean } = {}, finalValue: string = '') {
  executeScriptMock
    .mockResolvedValueOnce([
      {
        result: {
          ok: true,
          focused: true,
          tagName: 'input',
          isContentEditable: !!opts.isContentEditable,
        },
      },
    ])
    .mockResolvedValueOnce([{ result: finalValue }]);
}

describe('chrome_type_into — validation', () => {
  it('rejects missing text', async () => {
    const res = await exec({ selector: '#x' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('text');
  });

  it('rejects text exceeding 1024 chars', async () => {
    const res = await exec({ selector: '#x', text: 'a'.repeat(1025) });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('text');
  });

  it('rejects mutex selector|ref violation', async () => {
    const res = await exec({ selector: '#a', ref: 'r1', text: 'hi' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('selector|ref');
  });
});

describe('chrome_type_into — happy path', () => {
  it('focuses, types char-by-char, returns finalValue', async () => {
    queueFocusOk({}, 'hi');
    const res = await exec({ selector: '#search', text: 'hi', perKeyDelayMs: 0, jitterMs: 0 });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.typed).toBe(2);
    expect(body.finalValue).toBe('hi');

    // Expect 2 keystrokes × 2 commands (keyDown + keyUp) = 4 calls to dispatchKeyEvent.
    const keyEvents = sendCommandMock.mock.calls.filter((c) => c[1] === 'Input.dispatchKeyEvent');
    expect(keyEvents).toHaveLength(4);
    expect(keyEvents[0][2]).toMatchObject({ type: 'keyDown', text: 'h', key: 'h' });
    expect(keyEvents[1][2]).toMatchObject({ type: 'keyUp', key: 'h' });
    expect(keyEvents[2][2]).toMatchObject({ type: 'keyDown', text: 'i', key: 'i' });
    expect(keyEvents[3][2]).toMatchObject({ type: 'keyUp', key: 'i' });
  });

  it('clearFirst issues Ctrl+A + Delete before typing', async () => {
    queueFocusOk({}, 'new');
    await exec({
      selector: '#search',
      text: 'new',
      clearFirst: true,
      perKeyDelayMs: 0,
      jitterMs: 0,
    });
    const events = sendCommandMock.mock.calls.filter((c) => c[1] === 'Input.dispatchKeyEvent');
    // Order: rawKeyDown(A+ctrl), keyUp(A+ctrl), keyDown(Delete), keyUp(Delete), then 3 chars × 2 = 6
    expect(events[0][2]).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 2 });
    expect(events[1][2]).toMatchObject({ type: 'keyUp', key: 'a', modifiers: 2 });
    expect(events[2][2]).toMatchObject({ type: 'keyDown', key: 'Delete', windowsVirtualKeyCode: 46 });
    expect(events[3][2]).toMatchObject({ type: 'keyUp', key: 'Delete' });
    // Then 3 chars × 2 events = 6 more
    expect(events.length).toBe(4 + 6);
  });

  it('pressEnter sends Enter after the last char', async () => {
    queueFocusOk({}, 'hi');
    await exec({ selector: '#search', text: 'hi', pressEnter: true, perKeyDelayMs: 0, jitterMs: 0 });
    const events = sendCommandMock.mock.calls.filter((c) => c[1] === 'Input.dispatchKeyEvent');
    // 2 chars × 2 + Enter × 2 = 6
    expect(events.length).toBe(6);
    expect(events[4][2]).toMatchObject({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
    expect(events[5][2]).toMatchObject({ type: 'keyUp', key: 'Enter' });
  });

  it('reports contentEditable:true when the focus shim detects it', async () => {
    queueFocusOk({ isContentEditable: true }, 'note text');
    const res = await exec({ selector: '[contenteditable]', text: 'note text', perKeyDelayMs: 0, jitterMs: 0 });
    const body = parseBody(res);
    expect(body.contentEditable).toBe(true);
  });
});

describe('chrome_type_into — actionability errors', () => {
  it('focus shim notActionable:disabled → NOT_ACTIONABLE', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'element is disabled',
          notActionable: true,
          failures: ['disabled'],
        },
      },
    ]);
    const res = await exec({ selector: '#x', text: 'hi' });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.error.code).toBe('NOT_ACTIONABLE');
    expect(body.error.details.failures).toEqual(['disabled']);
  });

  it('focus shim notActionable:not_editable → NOT_ACTIONABLE', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'element is readonly',
          notActionable: true,
          failures: ['not_editable'],
        },
      },
    ]);
    const res = await exec({ selector: '#x', text: 'hi' });
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.error.code).toBe('NOT_ACTIONABLE');
    expect(body.error.details.failures).toEqual(['not_editable']);
  });

  it('focus shim returns ok:false without notActionable → UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'selector "#nope" matched no element' } },
    ]);
    const res = await exec({ selector: '#nope', text: 'hi' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('matched no element');
  });
});

describe('chrome_type_into — CDP error classification', () => {
  it('classifies "Another debugger" as CDP_BUSY', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: { ok: true, focused: true, tagName: 'input', isContentEditable: false },
      },
    ]);
    sendCommandMock.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const res = await exec({ selector: '#x', text: 'hi', perKeyDelayMs: 0, jitterMs: 0 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });
});
