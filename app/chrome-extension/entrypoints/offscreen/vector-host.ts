/**
 * Offscreen counterpart of `utils/indexer-rpc.ts`. See that file for the
 * architectural rationale. SW callers MUST go through the RPC client —
 * never construct a ContentIndexer outside the offscreen page.
 */
import { getGlobalContentIndexer } from '@/utils/content-indexer';
import type { SemanticSimilarityEngine } from '@/utils/semantic-similarity-engine';
import { clearAllVectorData } from '@/utils/vector-database';
import { INDEXER_HOST_MESSAGES } from '@/common/content-indexer-messages';
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { ensureRustKernel } from '@/shared/rust-kernel';

interface IndexerHostMessage {
  target?: string;
  type: string;
  query?: string;
  topK?: number;
  tabId?: number;
  changeInfo?: { status?: string };
  tab?: chrome.tabs.Tab;
  details?: { frameId: number; tabId: number };
}

type SemanticEngineGetter = () => SemanticSimilarityEngine | null;

type IndexerHostResponse = {
  success: boolean;
  error?: string;
  result?: unknown;
};

const INDEXER_MESSAGE_TYPES = new Set<string>([
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH,
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATS,
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_ALL,
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_VECTOR_DATA,
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_INDEX_TAB,
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REMOVE_TAB,
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REINITIALIZE,
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_START_INIT,
  OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATUS,
  INDEXER_HOST_MESSAGES.TAB_UPDATED,
  INDEXER_HOST_MESSAGES.TAB_REMOVED,
  INDEXER_HOST_MESSAGES.NAVIGATION_COMMITTED,
]);

/**
 * Returns true if the message was an indexer RPC and we've taken
 * responsibility for replying. The caller (offscreen/main.ts) should
 * return `true` from the `onMessage` listener so Chrome keeps the
 * channel open for the async sendResponse.
 */
export function handleIndexerMessage(
  message: IndexerHostMessage,
  sendResponse: (response: IndexerHostResponse) => void,
  getSemanticEngine: SemanticEngineGetter,
): boolean {
  if (!message || typeof message.type !== 'string') return false;
  if (!INDEXER_MESSAGE_TYPES.has(message.type)) return false;

  dispatchIndexerCall(message, getSemanticEngine)
    .then((result) => sendResponse({ success: true, result }))
    .catch((err) =>
      sendResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

  return true;
}

function requireTabId(message: IndexerHostMessage, label: string): number {
  if (typeof message.tabId !== 'number') {
    throw new Error(`${label}: [tabId] must be a number`);
  }
  return message.tabId;
}

async function dispatchIndexerCall(
  message: IndexerHostMessage,
  getSemanticEngine: SemanticEngineGetter,
): Promise<unknown> {
  await ensureRustKernel();
  const indexer = getGlobalContentIndexer(getSemanticEngine);

  switch (message.type) {
    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_SEARCH: {
      const query = typeof message.query === 'string' ? message.query : '';
      const topK = typeof message.topK === 'number' ? message.topK : 10;
      return await indexer.searchContent(query, topK);
    }

    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATS: {
      return indexer.getStats();
    }

    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_STATUS: {
      return {
        isInitialized: indexer.getStats().isInitialized,
        isInitializing: indexer.isSemanticEngineInitializing(),
        semanticEngineReady: indexer.isSemanticEngineReady(),
        semanticEngineInitializing: indexer.isSemanticEngineInitializing(),
      };
    }

    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_ALL: {
      await indexer.clearAllIndexes();
      return undefined;
    }

    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_CLEAR_VECTOR_DATA: {
      // Wipe the on-disk hnswlib + IndexedDB state. Runs even if the
      // indexer hasn't been booted (no isInitialized guard) because the
      // user may be triggering a model-reset before the engine ever ran.
      await clearAllVectorData();
      return undefined;
    }

    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_INDEX_TAB: {
      await indexer.indexTabContent(requireTabId(message, 'CONTENT_INDEXER_INDEX_TAB'));
      return undefined;
    }

    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REMOVE_TAB: {
      await indexer.removeTabIndex(requireTabId(message, 'CONTENT_INDEXER_REMOVE_TAB'));
      return undefined;
    }

    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_REINITIALIZE: {
      await indexer.reinitialize();
      return undefined;
    }

    case OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_START_INIT: {
      indexer.startSemanticEngineInitialization();
      return undefined;
    }

    case INDEXER_HOST_MESSAGES.TAB_UPDATED: {
      const tabId = requireTabId(message, 'TAB_UPDATED');
      if (!message.changeInfo || !message.tab) {
        throw new Error('TAB_UPDATED: [changeInfo] and [tab] are required');
      }
      indexer.handleTabUpdated(tabId, message.changeInfo, message.tab);
      return undefined;
    }

    case INDEXER_HOST_MESSAGES.TAB_REMOVED: {
      await indexer.handleTabRemoved(requireTabId(message, 'TAB_REMOVED'));
      return undefined;
    }

    case INDEXER_HOST_MESSAGES.NAVIGATION_COMMITTED: {
      if (!message.details) {
        throw new Error('NAVIGATION_COMMITTED: [details] is required');
      }
      await indexer.handleNavigationCommitted(message.details);
      return undefined;
    }

    default:
      throw new Error(`Unknown indexer message type: ${message.type}`);
  }
}
