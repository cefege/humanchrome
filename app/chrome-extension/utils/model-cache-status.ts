// Model-cache status helpers extracted from `semantic-similarity-engine.ts`.
//
// The engine module statically imports SIMDMathEngine and dynamically loads
// `@huggingface/transformers` + `onnxruntime-web` (~1.2 MB combined). The
// background service worker only needs the tiny IndexedDB-backed status
// helpers, so it must NOT pull in that heavy graph. This file is kept
// intentionally small — it depends on `ModelCacheManager` (pure IndexedDB)
// only, so the SW chunk no longer drags transformers/onnxruntime in.
//
// See IMP-0055.
import { ModelCacheManager } from './model-cache-manager';

/**
 * Manually trigger cache cleanup (removes expired entries).
 */
export async function cleanupModelCache(): Promise<void> {
  try {
    const cacheManager = ModelCacheManager.getInstance();
    await cacheManager.manualCleanup();
  } catch (error) {
    console.error('Failed to cleanup cache:', error);
    throw error;
  }
}

/**
 * Check if any model cache exists (used to gate engine init at SW startup
 * so we don't kick off a model download for a user who hasn't opted in).
 *
 * @returns Promise<boolean> True if any valid model cache exists.
 */
export async function hasAnyModelCache(): Promise<boolean> {
  try {
    const cacheManager = ModelCacheManager.getInstance();
    return await cacheManager.hasAnyValidCache();
  } catch (error) {
    console.error('Error checking for any model cache:', error);
    return false;
  }
}
