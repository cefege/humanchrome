/**
 * Offscreen vector-host tests — IMP-0122.
 *
 * The host owns the singleton ContentIndexer in the offscreen page and
 * services RPC calls from the SW. These tests mock the indexer module
 * so we can verify the dispatcher routes each message type to the right
 * indexer method and that errors are surfaced through the response
 * envelope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

const fakeIndexer = {
  searchContent: vi.fn(),
  getStats: vi.fn(),
  clearAllIndexes: vi.fn(),
  indexTabContent: vi.fn(),
  removeTabIndex: vi.fn(),
  reinitialize: vi.fn(),
  startSemanticEngineInitialization: vi.fn(),
  isSemanticEngineReady: vi.fn(),
  isSemanticEngineInitializing: vi.fn(),
};

vi.mock('@/utils/content-indexer', () => ({
  getGlobalContentIndexer: () => fakeIndexer,
}));

vi.mock('@/utils/vector-database', () => ({
  clearAllVectorData: vi.fn(async () => undefined),
}));

import { handleIndexerMessage } from '@/entrypoints/offscreen/vector-host';
import { clearAllVectorData } from '@/utils/vector-database';

beforeEach(() => {
  Object.values(fakeIndexer).forEach((fn) => fn.mockReset());
  fakeIndexer.isSemanticEngineReady.mockReturnValue(true);
  fakeIndexer.isSemanticEngineInitializing.mockReturnValue(false);
  fakeIndexer.getStats.mockReturnValue({
    totalDocuments: 1,
    totalTabs: 1,
    indexSize: 8,
    indexedPages: 1,
    isInitialized: true,
    semanticEngineReady: true,
    semanticEngineInitializing: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleIndexerMessage routing', () => {
  it('returns false for messages that are not indexer RPCs', () => {
    const sendResponse = vi.fn();
    const handled = handleIndexerMessage(
      { type: 'gifAddFrame' as any } as any,
      sendResponse as any,
    );
    expect(handled).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('returns false when the message has no type field', () => {
    const sendResponse = vi.fn();
    const handled = handleIndexerMessage({} as any, sendResponse as any);
    expect(handled).toBe(false);
  });

  it('CONTENT_INDEXER_SEARCH calls indexer.searchContent and wraps the result', async () => {
    fakeIndexer.searchContent.mockResolvedValueOnce([{ similarity: 0.42 }]);
    const sendResponse = vi.fn();
    const handled = handleIndexerMessage(
      {
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH,
        query: 'foo',
        topK: 3,
      },
      sendResponse,
    );
    expect(handled).toBe(true);

    // Flush microtasks so the async dispatch resolves and sendResponse fires.
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeIndexer.searchContent).toHaveBeenCalledWith('foo', 3);
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      result: [{ similarity: 0.42 }],
    });
  });

  it('CONTENT_INDEXER_STATS returns the indexer.getStats() snapshot', async () => {
    const sendResponse = vi.fn();
    handleIndexerMessage(
      { target: 'offscreen', type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATS },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeIndexer.getStats).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      result: expect.objectContaining({ totalDocuments: 1, totalTabs: 1 }),
    });
  });

  it('CONTENT_INDEXER_STATUS reads engine state without forcing init', async () => {
    fakeIndexer.isSemanticEngineReady.mockReturnValue(false);
    fakeIndexer.isSemanticEngineInitializing.mockReturnValue(true);

    const sendResponse = vi.fn();
    handleIndexerMessage(
      { target: 'offscreen', type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATUS },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      result: expect.objectContaining({
        semanticEngineReady: false,
        semanticEngineInitializing: true,
      }),
    });
  });

  it('CONTENT_INDEXER_CLEAR_ALL invokes the indexer clear path', async () => {
    fakeIndexer.clearAllIndexes.mockResolvedValueOnce(undefined);
    const sendResponse = vi.fn();
    handleIndexerMessage(
      { target: 'offscreen', type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_ALL },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeIndexer.clearAllIndexes).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ success: true, result: undefined });
  });

  it('CONTENT_INDEXER_CLEAR_VECTOR_DATA wipes on-disk vector data', async () => {
    const sendResponse = vi.fn();
    handleIndexerMessage(
      {
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_VECTOR_DATA,
      },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(clearAllVectorData).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ success: true, result: undefined });
  });

  it('CONTENT_INDEXER_INDEX_TAB rejects a non-number tabId', async () => {
    const sendResponse = vi.fn();
    handleIndexerMessage(
      {
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_INDEX_TAB,
        tabId: 'nope' as any,
      },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeIndexer.indexTabContent).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: expect.stringContaining('tabId'),
    });
  });

  it('CONTENT_INDEXER_INDEX_TAB forwards a valid tabId', async () => {
    fakeIndexer.indexTabContent.mockResolvedValueOnce(undefined);
    const sendResponse = vi.fn();
    handleIndexerMessage(
      {
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_INDEX_TAB,
        tabId: 7,
      },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeIndexer.indexTabContent).toHaveBeenCalledWith(7);
    expect(sendResponse).toHaveBeenCalledWith({ success: true, result: undefined });
  });

  it('CONTENT_INDEXER_REMOVE_TAB forwards the tabId', async () => {
    fakeIndexer.removeTabIndex.mockResolvedValueOnce(undefined);
    const sendResponse = vi.fn();
    handleIndexerMessage(
      {
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REMOVE_TAB,
        tabId: 9,
      },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeIndexer.removeTabIndex).toHaveBeenCalledWith(9);
  });

  it('CONTENT_INDEXER_REINITIALIZE invokes the indexer reinit path', async () => {
    fakeIndexer.reinitialize.mockResolvedValueOnce(undefined);
    const sendResponse = vi.fn();
    handleIndexerMessage(
      { target: 'offscreen', type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REINITIALIZE },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeIndexer.reinitialize).toHaveBeenCalled();
  });

  it('CONTENT_INDEXER_START_INIT calls startSemanticEngineInitialization (sync void)', async () => {
    const sendResponse = vi.fn();
    handleIndexerMessage(
      { target: 'offscreen', type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_START_INIT },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(fakeIndexer.startSemanticEngineInitialization).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ success: true, result: undefined });
  });

  it('surfaces a thrown indexer error in the response envelope', async () => {
    fakeIndexer.searchContent.mockRejectedValueOnce(new Error('engine offline'));
    const sendResponse = vi.fn();
    handleIndexerMessage(
      {
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH,
        query: 'q',
      },
      sendResponse,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'engine offline',
    });
  });
});
