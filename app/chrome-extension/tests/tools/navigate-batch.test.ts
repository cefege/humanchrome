/**
 * NavigateBatchTool unit tests
 *
 * Coverage:
 *   - Legacy path: maxConcurrent omitted opens all URLs without waiting
 *   - Worker pool: maxConcurrent caps in-flight tab loads
 *   - Worker pool: TIMEOUT while waiting still records the tab + surfaces error
 *   - Input validation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock gif-recorder to avoid pulling its full dependency graph.
vi.mock('@/entrypoints/background/tools/browser/gif-recorder', () => ({
  isAutoCaptureActive: vi.fn().mockReturnValue(false),
  captureFrameOnAction: vi.fn().mockResolvedValue(undefined),
}));

import { navigateBatchTool } from '@/entrypoints/background/tools/browser/common';

interface OnUpdatedListener {
  (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void;
}
interface OnRemovedListener {
  (tabId: number): void;
}

interface ChromeMockState {
  /** Sequential tab id assignment from chrome.tabs.create */
  nextTabId: number;
  /** Snapshot of tab ids that have been opened (in order). */
  createdTabIds: number[];
  /** How many tabs are currently "loading" (created but not yet completed). */
  inFlight: number;
  /** Peak concurrency observed by chrome.tabs.create vs onUpdated complete. */
  peakInFlight: number;
  /** Per-tab status. Drives chrome.tabs.get fast-path inside waitForTabComplete. */
  status: Map<number, 'loading' | 'complete'>;
  /** Live onUpdated listeners (waitForTabComplete arms one per call). */
  onUpdatedListeners: Set<OnUpdatedListener>;
  /** Live onRemoved listeners. */
  onRemovedListeners: Set<OnRemovedListener>;
}

function createChromeMock(opts: {
  /**
   * After chrome.tabs.create resolves, schedule the tab to fire
   * status:'complete' after this many ms via setTimeout. The harness uses
   * fake timers so tests advance time deterministically.
   */
  loadDelayMs: number;
  /** When true, never fire complete for this tab — simulates a hung load. */
  neverComplete?: (tabId: number) => boolean;
}) {
  const state: ChromeMockState = {
    nextTabId: 1000,
    createdTabIds: [],
    inFlight: 0,
    peakInFlight: 0,
    status: new Map(),
    onUpdatedListeners: new Set(),
    onRemovedListeners: new Set(),
  };

  const fireComplete = (tabId: number) => {
    state.status.set(tabId, 'complete');
    state.inFlight = Math.max(0, state.inFlight - 1);
    for (const listener of state.onUpdatedListeners) {
      listener(tabId, { status: 'complete' }, {
        id: tabId,
        status: 'complete',
        url: 'https://example.com/',
      } as chrome.tabs.Tab);
    }
  };

  const tabs = {
    create: vi.fn(async (createProps: chrome.tabs.CreateProperties) => {
      const id = state.nextTabId++;
      state.createdTabIds.push(id);
      state.status.set(id, 'loading');
      state.inFlight += 1;
      if (state.inFlight > state.peakInFlight) state.peakInFlight = state.inFlight;

      // Schedule a deferred onUpdated complete event unless this tab is
      // marked as never-complete.
      if (!opts.neverComplete?.(id)) {
        setTimeout(() => fireComplete(id), opts.loadDelayMs);
      }
      return { id, url: createProps.url, status: 'loading' } as chrome.tabs.Tab;
    }),
    get: vi.fn(async (tabId: number) => {
      const status = state.status.get(tabId);
      if (!status) {
        throw new Error(`Tab ${tabId} not found`);
      }
      return { id: tabId, status, url: 'https://example.com/' } as chrome.tabs.Tab;
    }),
    onUpdated: {
      addListener: vi.fn((listener: OnUpdatedListener) => {
        state.onUpdatedListeners.add(listener);
      }),
      removeListener: vi.fn((listener: OnUpdatedListener) => {
        state.onUpdatedListeners.delete(listener);
      }),
    },
    onRemoved: {
      addListener: vi.fn((listener: OnRemovedListener) => {
        state.onRemovedListeners.add(listener);
      }),
      removeListener: vi.fn((listener: OnRemovedListener) => {
        state.onRemovedListeners.delete(listener);
      }),
    },
  };

  const windows = {
    getLastFocused: vi.fn(async () => ({ id: 7777 })),
  };

  return { state, tabs, windows };
}

