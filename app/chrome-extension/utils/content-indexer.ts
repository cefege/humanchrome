/**
 * Content index manager
 * Responsible for automatically extracting, chunking and indexing tab content
 */

import { semanticPolicy } from 'humanchrome-shared';
import { VectorDatabase, clearAllVectorData, getGlobalVectorDatabase } from './vector-database';
import type { SemanticSimilarityEngine } from './semantic-similarity-engine';
import {
  PREDEFINED_MODELS,
  type ModelPreset,
} from './semantic-similarity/model-registry';
import { INDEXER_HOST_MESSAGES } from '@/common/content-indexer-messages';

export interface IndexingOptions {
  autoIndex?: boolean;
  maxChunksPerPage?: number;
  skipDuplicates?: boolean;
}

interface ChromeTab {
  url?: string;
  title?: string;
}

interface TabUpdate {
  status?: string;
}

interface NavigationCommit {
  frameId: number;
  tabId: number;
}

export class ContentIndexer {
  private vectorDatabase!: VectorDatabase;
  private isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;
  private readonly options: Required<IndexingOptions>;

  constructor(
    private readonly getSemanticEngine: () => SemanticSimilarityEngine | null,
    options?: IndexingOptions,
  ) {
    this.options = {
      autoIndex: true,
      maxChunksPerPage: 50,
      skipDuplicates: true,
      ...options,
    };
  }

  /**
   * Get current selected model configuration
   */
  private async getCurrentModelConfig() {
    try {
      const result = await this.requestHost<{
        selectedModel?: ModelPreset;
        selectedVersion?: 'full' | 'quantized' | 'compressed';
      }>(INDEXER_HOST_MESSAGES.GET_MODEL_SETTINGS);
      const selectedModel = result.selectedModel || 'multilingual-e5-small';
      const selectedVersion = result.selectedVersion || 'quantized';

      const modelInfo = PREDEFINED_MODELS[selectedModel];

      return {
        modelPreset: selectedModel,
        modelIdentifier: modelInfo.modelIdentifier,
        dimension: modelInfo.dimension,
        modelVersion: selectedVersion,
        useLocalFiles: false,
        maxLength: 256,
        cacheSize: 1000,
        forceOffscreen: true,
      };
    } catch (error) {
      console.error('ContentIndexer: Failed to get current model config, using default:', error);
      return {
        modelPreset: 'multilingual-e5-small' as const,
        modelIdentifier: 'Xenova/multilingual-e5-small',
        dimension: 384,
        modelVersion: 'quantized' as const,
        useLocalFiles: false,
        maxLength: 256,
        cacheSize: 1000,
        forceOffscreen: true,
      };
    }
  }

  private async requestHost<T>(
    type: (typeof INDEXER_HOST_MESSAGES)[keyof typeof INDEXER_HOST_MESSAGES],
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const response = (await chrome.runtime.sendMessage({
      target: 'background',
      type,
      ...payload,
    })) as { success?: boolean; result?: T; error?: string } | undefined;

    if (!response?.success) {
      throw new Error(response?.error || `ContentIndexer host request failed: ${type}`);
    }

    return response.result as T;
  }

