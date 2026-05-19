/**
 * chrome_search_tabs_content (vector-search) tests — IMP-0122.
 *
 * Locks the offscreen-RPC contract: the SW tool must dispatch over
 * chrome.runtime.sendMessage via OffscreenManager + the indexer-rpc
 * helper, NEVER `await import('@/utils/content-indexer')` (which Chrome
 * forbids from a service worker, see GitHub issue #216/#217).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { vectorSearchTabsContentTool } from '@/entrypoints/background/tools/browser/vector-search';
import { OffscreenManager } from '@/utils/offscreen-manager';

type Msg = { target?: string; type: string; [k: string]: unknown };

let sendMessageMock: ReturnType<typeof vi.fn>;
let getContextsMock: ReturnType<typeof vi.fn>;
let createDocumentMock: ReturnType<typeof vi.fn>;

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

/**
 * Routes one outbound chrome.runtime.sendMessage to a typed handler.
 * Tests configure a per-type response by mutating the `responses` map.
 */
const responses = new Map<string, (msg: Msg) => unknown>();

function defaultRoutes() {
  responses.clear();
  responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATUS, () => ({
    success: true,
    result: {
      isInitialized: true,
      isInitializing: false,
      semanticEngineReady: true,
      semanticEngineInitializing: false,
    },
  }));
  responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH, () => ({
    success: true,
    result: [
      {
        similarity: 0.9,
        distance: 0.1,
        document: {
          id: 'a',
          tabId: 11,
          url: 'https://example.com/a',
          title: 'Doc A',
          chunk: { index: 0, source: 'body', text: 'Hello example world.' },
          embedding: new Float32Array([]),
          timestamp: 1000,
        },
      },
      {
        similarity: 0.5,
        distance: 0.5,
        document: {
          id: 'a2',
          // Same tabId, lower score → must be deduped out by tab.
          tabId: 11,
          url: 'https://example.com/a',
          title: 'Doc A',
          chunk: { index: 1, source: 'body', text: 'Lower scoring chunk.' },
          embedding: new Float32Array([]),
          timestamp: 1000,
        },
      },
      {
        similarity: 0.7,
        distance: 0.3,
        document: {
          id: 'b',
          tabId: 22,
          url: 'https://example.com/b',
          title: 'Doc B',
          chunk: { index: 0, source: 'body', text: 'Different tab, mid score.' },
          embedding: new Float32Array([]),
          timestamp: 2000,
        },
      },
    ],
  }));
  responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATS, () => ({
    success: true,
    result: {
      totalDocuments: 5,
      totalTabs: 2,
      indexSize: 256,
      indexedPages: 2,
      isInitialized: true,
      semanticEngineReady: true,
      semanticEngineInitializing: false,
    },
  }));
  responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_START_INIT, () => ({
    success: true,
  }));
}

beforeEach(() => {
  defaultRoutes();
  OffscreenManager.getInstance().reset();

  sendMessageMock = vi.fn(async (msg: Msg) => {
    const handler = responses.get(msg.type);
    if (!handler) {
      return { success: false, error: `no test route for ${msg.type}` };
    }
    return handler(msg);
  });

  getContextsMock = vi.fn(async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }]);
  createDocumentMock = vi.fn(async () => undefined);

  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    sendMessage: sendMessageMock,
    getContexts: getContextsMock,
  };
  (globalThis.chrome as any).offscreen = {
    createDocument: createDocumentMock,
    hasDocument: async () => true,
    closeDocument: async () => undefined,
  };
});

afterEach(() => {
  responses.clear();
  OffscreenManager.getInstance().reset();
});

