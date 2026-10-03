/**
 * `includeImageBodies` on the debugger capture backend.
 *
 * The capability exists because a picture on screen is often the one thing
 * that cannot be fetched again: the origin answers a direct GET with 403, and
 * the only copy is the one the browser already holds. So the tests below pin
 * the whole gate, not just the body predicate — an image request is dropped
 * twice before its body is ever considered (once by URL extension, once by
 * MIME type), and a capture that only opened one of the two gates would look
 * like it worked and return nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cdpSend } = vi.hoisted(() => ({ cdpSend: vi.fn() }));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: cdpSend,
    detach: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn().mockResolvedValue(undefined),
    withSession: vi.fn(),
  },
}));

import {
  networkDebuggerStartTool,
  networkDebuggerStopTool,
} from '@/entrypoints/background/tools/browser/network-capture-debugger';
import { compilePattern } from '@/entrypoints/background/tools/browser/intercept-response';

const TAB_ID = 31;
const PHOTO = 'https://images-ssl.gotinder.com/media/640x800_abc.webp';
const BODY = 'SU1PREFQ';

interface BufferedRequest {
  url: string;
  mimeType?: string;
  responseBody?: string;
  base64Encoded?: boolean;
}

interface DebuggerCaptureBuffer {
  includeImageBodies: boolean;
  imageUrlPattern: string | null;
  imageUrlMatches: ((url: string) => boolean) | null;
  requests: Record<string, BufferedRequest>;
}

/** The private surface under test — reached by cast, per the repo convention. */
interface DebuggerInternals {
  captureData: Map<number, DebuggerCaptureBuffer>;
  requestCounters: Map<number, number>;
  handleRequestWillBeSent(tabId: number, params: unknown): void;
  handleResponseReceived(tabId: number, params: unknown): void;
  handleLoadingFinished(tabId: number, params: unknown): Promise<void>;
}

const dbg = networkDebuggerStartTool as unknown as DebuggerInternals;

function start(includeImageBodies: boolean, imageUrlPattern: string | null = null) {
  dbg.captureData.set(TAB_ID, {
    startTime: Date.now(),
    tabUrl: 'https://tinder.com/app/matches',
    tabTitle: 'Matches',
    maxCaptureTime: 60_000,
    inactivityTimeout: 30_000,
    includeStatic: false,
    includeImageBodies,
    imageUrlPattern,
    imageUrlMatches: imageUrlPattern ? compilePattern(imageUrlPattern) : null,
    requests: {},
    limitReached: false,
    lastFlushAt: null,
  } as unknown as DebuggerCaptureBuffer);
  dbg.requestCounters.set(TAB_ID, 0);
}

async function load(requestId: string, url: string, mimeType: string) {
  dbg.handleRequestWillBeSent(TAB_ID, {
    requestId,
    request: { url, method: 'GET', headers: {} },
    timestamp: 1,
    type: 'Image',
    loaderId: 'L1',
    frameId: 'F1',
  });
  dbg.handleResponseReceived(TAB_ID, {
    requestId,
    response: { status: 200, statusText: 'OK', headers: {}, mimeType },
    timestamp: 2,
    type: 'Image',
  });
  await dbg.handleLoadingFinished(TAB_ID, { requestId, encodedDataLength: 4096 });
}

function buffered(): Record<string, BufferedRequest> {
  return dbg.captureData.get(TAB_ID)!.requests;
}

beforeEach(() => {
  const chromeMock = globalThis.chrome as unknown as { debugger: unknown };
  chromeMock.debugger = {
    sendCommand: vi.fn(),
    onEvent: { addListener: vi.fn() },
    onDetach: { addListener: vi.fn() },
  };
  cdpSend.mockReset();
  cdpSend.mockResolvedValue({ body: BODY, base64Encoded: true });
});

afterEach(() => {
  dbg.captureData.clear();
  dbg.requestCounters.clear();
});

