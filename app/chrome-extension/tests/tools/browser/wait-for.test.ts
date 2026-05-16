/**
 * chrome_wait_for tests (IMP-0102).
 *
 * Covers the two Playwright-parity kinds added in IMP-0102:
 *   - load_state: webNavigation.onCompleted / onDOMContentLoaded, with
 *     synchronous resolve when document.readyState already satisfies the wait.
 *   - url: webNavigation.onCommitted + onHistoryStateUpdated, with
 *     synchronous resolve when the tab's current URL already matches.
 *
 * The other kinds (element / network_idle / response_match / js) are
 * exercised indirectly by existing wait-helper.js and intercept-response
 * test suites; this file scopes itself to the IMP-0102 surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForTool } from '@/entrypoints/background/tools/browser/wait-for';

interface Listener<T> {
  fn: (details: T) => void;
}
type NavDetails = chrome.webNavigation.WebNavigationFramedCallbackDetails;
type NavTransitionDetails = chrome.webNavigation.WebNavigationTransitionCallbackDetails;

function makeEvent<T>(): {
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  fire: (details: T) => void;
  count: () => number;
} {
  const listeners: Listener<T>[] = [];
  return {
    addListener: vi.fn((fn: (details: T) => void) => {
      listeners.push({ fn });
    }),
    removeListener: vi.fn((fn: (details: T) => void) => {
      const idx = listeners.findIndex((l) => l.fn === fn);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    fire: (details: T) => {
      // Snapshot to avoid mutation during dispatch.
      [...listeners].forEach((l) => l.fn(details));
    },
    count: () => listeners.length,
  };
}

let onCompleted: ReturnType<typeof makeEvent<NavDetails>>;
let onDOMContentLoaded: ReturnType<typeof makeEvent<NavDetails>>;
let onCommitted: ReturnType<typeof makeEvent<NavTransitionDetails>>;
let onHistoryStateUpdated: ReturnType<typeof makeEvent<NavTransitionDetails>>;
let executeScriptMock: ReturnType<typeof vi.fn>;
let tabsGetMock: ReturnType<typeof vi.fn>;

const TAB_ID = 42;

beforeEach(() => {
  onCompleted = makeEvent<NavDetails>();
  onDOMContentLoaded = makeEvent<NavDetails>();
  onCommitted = makeEvent<NavTransitionDetails>();
  onHistoryStateUpdated = makeEvent<NavTransitionDetails>();

  // Default: page is still loading so listener subscription is needed.
  executeScriptMock = vi.fn().mockResolvedValue([{ result: 'loading' }]);
  // Default tab url (no match for url tests).
  tabsGetMock = vi.fn().mockResolvedValue({ id: TAB_ID, url: 'https://example.com/start' });

  (globalThis.chrome as any).webNavigation = {
    onCompleted,
    onDOMContentLoaded,
    onCommitted,
    onHistoryStateUpdated,
  };
  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    get: tabsGetMock,
    query: vi.fn().mockResolvedValue([{ id: TAB_ID }]),
    sendMessage: vi.fn().mockResolvedValue({ status: 'pong' }),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_wait_for kind="load_state"', () => {
  it('resolves immediately when readyState already satisfies the requested state', async () => {
    executeScriptMock.mockResolvedValueOnce([{ result: 'complete' }]);

    const res = await waitForTool.execute({ kind: 'load_state', state: 'load', tabId: TAB_ID });

    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.kind).toBe('load_state');
    expect(body.state).toBe('load');
    expect(body.alreadyLoaded).toBe(true);
    expect(body.readyState).toBe('complete');
    // No subscription should have happened.
    expect(onCompleted.count()).toBe(0);
  });

  it('treats "complete" as a synonym for "load" (both map to onCompleted)', async () => {
    executeScriptMock.mockResolvedValueOnce([{ result: 'complete' }]);

    const res = await waitForTool.execute({
      kind: 'load_state',
      state: 'complete',
      tabId: TAB_ID,
    });

    expect(res.isError).toBe(false);
    expect(parseBody(res).state).toBe('complete');
    expect(parseBody(res).alreadyLoaded).toBe(true);
  });

  it('resolves immediately for "domcontentloaded" when readyState is "interactive"', async () => {
    executeScriptMock.mockResolvedValueOnce([{ result: 'interactive' }]);

    const res = await waitForTool.execute({
      kind: 'load_state',
      state: 'domcontentloaded',
      tabId: TAB_ID,
    });

    expect(parseBody(res).alreadyLoaded).toBe(true);
    // No listener install for the sync path.
    expect(onDOMContentLoaded.count()).toBe(0);
  });

  it('waits for onCompleted (load) when readyState is "loading"', async () => {
    // readyState='loading' (default) → subscribes to onCompleted.
    const promise = waitForTool.execute({ kind: 'load_state', state: 'load', tabId: TAB_ID });
    // Allow the readyState query + subscription to land.
    await new Promise((r) => setImmediate(r));
    expect(onCompleted.count()).toBe(1);

    // Wrong tab/frame → ignored.
    onCompleted.fire({
      tabId: 999,
      frameId: 0,
      url: 'https://other.com',
      timeStamp: Date.now(),
      processId: 0,
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavDetails);
    expect(onCompleted.count()).toBe(1); // still attached

    // Right tab+frame → resolves.
    onCompleted.fire({
      tabId: TAB_ID,
      frameId: 0,
      url: 'https://example.com/start',
      timeStamp: Date.now(),
      processId: 0,
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavDetails);

    const res = await promise;
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.kind).toBe('load_state');
    expect(body.alreadyLoaded).toBe(false);
    expect(onCompleted.count()).toBe(0); // detached on resolve
  });

  it('waits for onDOMContentLoaded when state="domcontentloaded" and document still loading', async () => {
    // readyState='loading' → must wait.
    const promise = waitForTool.execute({
      kind: 'load_state',
      state: 'domcontentloaded',
      tabId: TAB_ID,
    });
    await new Promise((r) => setImmediate(r));
    expect(onDOMContentLoaded.count()).toBe(1);
    expect(onCompleted.count()).toBe(0);

    onDOMContentLoaded.fire({
      tabId: TAB_ID,
      frameId: 0,
      url: 'https://example.com/start',
      timeStamp: Date.now(),
      processId: 0,
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavDetails);

    const res = await promise;
    expect(res.isError).toBe(false);
    expect(parseBody(res).state).toBe('domcontentloaded');
  });

  it('honors frameId filter (default 0) — sub-frame events do not resolve', async () => {
    const promise = waitForTool.execute({ kind: 'load_state', state: 'load', tabId: TAB_ID });
    await new Promise((r) => setImmediate(r));

    // Sub-frame load → ignored.
    onCompleted.fire({
      tabId: TAB_ID,
      frameId: 99,
      url: 'https://iframe.example.com/',
      timeStamp: Date.now(),
      processId: 0,
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'sub_frame',
      parentFrameId: 0,
    } as NavDetails);
    expect(onCompleted.count()).toBe(1); // not detached

    // Main frame load → resolves.
    onCompleted.fire({
      tabId: TAB_ID,
      frameId: 0,
      url: 'https://example.com/start',
      timeStamp: Date.now(),
      processId: 0,
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavDetails);

    const res = await promise;
    expect(parseBody(res).frameId).toBe(0);
  });

  it('times out as TIMEOUT when no event fires within timeoutMs', async () => {
    vi.useFakeTimers();
    const promise = waitForTool.execute({
      kind: 'load_state',
      state: 'load',
      tabId: TAB_ID,
      timeoutMs: 50,
    });
    // Allow the readyState IIFE to settle (it uses real microtasks via the
    // mock's resolved value).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    const res = await promise;
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TIMEOUT');
    expect((res.content[0] as any).text).toContain('load_state');
    // Listener detached on timeout.
    expect(onCompleted.count()).toBe(0);
  });

  it('rejects an unknown load state', async () => {
    const res = await waitForTool.execute({
      kind: 'load_state',
      state: 'bogus' as any,
      tabId: TAB_ID,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
    expect((res.content[0] as any).text).toContain('state');
  });

  it('clamps timeoutMs above the 120000ms cap to the cap value', async () => {
    executeScriptMock.mockResolvedValueOnce([{ result: 'complete' }]);
    // Synchronous path — just confirm the request still resolves and the
    // huge timeout does not blow up. The clamp itself is exercised in the
    // shared `Math.max(0, Math.min(requested, MAX_TIMEOUT_MS))` helper.
    const res = await waitForTool.execute({
      kind: 'load_state',
      state: 'load',
      tabId: TAB_ID,
      timeoutMs: 999_999_999,
    });
    expect(res.isError).toBe(false);
  });
});

describe('chrome_wait_for kind="url"', () => {
  it('resolves immediately when the current URL already matches a substring', async () => {
    // Both calls (`tryGetTab` in the dispatcher + the `waitForUrl` self-check)
    // must report the already-matching URL.
    tabsGetMock.mockResolvedValue({ id: TAB_ID, url: 'https://example.com/checkout' });
    const res = await waitForTool.execute({
      kind: 'url',
      pattern: '/checkout',
      tabId: TAB_ID,
    });

    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.kind).toBe('url');
    expect(body.alreadyMatched).toBe(true);
    expect(body.url).toBe('https://example.com/checkout');
    // No subscription needed.
    expect(onCommitted.count()).toBe(0);
    expect(onHistoryStateUpdated.count()).toBe(0);
  });

  it('resolves when onCommitted fires with a matching URL (substring pattern)', async () => {
    const promise = waitForTool.execute({
      kind: 'url',
      pattern: '/checkout',
      tabId: TAB_ID,
    });
    await new Promise((r) => setImmediate(r));
    expect(onCommitted.count()).toBe(1);
    expect(onHistoryStateUpdated.count()).toBe(1);

    onCommitted.fire({
      tabId: TAB_ID,
      frameId: 0,
      url: 'https://example.com/checkout?step=2',
      timeStamp: Date.now(),
      processId: 0,
      transitionType: 'link',
      transitionQualifiers: [],
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavTransitionDetails);

    const res = await promise;
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.alreadyMatched).toBe(false);
    expect(body.url).toBe('https://example.com/checkout?step=2');
    expect(body.pattern).toBe('/checkout');
    // Both listeners cleaned up.
    expect(onCommitted.count()).toBe(0);
    expect(onHistoryStateUpdated.count()).toBe(0);
  });

  it('resolves on onHistoryStateUpdated for SPA pushState transitions', async () => {
    const promise = waitForTool.execute({
      kind: 'url',
      pattern: '/dashboard',
      tabId: TAB_ID,
    });
    await new Promise((r) => setImmediate(r));

    onHistoryStateUpdated.fire({
      tabId: TAB_ID,
      frameId: 0,
      url: 'https://example.com/app/dashboard',
      timeStamp: Date.now(),
      processId: 0,
      transitionType: 'auto_subframe',
      transitionQualifiers: [],
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavTransitionDetails);

    const res = await promise;
    expect(res.isError).toBe(false);
    expect(parseBody(res).url).toBe('https://example.com/app/dashboard');
  });

  it('honors regex pattern syntax (/.../flags)', async () => {
    const promise = waitForTool.execute({
      kind: 'url',
      // Match any /orders/<digits> path
      pattern: '/\\/orders\\/\\d+$/',
      tabId: TAB_ID,
    });
    await new Promise((r) => setImmediate(r));

    // Non-match: trailing slash breaks the $ anchor → no resolve.
    onCommitted.fire({
      tabId: TAB_ID,
      frameId: 0,
      url: 'https://example.com/orders/42/',
      timeStamp: Date.now(),
      processId: 0,
      transitionType: 'link',
      transitionQualifiers: [],
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavTransitionDetails);
    expect(onCommitted.count()).toBe(1); // still attached

    // Match.
    onCommitted.fire({
      tabId: TAB_ID,
      frameId: 0,
      url: 'https://example.com/orders/42',
      timeStamp: Date.now(),
      processId: 0,
      transitionType: 'link',
      transitionQualifiers: [],
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavTransitionDetails);

    const res = await promise;
    expect(res.isError).toBe(false);
    expect(parseBody(res).url).toBe('https://example.com/orders/42');
  });

  it('ignores events for other tabs and for sub-frames', async () => {
    const promise = waitForTool.execute({
      kind: 'url',
      pattern: '/checkout',
      tabId: TAB_ID,
    });
    await new Promise((r) => setImmediate(r));

    // Wrong tab.
    onCommitted.fire({
      tabId: 999,
      frameId: 0,
      url: 'https://example.com/checkout',
      timeStamp: Date.now(),
      processId: 0,
      transitionType: 'link',
      transitionQualifiers: [],
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavTransitionDetails);

    // Sub-frame.
    onCommitted.fire({
      tabId: TAB_ID,
      frameId: 7,
      url: 'https://example.com/checkout',
      timeStamp: Date.now(),
      processId: 0,
      transitionType: 'link',
      transitionQualifiers: [],
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'sub_frame',
      parentFrameId: 0,
    } as NavTransitionDetails);

    expect(onCommitted.count()).toBe(1); // still attached

    // Right tab, main frame → resolves.
    onCommitted.fire({
      tabId: TAB_ID,
      frameId: 0,
      url: 'https://example.com/checkout',
      timeStamp: Date.now(),
      processId: 0,
      transitionType: 'link',
      transitionQualifiers: [],
      documentId: 'd',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      parentFrameId: -1,
    } as NavTransitionDetails);

    const res = await promise;
    expect(res.isError).toBe(false);
  });

  it('times out as TIMEOUT when no navigation event matches within timeoutMs', async () => {
    vi.useFakeTimers();
    const promise = waitForTool.execute({
      kind: 'url',
      pattern: '/checkout',
      tabId: TAB_ID,
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    const res = await promise;
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TIMEOUT');
    expect((res.content[0] as any).text).toContain('url');
    // Both listeners detached on timeout.
    expect(onCommitted.count()).toBe(0);
    expect(onHistoryStateUpdated.count()).toBe(0);
  });

  it('rejects when pattern is missing or whitespace', async () => {
    const res = await waitForTool.execute({ kind: 'url', tabId: TAB_ID });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
    expect((res.content[0] as any).text).toContain('pattern');

    const res2 = await waitForTool.execute({ kind: 'url', pattern: '   ', tabId: TAB_ID });
    expect(res2.isError).toBe(true);
    expect((res2.content[0] as any).text).toContain('pattern');
  });
});

describe('chrome_wait_for kind validation', () => {
  it('error message advertises the new kinds', async () => {
    const res = await waitForTool.execute({} as any);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('load_state');
    expect(text).toContain('url');
  });
});
