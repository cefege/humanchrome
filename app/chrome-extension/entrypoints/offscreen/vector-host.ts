/**
 * Offscreen counterpart of `utils/indexer-rpc.ts`. See that file for the
 * architectural rationale. SW callers MUST go through the RPC client —
 * never construct a ContentIndexer outside the offscreen page.
 */
import { getGlobalContentIndexer } from '@/utils/content-indexer';
import { clearAllVectorData } from '@/utils/vector-database';
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

interface IndexerHostMessage {
  target?: string;
  type: string;
  query?: string;
  topK?: number;
  tabId?: number;
}

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
): boolean {
  if (!message || typeof message.type !== 'string') return false;
  if (!INDEXER_MESSAGE_TYPES.has(message.type)) return false;

  dispatchIndexerCall(message)
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

async function dispatchIndexerCall(message: IndexerHostMessage): Promise<unknown> {
  const indexer = getGlobalContentIndexer();

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

    default:
      throw new Error(`Unknown indexer message type: ${message.type}`);
  }
}
