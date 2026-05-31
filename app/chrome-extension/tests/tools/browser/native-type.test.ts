/**
 * chrome_native_type tests — Bug-008 workaround.
 *
 * The tool's job: activate the Chrome window+tab, focus the target input,
 * send a `native_keystroke` request to the native-messaging host, and
 * propagate the host's success/error envelope to the caller. We mock
 * `sendNativeRequest` so the unit tests run without a real native host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendNativeRequestMock = vi.fn(
  async (_type: string, _payload: unknown, _timeout?: number) =>
    ({
      success: true,
      platform: 'darwin',
      mode: 'paste',
      charsTyped: 0,
      durationMs: 0,
    }) as unknown,
);
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
const FOCUS_NOT_LANDED = {
  result: { ok: true, focused: false, tagName: 'input', inputValue: '' },
};

beforeEach(() => {
  _resetClientStateForTests();
  sendNativeRequestMock.mockReset();
  sendNativeRequestMock.mockResolvedValue({
    success: true,
    platform: 'darwin',
    mode: 'paste',
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
  it('activates window + tab, focuses input, dispatches paste-mode native keystroke + verifies', async () => {
    executeScriptMock
      .mockResolvedValueOnce([FOCUS_OK]) // focus shim
      .mockResolvedValueOnce([{ result: 'Senior AI Engineer' }]); // readback
    sendNativeRequestMock.mockResolvedValueOnce({
      success: true,
      platform: 'darwin',
      mode: 'paste',
      charsTyped: 18,
      durationMs: 240,
      frontmostBefore: 'Google Chrome',
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
    expect(body.mode).toBe('paste');
    expect(body.verified).toBe(true);
    expect(body.frontmostBefore).toBe('Google Chrome');

    // Activated window + tab.
    expect(windowsUpdateMock).toHaveBeenCalledWith(WINDOW_ID, { focused: true });
    expect(tabsUpdateMock).toHaveBeenCalledWith(TAB_ID, { active: true });

    // Native RPC carried mode + expectedFrontmostApp.
    expect(sendNativeRequestMock).toHaveBeenCalledWith(
      'native_keystroke',
      expect.objectContaining({
        text: 'Senior AI Engineer',
        withReturn: false,
        mode: 'paste',
        expectedFrontmostApp: expect.arrayContaining(['Google Chrome']),
      }),
      15_000,
    );
  });

  it("mode:'keystroke' overrides the paste default", async () => {
    executeScriptMock
      .mockResolvedValueOnce([FOCUS_OK])
      .mockResolvedValueOnce([{ result: 'GraphQL' }]);
    sendNativeRequestMock.mockResolvedValueOnce({
      success: true,
      platform: 'darwin',
      mode: 'keystroke',
      charsTyped: 7,
      durationMs: 600,
    } as any);
    await exec({ selector: '#x', text: 'GraphQL', mode: 'keystroke', focusSettleMs: 1 });
    expect(sendNativeRequestMock).toHaveBeenCalledWith(
      'native_keystroke',
      expect.objectContaining({ mode: 'keystroke' }),
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
      mode: 'paste',
      charsTyped: 7,
      durationMs: 90,
    } as any);
    await exec({ selector: '#x', text: 'GraphQL', pressEnter: true, focusSettleMs: 1 });
    expect(sendNativeRequestMock).toHaveBeenCalledWith(
      'native_keystroke',
      expect.objectContaining({ withReturn: true }),
      15_000,
    );
  });
});

describe('chrome_native_type — safety guards', () => {
  it('refuses if focus shim reports focused:false (refuses to type into wrong element)', async () => {
    executeScriptMock.mockResolvedValueOnce([FOCUS_NOT_LANDED]);
    const res = await exec({ selector: '#x', text: 'hi', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.message).toContain('did not receive focus');
    expect(body.error.details.hint).toBe('focus_failed');
    // Native RPC never fires when focus didn't land.
    expect(sendNativeRequestMock).not.toHaveBeenCalled();
  });

  it('refuses on wrong_frontmost_app — keystrokes did NOT land in the wrong app', async () => {
    executeScriptMock.mockResolvedValueOnce([FOCUS_OK]);
    sendNativeRequestMock.mockResolvedValueOnce({
      success: false,
      platform: 'darwin',
      error: 'Refusing to send keystrokes: frontmost app is "Visual Studio Code", expected one of [Google Chrome, ...]',
      code: 'wrong_frontmost_app',
      frontmostBefore: 'Visual Studio Code',
    } as any);
    const res = await exec({ selector: '#x', text: 'hi', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.details.frontmostBefore).toBe('Visual Studio Code');
    expect(body.error.details.hint).toBe('wrong_frontmost_app');
  });

  it("refuses with verification_failed when finalValue doesn't contain the text", async () => {
    executeScriptMock
      .mockResolvedValueOnce([FOCUS_OK])
      .mockResolvedValueOnce([{ result: '' }]); // input cleared / no text landed
    sendNativeRequestMock.mockResolvedValueOnce({
      success: true,
      platform: 'darwin',
      mode: 'paste',
      charsTyped: 5,
      durationMs: 90,
    } as any);
    const res = await exec({ selector: '#x', text: 'hello', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.details.hint).toBe('verification_failed');
    expect(body.error.details.finalValue).toBe('');
  });

  it("refuses when finalValue contains different text (typed into wrong input)", async () => {
    executeScriptMock
      .mockResolvedValueOnce([FOCUS_OK])
      .mockResolvedValueOnce([{ result: 'stale value' }]);
    sendNativeRequestMock.mockResolvedValueOnce({
      success: true,
      platform: 'darwin',
      mode: 'paste',
      charsTyped: 5,
      durationMs: 80,
    } as any);
    const res = await exec({ selector: '#x', text: 'hello', focusSettleMs: 1 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details.hint).toBe('verification_failed');
  });

  it('verify:false opts out of post-keystroke verification', async () => {
    executeScriptMock
      .mockResolvedValueOnce([FOCUS_OK])
      .mockResolvedValueOnce([{ result: '' }]); // empty, but verify is off
    sendNativeRequestMock.mockResolvedValueOnce({
      success: true,
      platform: 'darwin',
      mode: 'paste',
      charsTyped: 5,
      durationMs: 80,
    } as any);
    const res = await exec({ selector: '#x', text: 'hello', verify: false, focusSettleMs: 1 });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.verified).toBe(null);
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
