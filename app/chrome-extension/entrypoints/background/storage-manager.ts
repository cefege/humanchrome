import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { indexerRpc } from '@/utils/indexer-rpc';

/**
 * Get storage statistics.
 *
 * Pre-IMP-0122 this did `await import('@/utils/content-indexer')` from
 * the SW and crashed on Chrome's dynamic-`import()` ban. The indexer now
 * lives in the offscreen page; we go through the RPC shim.
 */
export async function handleGetStorageStats(): Promise<{
  success: boolean;
  stats?: any;
  error?: string;
}> {
  try {
    const stats = await indexerRpc.getStats();

    return {
      success: true,
      stats: {
        indexedPages: stats.indexedPages || 0,
        totalDocuments: stats.totalDocuments || 0,
        totalTabs: stats.totalTabs || 0,
        indexSize: stats.indexSize || 0,
        isInitialized: stats.isInitialized || false,
        semanticEngineReady: stats.semanticEngineReady || false,
        semanticEngineInitializing: stats.semanticEngineInitializing || false,
      },
    };
  } catch (error: any) {
    console.error('Background: Failed to get storage stats:', error);
    return {
      success: false,
      error: error?.message ?? String(error),
      stats: {
        indexedPages: 0,
        totalDocuments: 0,
        totalTabs: 0,
        indexSize: 0,
        isInitialized: false,
        semanticEngineReady: false,
        semanticEngineInitializing: false,
      },
    };
  }
}

/**
 * Clear all data — indexer state, vector data, and chrome.storage caches.
 *
 * Each cleanup branch is best-effort; we continue past failures so a
 * stuck indexer doesn't prevent us from clearing the vector DB and
 * chrome.storage entries (and vice versa).
 */
export async function handleClearAllData(): Promise<{ success: boolean; error?: string }> {
  try {
    // 1. ContentIndexer indexes (RPC to offscreen).
    try {
      await indexerRpc.clearAllIndexes();
      console.log('Storage: ContentIndexer indexes cleared successfully');
    } catch (indexerError) {
      console.warn('Background: Failed to clear ContentIndexer indexes:', indexerError);
    }

    // 2. VectorDatabase data — dispatched to offscreen because the
    // `hnswlib-wasm-static` import in `utils/vector-database` would
    // otherwise drag the WASM loader into the SW bundle. The offscreen
    // helper already owns that graph (it's where the indexer lives).
    try {
      await indexerRpc.clearVectorData();
      console.log('Storage: Vector database data cleared successfully');
    } catch (vectorError) {
      console.warn('Background: Failed to clear vector data:', vectorError);
    }

    // 3. Chrome.storage caches (preserve model preferences).
    try {
      const keysToRemove = ['vectorDatabaseStats', 'lastCleanupTime', 'contentIndexerStats'];
      await chrome.storage.local.remove(keysToRemove);
      console.log('Storage: Chrome storage data cleared successfully');
    } catch (storageError) {
      console.warn('Background: Failed to clear chrome storage data:', storageError);
    }

    return { success: true };
  } catch (error: any) {
    console.error('Background: Failed to clear all data:', error);
    return { success: false, error: error?.message ?? String(error) };
  }
}

/**
 * Initialize storage manager module message listeners.
 */
export const initStorageManagerListener = () => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS) {
      handleGetStorageStats()
        .then((result: { success: boolean; stats?: any; error?: string }) => sendResponse(result))
        .catch((error: any) => sendResponse({ success: false, error: error.message }));
      return true;
    } else if (message.type === BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA) {
      handleClearAllData()
        .then((result: { success: boolean; error?: string }) => sendResponse(result))
        .catch((error: any) => sendResponse({ success: false, error: error.message }));
      return true;
    }
  });
};
