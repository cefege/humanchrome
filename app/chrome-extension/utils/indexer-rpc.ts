/**
 * Indexer RPC shim (IMP-0122).
 *
 * The `ContentIndexer` graph pulls `@huggingface/transformers` +
 * `onnxruntime-web` + `hnswlib-wasm-static` (~1.2 MB). We can't import it
 * statically into the SW (boot regression) and we can't `await import()`
 * it from the SW either — Chrome rejects dynamic `import()` of new module
 * chunks from a ServiceWorkerGlobalScope (https://github.com/w3c/ServiceWorker/issues/1356).
 *
 * Fix: the indexer lives in the offscreen document (which has a DOM and
 * can `import()` freely). SW callers (vector-search tool, storage-
 * manager, semantic-similarity hooks) speak to it via
 * `chrome.runtime.sendMessage`. This module is the typed client.
 *
 * Pre-IMP-0122 these call sites did `await import('@/utils/content-indexer')`
 * directly from the SW and crashed at runtime. Replace each one with
 * `indexerRpc.<method>(...)`.
 */
import { OffscreenManager } from './offscreen-manager';
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import type { SearchResult } from './vector-database';

export interface IndexerStats {
  totalDocuments: number;
  totalTabs: number;
  indexSize: number;
  indexedPages: number;
  isInitialized: boolean;
  semanticEngineReady: boolean;
  semanticEngineInitializing: boolean;
}

export interface IndexerStatus {
  isInitialized: boolean;
  isInitializing: boolean;
  semanticEngineReady: boolean;
  semanticEngineInitializing: boolean;
}

interface OffscreenResponse<T = unknown> {
  success?: boolean;
  error?: string;
  result?: T;
}

type OffscreenMessageType =
  (typeof OFFSCREEN_MESSAGE_TYPES)[keyof typeof OFFSCREEN_MESSAGE_TYPES];

interface OffscreenMessage {
  target: 'offscreen';
  type: OffscreenMessageType;
  [k: string]: unknown;
}

/**
 * Send a message to the offscreen indexer and unwrap the response envelope.
 *
 * The offscreen page must exist before any indexer call — we always
 * ensure it via `OffscreenManager.ensureOffscreenDocument()` first so SW
 * callers don't need to know the lifecycle. Errors from the offscreen
 * page are surfaced as thrown Errors so the calling tool can map them to
 * the standard error envelope.
 */
async function send<T>(message: OffscreenMessage): Promise<T> {
  await OffscreenManager.getInstance().ensureOffscreenDocument();
  const response = (await chrome.runtime.sendMessage(message)) as
    | OffscreenResponse<T>
    | undefined;
  if (!response) {
    throw new Error('No response received from offscreen indexer');
  }
  if (!response.success) {
    throw new Error(response.error || 'Offscreen indexer call failed');
  }
  return response.result as T;
}

export const indexerRpc = {
  /** Mirrors `ContentIndexer.searchContent(query, topK)`. */
  async searchContent(query: string, topK: number = 10): Promise<SearchResult[]> {
    return send<SearchResult[]>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH,
      query,
      topK,
    });
  },

  /** Mirrors `ContentIndexer.getStats()`. */
  async getStats(): Promise<IndexerStats> {
    return send<IndexerStats>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATS,
    });
  },

  /** Quick readiness check (no init side-effects). */
  async getStatus(): Promise<IndexerStatus> {
    return send<IndexerStatus>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATUS,
    });
  },

  /** Mirrors `ContentIndexer.clearAllIndexes()`. */
  async clearAllIndexes(): Promise<void> {
    await send<void>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_ALL,
    });
  },

  /** Mirrors `clearAllVectorData()` from `utils/vector-database`. */
  async clearVectorData(): Promise<void> {
    await send<void>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_VECTOR_DATA,
    });
  },

  /** Mirrors `ContentIndexer.indexTabContent(tabId)`. */
  async indexTab(tabId: number): Promise<void> {
    await send<void>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_INDEX_TAB,
      tabId,
    });
  },

  /** Mirrors `ContentIndexer.removeTabIndex(tabId)`. */
  async removeTabIndex(tabId: number): Promise<void> {
    await send<void>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REMOVE_TAB,
      tabId,
    });
  },

  /** Mirrors `ContentIndexer.reinitialize()`. */
  async reinitialize(): Promise<void> {
    await send<void>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REINITIALIZE,
    });
  },

  /** Mirrors `ContentIndexer.startSemanticEngineInitialization()`. */
  async startSemanticEngineInitialization(): Promise<void> {
    await send<void>({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_START_INIT,
    });
  },
};

/** Test-only seam for swapping out the underlying chrome.runtime.sendMessage. */
export const _internals = { send };