describe('NavigateBatchTool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('legacy path (no maxConcurrent) opens all URLs without waiting for load', async () => {
    const { state, tabs, windows } = createChromeMock({ loadDelayMs: 5_000 });
    vi.stubGlobal('chrome', { tabs, windows });

    const urls = ['https://a.example/', 'https://b.example/', 'https://c.example/'];

    // Run execute and let microtasks/timers settle as needed. The tool must
    // resolve before any tab fires onUpdated complete (loadDelayMs=5s, not
    // advanced).
    const promise = navigateBatchTool.execute({ urls });
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.isError).toBe(false);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.tabs).toHaveLength(3);
    expect(payload.count).toBe(3);
    expect(payload.windowId).toBe(7777);
    expect(payload.errors).toBeUndefined();

    // No tab listener should have been armed (legacy path doesn't wait).
    expect(tabs.onUpdated.addListener).not.toHaveBeenCalled();
    expect(state.createdTabIds).toHaveLength(3);
  });

  it('maxConcurrent caps in-flight tab opens', async () => {
    const { state, tabs, windows } = createChromeMock({ loadDelayMs: 100 });
    vi.stubGlobal('chrome', { tabs, windows });

    const urls = [
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
      'https://d.example/',
      'https://e.example/',
      'https://f.example/',
    ];

    const promise = navigateBatchTool.execute({ urls, maxConcurrent: 2 });

    // Drain timers in ticks until the tool resolves. Each load completes 100ms
    // after creation; with maxConcurrent=2 and 6 URLs this needs ~300ms.
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(result.isError).toBe(false);
    expect(payload.tabs).toHaveLength(6);
    expect(payload.errors).toBeUndefined();

    // The pool size cap is the load-bearing assertion.
    expect(state.peakInFlight).toBeLessThanOrEqual(2);
    expect(state.peakInFlight).toBeGreaterThanOrEqual(1);
  });

  it('maxConcurrent=1 fully serializes opens', async () => {
    const { state, tabs, windows } = createChromeMock({ loadDelayMs: 50 });
    vi.stubGlobal('chrome', { tabs, windows });

    const urls = ['https://a.example/', 'https://b.example/', 'https://c.example/'];

    const promise = navigateBatchTool.execute({ urls, maxConcurrent: 1 });
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(state.peakInFlight).toBe(1);
  });

  it('worker pool surfaces TIMEOUT errors but still records the tab', async () => {
    // First tab never completes → forces a TIMEOUT. Subsequent tabs load
    // normally so we can see the worker pool moves on.
    const stuckTabIds = new Set<number>();
    const { state, tabs, windows } = createChromeMock({
      loadDelayMs: 10,
      neverComplete: (id) => {
        // The very first created tab gets stuck.
        if (state.createdTabIds.length === 1 && state.createdTabIds[0] === id) {
          stuckTabIds.add(id);
          return true;
        }
        return false;
      },
    });
    vi.stubGlobal('chrome', { tabs, windows });

    const urls = ['https://stuck.example/', 'https://b.example/', 'https://c.example/'];

    const promise = navigateBatchTool.execute({
      urls,
      maxConcurrent: 1,
      perUrlTimeoutMs: 1_000,
    });

    // Advance past the per-url timeout so the stuck tab fires TIMEOUT, then
    // past the remaining loads (10ms each).
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await promise;
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(result.isError).toBe(false);
    // Tab is still recorded — caller can clean it up.
    expect(payload.tabs.length).toBe(3);
    // But errors carries the timeout entry for the stuck URL.
    expect(payload.errors).toBeDefined();
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].url).toBe('https://stuck.example/');
    expect(payload.errors[0].message).toContain('TIMEOUT');
  });

  it('rejects empty url array', async () => {
    const { tabs, windows } = createChromeMock({ loadDelayMs: 0 });
    vi.stubGlobal('chrome', { tabs, windows });

    const result = await navigateBatchTool.execute({ urls: [] });
    expect(result.isError).toBe(true);
  });

  it('maxConcurrent >= urls.length falls through to legacy path (no wait)', async () => {
    const { state, tabs, windows } = createChromeMock({ loadDelayMs: 5_000 });
    vi.stubGlobal('chrome', { tabs, windows });

    const urls = ['https://a.example/', 'https://b.example/'];
    const promise = navigateBatchTool.execute({ urls, maxConcurrent: 5 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result.isError).toBe(false);
    expect(tabs.onUpdated.addListener).not.toHaveBeenCalled();
    expect(state.createdTabIds).toHaveLength(2);
  });
});