describe('chrome_search_tabs_content (IMP-0122 offscreen RPC)', () => {
  it('rejects an empty query', async () => {
    const res = await vectorSearchTabsContentTool.execute({ query: '' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Query parameter');
  });

  it('rejects a whitespace-only query', async () => {
    const res = await vectorSearchTabsContentTool.execute({ query: '   ' });
    expect(res.isError).toBe(true);
  });

  it('dispatches search/stats over chrome.runtime.sendMessage (no dynamic import)', async () => {
    await vectorSearchTabsContentTool.execute({ query: 'hello' });

    const types = sendMessageMock.mock.calls.map((c: any[]) => (c[0] as Msg).type);
    expect(types).toContain(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATUS);
    expect(types).toContain(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH);
    expect(types).toContain(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATS);

    // Search message must carry the query and a topK >= 1.
    const searchCall = sendMessageMock.mock.calls.find(
      (c: any[]) => (c[0] as Msg).type === OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH,
    );
    const searchMsg = searchCall![0] as Msg;
    expect(searchMsg.target).toBe('offscreen');
    expect(searchMsg.query).toBe('hello');
    expect(typeof searchMsg.topK).toBe('number');
  });

  it('ensures the offscreen document is created before dispatching', async () => {
    // First call into a brand-new OffscreenManager state. The manager's
    // `_doCreateOffscreenDocument` checks `getContexts`; we return empty
    // for the first probe so it must call createDocument.
    getContextsMock.mockResolvedValueOnce([]);
    OffscreenManager.getInstance().reset();

    await vectorSearchTabsContentTool.execute({ query: 'first call' });
    expect(createDocumentMock).toHaveBeenCalledTimes(1);

    // Subsequent calls reuse the cached "isCreated" flag — no second
    // createDocument fires.
    await vectorSearchTabsContentTool.execute({ query: 'second call' });
    expect(createDocumentMock).toHaveBeenCalledTimes(1);
  });

  it('returns the still-initializing message when the engine is downloading', async () => {
    responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATUS, () => ({
      success: true,
      result: {
        isInitialized: false,
        isInitializing: true,
        semanticEngineReady: false,
        semanticEngineInitializing: true,
      },
    }));

    const res = await vectorSearchTabsContentTool.execute({ query: 'still loading' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('still initializing');
  });

  it('triggers init and errors when the engine is not yet ready', async () => {
    responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATUS, () => ({
      success: true,
      result: {
        isInitialized: false,
        isInitializing: false,
        semanticEngineReady: false,
        semanticEngineInitializing: false,
      },
    }));

    const res = await vectorSearchTabsContentTool.execute({ query: 'cold start' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Failed to initialize');

    const types = sendMessageMock.mock.calls.map((c: any[]) => (c[0] as Msg).type);
    expect(types).toContain(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_START_INIT);
  });

  it('surfaces a thrown error from the offscreen page as an error envelope', async () => {
    responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH, () => ({
      success: false,
      error: 'engine crashed',
    }));

    const res = await vectorSearchTabsContentTool.execute({ query: 'boom' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('engine crashed');
  });

  it('deduplicates results by tab and returns the top-scoring chunk', async () => {
    const res = await vectorSearchTabsContentTool.execute({ query: 'dedupe' });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.matchedTabs).toHaveLength(2);
    const tabIds = body.matchedTabs.map((t: any) => t.tabId).sort();
    expect(tabIds).toEqual([11, 22]);
    // Tab 11's lower-scoring chunk must NOT win.
    const tab11 = body.matchedTabs.find((t: any) => t.tabId === 11);
    expect(tab11.semanticScore).toBe(0.9);
    // Sorted by similarity desc.
    expect(body.matchedTabs[0].semanticScore).toBeGreaterThanOrEqual(
      body.matchedTabs[1].semanticScore,
    );
  });

  it('returns the indexStats block reported by the offscreen page', async () => {
    const res = await vectorSearchTabsContentTool.execute({ query: 'stats' });
    const body = parseBody(res);
    expect(body.indexStats).toBeDefined();
    expect(body.indexStats.totalTabs).toBe(2);
    expect(body.indexStats.totalDocuments).toBe(5);
    expect(body.indexStats.indexedPages).toBe(2);
    expect(body.indexStats.semanticEngineReady).toBe(true);
    expect(body.vectorSearchEnabled).toBe(true);
  });

  it('handles a "no results" search by returning an empty matchedTabs array', async () => {
    responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH, () => ({
      success: true,
      result: [],
    }));

    const res = await vectorSearchTabsContentTool.execute({ query: 'nothing' });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.matchedTabs).toEqual([]);
    expect(body.matchedTabsCount).toBe(0);
  });

  it('rebuildIndex clears the offscreen indexes and re-indexes valid tabs', async () => {
    responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_ALL, () => ({
      success: true,
      result: undefined,
    }));
    responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_INDEX_TAB, () => ({
      success: true,
      result: undefined,
    }));

    (globalThis.chrome as any).windows = {
      getAll: async () => [
        {
          tabs: [
            { id: 1, url: 'https://example.com/a' },
            { id: 2, url: 'chrome://settings' },
            { id: 3, url: 'about:blank' },
            { id: 4, url: 'https://example.com/b' },
          ],
        },
      ],
    };

    await vectorSearchTabsContentTool.rebuildIndex();

    const clearCalls = sendMessageMock.mock.calls.filter(
      (c: any[]) => (c[0] as Msg).type === OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_ALL,
    );
    expect(clearCalls).toHaveLength(1);

    const indexCalls = sendMessageMock.mock.calls.filter(
      (c: any[]) => (c[0] as Msg).type === OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_INDEX_TAB,
    );
    // chrome:// and about: tabs must be filtered; only ids 1 and 4 reach the offscreen.
    const indexedTabIds = indexCalls.map((c: any[]) => (c[0] as Msg).tabId).sort();
    expect(indexedTabIds).toEqual([1, 4]);

    delete (globalThis.chrome as any).windows;
  });

  it('removeTabIndex forwards the tabId to the offscreen helper', async () => {
    responses.set(OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REMOVE_TAB, () => ({
      success: true,
      result: undefined,
    }));

    await vectorSearchTabsContentTool.removeTabIndex(42);

    const call = sendMessageMock.mock.calls.find(
      (c: any[]) => (c[0] as Msg).type === OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REMOVE_TAB,
    );
    expect(call).toBeDefined();
    expect((call![0] as Msg).tabId).toBe(42);
  });
});
