/**
 * Vectorized tab content search tool — thin RPC shim over the offscreen
 * indexer (utils/indexer-rpc.ts). The ~1.2 MB ML graph lives in the
 * offscreen document because Chrome forbids dynamic import() of new
 * module chunks from a ServiceWorkerGlobalScope
 * (https://github.com/w3c/ServiceWorker/issues/1356).
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { semanticPolicy, TOOL_NAMES } from 'humanchrome-shared';
import { ERROR_MESSAGES } from '@/common/constants';
import { indexerRpc } from '@/utils/indexer-rpc';
import { withSuggestedNext } from './_common';

// Result rows name tabs the LLM might want to focus or navigate to.
const SEARCH_TABS_NEXT = ['chrome_switch_tab', 'chrome_navigate', 'chrome_read_page'] as const;

/**
 * Tool for vectorized search of tab content using semantic similarity.
 */
class VectorSearchTabsContentTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT;

  async execute(args: { query: string }): Promise<ToolResult> {
    try {
      const { query } = args;

      if (!query || query.trim().length === 0) {
        return createErrorResponse(
          ERROR_MESSAGES.INVALID_PARAMETERS + ': Query parameter is required and cannot be empty',
        );
      }

      console.log(`VectorSearchTabsContentTool: Starting vector search with query: "${query}"`);

      // Check engine status via offscreen — if it's still booting, surface
      // the same "please retry" error the old code path used.
      let status;
      try {
        status = await indexerRpc.getStatus();
      } catch (statusError) {
        return createErrorResponse(
          `Vector search failed: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
        );
      }

      if (!status.semanticEngineReady) {
        if (status.semanticEngineInitializing) {
          return createErrorResponse(
            'Vector search engine is still initializing (model downloading). Please wait a moment and try again.',
          );
        }
        // Kick off init; caller can retry on next tick.
        try {
          await indexerRpc.startSemanticEngineInitialization();
        } catch {
          // best-effort
        }
        return createErrorResponse('Failed to initialize vector search engine');
      }

      // The offscreen semantic index owns top-50 candidate retrieval, per-tab collapse,
      // stable ranking, snippet extraction, and the top-ten response cap.
      const topResults = await indexerRpc.searchContent(query);

      const stats = await indexerRpc.getStats();

      const result = {
        success: true,
        totalTabsSearched: stats.totalTabs,
        matchedTabsCount: topResults.length,
        vectorSearchEnabled: true,
        indexStats: {
          totalDocuments: stats.totalDocuments,
          totalTabs: stats.totalTabs,
          indexedPages: stats.indexedPages,
          semanticEngineReady: stats.semanticEngineReady,
          semanticEngineInitializing: stats.semanticEngineInitializing,
        },
        matchedTabs: topResults.map((r) => ({
          tabId: r.tabId,
          url: r.url,
          title: r.title,
          semanticScore: r.semanticScore,
          matchedSnippets: [r.matchedSnippet],
          chunkSource: r.chunkSource,
          timestamp: r.timestamp,
        })),
      };

      console.log(
        `VectorSearchTabsContentTool: Found ${topResults.length} results with vector search`,
      );

      return withSuggestedNext(
        {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: false,
        },
        SEARCH_TABS_NEXT,
      );
    } catch (error) {
      console.error('VectorSearchTabsContentTool: Search failed:', error);
      return createErrorResponse(
        `Vector search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }



  public async getIndexStats() {
    try {
      return await indexerRpc.getStats();
    } catch {
      return {
        totalDocuments: 0,
        totalTabs: 0,
        indexSize: 0,
        indexedPages: 0,
        isInitialized: false,
        semanticEngineReady: false,
        semanticEngineInitializing: false,
      };
    }
  }

  public async rebuildIndex(): Promise<void> {
    try {
      await indexerRpc.clearAllIndexes();

      const windows = await chrome.windows.getAll({ populate: true });
      const allTabs: chrome.tabs.Tab[] = [];

      for (const window of windows) {
        if (window.tabs) allTabs.push(...window.tabs);
      }

      const validTabs = allTabs.filter(
        (tab) => Boolean(tab.id && tab.url && semanticPolicy.isSemanticRebuildIndexableUrl(tab.url)),
      );

      await Promise.allSettled(
        validTabs.map((tab) => indexerRpc.indexTab(tab.id!).catch(() => undefined)),
      );

      console.log(`VectorSearchTabsContentTool: Rebuilt index for ${validTabs.length} tabs`);
    } catch (error) {
      console.error('VectorSearchTabsContentTool: Failed to rebuild index:', error);
      throw error;
    }
  }

  public async indexTab(tabId: number): Promise<void> {
    await indexerRpc.indexTab(tabId);
  }

  public async removeTabIndex(tabId: number): Promise<void> {
    await indexerRpc.removeTabIndex(tabId);
  }
}

export const vectorSearchTabsContentTool = new VectorSearchTabsContentTool();
