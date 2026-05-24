/**
 * chrome_list_frames tests (IMP-0044).
 *
 * Pure read-only enumeration of chrome.webNavigation.getAllFrames.
 * Tests stub chrome.webNavigation.getAllFrames + chrome.tabs.query
 * (for the active-tab fallback) and assert the tool's contract:
 *
 *   - explicit tabId is forwarded verbatim to the API
 *   - no explicit tabId → tool resolves the active tab in (optionally)
 *     a specified window
 *   - the response shape is `{ tabId, frames[], count }` with the main
 *     frame (frameId 0, parentFrameId -1) always first when present
 *   - urlContains filter is case-insensitive substring on URL, and
 *     `totalBeforeFilter` is reported alongside
 *   - getAllFrames() === null is treated as "no frames" (tab discarded)
 *     rather than an error
 *   - "no tab with id" rejection is classified as TAB_CLOSED
 *   - other rejections surface as a generic UNKNOWN error
 *   - missing active tab → TAB_NOT_FOUND
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listFramesTool } from '@/entrypoints/background/tools/browser/list-frames';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'list-frames-test-client';

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => listFramesTool.execute(args));
}

const FRAMES_3 = [
  // Main document
  { frameId: 0, parentFrameId: -1, url: 'https://example.com/', errorOccurred: false },
  // First-party iframe nested inside the main doc
  {
    frameId: 11,
    parentFrameId: 0,
    url: 'https://example.com/inner',
    errorOccurred: false,
  },
  // Third-party iframe (e.g. an ad/sandbox)
  { frameId: 22, parentFrameId: 0, url: 'https://ads.example/', errorOccurred: false },
];

beforeEach(() => {
  _resetClientStateForTests();
  (globalThis.chrome as any).webNavigation = {
    getAllFrames: vi.fn().mockResolvedValue(FRAMES_3),
  };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    get: vi.fn(async (id: number) => ({ id, url: 'https://example.com/', windowId: 1 })),
  };
});

afterEach(() => {
  _resetClientStateForTests();
  delete (globalThis.chrome as any).webNavigation;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_list_frames', () => {
  it('forwards an explicit tabId and returns the frame entries', async () => {
    const res = await exec({ tabId: 42 });

    expect(res.isError).toBe(false);
    expect((globalThis.chrome as any).webNavigation.getAllFrames).toHaveBeenCalledWith({
      tabId: 42,
    });
    const body = parseBody(res);
    expect(body.tabId).toBe(42);
    expect(body.count).toBe(3);
    expect(body.frames[0]).toEqual({
      frameId: 0,
      parentFrameId: -1,
      url: 'https://example.com/',
      errorOccurred: false,
    });
  });

  it('falls back to the client-owned tab when no tabId is provided', async () => {
    claimTabForClient(TEST_CLIENT, 7, 1);
    const res = await exec({});

    expect(res.isError).toBe(false);
    expect((globalThis.chrome as any).webNavigation.getAllFrames).toHaveBeenCalledWith({
      tabId: 7,
    });
    const body = parseBody(res);
    expect(body.tabId).toBe(7);
  });

  it('filters the owned-tab lookup by windowId when provided', async () => {
    claimTabForClient(TEST_CLIENT, 99, 3);
    const tabsGetMock = vi.fn(async (id: number) => ({ id, windowId: 3 }));
    (globalThis.chrome as any).tabs.get = tabsGetMock;

    await exec({ windowId: 3 });

    expect(tabsGetMock).toHaveBeenCalledWith(99);
    expect((globalThis.chrome as any).webNavigation.getAllFrames).toHaveBeenCalledWith({
      tabId: 99,
    });
  });

  it('sorts frames so the main document (parentFrameId: -1) comes first, then by parent then frameId', async () => {
    // Provide entries in a deliberately bad order to prove the sort runs.
    (globalThis.chrome as any).webNavigation.getAllFrames = vi.fn().mockResolvedValue([
      { frameId: 22, parentFrameId: 0, url: 'https://ads.example/', errorOccurred: false },
      {
        frameId: 11,
        parentFrameId: 0,
        url: 'https://example.com/inner',
        errorOccurred: false,
      },
      { frameId: 0, parentFrameId: -1, url: 'https://example.com/', errorOccurred: false },
    ]);

    const body = parseBody(await exec({ tabId: 1 }));

    expect(body.frames.map((f: any) => f.frameId)).toEqual([0, 11, 22]);
  });

  it('filters by urlContains (case-insensitive substring) and reports totalBeforeFilter', async () => {
    const res = await exec({ tabId: 1, urlContains: 'ADS.example' });

    const body = parseBody(res);
    expect(body.count).toBe(1);
    expect(body.totalBeforeFilter).toBe(3);
    expect(body.urlContains).toBe('ADS.example');
    expect(body.frames[0].url).toBe('https://ads.example/');
  });

  it('returns an empty list when getAllFrames resolves to null (discarded tab)', async () => {
    (globalThis.chrome as any).webNavigation.getAllFrames = vi.fn().mockResolvedValue(null);

    const res = await exec({ tabId: 1 });

    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.frames).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('classifies "no tab with id" rejection as TAB_CLOSED', async () => {
    (globalThis.chrome as any).webNavigation.getAllFrames = vi
      .fn()
      .mockRejectedValue(new Error('No tab with id: 99'));

    const res = await exec({ tabId: 99 });

    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('TAB_CLOSED');
    expect(text).toContain('99');
  });

  it('surfaces other getAllFrames rejections as UNKNOWN with the message', async () => {
    (globalThis.chrome as any).webNavigation.getAllFrames = vi
      .fn()
      .mockRejectedValue(new Error('Permission denied'));

    const res = await exec({ tabId: 1 });

    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('Permission denied');
  });

  it('returns TAB_NOT_FOUND when there is no owned tab', async () => {
    const res = await exec({});

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });
});
