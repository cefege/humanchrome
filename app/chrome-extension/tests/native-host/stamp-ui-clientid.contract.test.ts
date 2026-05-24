/**
 * Contract: per-window UI clientId stamping (IMP-0167).
 *
 * Pre-fix, every popup shared `__ui:popup` regardless of the Chrome
 * window it was opened from. Two popups in different windows fought
 * over the same owned-tab lane. Post-fix, the surface tag is
 * suffixed with the originating windowId so each window gets its own
 * lane: `__ui:popup:42`.
 *
 * Resolution order for windowId:
 *   1. `sender.tab?.windowId` (content-script messages)
 *   2. `chrome.windows.getLastFocused()` (popup/sidepanel/options pages)
 *   3. `:0` fallback so the format stays parseable
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pull the function out of native-host.ts. It's not exported, so we
// import the whole module and reach in via a re-export shim we add
// below. Actually — native-host.ts doesn't export stampUiClientId; we
// test the observable surface by intercepting handleCallTool's call.
//
// Simplest test approach: capture the clientId passed to handleCallTool
// when chrome.runtime.onMessage fires with `{type:'call_tool',...}`.

const handleCallToolMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: handleCallToolMock,
}));

vi.mock('@/entrypoints/background/record-replay/flow-store', () => ({
  listPublished: vi.fn().mockResolvedValue([]),
  getFlow: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/entrypoints/background/keepalive-manager', () => ({
  acquireKeepalive: vi.fn(),
}));

vi.mock('@/entrypoints/background/utils/debug-log', () => ({
  debugLog: {
    with: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock('@/entrypoints/background/utils/client-state', () => ({
  loadPersistedClientState: vi.fn().mockResolvedValue(undefined),
  releaseClient: vi.fn(),
  getClientState: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools/browser/dialog', () => ({
  releaseDialogDefaultsForTabs: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/entrypoints/background/tools/browser/locator-handler', () => ({
  releaseLocatorHandlersForTabs: vi.fn().mockReturnValue([]),
}));

let onMessageListener:
  | ((message: any, sender: any, sendResponse: (r: any) => void) => boolean | void)
  | undefined;

beforeEach(() => {
  vi.resetModules();
  handleCallToolMock.mockReset().mockResolvedValue({ ok: true });
  onMessageListener = undefined;
  (globalThis.chrome as any) = {
    runtime: {
      id: 'test-ext',
      onMessage: {
        addListener: vi.fn((fn) => {
          onMessageListener = fn;
        }),
        removeListener: vi.fn(),
      },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connectNative: vi.fn().mockReturnValue({
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      }),
      lastError: undefined,
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
    },
    windows: {
      getLastFocused: vi.fn(),
      onRemoved: { addListener: vi.fn() },
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  };
});

afterEach(() => {
  onMessageListener = undefined;
});

async function bootListener() {
  const mod = await import('@/entrypoints/background/native-host');
  mod.initNativeHostListener();
  if (!onMessageListener) {
    throw new Error('chrome.runtime.onMessage.addListener was not called');
  }
  return mod;
}

async function callViaListener(senderUrl: string, senderWindowId?: number): Promise<string> {
  await bootListener();
  const sender = {
    url: `chrome-extension://test-ext${senderUrl}`,
    tab: typeof senderWindowId === 'number' ? { windowId: senderWindowId } : undefined,
  };
  const sendResponse = vi.fn();
  const result = onMessageListener!(
    { type: 'call_tool', name: 'chrome_ping', args: {} },
    sender,
    sendResponse,
  );
  expect(result).toBe(true);
  // Wait for async chain to settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(handleCallToolMock).toHaveBeenCalled();
  const clientId = handleCallToolMock.mock.calls[0]?.[2] as string;
  handleCallToolMock.mockClear();
  return clientId;
}

describe('IMP-0167 — per-window UI clientId stamping', () => {
  it('popup with sender.tab.windowId gets the windowId suffix', async () => {
    const id = await callViaListener('/popup.html', 42);
    expect(id).toBe('__ui:popup:42');
  });

  it('popup without sender.tab falls back to chrome.windows.getLastFocused', async () => {
    (globalThis.chrome as any).windows.getLastFocused.mockResolvedValueOnce({ id: 77 });
    const id = await callViaListener('/popup.html');
    expect(id).toBe('__ui:popup:77');
    expect((globalThis.chrome as any).windows.getLastFocused).toHaveBeenCalledWith({
      windowTypes: ['normal'],
    });
  });

  it('sidepanel from a content-script message picks up sender.tab.windowId', async () => {
    const id = await callViaListener('/sidepanel.html', 13);
    expect(id).toBe('__ui:sidepanel:13');
  });

  it('options page with no windowId falls back to :0', async () => {
    (globalThis.chrome as any).windows.getLastFocused.mockRejectedValueOnce(
      new Error('no window'),
    );
    const id = await callViaListener('/options.html');
    expect(id).toBe('__ui:options:0');
  });

  it('quickpanel gets per-window lane too', async () => {
    const id = await callViaListener('/quickpanel.html', 5);
    expect(id).toBe('__ui:quickpanel:5');
  });

  it('unknown surface still gets the :<windowId> suffix', async () => {
    (globalThis.chrome as any).windows.getLastFocused.mockResolvedValueOnce({ id: 99 });
    const id = await callViaListener('/welcome.html');
    expect(id).toBe('__ui:unknown:99');
  });
});