  /**
   * Initialize content indexer
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitialize().finally(() => {
      this.isInitializing = false;
    });

    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      const engineConfig = await this.getCurrentModelConfig();
      if (!this.isSemanticEngineReady()) {
        throw new Error('Semantic engine is not ready yet. Please initialize the semantic engine first.');
      }

      this.vectorDatabase = await getGlobalVectorDatabase({
        dimension: engineConfig.dimension,
        efSearch: 50,
      });
      await this.vectorDatabase.initialize();

      this.isInitialized = true;
    } catch (error) {
      console.error('ContentIndexer: Initialization failed:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Index content of specified tab
   */
  public async indexTabContent(tabId: number): Promise<void> {
    // Check if semantic engine is ready before attempting to index
    if (!this.isSemanticEngineReady() && !this.isSemanticEngineInitializing()) {
      console.log(
        `ContentIndexer: Skipping tab ${tabId} - semantic engine not ready and not initializing`,
      );
      return;
    }

    if (!this.isInitialized) {
      // Only initialize if semantic engine is already ready
      if (!this.isSemanticEngineReady()) {
        console.log(
          `ContentIndexer: Skipping tab ${tabId} - ContentIndexer not initialized and semantic engine not ready`,
        );
        return;
      }
      await this.initialize();
    }

    try {
      const tab = await this.requestHost<ChromeTab>(INDEXER_HOST_MESSAGES.GET_TAB, { tabId });
      if (!tab.url || !semanticPolicy.isSemanticIndexableContentUrl(tab.url)) {
        console.log(`ContentIndexer: Skipping tab ${tabId} - URL not indexable`);
        return;
      }

      const title = tab.title || '';
      if (this.options.skipDuplicates && this.vectorDatabase.hasIndexedPage(tab.url, title)) {
        console.log(`ContentIndexer: Skipping tab ${tabId} - already indexed`);
        return;
      }

      console.log(`ContentIndexer: Starting to index tab ${tabId}: ${tab.title}`);

      const content = await this.extractTabContent(tabId);
      if (!content) {
        console.log(`ContentIndexer: No content extracted from tab ${tabId}`);
        return;
      }

      const chunks = semanticPolicy.semanticChunksForIndexing(
        content.textContent,
        this.options.maxChunksPerPage,
        content.title,
      );
      console.log(`ContentIndexer: Generated ${chunks.length} chunks for tab ${tabId}`);

      const engine = this.getSemanticEngine();
      if (!engine?.isInitialized) {
        throw new Error('Semantic engine is not ready yet. Please initialize the semantic engine first.');
      }

      for (const chunk of chunks) {
        try {
          const embedding = await engine.getEmbedding(chunk.text);
          const label = await this.vectorDatabase.addDocument(tabId, tab.url, title, chunk, embedding);
          console.log(`ContentIndexer: Indexed chunk ${chunk.index} with label ${label}`);
        } catch (error) {
          console.error(`ContentIndexer: Failed to index chunk ${chunk.index}:`, error);
        }
      }

      this.vectorDatabase.markIndexedPage(tab.url, title);

      console.log(
        `ContentIndexer: Successfully indexed ${chunks.length} chunks for tab ${tabId}`,
      );
    } catch (error) {
      console.error(`ContentIndexer: Failed to index tab ${tabId}:`, error);
    }
  }

  /**
   * Search content
   */
  public async searchContent(query: string, topK: number = 10) {
    // Check if semantic engine is ready before attempting to search
    if (!this.isSemanticEngineReady() && !this.isSemanticEngineInitializing()) {
      throw new Error(
        'Semantic engine is not ready yet. Please initialize the semantic engine first.',
      );
    }

    if (!this.isInitialized) {
      // Only initialize if semantic engine is already ready
      if (!this.isSemanticEngineReady()) {
        throw new Error(
          'ContentIndexer not initialized and semantic engine not ready. Please initialize the semantic engine first.',
        );
      }
      await this.initialize();
    }

    try {
      const engine = this.getSemanticEngine();
      if (!engine?.isInitialized) {
        throw new Error('Semantic engine is not ready yet. Please initialize the semantic engine first.');
      }
      const queryEmbedding = await engine.getEmbedding(query);
      const results = await this.vectorDatabase.search(queryEmbedding, topK);

      console.log(`ContentIndexer: Found ${results.length} results for query: "${query}"`);
      return results;
    } catch (error) {
      console.error('ContentIndexer: Search failed:', error);
      throw error;
    }
  }

