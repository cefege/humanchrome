import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentIndexer } from '@/utils/content-indexer';
import type { SemanticSimilarityEngine } from '@/utils/semantic-similarity-engine';
import type { TextChunk } from '@/utils/text-chunker';
import { INDEXER_HOST_MESSAGES } from '@/common/content-indexer-messages';

interface HostRequest {
  type: string;
  tabId?: number;
}

const state = vi.hoisted(() => ({
  documents: [] as { tabId: number; chunk: TextChunk }[],
  indexedPages: new Set<string>(),
}));

vi.mock('@/utils/vector-database', () => ({
  getGlobalVectorDatabase: async () => ({
    initialize: async () => {},
    hasIndexedPage: (url: string) => state.indexedPages.has(url),
    markIndexedPage: (url: string) => state.indexedPages.add(url),
    addDocument: async (tabId: number, _url: string, _title: string, chunk: TextChunk) => {
      state.documents.push({ tabId, chunk });
      return state.documents.length - 1;
    },
  }),
}));

beforeEach(() => {
  state.documents.length = 0;
  state.indexedPages.clear();
  vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(async (...args: unknown[]) => {
    // The production caller uses the one-argument overload, not Chrome's external-ID overload.
    const message = args[0] as HostRequest;
    switch (message.type) {
      case INDEXER_HOST_MESSAGES.GET_MODEL_SETTINGS:
        return { success: true, result: {} };
      case INDEXER_HOST_MESSAGES.GET_TAB:
        return {
          success: true,
          result: { url: `https://example.com/${message.tabId}`, title: 'Astronomy notes' },
        };
      case INDEXER_HOST_MESSAGES.EXTRACT_TAB_CONTENT:
        return {
          success: true,
          result: {
            title: 'Astronomy notes',
            textContent: 'The telescope observes an exoplanet transit across a distant star.',
          },
        };
      default:
        throw new Error(`Unexpected host request: ${message.type}`);
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createIndexer(getEmbedding: (text: string) => Promise<Float32Array>) {
  // This unit supplies only the inference boundary used by ContentIndexer.
  const engine = { isInitialized: true, getEmbedding } as SemanticSimilarityEngine;
  return new ContentIndexer(() => engine);
}

describe('ContentIndexer concurrent indexing', () => {
  it('does not duplicate vectors when automatic indexing overlaps an explicit request', async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const indexer = createIndexer(async () => {
      started.resolve();
      await release.promise;
      return new Float32Array([1, 0]);
    });
    await indexer.initialize();
    const explicit = indexer.indexTabContent(7);
    await started.promise;
    indexer.handleTabUpdated(7, { status: 'complete' }, { url: 'https://example.com/7' });
    await vi.advanceTimersByTimeAsync(2_000);
    release.resolve();
    await explicit;
    await vi.runOnlyPendingTimersAsync();

    const chunkIds = state.documents.map(({ tabId, chunk }) => `${tabId}:${chunk.index}`);
    expect(state.documents.some(({ chunk }) => chunk.text.includes('exoplanet'))).toBe(true);
    expect(chunkIds).toEqual([...new Set(chunkIds)]);
  });

  it('does not block a different tab behind slow inference', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    const indexer = createIndexer(async () => {
      if (first) {
        first = false;
        started.resolve();
        await release.promise;
      }
      return new Float32Array([1, 0]);
    });
    await indexer.initialize();
    const slow = indexer.indexTabContent(7);
    await started.promise;
    try {
      await indexer.indexTabContent(8);
      expect([...new Set(state.documents.map(({ tabId }) => tabId))]).toEqual([8]);
    } finally {
      release.resolve();
      await slow;
    }
    expect([...new Set(state.documents.map(({ tabId }) => tabId))].sort()).toEqual([7, 8]);
  });
});
