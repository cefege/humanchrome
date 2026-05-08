/**
 * Screenshot tool tests.
 *
 * These tests pin the three capture paths (CDP viewport, helper-assisted
 * visible area, full-page stitching), the bridge-save fallback to
 * chrome.downloads (which now surfaces both errors per PR #64), and the
 * page-details validation.
 *
 * The screenshot tool dynamically imports `cdpSessionManager` and reaches
 * into a handful of utility modules. Each test installs the minimum chrome
 * mocks it needs, and uses vi.mock() at module-load to stub the heavier
 * dependencies (image-utils canvas operations, native-host RPC).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal PNG data URL for tests — a real 1x1 transparent PNG so any byte
// inspection in image-utils sees a valid header. The actual content doesn't
// matter for the assertions.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

// Hoisted vi.fn instances stay stable across vi.resetModules — the mock
// factories capture these references at hoist time, so configuring them
// per-test propagates into the freshly-imported screenshot module.
const stubs = vi.hoisted(() => ({
  cdpWithSession: vi.fn(),
  cdpSendCommand: vi.fn(),
  sendNativeRequest: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: stubs.cdpWithSession,
    sendCommand: stubs.cdpSendCommand,
  },
}));

vi.mock('@/entrypoints/background/native-host', () => ({
  sendNativeRequest: stubs.sendNativeRequest,
  initNativeHostListener: () => {},
}));

vi.mock('@/utils/screenshot-context', () => ({
  screenshotContextManager: {
    setContext: stubs.setContext,
    getContext: vi.fn(),
    clearContext: vi.fn(),
  },
  scaleCoordinates: (x: number, y: number) => ({ x, y }),
}));

// image-utils does heavy canvas work that doesn't run in jsdom. Stub.
vi.mock('../../../utils/image-utils', () => ({
  canvasToDataURL: vi.fn(async () => PNG_DATA_URL),
  createImageBitmapFromUrl: vi.fn(async () => ({ width: 1280, height: 800 })),
  cropAndResizeImage: vi.fn(async () => ({})),
  stitchImages: vi.fn(async () => ({})),
  compressImage: vi.fn(async () => ({ dataUrl: PNG_DATA_URL, mimeType: 'image/jpeg' })),
}));

// Helper: install a fresh chrome mock and re-import the tool so module-level
// state (e.g., the singleton instance) is rebuilt against this iteration's
// mocks.
async function loadTool(): Promise<
  typeof import('@/entrypoints/background/tools/browser/screenshot')
> {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/screenshot');
}

interface ChromeOverrides {
  url?: string;
  helperPageDetails?: any;
  helperPrepareOk?: boolean;
  captureVisibleTab?: ReturnType<typeof vi.fn>;
  download?: ReturnType<typeof vi.fn>;
}

function installChrome(overrides: ChromeOverrides = {}) {
  const tab = { id: 7, windowId: 11, url: overrides.url ?? 'https://example.com/', title: 'X' };
  const sendMessageToTab = vi.fn(async (_tabId: number, msg: any) => {
    if (msg.action === 'preparePageForCapture') {
      return overrides.helperPrepareOk === false ? { success: false } : { success: true };
    }
    if (msg.action === 'getPageDetails') {
      return (
        overrides.helperPageDetails ?? {
          totalWidth: 1280,
          totalHeight: 800,
          viewportWidth: 1280,
          viewportHeight: 800,
          devicePixelRatio: 1,
          currentScrollX: 0,
          currentScrollY: 0,
        }
      );
    }
    if (msg.action === 'scrollPage') {
      return { newScrollY: msg.y };
    }
    if (typeof msg.action === 'string' && msg.action.endsWith('_ping')) {
      return { status: 'pong' };
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
      captureVisibleTab: overrides.captureVisibleTab ?? vi.fn(async () => PNG_DATA_URL),
      sendMessage: sendMessageToTab,
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: undefined }]),
    },
    downloads: {
      download: overrides.download ?? vi.fn(async () => 999),
    },
    windows: {
      onRemoved: { addListener: vi.fn() },
    },
  };
  return { tab, sendMessageToTab };
}

beforeEach(() => {
  // Default withSession just runs the inner fn so CDP-path tests can configure
  // sendCommand and let it execute. Tests don't usually need to override this.
  stubs.cdpWithSession.mockReset().mockImplementation(async (_t: number, _o: string, fn: any) => {
    return await fn();
  });
  stubs.cdpSendCommand.mockReset();
  stubs.sendNativeRequest.mockReset();
  stubs.setContext.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('screenshot — URL guards', () => {
  it('rejects chrome:// URLs with the documented message', async () => {
    installChrome({ url: 'chrome://settings' });
    const { screenshotTool } = await loadTool();
    const res = await screenshotTool.execute({ name: 's', tabId: 7 } as any);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toMatch(/Cannot capture special browser pages/i);
  });

  it('rejects chrome web store URLs', async () => {
    installChrome({ url: 'https://chrome.google.com/webstore/detail/foo' });
    const { screenshotTool } = await loadTool();
    const res = await screenshotTool.execute({ name: 's', tabId: 7 } as any);
    expect(res.isError).toBe(true);
  });
});

describe('screenshot — capture paths', () => {
  it('uses the CDP path when background=true and not full-page and no selector', async () => {
    installChrome();
    stubs.cdpSendCommand
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } })
      .mockResolvedValueOnce({ data: 'fake-base64' });
    stubs.sendNativeRequest.mockResolvedValue({ success: true, filePath: '/tmp/x.png' });

    const { screenshotTool } = await loadTool();
    await screenshotTool.execute({ name: 's', tabId: 7 } as any);

    expect(stubs.cdpSendCommand).toHaveBeenCalledWith(
      7,
      'Page.captureScreenshot',
      expect.any(Object),
    );
    // captureVisibleTab is the helper-path fallback; CDP path should bypass it.
    expect((globalThis as any).chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('falls back to captureVisibleTab when CDP throws', async () => {
    installChrome();
    stubs.cdpSendCommand.mockRejectedValue(new Error('CDP unavailable'));
    stubs.sendNativeRequest.mockResolvedValue({ success: true, filePath: '/tmp/x.png' });

    const { screenshotTool } = await loadTool();
    await screenshotTool.execute({ name: 's', tabId: 7 } as any);

    expect((globalThis as any).chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });
});

describe('screenshot — bridge save fallback (PR #64 behaviour)', () => {
  it('saves via the bridge by default when prepareFile succeeds', async () => {
    installChrome();
    stubs.cdpSendCommand
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } })
      .mockResolvedValueOnce({ data: 'fake' });
    stubs.sendNativeRequest.mockResolvedValue({ success: true, filePath: '/tmp/saved.png' });

    const { screenshotTool } = await loadTool();
    const res = await screenshotTool.execute({ name: 's', tabId: 7 } as any);

    expect(stubs.sendNativeRequest).toHaveBeenCalled();
    const text = (res.content[0] as any).text;
    const parsed = JSON.parse(text);
    expect(parsed.fileSaved).toBe(true);
    expect(parsed.fullPath).toBe('/tmp/saved.png');
    expect(parsed.saveWarning).toBeUndefined(); // No fallback path used
    expect((globalThis as any).chrome.downloads.download).not.toHaveBeenCalled();
  });

  it('falls back to chrome.downloads when bridge replies success=false; surfaces bridge error in saveWarning', async () => {
    installChrome();
    stubs.cdpSendCommand
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } })
      .mockResolvedValueOnce({ data: 'fake' });
    stubs.sendNativeRequest.mockResolvedValue({ success: false, error: 'disk full' });

    const { screenshotTool } = await loadTool();
    const res = await screenshotTool.execute({ name: 's', tabId: 7 } as any);

    const parsed = JSON.parse((res.content[0] as any).text);
    expect((globalThis as any).chrome.downloads.download).toHaveBeenCalled();
    expect(parsed.fileSaved).toBe(true);
    expect(parsed.saveWarning).toMatch(/disk full/);
  });

  it('reports both failures when bridge AND chrome.downloads both fail', async () => {
    const downloadFail = vi.fn(async () => {
      throw new Error('downloads policy denied');
    });
    installChrome({ download: downloadFail });
    stubs.cdpSendCommand
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } })
      .mockResolvedValueOnce({ data: 'fake' });
    stubs.sendNativeRequest.mockResolvedValue({ success: false, error: 'host gone' });

    const { screenshotTool } = await loadTool();
    const res = await screenshotTool.execute({ name: 's', tabId: 7 } as any);

    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.fileSaved).toBe(false);
    expect(parsed.saveError).toMatch(/Bridge: host gone/);
    expect(parsed.saveError).toMatch(/chrome\.downloads: downloads policy denied/);
  });
});

describe('screenshot — context emission', () => {
  it('writes screenshot context for the active tab so chrome_computer can scale coordinates', async () => {
    installChrome();
    stubs.cdpSendCommand
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } })
      .mockResolvedValueOnce({ data: 'fake' });
    stubs.sendNativeRequest.mockResolvedValue({ success: true, filePath: '/tmp/x.png' });

    const { screenshotTool } = await loadTool();
    await screenshotTool.execute({ name: 's', tabId: 7 } as any);

    expect(stubs.setContext).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        screenshotWidth: expect.any(Number),
        screenshotHeight: expect.any(Number),
        viewportWidth: expect.any(Number),
        viewportHeight: expect.any(Number),
      }),
    );
  });
});

describe('screenshot — bad page details surface clearly', () => {
  it('throws a descriptive error when the helper returns NaN dimensions', async () => {
    installChrome({
      helperPageDetails: {
        totalWidth: NaN,
        totalHeight: 800,
        viewportWidth: 1280,
        viewportHeight: 800,
        devicePixelRatio: 1,
        currentScrollX: 0,
        currentScrollY: 0,
      },
    });
    // Force the helper path so the page-details validation runs.
    stubs.cdpSendCommand.mockRejectedValue(new Error('skip CDP'));

    const { screenshotTool } = await loadTool();
    const res = await screenshotTool.execute({ name: 's', tabId: 7, fullPage: true } as any);

    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toMatch(/totalWidth/);
  });
});