  /**
   * Remove tab index
   */
  public async removeTabIndex(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      await this.vectorDatabase.removeTabDocuments(tabId);

      console.log(`ContentIndexer: Removed index for tab ${tabId}`);
    } catch (error) {
      console.error(`ContentIndexer: Failed to remove index for tab ${tabId}:`, error);
    }
  }

  /**
   * Check if semantic engine is ready in this offscreen document.
   */
  public isSemanticEngineReady(): boolean {
    return this.getSemanticEngine()?.isInitialized ?? false;
  }

  /**
   * Check if semantic engine is initializing.
   */
  public isSemanticEngineInitializing(): boolean {
    return this.isInitializing;
  }

  /**
   * Reinitialize content indexer (for model switching)
   */
  public async reinitialize(): Promise<void> {
    console.log('ContentIndexer: Reinitializing for model switch...');

    this.isInitialized = false;
    this.isInitializing = false;
    this.initPromise = null;

    await this.performCompleteDataCleanupForModelSwitch();

    if (!this.isSemanticEngineReady()) {
      throw new Error('Semantic engine is not ready yet. Please initialize the semantic engine first.');
    }

    await this.initialize();

    console.log('ContentIndexer: Reinitialization completed successfully');
  }

  /**
   * Perform complete data cleanup for model switching
   */
  private async performCompleteDataCleanupForModelSwitch(): Promise<void> {
    console.log('ContentIndexer: Starting complete data cleanup for model switch...');
    try {
      await clearAllVectorData();
      console.log('ContentIndexer: Complete data cleanup for model switch finished successfully');
    } catch (error) {
      console.error('ContentIndexer: Complete data cleanup for model switch failed:', error);
      throw error;
    }
  }

  /**
   * Start indexer initialization once the local offscreen engine is ready.
   */
  public startSemanticEngineInitialization(): void {
    if (!this.isInitialized && !this.isInitializing) {
      if (!this.isSemanticEngineReady()) {
        console.log('ContentIndexer: Semantic engine not ready, skipping initialization');
        return;
      }

      console.log('ContentIndexer: Starting initialization (semantic engine ready)...');
      this.initialize().catch((error) => {
        console.error('ContentIndexer: Background initialization failed:', error);
      });
    }
  }

  /**
   * Get indexing statistics
   */
  public getStats() {
    const vectorStats = this.vectorDatabase
      ? this.vectorDatabase.getStats()
      : {
          totalDocuments: 0,
          totalTabs: 0,
          indexSize: 0,
        };

    return {
      ...vectorStats,
      indexedPages: this.vectorDatabase?.indexedPageCount() ?? 0,
      isInitialized: this.isInitialized,
      semanticEngineReady: this.isSemanticEngineReady(),
      semanticEngineInitializing: this.isSemanticEngineInitializing(),
    };
  }

  /**
   * Clear all indexes
   */
  public async clearAllIndexes(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      await this.vectorDatabase.clear();
      this.vectorDatabase.clearIndexedPages();
      console.log('ContentIndexer: All indexes cleared');
    } catch (error) {
      console.error('ContentIndexer: Failed to clear indexes:', error);
    }
  }

  public handleTabUpdated(
    tabId: number,
    changeInfo: TabUpdate,
    tab: ChromeTab,
  ): void {
    if (
      !this.isInitialized ||
      !this.options.autoIndex ||
      changeInfo.status !== 'complete' ||
      !tab.url
    ) {
      return;
    }

    setTimeout(() => {
      if (!this.isSemanticEngineReady() && !this.isSemanticEngineInitializing()) {
        console.log(
          `ContentIndexer: Skipping auto-index for tab ${tabId} - semantic engine not ready`,
        );
        return;
      }

      this.indexTabContent(tabId).catch((error) => {
        console.error(`ContentIndexer: Auto-indexing failed for tab ${tabId}:`, error);
      });
    }, 2000);
  }

  public async handleTabRemoved(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      return;
    }
    await this.removeTabIndex(tabId);
  }

  public async handleNavigationCommitted(details: NavigationCommit): Promise<void> {
    if (!this.isInitialized || details.frameId !== 0) {
      return;
    }
    await this.removeTabIndex(details.tabId);
  }

  private async extractTabContent(
    tabId: number,
  ): Promise<{ textContent: string; title: string } | null> {
    try {
      return await this.requestHost<{ textContent: string; title: string } | null>(
        INDEXER_HOST_MESSAGES.EXTRACT_TAB_CONTENT,
        { tabId },
      );
    } catch (error) {
      console.error(`ContentIndexer: Error extracting content from tab ${tabId}:`, error);
      return null;
    }
  }
}

let globalContentIndexer: ContentIndexer | null = null;

/**
 * Get global ContentIndexer instance
 */
export function getGlobalContentIndexer(
  getSemanticEngine: () => SemanticSimilarityEngine | null,
): ContentIndexer {
  if (!globalContentIndexer) {
    globalContentIndexer = new ContentIndexer(getSemanticEngine);
  }
  return globalContentIndexer;
}
