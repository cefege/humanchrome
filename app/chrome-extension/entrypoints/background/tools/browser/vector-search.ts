/**
 * Vectorized tab content search tool — thin RPC shim over the offscreen
 * indexer (utils/indexer-rpc.ts). The ~1.2 MB ML graph lives in the
 * offscreen document because Chrome forbids dynamic import() of new
 * module chunks from a ServiceWorkerGlobalScope
 * (https://github.com/w3c/ServiceWorker/issues/1356).
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';
import { ERROR_MESSAGES } from '@/common/constants';
import { indexerRpc } from '@/utils/indexer-rpc';
import type { SearchResult } from '@/utils/vector-database';
import { withSuggestedNext } from './_common';

// IMP-0186: matches name tabs the LLM might want to focus or navigate to.
const SEARCH_TABS_NEXT = ['chrome_switch_tab', 'chrome_navigate', 'chrome_read_page'] as const;

interface VectorSearchResult {
  tabId: number;
  url: string;
  title: string;
  semanticScore: number;
  matchedSnippet: string;
  chunkSource: string;
  timestamp: number;
}

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

      // Execute vector search, get more results for deduplication.
      const searchResults = await indexerRpc.searchContent(query, 50);

      const vectorSearchResults = this.convertSearchResults(searchResults);
      const deduplicatedResults = this.deduplicateByTab(vectorSearchResults);
      const topResults = deduplicatedResults
        .sort((a, b) => b.semanticScore - a.semanticScore)
        .slice(0, 10);

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

  /** Convert offscreen `SearchResult` -> tool-shape result. */
  private convertSearchResults(searchResults: SearchResult[]): VectorSearchResult[] {
    return searchResults.map((result) => ({
      tabId: result.document.tabId,
      url: result.document.url,
      title: result.document.title,
      semanticScore: result.similarity,
      matchedSnippet: this.extractSnippet(result.document.chunk.text),
      chunkSource: result.document.chunk.source,
      timestamp: result.document.timestamp,
    }));
  }

  /** Keep only the top-scoring fragment per tab. */
  private deduplicateByTab(results: VectorSearchResult[]): VectorSearchResult[] {
    const tabMap = new Map<number, VectorSearchResult>();

    for (const result of results) {
      const existing = tabMap.get(result.tabId);
      if (!existing || result.semanticScore > existing.semanticScore) {
        tabMap.set(result.tabId, result);
      }
    }

    return Array.from(tabMap.values());
  }

  /** Pick a readable preview snippet, preferring sentence boundaries. */
  private extractSnippet(text: string, maxLength: number = 200): string {
    if (text.length <= maxLength) return text;

    const truncated = text.substring(0, maxLength);
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?'),
      truncated.lastIndexOf('。'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?'),
    );

    if (lastSentenceEnd > maxLength * 0.7) {
      return truncated.substring(0, lastSentenceEnd + 1);
    }

    const lastSpaceIndex = truncated.lastIndexOf(' ');
    if (lastSpaceIndex > maxLength * 0.8) {
      return truncated.substring(0, lastSpaceIndex) + '...';
    }

    return truncated + '...';
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
        (tab) =>
          tab.id &&
          tab.url &&
          !tab.url.startsWith('chrome://') &&
          !tab.url.startsWith('chrome-extension://') &&
          !tab.url.startsWith('edge://') &&
          !tab.url.startsWith('about:'),
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
