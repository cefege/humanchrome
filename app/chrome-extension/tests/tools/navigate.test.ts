/**
 * NavigateTool — focused coverage for the `newTab` override (#334).
 *
 * The default navigate behavior is "if a same-host tab is already open,
 * activate it instead of opening a new one." That's a useful default but
 * breaks workflows that need a guaranteed-fresh tab (e.g. a send flow
 * that must not inherit a stale CDP session bound to the existing tab).
 * `newTab: true` is the documented override and must skip the
 * existing-tab lookup unconditionally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/entrypoints/background/tools/browser/gif-recorder', () => ({
  isAutoCaptureActive: vi.fn().mockReturnValue(false),
  captureFrameOnAction: vi.fn().mockResolvedValue(undefined),
}));

import { navigateTool } from '@/entrypoints/background/tools/browser/common';

interface ChromeMock {
  runtime: { lastError?: chrome.runtime.LastError };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
  };
  windows: {
    getLastFocused: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

let chromeMock: ChromeMock;

const existingFeedTab = {
  id: 4242,
  windowId: 1,
  url: 'https://www.linkedin.com/feed/',
  active: false,
  index: 0,
} as unknown as chrome.tabs.Tab;

beforeEach(() => {
  chromeMock = {
    runtime: {},
    tabs: {
      query: vi.fn().mockResolvedValue([existingFeedTab]),
      create: vi.fn().mockImplementation(async (props) => ({
        id: 5050,
        windowId: props.windowId ?? 1,
        url: props.url,
        active: !!props.active,
        index: 1,
      })),
      get: vi.fn().mockImplementation(async (tabId: number) => {
        if (tabId === existingFeedTab.id) return existingFeedTab;
        if (tabId === 5050)
          return {
            id: 5050,
            windowId: 1,
            url: 'https://www.linkedin.com/messaging/thread/2-abc/',
            active: false,
            index: 1,
          } as chrome.tabs.Tab;
        const err = new Error(`No tab with id ${tabId}`);
        throw err;
      }),
      update: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
    },
    windows: {
      getLastFocused: vi
        .fn()
        .mockResolvedValue({ id: 1, focused: true, type: 'normal' } as chrome.windows.Window),
      get: vi
        .fn()
        .mockResolvedValue({ id: 1, focused: true, type: 'normal' } as chrome.windows.Window),
      update: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ id: 2, tabs: [] } as unknown as chrome.windows.Window),
    },
  };
  (globalThis as unknown as { chrome: ChromeMock }).chrome = chromeMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const parseResult = (resp: { content: unknown }) => {
  const first = (resp.content as Array<{ type: string; text?: string }>)[0];
  if (!first || typeof first.text !== 'string') {
    throw new Error(`unexpected non-text ToolResult: ${JSON.stringify(resp)}`);
  }
  return JSON.parse(first.text);
};

describe('NavigateTool — newTab override (#334)', () => {
  it('without newTab, activates an existing tab when the URL exactly matches (regression guard for the default)', async () => {
    // Existing tab at the SAME URL we navigate to — this is the path
    // where the default activate-existing behaviour kicks in.
    const resp = await navigateTool.execute({ url: existingFeedTab.url });
    const body = parseResult(resp);
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/Activated existing tab/i);
    expect(body.tabId).toBe(existingFeedTab.id);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('newTab:true forces a fresh tab even when an exact-URL match exists', async () => {
    const resp = await navigateTool.execute({
      newTab: true,
      url: existingFeedTab.url, // the SAME URL — default path would activate the existing tab
    });
    const body = parseResult(resp);
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/Opened URL in new tab/i);
    expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    // Critically: we must NOT have hit the host-pattern query — that's
    // the silent-ignore path the bug filed against.
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
  });

  it('newTab:true with an explicit tabId still honors the pinned tab (explicit wins)', async () => {
    const resp = await navigateTool.execute({
      newTab: true,
      tabId: existingFeedTab.id,
      url: 'https://www.linkedin.com/feed/',
    });
    const body = parseResult(resp);
    // explicit tabId path activates the pinned tab; newTab is ignored
    // because the caller asked for a specific target by id.
    expect(body.tabId).toBe(existingFeedTab.id);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });
});
