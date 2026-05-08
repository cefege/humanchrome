/**
 * web-fetcher tool tests.
 *
 * Pins the four modalities (text, raw HTML, MHTML save, raw HTML save) and
 * the new precondition fix from PR #65, plus a regression for the FileReader
 * blob→base64 path from PR #63 that survives multi-MB blobs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  sendNativeRequest: vi.fn(),
}));

vi.mock('@/entrypoints/background/native-host', () => ({
  sendNativeRequest: stubs.sendNativeRequest,
  initNativeHostListener: () => {},
}));

async function loadTool(): Promise<
  typeof import('@/entrypoints/background/tools/browser/web-fetcher')
> {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/web-fetcher');
}

interface ChromeOverrides {
  url?: string;
  tabId?: number;
  htmlResponse?: any;
  textResponse?: any;
  mhtmlBlob?: Blob | undefined;
  mhtmlThrows?: Error;
}

function installChrome(overrides: ChromeOverrides = {}) {
  const tabId = overrides.tabId ?? 5;
  const tab: chrome.tabs.Tab = {
    id: tabId,
    windowId: 1,
    url: overrides.url ?? 'https://example.com/',
    title: 'Example',
  } as any;

  const sendMessage = vi.fn(async (_tid: number, msg: any) => {
    if (typeof msg.action === 'string' && msg.action.endsWith('_ping')) {
      return { status: 'pong' };
    }
    if (msg.action === 'getHtmlContent') {
      return (
        overrides.htmlResponse ?? { success: true, htmlContent: '<html><body>Hi</body></html>' }
      );
    }
    if (msg.action === 'getTextContent') {
      return overrides.textResponse ?? { success: true, textContent: 'Hi' };
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
      create: vi.fn(async () => tab),
      update: vi.fn(async () => tab),
      sendMessage,
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    windows: {
      update: vi.fn(),
      onRemoved: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: undefined }]),
    },
    pageCapture: {
      saveAsMHTML: vi.fn(async () => {
        if (overrides.mhtmlThrows) throw overrides.mhtmlThrows;
        // Distinguish "not provided" (default to a real blob) from
        // "explicitly undefined" (simulate Chrome's behaviour on
        // unsupported pages — the API resolves to undefined).
        if ('mhtmlBlob' in overrides) return overrides.mhtmlBlob;
        return new Blob(['MHTML body'], { type: 'multipart/related' });
      }),
    },
  };
  return { tab, sendMessage };
}

beforeEach(() => {
  stubs.sendNativeRequest.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('web_fetcher — savePath precondition (PR #65)', () => {
  it('rejects savePath without htmlContent or textContent enabled', async () => {
    installChrome();
    const { webFetcherTool } = await loadTool();
    const res = await webFetcherTool.execute({
      tabId: 5,
      savePath: '/tmp/page.html',
      htmlContent: false,
      textContent: false,
    } as any);

    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toMatch(/nothing to save/i);
    expect(stubs.sendNativeRequest).not.toHaveBeenCalled();
  });

  it('mhtml savePath bypasses the precondition (mhtml is self-contained)', async () => {
    installChrome();
    stubs.sendNativeRequest.mockResolvedValue({
      success: true,
      filePath: '/tmp/page.mhtml',
      size: 100,
    });
    const { webFetcherTool } = await loadTool();
    const res = await webFetcherTool.execute({
      tabId: 5,
      savePath: '/tmp/page.mhtml',
      htmlContent: false,
      textContent: false,
    } as any);

    expect(res.isError).toBe(false);
    expect(stubs.sendNativeRequest).toHaveBeenCalledWith(
      'file_operation',
      expect.objectContaining({ action: 'saveToPath', destPath: '/tmp/page.mhtml' }),
      expect.any(Number),
    );
  });
});

describe('web_fetcher — MHTML save', () => {
  it('passes base64 of the blob to the bridge with the user destPath', async () => {
    installChrome({ mhtmlBlob: new Blob(['Hello MHTML'], { type: 'multipart/related' }) });
    stubs.sendNativeRequest.mockResolvedValue({
      success: true,
      filePath: '/tmp/page.mhtml',
      size: 11,
    });

    const { webFetcherTool } = await loadTool();
    await webFetcherTool.execute({ tabId: 5, savePath: '/tmp/page.mhtml' } as any);

    expect(stubs.sendNativeRequest).toHaveBeenCalledTimes(1);
    const call = stubs.sendNativeRequest.mock.calls[0];
    expect(call[0]).toBe('file_operation');
    expect(call[1].action).toBe('saveToPath');
    expect(call[1].destPath).toBe('/tmp/page.mhtml');
    expect(typeof call[1].base64Data).toBe('string');
    // FileReader path strips the data:...;base64, prefix; what remains is the
    // raw base64 of "Hello MHTML"
    expect(call[1].base64Data).toBe(btoa('Hello MHTML'));
  });

  it('surfaces a clear error when chrome.pageCapture.saveAsMHTML returns no blob', async () => {
    installChrome({ mhtmlBlob: undefined });
    const { webFetcherTool } = await loadTool();
    const res = await webFetcherTool.execute({
      tabId: 5,
      savePath: '/tmp/page.mhtml',
    } as any);

    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toMatch(/saveAsMHTML returned no blob/i);
    expect(stubs.sendNativeRequest).not.toHaveBeenCalled();
  });

  it('encodes a multi-MB blob without stack overflow (PR #63 regression)', async () => {
    // 5MB blob — large enough that the old String.fromCharCode loop would
    // chew through memory; FileReader-based path handles it cleanly.
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    installChrome({ mhtmlBlob: new Blob([big]) });
    stubs.sendNativeRequest.mockResolvedValue({
      success: true,
      filePath: '/tmp/big.mhtml',
      size: big.length,
    });

    const { webFetcherTool } = await loadTool();
    const res = await webFetcherTool.execute({ tabId: 5, savePath: '/tmp/big.mhtml' } as any);

    expect(res.isError).toBe(false);
    const call = stubs.sendNativeRequest.mock.calls[0];
    // base64 expands by 4/3, so 5 MB binary ≈ 6.67 MB base64. Sanity check
    // the order of magnitude — the encoding completed and produced something
    // proportional to the input.
    expect(call[1].base64Data.length).toBeGreaterThan(big.length);
  }, 15_000);
});

describe('web_fetcher — content extraction modes', () => {
  it('surfaces helper errors at the boundary so the LLM sees a meaningful message', async () => {
    // The base class's sendMessageToTab throws when the helper response has
    // a top-level `error` field; the outer catch in execute() then wraps it
    // in createErrorResponse. We verify the error reaches the tool result
    // verbatim — the LLM has enough to retry with a different selector.
    installChrome({
      htmlResponse: { success: false, error: 'No element found matching selector: #nope' },
    });
    const { webFetcherTool } = await loadTool();
    const res = await webFetcherTool.execute({
      tabId: 5,
      htmlContent: true,
      selector: '#nope',
    } as any);

    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toMatch(/No element found matching selector: #nope/);
  });

  it('returns text content by default (textContent enabled, htmlContent disabled)', async () => {
    installChrome({ textResponse: { success: true, textContent: 'Hello world' } });
    const { webFetcherTool } = await loadTool();
    const res = await webFetcherTool.execute({ tabId: 5 } as any);

    expect(res.isError).toBe(false);
    const text = (res.content[0] as any).text;
    expect(JSON.parse(text).textContent).toBe('Hello world');
  });
});

describe('web_fetcher — HTML save to disk', () => {
  it('writes textData (raw HTML) via saveToPath', async () => {
    installChrome({
      htmlResponse: { success: true, htmlContent: '<html>x</html>' },
    });
    stubs.sendNativeRequest.mockResolvedValue({
      success: true,
      filePath: '/tmp/page.html',
      size: 14,
    });

    const { webFetcherTool } = await loadTool();
    const res = await webFetcherTool.execute({
      tabId: 5,
      savePath: '/tmp/page.html',
      htmlContent: true,
    } as any);

    expect(res.isError).toBe(false);
    const call = stubs.sendNativeRequest.mock.calls[0];
    expect(call[1].action).toBe('saveToPath');
    expect(call[1].destPath).toBe('/tmp/page.html');
    expect(call[1].textData).toBe('<html>x</html>');
  });
});
