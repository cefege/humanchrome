/**
 * chrome_keyboard `shortcut` param tests (IMP-0030).
 *
 * Two layers:
 *   1. `resolveShortcutKeys` is a pure function — exhaustive
 *      mac-vs-non-mac mapping coverage so a future PR that touches
 *      one chord can't silently break the others.
 *   2. End-to-end: when `shortcut` is supplied, the tool must call
 *      `chrome.runtime.getPlatformInfo`, resolve the chord, and forward
 *      it as the `keys` payload to the in-page helper. When both
 *      `keys` and `shortcut` are present, `shortcut` wins (the sketch
 *      explicitly calls this out — agents reaching for a high-level
 *      name don't want a stale literal silently overriding it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  keyboardTool,
  resolveShortcutKeys,
  type KeyboardShortcut,
} from '@/entrypoints/background/tools/browser/keyboard';

describe('resolveShortcutKeys (IMP-0030 pure mapping)', () => {
  const cases: Array<{ shortcut: KeyboardShortcut; mac: string; other: string }> = [
    { shortcut: 'copy', mac: 'Meta+c', other: 'Ctrl+c' },
    { shortcut: 'paste', mac: 'Meta+v', other: 'Ctrl+v' },
    { shortcut: 'cut', mac: 'Meta+x', other: 'Ctrl+x' },
    { shortcut: 'undo', mac: 'Meta+z', other: 'Ctrl+z' },
    { shortcut: 'redo', mac: 'Meta+Shift+z', other: 'Ctrl+y' },
    { shortcut: 'save', mac: 'Meta+s', other: 'Ctrl+s' },
    { shortcut: 'select_all', mac: 'Meta+a', other: 'Ctrl+a' },
    { shortcut: 'find', mac: 'Meta+f', other: 'Ctrl+f' },
    { shortcut: 'refresh', mac: 'Meta+r', other: 'Ctrl+r' },
    { shortcut: 'back', mac: 'Meta+ArrowLeft', other: 'Alt+ArrowLeft' },
    { shortcut: 'forward', mac: 'Meta+ArrowRight', other: 'Alt+ArrowRight' },
    { shortcut: 'new_tab', mac: 'Meta+t', other: 'Ctrl+t' },
    { shortcut: 'close_tab', mac: 'Meta+w', other: 'Ctrl+w' },
  ];

  for (const c of cases) {
    it(`maps ${c.shortcut} → ${c.mac} on macOS`, () => {
      expect(resolveShortcutKeys(c.shortcut, true)).toBe(c.mac);
    });
    it(`maps ${c.shortcut} → ${c.other} on non-mac`, () => {
      expect(resolveShortcutKeys(c.shortcut, false)).toBe(c.other);
    });
  }
});

describe('chrome_keyboard shortcut → keys forwarding', () => {
  let getPlatformInfo: ReturnType<typeof vi.fn>;
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getPlatformInfo = vi.fn().mockResolvedValue({ os: 'mac' });
    (globalThis.chrome as any).runtime = {
      ...(globalThis.chrome as any).runtime,
      getPlatformInfo,
    };
    (globalThis.chrome as any).tabs = {
      ...(globalThis.chrome as any).tabs,
      query: vi.fn().mockResolvedValue([{ id: 7, url: 'https://example.com', windowId: 1 }]),
      get: vi.fn().mockResolvedValue({ id: 7, url: 'https://example.com', windowId: 1 }),
    };

    // The tool snapshots tab state, injects helpers, asserts same document,
    // then calls sendMessageToTab. Stub the BaseBrowserToolExecutor methods
    // we depend on so we can exercise just the resolve+forward path.
    sendMessageMock = vi.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      results: [],
    });
    vi.spyOn(keyboardTool as any, 'snapshotTabState').mockResolvedValue({ tabId: 7 });
    vi.spyOn(keyboardTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(keyboardTool as any, 'assertSameDocument').mockResolvedValue(undefined);
    vi.spyOn(keyboardTool as any, 'sendMessageToTab').mockImplementation(sendMessageMock as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses macOS chord when getPlatformInfo returns os:mac', async () => {
    const res = await keyboardTool.execute({ shortcut: 'copy', tabId: 7 } as any);
    expect(res.isError).toBe(false);
    const sent = sendMessageMock.mock.calls.find((c) => (c[1] as any)?.keys);
    expect((sent?.[1] as any).keys).toBe('Meta+c');
  });

  it('uses non-mac chord when getPlatformInfo returns os:win', async () => {
    getPlatformInfo.mockResolvedValueOnce({ os: 'win' });
    await keyboardTool.execute({ shortcut: 'paste', tabId: 7 } as any);
    const sent = sendMessageMock.mock.calls.find((c) => (c[1] as any)?.keys);
    expect((sent?.[1] as any).keys).toBe('Ctrl+v');
  });

  it('shortcut wins over keys when both are supplied', async () => {
    await keyboardTool.execute({ shortcut: 'copy', keys: 'Enter', tabId: 7 } as any);
    const sent = sendMessageMock.mock.calls.find((c) => (c[1] as any)?.keys);
    expect((sent?.[1] as any).keys).toBe('Meta+c');
  });

  it('falls back to non-mac chord if getPlatformInfo throws', async () => {
    getPlatformInfo.mockRejectedValueOnce(new Error('not available'));
    await keyboardTool.execute({ shortcut: 'find', tabId: 7 } as any);
    const sent = sendMessageMock.mock.calls.find((c) => (c[1] as any)?.keys);
    expect((sent?.[1] as any).keys).toBe('Ctrl+f');
  });

  it('rejects with INVALID_ARGS when neither keys nor shortcut is supplied', async () => {
    const res = await keyboardTool.execute({ tabId: 7 } as any);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('INVALID_ARGS');
    expect(text).toContain('keys|shortcut');
  });

  it('still accepts a raw keys string when no shortcut is supplied', async () => {
    await keyboardTool.execute({ keys: 'Enter', tabId: 7 } as any);
    const sent = sendMessageMock.mock.calls.find((c) => (c[1] as any)?.keys);
    expect((sent?.[1] as any).keys).toBe('Enter');
    // No platform lookup needed when shortcut is absent.
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });
});
