/**
 * chrome_native_type tests — Bug-008 workaround.
 *
 * The tool's job: activate the Chrome window+tab, focus the target input,
 * send a `native_keystroke` request to the native-messaging host, and
 * propagate the host's success/error envelope to the caller. We mock
 * `sendNativeRequest` so the unit tests run without a real native host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendNativeRequestMock = vi.fn(async () => ({
  success: true,
  platform: 'darwin',
  charsTyped: 0,
  durationMs: 0,
}));
vi.mock('@/entrypoints/background/native-host', () => ({
  sendNativeRequest: (...args: unknown[]) =>
    sendNativeRequestMock(...(args as [string, unknown, number?])),
}));

import { nativeTypeTool } from '@/entrypoints/background/tools/browser/native-type';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'native-type-test-client';
const TAB_ID = 31;
const WINDOW_ID = 1;

let executeScriptMock: ReturnType<typeof vi.fn>;
let tabsUpdateMock: ReturnType<typeof vi.fn>;
let windowsUpdateMock: ReturnType<typeof vi.fn>;

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => nativeTypeTool.execute(args));
}
function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

const FOCUS_OK = {
  result: { ok: true, focused: true, tagName: 'input', inputValue: '' },
};

beforeEach(() => {
  _resetClientStateForTests();
  sendNativeRequestMock.mockReset();
  sendNativeRequestMock.mockResolvedValue({
    success: true,
    platform: 'darwin',
    charsTyped: 0,
    durationMs: 12,
  } as any);
  executeScriptMock = vi.fn();
  tabsUpdateMock = vi.fn(async () => ({ id: TAB_ID, windowId: WINDOW_ID, active: true }));
  windowsUpdateMock = vi.fn(async () => ({ id: WINDOW_ID, focused: true }));
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: WINDOW_ID, active: false })),
      update: tabsUpdateMock,
      onRemoved: { addListener: () => undefined },
    },
    windows: {
      update: windowsUpdateMock,
      onRemoved: { addListener: () => undefined },
    },
    scripting: { executeScript: executeScriptMock },
    runtime: { lastError: undefined },
  };
  claimTabForClient(TEST_CLIENT, TAB_ID, WINDOW_ID);
});

afterEach(() => {
  _resetClientStateForTests();
});

describe('chrome_native_type — validation', () => {
  it('rejects missing text', async () => {
    const res = await exec({ selector: '#x' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('text');
  });

  it('rejects empty text', async () => {
    const res = await exec({ selector: '#x', text: '' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('text');
  });

  it('rejects text > 1024 chars', async () => {
    const res = await exec({ selector: '#x', text: 'a'.repeat(1025) });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('text');
  });

  it('rejects missing selector and ref', async () => {
    const res = await exec({ text: 'hi' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('selector|ref');
  });
});

describe('chrome_native_type — happy path', () => {
  it('activates window + tab, focuses input, dispatches native keystroke', async () => {
    executeScriptMock
      .mockResolvedValueOnce([FOCUS_OK]) // focus shim
      .mockResolvedValueOnce([{ result: 'Senior AI Engineer' }]); // readback
    sendNativeRequestMock.mockResolvedValueOnce({
      success: true,
      platform: 'darwin',
      charsTyped: 18,
      durationMs: 240,
    } as any);

    const res = await exec({
      selector: 'input[aria-label="Add title"]',
      text: 'Senior AI Engineer',
      focusSettleMs: 1,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.charsTyped).toBe(18);
    expect(body.finalValue).toBe('Senior AI Engineer');
    expect(body.platform).toBe('darwin');

    // Activated window + tab.
    expect(windowsUpdateMock).toHaveBeenCalledWith(WINDOW_ID, { focused: true });
    expect(tabsUpdateMock).toHaveBeenCalledWith(TAB_ID, { active: true });

    // Native RPC carried the text + no pressEnter by default.
    expect(sendNativeRequestMock).toHaveBeenCalledWith(
      'native_keystroke',
      { text: 'Senior AI Engineer', withReturn: false },
      15_000,
    );
  });

  it('pressEnter:true is forwarded as withReturn:true on the native RPC', async () => {
    executeScriptMock
      .mockResolvedValueOnce([FOCUS_OK])
      .mockResolvedValueOnce([{ result: 'GraphQL' }]);
    sendNativeRequestMock.mockResolvedValueOnce({
      success: true,
      platform: 'darwin',
      charsTyped: 7,
      durationMs: 90,
    } as any);

    await exec({ selector: '#x', text: 'GraphQL', pressEnter: true, focusSettleMs: 1 });
    expect(sendNativeRequestMock).toHaveBeenCalledWith(
      'native_keystroke',
      { text: 'GraphQL', withReturn: true },
      15_000,
    );
  });
});

describe('chrome_native_type — error classification', () => {
  it('focus shim notActionable → NOT_ACTIONABLE; native RPC never fires', async () => {
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
    const res = await exec({ selector: '#x', text: 'hi', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('NOT_ACTIONABLE');
    expect(body.error.details.failures).toEqual(['disabled']);
    expect(sendNativeRequestMock).not.toHaveBeenCalled();
  });

  it('native host permission_denied → PERMISSION_DENIED', async () => {
    executeScriptMock.mockResolvedValueOnce([FOCUS_OK]);
    sendNativeRequestMock.mockResolvedValueOnce({
      success: false,
      platform: 'darwin',
      error: 'osascript blocked by macOS Accessibility. Grant in System Settings → ...',
      code: 'permission_denied',
    } as any);
    const res = await exec({ selector: '#x', text: 'hi', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('PERMISSION_DENIED');
    expect(body.error.message).toContain('Accessibility');
  });

  it('native host not_supported (Linux/Windows) → UNKNOWN with hint', async () => {
    executeScriptMock.mockResolvedValueOnce([FOCUS_OK]);
    sendNativeRequestMock.mockResolvedValueOnce({
      success: false,
      platform: 'linux',
      error: 'native_keystroke not implemented for platform "linux" yet (macOS only)',
      code: 'not_supported',
    } as any);
    const res = await exec({ selector: '#x', text: 'hi', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('UNKNOWN');
    expect(body.error.details.hint).toContain('macOS only');
  });

  it('native host timeout → TIMEOUT', async () => {
    executeScriptMock.mockResolvedValueOnce([FOCUS_OK]);
    sendNativeRequestMock.mockResolvedValueOnce({
      success: false,
      platform: 'darwin',
      error: 'osascript exceeded 10000ms timeout',
      code: 'timeout',
    } as any);
    const res = await exec({ selector: '#x', text: 'hi', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('TIMEOUT');
  });

  it('"Native host not connected" classified as UNKNOWN with hint', async () => {
    executeScriptMock.mockResolvedValueOnce([FOCUS_OK]);
    sendNativeRequestMock.mockRejectedValueOnce(new Error('Native host not connected'));
    const res = await exec({ selector: '#x', text: 'hi', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.message).toContain('native host not connected');
  });
});
