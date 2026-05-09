import { initNativeHostListener } from './native-host';
import {
  initSemanticSimilarityListener,
  initializeSemanticEngineIfCached,
} from './semantic-similarity';
import { initStorageManagerListener } from './storage-manager';
import { cleanupModelCache } from '@/utils/model-cache-status';
import { initRecordReplayListeners } from './record-replay';
import { initElementMarkerListeners } from './element-marker';
import { initWebEditorListeners } from './web-editor';
import { initQuickPanelAgentHandler } from './quick-panel/agent-handler';
import { initQuickPanelCommands } from './quick-panel/commands';
import { initQuickPanelTabsHandler } from './quick-panel/tabs-handler';
import { initLastTabGuardListeners } from '@/utils/last-tab-guard';
import { initTabCreationTracker } from './utils/tab-creation-tracker';

// Record-Replay V3 (feature flag)
import { bootstrapV3 } from './record-replay-v3/bootstrap';

/**
 * Feature flag for RR-V3
 * Set to true to enable the new Record-Replay V3 engine
 */
const ENABLE_RR_V3 = true;

/**
 * Background script entry point
 * Initializes all background services and listeners
 *
 * `type: 'module'` makes the SW an ESM script, which lets Rolldown emit the
 * dynamic-import targets (e.g. `await import('@/utils/content-indexer')` in
 * `tools/browser/vector-search.ts`, `await import('@/utils/vector-database')`
 * in `storage-manager.ts`) as separate chunks instead of inlining them into
 * `background.js`. Without this, WXT compiles the SW as a classic IIFE and
 * Rolldown's `inlineDynamicImports` pass collapses the entire reachable graph
 * — including `@huggingface/transformers` (~700 KB) and `onnxruntime-web`
 * (~500 KB) — into the SW chunk regardless of dynamic-import sites in source.
 * See IMP-0057.
 */
export default defineBackground({
  type: 'module',
  main: () => {
    // Open welcome page on first install
    chrome.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install') {
        // Open the welcome/onboarding page for new installations
        chrome.tabs.create({
          url: chrome.runtime.getURL('/welcome.html'),
        });
      }
    });

    // Initialize core services
    initNativeHostListener();
    initSemanticSimilarityListener();
    initStorageManagerListener();
    // Last-tab guard: keep windows alive when tools close the last tab
    initLastTabGuardListeners();
    initTabCreationTracker();
    // Record & Replay V1/V2 listeners
    initRecordReplayListeners();

    // Record & Replay V3 (new engine)
    if (ENABLE_RR_V3) {
      bootstrapV3()
        .then((runtime) => {
          console.log(`[RR-V3] Bootstrap complete, ownerId: ${runtime.ownerId}`);
        })
        .catch((error) => {
          console.error('[RR-V3] Bootstrap failed:', error);
        });
    }

    // Element marker: context menu + CRUD listeners
    initElementMarkerListeners();
    // Web editor: toggle edit-mode overlay
    initWebEditorListeners();
    // Quick Panel: send messages to AgentChat via background-stream bridge
    initQuickPanelAgentHandler();
    // Quick Panel: tabs search bridge for content script UI
    initQuickPanelTabsHandler();
    // Quick Panel: keyboard shortcut handler
    initQuickPanelCommands();

    // Conditionally initialize semantic similarity engine if model cache exists
    initializeSemanticEngineIfCached()
      .then((initialized) => {
        if (initialized) {
          console.log('Background: Semantic similarity engine initialized from cache');
        } else {
          console.log(
            'Background: Semantic similarity engine initialization skipped (no cache found)',
          );
        }
      })
      .catch((error) => {
        console.warn('Background: Failed to conditionally initialize semantic engine:', error);
      });

    // Initial cleanup on startup
    cleanupModelCache().catch((error) => {
      console.warn('Background: Initial cache cleanup failed:', error);
    });
  },
});