describe('chrome_network_capture includeImageBodies', () => {
  it('keeps an image and its bytes when image bodies were asked for', async () => {
    start(true);

    await load('r1', PHOTO, 'image/webp');

    const kept = buffered().r1;
    expect(kept.url).toBe(PHOTO);
    expect(kept.responseBody).toBe(BODY);
    expect(kept.base64Encoded).toBe(true);
  });

  it('drops the same image entirely by default', async () => {
    start(false);

    await load('r1', PHOTO, 'image/webp');

    expect(buffered()).toEqual({});
    expect(cdpSend).not.toHaveBeenCalledWith(TAB_ID, 'Network.getResponseBody', expect.anything());
  });

  it('keeps an image whose URL carries no image extension, on its MIME type', async () => {
    start(true);

    await load('r1', 'https://cdn.example.com/photo/9f2b', 'image/png');

    expect(buffered().r1.responseBody).toBe(BODY);
  });

  it('still drops scripts and stylesheets while image bodies are on', async () => {
    start(true);

    await load('r1', 'https://tinder.com/app/main.js', 'application/javascript');
    await load('r2', 'https://tinder.com/app/main.css', 'text/css');

    expect(buffered()).toEqual({});
  });

  it('leaves an API body working exactly as before', async () => {
    start(false);

    await load('r1', 'https://api.gotinder.com/v1/me', 'application/json');

    expect(buffered().r1.responseBody).toBe(BODY);
  });

  it('keeps only the images the pattern names', async () => {
    start(true, '/640x800_');

    await load('r1', PHOTO, 'image/webp');
    await load('r2', 'https://images-ssl.gotinder.com/media/172x216_rail.jpg', 'image/jpeg');

    expect(Object.keys(buffered())).toEqual(['r1']);
  });

  it('stops with only the requests the pattern names', async () => {
    start(true, '/640x800_');
    await load('r1', PHOTO, 'image/webp');

    const stop = (
      networkDebuggerStopTool as unknown as {
        performStop(
          startTool: unknown,
          tabId: number,
          urlPattern?: string,
        ): Promise<{
          content: { text: string }[];
        }>;
      }
    ).performStop(networkDebuggerStartTool, TAB_ID, '/640x800_');
    const result = JSON.parse((await stop).content[0].text);

    expect(result.requestCount).toBe(1);
    expect(result.requests.map((r: { url: string }) => r.url)).toEqual([PHOTO]);
  });

  it('keeps nothing when the pattern matches no image the page loaded', async () => {
    start(true, '/1080x1350_');

    await load('r1', PHOTO, 'image/webp');
    await load('r2', 'https://images-ssl.gotinder.com/media/172x216_rail.jpg', 'image/jpeg');

    expect(buffered()).toEqual({});
  });
});

describe('chrome_network_capture includeImageBodies — service worker', () => {
  // tinder.com serves every match thumbnail from its service worker's cache,
  // and a response the worker answers never reaches the capture. The bypass is
  // what makes the bodies visible, and it must not outlive the capture.
  const internals = networkDebuggerStartTool as unknown as {
    startCaptureForTab(tabId: number, options: object): Promise<void>;
    stopCapture(tabId: number): Promise<unknown>;
  };
  const options = (includeImageBodies: boolean) => ({
    maxCaptureTime: 60_000,
    inactivityTimeout: 0,
    includeStatic: false,
    includeImageBodies,
    imageUrlPattern: null,
  });
  const bypassCalls = () =>
    cdpSend.mock.calls
      .filter(([, method]) => method === 'Network.setBypassServiceWorker')
      .map(([, , params]) => params);

  beforeEach(() => {
    const chromeMock = globalThis.chrome as unknown as { tabs: { get: unknown } };
    chromeMock.tabs.get = vi
      .fn()
      .mockResolvedValue({ id: TAB_ID, url: 'https://tinder.com/app/matches', title: 'Matches' });
    cdpSend.mockResolvedValue({});
  });

  it('bypasses the worker while image bodies are captured and hands it back on stop', async () => {
    await internals.startCaptureForTab(TAB_ID, options(true));
    expect(bypassCalls()).toEqual([{ bypass: true }]);

    await internals.stopCapture(TAB_ID);
    expect(bypassCalls()).toEqual([{ bypass: true }, { bypass: false }]);
  });

  it('leaves the worker alone for a capture that asked for no image bodies', async () => {
    await internals.startCaptureForTab(TAB_ID, options(false));
    await internals.stopCapture(TAB_ID);
    expect(bypassCalls()).toEqual([]);
  });
});
