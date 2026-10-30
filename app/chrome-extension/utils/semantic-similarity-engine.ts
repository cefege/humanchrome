/**
 * Semantic similarity host for retained model and inference effects.
 *
 * Model registry data, transformer tokenization, ONNX worker transport, and the optional SIMD
 * adapter stay in this browser host. Rust owns cache eviction, batch planning, pooling,
 * normalization, and direct-worker similarity reconstruction after kernel readiness.
 *
 * Why dynamic `import('@huggingface/transformers')`: the library is ~3 MB
 * minified. Static import would pull it into every consumer (popup,
 * background, sidepanel) even though runtime use is offscreen-only.
 * Keep all transformers references behind `loadTransformers()` so the
 * heavy chunk loads on first engine init.
 *
 * Background callers must use the Proxy (postMessage to offscreen) — never
 * `new SemanticSimilarityEngine()` outside the offscreen entrypoint, or you
 * boot ONNX in a context that has no GPU/SIMD pinning and will crash.
 */
import type {
  AutoTokenizer as AutoTokenizerType,
  env as TransformersEnvType,
  Tensor as TransformersTensor,
  PreTrainedTokenizer,
} from '@huggingface/transformers';

type TransformersModule = {
  AutoTokenizer: typeof AutoTokenizerType;
  env: typeof TransformersEnvType;
};

let transformersModulePromise: Promise<TransformersModule> | null = null;

/** Lazily load `@huggingface/transformers`. Cached after first call. */
function loadTransformers(): Promise<TransformersModule> {
  if (!transformersModulePromise) {
    transformersModulePromise = import('@huggingface/transformers').then((mod) => ({
      AutoTokenizer: mod.AutoTokenizer,
      env: mod.env,
    }));
  }
  return transformersModulePromise;
}
import { semanticPolicy } from 'humanchrome-shared';
import LRUCache from './lru-cache';
import { SIMDMathEngine } from './simd-math-engine';
import { OffscreenManager } from './offscreen-manager';
import { INDEXER_HOST_MESSAGES } from '@/common/content-indexer-messages';
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

import { ModelCacheManager } from './model-cache-manager';

// Re-export the lightweight cache-status helpers from their new home so
// existing import sites (popup, etc.) keep working. The background service
// worker should import directly from `./model-cache-status` to avoid pulling
// the heavy transformers/onnxruntime graph through this module. See IMP-0055.
export { cleanupModelCache, hasAnyModelCache } from './model-cache-status';

/**
 * Get cached model data, prioritizing cache reads and handling redirected URLs.
 * @param {string} modelUrl Stable, permanent URL of the model
 * @returns {Promise<ArrayBuffer>} Model data as ArrayBuffer
 */
async function getCachedModelData(modelUrl: string): Promise<ArrayBuffer> {
  const cacheManager = ModelCacheManager.getInstance();

  const cachedData = await cacheManager.getCachedModelData(modelUrl);
  if (cachedData) {
    return cachedData;
  }

  console.log('Model not found in cache or expired. Fetching from network...');

  try {
    const response = await fetch(modelUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    await cacheManager.storeModelData(modelUrl, arrayBuffer);

    console.log(
      `Model fetched from network and successfully cached (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)}MB).`,
    );

    return arrayBuffer;
  } catch (error) {
    console.error(`Error fetching or caching model:`, error);
    // Drop any partial cache entry on failure.
    await cacheManager.deleteCacheEntry(modelUrl);
    throw error;
  }
}

/**
 * Clear all model cache entries
 */
export async function clearModelCache(): Promise<void> {
  try {
    const cacheManager = ModelCacheManager.getInstance();
    await cacheManager.clearAllCache();
  } catch (error) {
    console.error('Failed to clear model cache:', error);
    throw error;
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: Array<{
    url: string;
    size: number;
    sizeMB: number;
    timestamp: number;
    age: string;
    expired: boolean;
  }>;
}> {
  try {
    const cacheManager = ModelCacheManager.getInstance();
    return await cacheManager.getCacheStats();
  } catch (error) {
    console.error('Failed to get cache stats:', error);
    throw error;
  }
}

// `cleanupModelCache` lives in `./model-cache-status` and is re-exported above
// for back-compat. See IMP-0055.

function isModelPreset(value: unknown): value is ModelPreset {
  return typeof value === 'string' && value in PREDEFINED_MODELS;
}

/**
 * Check if the default model is cached and available
 * @returns Promise<boolean> True if default model is cached and valid
 */
export async function isDefaultModelCached(): Promise<boolean> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      target: 'background',
      type: INDEXER_HOST_MESSAGES.GET_MODEL_SETTINGS,
    });
    if (
      typeof response !== 'object' ||
      response === null ||
      !('success' in response) ||
      response.success !== true ||
      !('result' in response)
    ) {
      throw new Error('Unable to read semantic model settings from the background host');
    }

    const settings = response.result;
    const defaultModel =
      typeof settings === 'object' &&
      settings !== null &&
      'selectedModel' in settings &&
      isModelPreset(settings.selectedModel)
        ? settings.selectedModel
        : 'multilingual-e5-small';

    const modelInfo = PREDEFINED_MODELS[defaultModel];
    const modelIdentifier = modelInfo.modelIdentifier;
    const onnxModelFile = 'model.onnx';

    const modelIdParts = modelIdentifier.split('/');
    const modelNameForUrl = modelIdParts.length > 1 ? modelIdentifier : `Xenova/${modelIdentifier}`;
    const onnxModelUrl = `https://huggingface.co/${modelNameForUrl}/resolve/main/onnx/${onnxModelFile}`;

    const cacheManager = ModelCacheManager.getInstance();
    return await cacheManager.isModelCached(onnxModelUrl);
  } catch (error) {
    console.error('Error checking if default model is cached:', error);
    return false;
  }
}

// `hasAnyModelCache` lives in `./model-cache-status` and is re-exported above
// for back-compat. See IMP-0055.

// IMP-0019 slice 1: model-registry extracted to ./semantic-similarity/model-registry
// — re-exported here so the import path `@/utils/semantic-similarity-engine` keeps
// working for popup, sidepanel, etc.
export {
  PREDEFINED_MODELS,
  type ModelPreset,
  getModelInfo,
  listAvailableModels,
  recommendModelForLanguage,
  recommendModelForDevice,
  getModelSizeInfo,
  compareModels,
  getOnnxFileNameForVersion,
  getModelIdentifierWithVersion,
  getAllModelSizes,
} from './semantic-similarity/model-registry';
import {
  PREDEFINED_MODELS,
  getOnnxFileNameForVersion,
  type ModelPreset,
} from './semantic-similarity/model-registry';


// IMP-0019 slice 3: proxy extracted to ./semantic-similarity/proxy. Re-exported
// so background-context callers (ContentIndexer etc.) keep their import path.
export { SemanticSimilarityEngineProxy } from './semantic-similarity/proxy';

// Define necessary types
export interface ModelConfig {
  modelIdentifier: string;
  localModelPathPrefix?: string; // Base path for local models (relative to public)
  onnxModelFile?: string; // ONNX model filename
  maxLength?: number;
  cacheSize?: number;
  numThreads?: number;
  executionProviders?: string[];
  useLocalFiles?: boolean;
  workerPath?: string; // Worker script path (relative to extension root)
  concurrentLimit?: number; // Worker task concurrency limit
  forceOffscreen?: boolean; // Force offscreen mode (for testing)
  modelPreset?: ModelPreset; // Predefined model selection
  dimension?: number; // Vector dimension (auto-obtained from preset model)
  modelVersion?: 'full' | 'quantized' | 'compressed'; // Model version selection
  requiresTokenTypeIds?: boolean; // Whether model requires token_type_ids input
}

interface WorkerMessagePayload {
  modelPath?: string;
  modelData?: ArrayBuffer;
  numThreads?: number;
  executionProviders?: string[];
  input_ids?: number[];
  attention_mask?: number[];
  token_type_ids?: number[];
  dims?: {
    input_ids: number[];
    attention_mask: number[];
    token_type_ids?: number[];
  };
}

interface WorkerResponsePayload {
  data?: Float32Array | number[]; // Tensor data as Float32Array or number array
  dims?: number[]; // Tensor dimensions
  message?: string; // For error or status messages
}

interface WorkerStats {
  inferenceTime?: number;
  totalInferences?: number;
  averageInferenceTime?: number;
  memoryAllocations?: number;
  batchSize?: number;
}

interface PendingMessage {
  resolve: (value: WorkerResponsePayload | PromiseLike<WorkerResponsePayload>) => void;
  reject: (reason?: any) => void;
  type: string;
}

interface TokenizedOutput {
  // Simulates part of transformers.js tokenizer output
  input_ids: TransformersTensor;
  attention_mask: TransformersTensor;
  token_type_ids?: TransformersTensor;
}

export class SemanticSimilarityEngine {
  private worker: Worker | null = null;
  private tokenizer: PreTrainedTokenizer | null = null;
  public isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;
  private nextTokenId = 0;
  private pendingMessages = new Map<number, PendingMessage>();
  private useOffscreen = false; // Whether to use offscreen mode

  public readonly config: Required<ModelConfig>;

  private embeddingCache: LRUCache<string, Float32Array>;
  private tokenizationCache: LRUCache<string, TokenizedOutput>;
  // Owns reusable contiguous mean-pooling state; it holds no browser resources or document map.
  private readonly semanticIndex = new semanticPolicy.RustSemanticIndex();
  // Added: SIMD math engine
  private simdMath: SIMDMathEngine | null = null;
  private useSIMD = false;

  public cacheStats = {
    embedding: { hits: 0, misses: 0, size: 0 },
    tokenization: { hits: 0, misses: 0, size: 0 },
  };

  public performanceStats = {
    totalEmbeddingComputations: 0,
    totalEmbeddingTime: 0,
    averageEmbeddingTime: 0,
    totalTokenizationTime: 0,
    averageTokenizationTime: 0,
    totalSimilarityComputations: 0,
    totalSimilarityTime: 0,
    averageSimilarityTime: 0,
    workerStats: null as WorkerStats | null,
  };

  private runningWorkerTasks = 0;
  private workerTaskQueue: (() => void)[] = [];

  /**
   * Detect if current runtime environment supports Worker
   */
  private isWorkerSupported(): boolean {
    try {
      // Check if in Service Worker environment (background script)
      if (typeof importScripts === 'function') {
        return false;
      }

      // Check if Worker constructor is available
      return typeof Worker !== 'undefined';
    } catch {
      return false;
    }
  }

  /**
   * Detect if in offscreen document environment
   */
  private isInOffscreenDocument(): boolean {
    try {
      // In offscreen document, window.location.pathname is usually '/offscreen.html'
      return (
        typeof window !== 'undefined' &&
        window.location &&
        window.location.pathname.includes('offscreen')
      );
    } catch {
      return false;
    }
  }

  /**
   * Ensure offscreen document exists
   */
  private async ensureOffscreenDocument(): Promise<void> {
    return OffscreenManager.getInstance().ensureOffscreenDocument();
  }

  // Helper function to safely convert tensor data to number array
  private convertTensorDataToNumbers(data: any): number[] {
    if (data instanceof BigInt64Array) {
      return Array.from(data, (val: bigint) => Number(val));
    } else if (data instanceof Int32Array) {
      return Array.from(data);
    } else {
      return Array.from(data);
    }
  }

  constructor(options: Partial<ModelConfig> = {}) {
    console.log('SemanticSimilarityEngine: Constructor called with options:', {
      useLocalFiles: options.useLocalFiles,
      modelIdentifier: options.modelIdentifier,
      forceOffscreen: options.forceOffscreen,
      modelPreset: options.modelPreset,
      modelVersion: options.modelVersion,
    });

    // Handle model presets
    let modelConfig = { ...options };
    if (options.modelPreset && PREDEFINED_MODELS[options.modelPreset]) {
      const preset = PREDEFINED_MODELS[options.modelPreset];
      const modelVersion = options.modelVersion || 'quantized'; // Default to quantized version
      const baseModelIdentifier = preset.modelIdentifier; // Use base identifier without version suffix
      const onnxFileName = getOnnxFileNameForVersion(modelVersion); // Get ONNX filename based on version

      // Get model-specific configuration
      const modelSpecificConfig = (preset as any).modelSpecificConfig || {};

      modelConfig = {
        ...options,
        modelIdentifier: baseModelIdentifier, // Use base identifier
        onnxModelFile: onnxFileName, // Set corresponding version ONNX filename
        dimension: preset.dimension,
        modelVersion: modelVersion,
        requiresTokenTypeIds: modelSpecificConfig.requiresTokenTypeIds !== false, // Default to true unless explicitly set to false
      };
      console.log(
        `SemanticSimilarityEngine: Using model preset "${options.modelPreset}" with version "${modelVersion}":`,
        preset,
      );
      console.log(`SemanticSimilarityEngine: Base model identifier: ${baseModelIdentifier}`);
      console.log(`SemanticSimilarityEngine: ONNX file for version: ${onnxFileName}`);
      console.log(
        `SemanticSimilarityEngine: Requires token_type_ids: ${modelConfig.requiresTokenTypeIds}`,
      );
    }

    // Set default configuration - using 2025 recommended default model
    this.config = {
      ...modelConfig,
      modelIdentifier: modelConfig.modelIdentifier || 'Xenova/bge-small-en-v1.5',
      localModelPathPrefix: modelConfig.localModelPathPrefix || 'models/',
      onnxModelFile: modelConfig.onnxModelFile || 'model.onnx',
      maxLength: modelConfig.maxLength || 256,
      cacheSize: modelConfig.cacheSize || 500,
      numThreads:
        modelConfig.numThreads ||
        (typeof navigator !== 'undefined' && navigator.hardwareConcurrency
          ? Math.max(1, Math.floor(navigator.hardwareConcurrency / 2))
          : 2),
      executionProviders:
        modelConfig.executionProviders ||
        (typeof WebAssembly === 'object' &&
        WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
          ? ['wasm']
          : ['webgl']),
      useLocalFiles: (() => {
        console.log(
          'SemanticSimilarityEngine: DEBUG - modelConfig.useLocalFiles:',
          modelConfig.useLocalFiles,
        );
        console.log(
          'SemanticSimilarityEngine: DEBUG - modelConfig.useLocalFiles !== undefined:',
          modelConfig.useLocalFiles !== undefined,
        );
        const result = modelConfig.useLocalFiles !== undefined ? modelConfig.useLocalFiles : true;
        console.log('SemanticSimilarityEngine: DEBUG - final useLocalFiles value:', result);
        return result;
      })(),
      workerPath: modelConfig.workerPath || 'js/similarity.worker.js', // Will be overridden by WXT's `new URL`
      concurrentLimit:
        modelConfig.concurrentLimit ||
        Math.max(
          1,
          modelConfig.numThreads ||
            (typeof navigator !== 'undefined' && navigator.hardwareConcurrency
              ? Math.max(1, Math.floor(navigator.hardwareConcurrency / 2))
              : 2),
        ),
      forceOffscreen: modelConfig.forceOffscreen || false,
      modelPreset: modelConfig.modelPreset || 'bge-small-en-v1.5',
      dimension: modelConfig.dimension || 384,
      modelVersion: modelConfig.modelVersion || 'quantized',
      requiresTokenTypeIds: modelConfig.requiresTokenTypeIds !== false, // Default to true
    } as Required<ModelConfig>;

    console.log('SemanticSimilarityEngine: Final config:', {
      useLocalFiles: this.config.useLocalFiles,
      modelIdentifier: this.config.modelIdentifier,
      forceOffscreen: this.config.forceOffscreen,
    });

    this.embeddingCache = new LRUCache<string, Float32Array>(this.config.cacheSize);
    this.tokenizationCache = new LRUCache<string, TokenizedOutput>(
      Math.min(this.config.cacheSize, 200),
    );
    this.simdMath = new SIMDMathEngine();
  }

  private _sendMessageToWorker(
    type: string,
    payload?: WorkerMessagePayload,
    transferList?: Transferable[],
  ): Promise<WorkerResponsePayload> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker is not initialized.'));
        return;
      }
      const id = this.nextTokenId++;
      this.pendingMessages.set(id, { resolve, reject, type });

      // Use transferable objects if provided for zero-copy transfer
      if (transferList && transferList.length > 0) {
        this.worker.postMessage({ id, type, payload }, transferList);
      } else {
        this.worker.postMessage({ id, type, payload });
      }
    });
  }

  private _setupWorker(): void {
    console.log('SemanticSimilarityEngine: Setting up worker...');

    // Use the Chrome extension URL — most reliable in production builds.
    try {
      const workerUrl = chrome.runtime.getURL('workers/similarity.worker.js');
      console.log(`SemanticSimilarityEngine: Trying chrome.runtime.getURL ${workerUrl}`);
      this.worker = new Worker(workerUrl, { type: 'module' });
      console.log(`SemanticSimilarityEngine: Method 1 successful with path`);
    } catch (error) {
      console.warn('Method (chrome.runtime.getURL) failed:', error);
    }

    if (!this.worker) {
      throw new Error('Worker creation failed');
    }

    this.worker.onmessage = (
      event: MessageEvent<{
        id: number;
        type: string;
        status: string;
        payload: WorkerResponsePayload;
        stats?: WorkerStats;
      }>,
    ) => {
      const { id, status, payload, stats } = event.data;
      const promiseCallbacks = this.pendingMessages.get(id);
      if (!promiseCallbacks) return;

      this.pendingMessages.delete(id);

      if (stats) {
        this.performanceStats.workerStats = stats;
      }

      if (status === 'success') {
        promiseCallbacks.resolve(payload);
      } else {
        const error = new Error(
          payload?.message || `Worker error for task ${promiseCallbacks.type}`,
        );
        (error as any).name = (payload as any)?.name || 'WorkerError';
        (error as any).stack = (payload as any)?.stack || undefined;
        console.error(
          `Error from worker (task ${id}, type ${promiseCallbacks.type}):`,
          error,
          event.data,
        );
        promiseCallbacks.reject(error);
      }
    };

    this.worker.onerror = (error: ErrorEvent) => {
      console.error('==== Unhandled error in SemanticSimilarityEngine Worker ====');
      console.error('Event Message:', error.message);
      console.error('Event Filename:', error.filename);
      console.error('Event Lineno:', error.lineno);
      console.error('Event Colno:', error.colno);
      if (error.error) {
        console.error('Actual Error Name:', error.error.name);
        console.error('Actual Error Message:', error.error.message);
        console.error('Actual Error Stack:', error.error.stack);
      } else {
        console.error('Actual Error object (event.error) is not available. Error details:', {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        });
      }
      console.error('==========================================================');
      this.pendingMessages.forEach((callbacks) => {
        callbacks.reject(new Error(`Worker terminated or unhandled error: ${error.message}`));
      });
      this.pendingMessages.clear();
      this.isInitialized = false;
      this.isInitializing = false;
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return Promise.resolve();
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitialize().finally(() => {
      this.isInitializing = false;
      // this.warmupModel();
    });
    return this.initPromise;
  }

  /** Initialize with a progress callback. */
  public async initializeWithProgress(
    onProgress?: (progress: { status: string; progress: number; message?: string }) => void,
  ): Promise<void> {
    if (this.isInitialized) return Promise.resolve();
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitializeWithProgress(onProgress).finally(() => {
      this.isInitializing = false;
      // this.warmupModel();
    });
    return this.initPromise;
  }

  private async _doInitializeWithProgress(
    onProgress?: (progress: { status: string; progress: number; message?: string }) => void,
  ): Promise<void> {
    console.log('SemanticSimilarityEngine: Initializing with progress tracking...');
    const startTime = performance.now();

    const reportProgress = (status: string, progress: number, message?: string) => {
      if (onProgress) {
        onProgress({ status, progress, message });
      }
    };

    try {
      reportProgress('initializing', 5, 'Starting initialization...');

      const workerSupported = this.isWorkerSupported();
      const inOffscreenDocument = this.isInOffscreenDocument();

      // Already inside an offscreen document — force direct Worker mode so we
      // do not recursively spawn another offscreen document.
      if (inOffscreenDocument) {
        this.useOffscreen = false;
        console.log(
          'SemanticSimilarityEngine: Running in offscreen document, using direct Worker mode to prevent recursion',
        );
      } else {
        this.useOffscreen = this.config.forceOffscreen || !workerSupported;
      }

      console.log(
        `SemanticSimilarityEngine: Worker supported: ${workerSupported}, In offscreen: ${inOffscreenDocument}, Using offscreen: ${this.useOffscreen}`,
      );

      reportProgress('initializing', 10, 'Environment detection complete');

      if (this.useOffscreen) {
        reportProgress('initializing', 15, 'Setting up offscreen document...');
        await this.ensureOffscreenDocument();

        console.log('SemanticSimilarityEngine: Sending config to offscreen:', {
          useLocalFiles: this.config.useLocalFiles,
          modelIdentifier: this.config.modelIdentifier,
          localModelPathPrefix: this.config.localModelPathPrefix,
        });

        const configToSend = {
          modelIdentifier: this.config.modelIdentifier,
          localModelPathPrefix: this.config.localModelPathPrefix,
          onnxModelFile: this.config.onnxModelFile,
          maxLength: this.config.maxLength,
          cacheSize: this.config.cacheSize,
          numThreads: this.config.numThreads,
          executionProviders: this.config.executionProviders,
          // Coerce to boolean — chrome.runtime.sendMessage drops undefined.
          useLocalFiles: Boolean(this.config.useLocalFiles),
          workerPath: this.config.workerPath,
          concurrentLimit: this.config.concurrentLimit,
          forceOffscreen: this.config.forceOffscreen,
          modelPreset: this.config.modelPreset,
          modelVersion: this.config.modelVersion,
          dimension: this.config.dimension,
        };

        // JSON round-trip guarantees the structured-cloneable shape.
        const serializedConfig = JSON.parse(JSON.stringify(configToSend));

        reportProgress('initializing', 20, 'Delegating to offscreen document...');

        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
          config: serializedConfig,
        });

        if (!response || !response.success) {
          throw new Error(response?.error || 'Failed to initialize engine in offscreen document');
        }

        reportProgress('ready', 100, 'Initialized via offscreen document');
        console.log('SemanticSimilarityEngine: Initialized via offscreen document');
      } else {
        await this._initializeDirectWorkerWithProgress(reportProgress);
      }

      this.isInitialized = true;
      console.log(
        `SemanticSimilarityEngine: Initialization complete in ${(performance.now() - startTime).toFixed(2)}ms`,
      );
    } catch (error) {
      console.error('SemanticSimilarityEngine: Initialization failed.', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      reportProgress('error', 0, `Initialization failed: ${errorMessage}`);
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.isInitializing = false;
      this.initPromise = null;

      const enhancedError = new Error(errorMessage);
      enhancedError.name = 'ModelInitializationError';
      throw enhancedError;
    }
  }

  private async _doInitialize(): Promise<void> {
    console.log('SemanticSimilarityEngine: Initializing...');
    const startTime = performance.now();
    try {
      const workerSupported = this.isWorkerSupported();
      const inOffscreenDocument = this.isInOffscreenDocument();

      // Already inside an offscreen document — force direct Worker mode to
      // avoid recursively spawning another offscreen document.
      if (inOffscreenDocument) {
        this.useOffscreen = false;
        console.log(
          'SemanticSimilarityEngine: Running in offscreen document, using direct Worker mode to prevent recursion',
        );
      } else {
        this.useOffscreen = this.config.forceOffscreen || !workerSupported;
      }

      console.log(
        `SemanticSimilarityEngine: Worker supported: ${workerSupported}, In offscreen: ${inOffscreenDocument}, Using offscreen: ${this.useOffscreen}`,
      );

      if (this.useOffscreen) {
        await this.ensureOffscreenDocument();

        console.log('SemanticSimilarityEngine: Sending config to offscreen:', {
          useLocalFiles: this.config.useLocalFiles,
          modelIdentifier: this.config.modelIdentifier,
          localModelPathPrefix: this.config.localModelPathPrefix,
        });

        const configToSend = {
          modelIdentifier: this.config.modelIdentifier,
          localModelPathPrefix: this.config.localModelPathPrefix,
          onnxModelFile: this.config.onnxModelFile,
          maxLength: this.config.maxLength,
          cacheSize: this.config.cacheSize,
          numThreads: this.config.numThreads,
          executionProviders: this.config.executionProviders,
          // Coerce to boolean — chrome.runtime.sendMessage drops undefined.
          useLocalFiles: Boolean(this.config.useLocalFiles),
          workerPath: this.config.workerPath,
          concurrentLimit: this.config.concurrentLimit,
          forceOffscreen: this.config.forceOffscreen,
          modelPreset: this.config.modelPreset,
          modelVersion: this.config.modelVersion,
          dimension: this.config.dimension,
        };

        console.log(
          'SemanticSimilarityEngine: DEBUG - configToSend.useLocalFiles:',
          configToSend.useLocalFiles,
        );
        console.log(
          'SemanticSimilarityEngine: DEBUG - typeof configToSend.useLocalFiles:',
          typeof configToSend.useLocalFiles,
        );

        console.log('SemanticSimilarityEngine: Explicit config to send:', configToSend);
        console.log(
          'SemanticSimilarityEngine: DEBUG - this.config.useLocalFiles value:',
          this.config.useLocalFiles,
        );
        console.log(
          'SemanticSimilarityEngine: DEBUG - typeof this.config.useLocalFiles:',
          typeof this.config.useLocalFiles,
        );

        // JSON round-trip guarantees the structured-cloneable shape.
        const serializedConfig = JSON.parse(JSON.stringify(configToSend));
        console.log(
          'SemanticSimilarityEngine: DEBUG - serializedConfig.useLocalFiles:',
          serializedConfig.useLocalFiles,
        );

        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
          config: serializedConfig,
        });

        if (!response || !response.success) {
          throw new Error(response?.error || 'Failed to initialize engine in offscreen document');
        }

        console.log('SemanticSimilarityEngine: Initialized via offscreen document');
      } else {
        this._setupWorker();

        const { AutoTokenizer, env: TransformersEnv } = await loadTransformers();

        TransformersEnv.allowRemoteModels = !this.config.useLocalFiles;
        TransformersEnv.allowLocalModels = this.config.useLocalFiles;

        console.log(`SemanticSimilarityEngine: TransformersEnv config:`, {
          allowRemoteModels: TransformersEnv.allowRemoteModels,
          allowLocalModels: TransformersEnv.allowLocalModels,
          useLocalFiles: this.config.useLocalFiles,
        });
        if (TransformersEnv.backends?.onnx?.wasm) {
          TransformersEnv.backends.onnx.wasm.numThreads = this.config.numThreads;
        }

        let tokenizerIdentifier = this.config.modelIdentifier;
        if (this.config.useLocalFiles) {
          // For WXT, public/ assets resolve at the root path; transformers.js
          // auto-prefixes with `/models/`, so we pass the bare identifier.
          tokenizerIdentifier = this.config.modelIdentifier;
        }
        console.log(
          `SemanticSimilarityEngine: Loading tokenizer from ${tokenizerIdentifier} (local_files_only: ${this.config.useLocalFiles})`,
        );
        const tokenizerConfig: any = {
          quantized: false,
          local_files_only: this.config.useLocalFiles,
        };

        // Models that don't need token_type_ids must opt out explicitly so
        // the tokenizer doesn't emit the field.
        if (!this.config.requiresTokenTypeIds) {
          tokenizerConfig.return_token_type_ids = false;
        }

        console.log(`SemanticSimilarityEngine: Full tokenizer config:`, {
          tokenizerIdentifier,
          localModelPathPrefix: this.config.localModelPathPrefix,
          modelIdentifier: this.config.modelIdentifier,
          useLocalFiles: this.config.useLocalFiles,
          local_files_only: this.config.useLocalFiles,
          requiresTokenTypeIds: this.config.requiresTokenTypeIds,
          tokenizerConfig,
        });
        this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerIdentifier, tokenizerConfig);
        console.log('SemanticSimilarityEngine: Tokenizer loaded.');

        if (this.config.useLocalFiles) {
          // Local files mode - use URL path as before
          const onnxModelPathForWorker = chrome.runtime.getURL(
            `models/${this.config.modelIdentifier}/${this.config.onnxModelFile}`,
          );
          console.log(
            `SemanticSimilarityEngine: Instructing worker to load local ONNX model from ${onnxModelPathForWorker}`,
          );
          await this._sendMessageToWorker('init', {
            modelPath: onnxModelPathForWorker,
            numThreads: this.config.numThreads,
            executionProviders: this.config.executionProviders,
          });
        } else {
          // Remote files mode - use cached model data
          const modelIdParts = this.config.modelIdentifier.split('/');
          const modelNameForUrl =
            modelIdParts.length > 1
              ? this.config.modelIdentifier
              : `Xenova/${this.config.modelIdentifier}`;
          const onnxModelUrl = `https://huggingface.co/${modelNameForUrl}/resolve/main/onnx/${this.config.onnxModelFile}`;

          if (!this.config.modelIdentifier.includes('/')) {
            console.warn(
              `Warning: modelIdentifier "${this.config.modelIdentifier}" might not be a full HuggingFace path. Assuming Xenova prefix for remote URL.`,
            );
          }

          console.log(`SemanticSimilarityEngine: Getting cached model data from ${onnxModelUrl}`);

          // Get model data from cache (may download if not cached)
          const modelData = await getCachedModelData(onnxModelUrl);

          console.log(
            `SemanticSimilarityEngine: Sending cached model data to worker (${modelData.byteLength} bytes)`,
          );

          // Send ArrayBuffer to worker with transferable objects for zero-copy
          await this._sendMessageToWorker(
            'init',
            {
              modelData: modelData,
              numThreads: this.config.numThreads,
              executionProviders: this.config.executionProviders,
            },
            [modelData],
          );
        }
        console.log('SemanticSimilarityEngine: Worker reported model initialized.');

        try {
          console.log('SemanticSimilarityEngine: Checking SIMD support...');
          const simdSupported = await SIMDMathEngine.checkSIMDSupport();

          if (simdSupported) {
            console.log('SemanticSimilarityEngine: SIMD supported, initializing...');
            await this.simdMath!.initialize();
            this.useSIMD = true;
            console.log('SemanticSimilarityEngine: SIMD acceleration enabled');
          } else {
            console.log('SemanticSimilarityEngine: SIMD not supported, using JavaScript fallback');
            console.log('SemanticSimilarityEngine: To enable SIMD, please use:');
            console.log('  - Chrome 91+ (May 2021)');
            console.log('  - Firefox 89+ (June 2021)');
            console.log('  - Safari 16.4+ (March 2023)');
            console.log('  - Edge 91+ (May 2021)');
            this.useSIMD = false;
          }
        } catch (simdError) {
          console.warn(
            'SemanticSimilarityEngine: SIMD initialization failed, using JavaScript fallback:',
            simdError,
          );
          this.useSIMD = false;
        }
      }

      this.isInitialized = true;
      console.log(
        `SemanticSimilarityEngine: Initialization complete in ${(performance.now() - startTime).toFixed(2)}ms`,
      );
    } catch (error) {
      console.error('SemanticSimilarityEngine: Initialization failed.', error);
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.isInitializing = false;
      this.initPromise = null;

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const enhancedError = new Error(errorMessage);
      enhancedError.name = 'ModelInitializationError';
      throw enhancedError;
    }
  }

  /** Direct Worker initialization path with progress reporting. */
  private async _initializeDirectWorkerWithProgress(
    reportProgress: (status: string, progress: number, message?: string) => void,
  ): Promise<void> {
    reportProgress('initializing', 25, 'Setting up worker...');
    this._setupWorker();

    const { AutoTokenizer, env: TransformersEnv } = await loadTransformers();

    TransformersEnv.allowRemoteModels = !this.config.useLocalFiles;
    TransformersEnv.allowLocalModels = this.config.useLocalFiles;

    console.log(`SemanticSimilarityEngine: TransformersEnv config:`, {
      allowRemoteModels: TransformersEnv.allowRemoteModels,
      allowLocalModels: TransformersEnv.allowLocalModels,
      useLocalFiles: this.config.useLocalFiles,
    });
    if (TransformersEnv.backends?.onnx?.wasm) {
      TransformersEnv.backends.onnx.wasm.numThreads = this.config.numThreads;
    }

    let tokenizerIdentifier = this.config.modelIdentifier;
    if (this.config.useLocalFiles) {
      tokenizerIdentifier = this.config.modelIdentifier;
    }

    reportProgress('downloading', 40, 'Loading tokenizer...');
    console.log(
      `SemanticSimilarityEngine: Loading tokenizer from ${tokenizerIdentifier} (local_files_only: ${this.config.useLocalFiles})`,
    );

    // Uses transformers.js 2.17+ progress_callback (downgrades silently when absent).
    const tokenizerProgressCallback = (progress: any) => {
      if (progress.status === 'downloading') {
        const progressPercent = Math.min(40 + (progress.progress || 0) * 0.3, 70);
        reportProgress(
          'downloading',
          progressPercent,
          `Downloading tokenizer: ${progress.file || ''}`,
        );
      }
    };

    const tokenizerConfig: any = {
      quantized: false,
      local_files_only: this.config.useLocalFiles,
    };

    // Models that don't need token_type_ids must opt out explicitly.
    if (!this.config.requiresTokenTypeIds) {
      tokenizerConfig.return_token_type_ids = false;
    }

    try {
      if (!this.config.useLocalFiles) {
        tokenizerConfig.progress_callback = tokenizerProgressCallback;
      }
      this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerIdentifier, tokenizerConfig);
    } catch (error) {
      // Older transformers.js versions don't accept progress_callback — retry without it.
      console.log(
        'SemanticSimilarityEngine: Progress callback not supported, using standard loading',
      );
      delete tokenizerConfig.progress_callback;
      this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerIdentifier, tokenizerConfig);
    }

    reportProgress('downloading', 70, 'Tokenizer loaded, setting up ONNX model...');
    console.log('SemanticSimilarityEngine: Tokenizer loaded.');

    if (this.config.useLocalFiles) {
      // Local files mode - use URL path as before
      const onnxModelPathForWorker = chrome.runtime.getURL(
        `models/${this.config.modelIdentifier}/${this.config.onnxModelFile}`,
      );
      reportProgress('downloading', 80, 'Loading local ONNX model...');
      console.log(
        `SemanticSimilarityEngine: Instructing worker to load local ONNX model from ${onnxModelPathForWorker}`,
      );
      await this._sendMessageToWorker('init', {
        modelPath: onnxModelPathForWorker,
        numThreads: this.config.numThreads,
        executionProviders: this.config.executionProviders,
      });
    } else {
      // Remote files mode - use cached model data
      const modelIdParts = this.config.modelIdentifier.split('/');
      const modelNameForUrl =
        modelIdParts.length > 1
          ? this.config.modelIdentifier
          : `Xenova/${this.config.modelIdentifier}`;
      const onnxModelUrl = `https://huggingface.co/${modelNameForUrl}/resolve/main/onnx/${this.config.onnxModelFile}`;

      if (!this.config.modelIdentifier.includes('/')) {
        console.warn(
          `Warning: modelIdentifier "${this.config.modelIdentifier}" might not be a full HuggingFace path. Assuming Xenova prefix for remote URL.`,
        );
      }

      reportProgress('downloading', 80, 'Loading cached ONNX model...');
      console.log(`SemanticSimilarityEngine: Getting cached model data from ${onnxModelUrl}`);

      // Get model data from cache (may download if not cached)
      const modelData = await getCachedModelData(onnxModelUrl);

      console.log(
        `SemanticSimilarityEngine: Sending cached model data to worker (${modelData.byteLength} bytes)`,
      );

      // Send ArrayBuffer to worker with transferable objects for zero-copy
      await this._sendMessageToWorker(
        'init',
        {
          modelData: modelData,
          numThreads: this.config.numThreads,
          executionProviders: this.config.executionProviders,
        },
        [modelData],
      );
    }
    console.log('SemanticSimilarityEngine: Worker reported model initialized.');

    reportProgress('initializing', 90, 'Setting up SIMD acceleration...');
    try {
      console.log('SemanticSimilarityEngine: Checking SIMD support...');
      const simdSupported = await SIMDMathEngine.checkSIMDSupport();

      if (simdSupported) {
        console.log('SemanticSimilarityEngine: SIMD supported, initializing...');
        await this.simdMath!.initialize();
        this.useSIMD = true;
        console.log('SemanticSimilarityEngine: SIMD acceleration enabled');
      } else {
        console.log('SemanticSimilarityEngine: SIMD not supported, using JavaScript fallback');
        this.useSIMD = false;
      }
    } catch (simdError) {
      console.warn(
        'SemanticSimilarityEngine: SIMD initialization failed, using JavaScript fallback:',
        simdError,
      );
      this.useSIMD = false;
    }

    reportProgress('ready', 100, 'Initialization complete');
  }

  public async warmupModel(): Promise<void> {
    if (!this.isInitialized && !this.isInitializing) {
      await this.initialize();
    } else if (this.isInitializing && this.initPromise) {
      await this.initPromise;
    }
    if (!this.isInitialized) throw new Error('Engine not initialized after warmup attempt.');
    console.log('SemanticSimilarityEngine: Warming up model...');

    // Cover a mix of short, medium, and long inputs so JIT and caches warm up
    // for the input shapes we'll actually see at runtime.
    const warmupTexts = [
      'Hello',
      'Hola',
      'Test',
      'Hello world, this is a test.',
      'Hola mundo, esto es una prueba.',
      'The quick brown fox jumps over the lazy dog.',
      'This is a longer text that contains multiple sentences. It helps warm up the model for various text lengths.',
      'Este es un texto más largo que contiene varias oraciones. Ayuda a calentar el modelo para diferentes longitudes de texto.',
    ];

    try {
      // Progressive warmup: individual passes first, then a batched pass.
      console.log('SemanticSimilarityEngine: Phase 1 - Individual warmup...');
      for (const text of warmupTexts.slice(0, 4)) {
        await this.getEmbedding(text);
      }

      console.log('SemanticSimilarityEngine: Phase 2 - Batch warmup...');
      await this.getEmbeddingsBatch(warmupTexts.slice(4));

      // Keep cached entries from the warmup pass.
      console.log('SemanticSimilarityEngine: Model warmup complete. Cache preserved.');
      console.log(`Embedding cache: ${this.cacheStats.embedding.size} items`);
      console.log(`Tokenization cache: ${this.cacheStats.tokenization.size} items`);
    } catch (error) {
      console.warn('SemanticSimilarityEngine: Warmup failed. This might not be critical.', error);
    }
  }

  private async _tokenizeText(text: string | string[]): Promise<TokenizedOutput> {
    if (!this.tokenizer) throw new Error('Tokenizer not initialized.');

    // Cache lookup is per-string only — batch inputs typically don't repeat.
    if (typeof text === 'string') {
      const cacheKey = `tokenize:${text}`;
      const cached = this.tokenizationCache.get(cacheKey);
      if (cached) {
        this.cacheStats.tokenization.hits++;
        this.cacheStats.tokenization.size = this.tokenizationCache.size;
        return cached;
      }
      this.cacheStats.tokenization.misses++;

      const startTime = performance.now();
      const tokenizerOptions: any = {
        padding: true,
        truncation: true,
        max_length: this.config.maxLength,
        return_tensors: 'np',
      };

      if (!this.config.requiresTokenTypeIds) {
        tokenizerOptions.return_token_type_ids = false;
      }

      const result = (await this.tokenizer(text, tokenizerOptions)) as TokenizedOutput;

      this.performanceStats.totalTokenizationTime += performance.now() - startTime;
      this.performanceStats.averageTokenizationTime =
        this.performanceStats.totalTokenizationTime /
        (this.cacheStats.tokenization.hits + this.cacheStats.tokenization.misses);

      this.tokenizationCache.set(cacheKey, result);
      this.cacheStats.tokenization.size = this.tokenizationCache.size;

      return result;
    }

    const startTime = performance.now();
    const tokenizerOptions: any = {
      padding: true,
      truncation: true,
      max_length: this.config.maxLength,
      return_tensors: 'np',
    };

    if (!this.config.requiresTokenTypeIds) {
      tokenizerOptions.return_token_type_ids = false;
    }

    const result = (await this.tokenizer(text, tokenizerOptions)) as TokenizedOutput;

    this.performanceStats.totalTokenizationTime += performance.now() - startTime;
    return result;
  }

  private _extractEmbeddingFromWorkerOutput(
    workerOutput: WorkerResponsePayload,
    attentionMaskArray: number[],
  ): Float32Array {
    if (!workerOutput.data || !workerOutput.dims) {
      throw new Error('Invalid worker output for embedding extraction.');
    }

    const hiddenState =
      workerOutput.data instanceof Float32Array
        ? workerOutput.data
        : new Float32Array(workerOutput.data);
    const [, sequenceLength, hiddenSize] = workerOutput.dims;
    return this.semanticIndex.meanPoolNormalized(
      hiddenState,
      Int32Array.from(attentionMaskArray),
      1,
      sequenceLength,
      hiddenSize,
    );
  }

  private _extractBatchEmbeddingsFromWorkerOutput(
    workerOutput: WorkerResponsePayload,
    attentionMask: number[],
  ): Float32Array[] {
    if (!workerOutput.data || !workerOutput.dims) {
      throw new Error('Invalid worker output for batch embedding extraction.');
    }

    const hiddenState =
      workerOutput.data instanceof Float32Array
        ? workerOutput.data
        : new Float32Array(workerOutput.data);
    const [batchSize, sequenceLength, hiddenSize] = workerOutput.dims;
    const pooled = this.semanticIndex.meanPoolNormalized(
      hiddenState,
      Int32Array.from(attentionMask),
      batchSize,
      sequenceLength,
      hiddenSize,
    );
    const embeddings: Float32Array[] = new Array(batchSize);
    for (let batchIndex = 0; batchIndex < batchSize; batchIndex++) {
      const offset = batchIndex * hiddenSize;
      embeddings[batchIndex] = pooled.subarray(offset, offset + hiddenSize);
    }
    return embeddings;
  }

  public async getEmbedding(
    text: string,
    options: Record<string, any> = {},
  ): Promise<Float32Array> {
    if (!this.isInitialized) await this.initialize();

    const cacheKey = this.getCacheKey(text, options);
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      this.cacheStats.embedding.hits++;
      this.cacheStats.embedding.size = this.embeddingCache.size;
      return cached;
    }
    this.cacheStats.embedding.misses++;

    if (this.useOffscreen) {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
        text: text,
        options: options,
      });

      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to get embedding from offscreen document');
      }

      if (!response.embedding || !Array.isArray(response.embedding)) {
        throw new Error('Invalid embedding data received from offscreen document');
      }

      console.log('SemanticSimilarityEngine: Received embedding from offscreen:', {
        length: response.embedding.length,
        type: typeof response.embedding,
        isArray: Array.isArray(response.embedding),
        firstFewValues: response.embedding.slice(0, 5),
      });

      const embedding = new Float32Array(response.embedding);

      console.log('SemanticSimilarityEngine: Converted embedding:', {
        length: embedding.length,
        type: typeof embedding,
        constructor: embedding.constructor.name,
        isFloat32Array: embedding instanceof Float32Array,
        firstFewValues: Array.from(embedding.slice(0, 5)),
      });

      this.embeddingCache.set(cacheKey, embedding);
      this.cacheStats.embedding.size = this.embeddingCache.size;

      this.performanceStats.totalEmbeddingComputations++;

      return embedding;
    }

    if (this.runningWorkerTasks >= this.config.concurrentLimit) {
      await this.waitForWorkerSlot();
    }
    this.runningWorkerTasks++;

    const startTime = performance.now();
    try {
      const tokenized = await this._tokenizeText(text);

      const inputIdsData = this.convertTensorDataToNumbers(tokenized.input_ids.data);
      const attentionMaskData = this.convertTensorDataToNumbers(tokenized.attention_mask.data);
      const tokenTypeIdsData = tokenized.token_type_ids
        ? this.convertTensorDataToNumbers(tokenized.token_type_ids.data)
        : undefined;

      const workerPayload: WorkerMessagePayload = {
        input_ids: inputIdsData,
        attention_mask: attentionMaskData,
        token_type_ids: tokenTypeIdsData,
        dims: {
          input_ids: tokenized.input_ids.dims,
          attention_mask: tokenized.attention_mask.dims,
          token_type_ids: tokenized.token_type_ids?.dims,
        },
      };

      const workerOutput = await this._sendMessageToWorker('infer', workerPayload);
      const embedding = this._extractEmbeddingFromWorkerOutput(workerOutput, attentionMaskData);
      this.embeddingCache.set(cacheKey, embedding);
      this.cacheStats.embedding.size = this.embeddingCache.size;

      this.performanceStats.totalEmbeddingComputations++;
      this.performanceStats.totalEmbeddingTime += performance.now() - startTime;
      this.performanceStats.averageEmbeddingTime =
        this.performanceStats.totalEmbeddingTime / this.performanceStats.totalEmbeddingComputations;
      return embedding;
    } finally {
      this.runningWorkerTasks--;
      this.processWorkerQueue();
    }
  }

  public async getEmbeddingsBatch(
    texts: string[],
    options: Record<string, any> = {},
  ): Promise<Float32Array[]> {
    if (!this.isInitialized) await this.initialize();
    if (!texts || texts.length === 0) return [];

    const cachedByInput = texts.map((text) => this.embeddingCache.get(this.getCacheKey(text, options)));
    for (const cached of cachedByInput) {
      if (cached) this.cacheStats.embedding.hits++;
      else this.cacheStats.embedding.misses++;
    }

    const plan = semanticPolicy.planSemanticEmbeddingBatch(
      texts,
      cachedByInput.map((cached) => cached !== null),
      this.useOffscreen ? 'offscreen' : 'directWorker',
    );
    if (!plan) {
      throw new Error('Invalid embedding batch cache plan');
    }
    if (plan.inferenceInputIndices.length === 0) {
      this.cacheStats.embedding.size = this.embeddingCache.size;
      return cachedByInput as Float32Array[];
    }

    const inferenceTexts = plan.inferenceInputIndices.map((index) => texts[index]);
    let inferred: Float32Array[];
    if (this.useOffscreen) {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_BATCH_COMPUTE,
        texts: inferenceTexts,
        options,
      });
      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to get embeddings batch from offscreen document');
      }
      inferred = response.embeddings.map((embedding: number[]) => new Float32Array(embedding));
    } else {
      if (this.runningWorkerTasks >= this.config.concurrentLimit) {
        await this.waitForWorkerSlot();
      }
      this.runningWorkerTasks++;
      const startTime = performance.now();
      try {
        const tokenizedBatch = await this._tokenizeText(inferenceTexts);
        const workerPayload: WorkerMessagePayload = {
          input_ids: this.convertTensorDataToNumbers(tokenizedBatch.input_ids.data),
          attention_mask: this.convertTensorDataToNumbers(tokenizedBatch.attention_mask.data),
          token_type_ids: tokenizedBatch.token_type_ids
            ? this.convertTensorDataToNumbers(tokenizedBatch.token_type_ids.data)
            : undefined,
          dims: {
            input_ids: tokenizedBatch.input_ids.dims,
            attention_mask: tokenizedBatch.attention_mask.dims,
            token_type_ids: tokenizedBatch.token_type_ids?.dims,
          },
        };
        const workerOutput = await this._sendMessageToWorker('batchInfer', workerPayload);
        inferred = this._extractBatchEmbeddingsFromWorkerOutput(
          workerOutput,
          this.convertTensorDataToNumbers(tokenizedBatch.attention_mask.data),
        );
        this.performanceStats.totalEmbeddingTime += performance.now() - startTime;
        this.performanceStats.averageEmbeddingTime =
          this.performanceStats.totalEmbeddingTime /
          (this.performanceStats.totalEmbeddingComputations + inferenceTexts.length);
      } finally {
        this.runningWorkerTasks--;
        this.processWorkerQueue();
      }
    }

    if (inferred.length !== inferenceTexts.length) {
      throw new Error('Invalid embedding batch response');
    }
    for (let responseIndex = 0; responseIndex < inferred.length; responseIndex++) {
      const originalIndex = plan.inferenceInputIndices[responseIndex];
      this.embeddingCache.set(this.getCacheKey(texts[originalIndex], options), inferred[responseIndex]);
    }

    const results = plan.resultSources.map((source) =>
      source.kind === 'cachedInput' ? cachedByInput[source.index] : inferred[source.index],
    );
    if (results.some((embedding) => !embedding)) {
      throw new Error('Invalid embedding batch reconstruction');
    }
    this.cacheStats.embedding.size = this.embeddingCache.size;
    this.performanceStats.totalEmbeddingComputations += inferenceTexts.length;
    return results as Float32Array[];
  }

  public async computeSimilarity(
    text1: string,
    text2: string,
    options: Record<string, any> = {},
  ): Promise<number> {
    if (!this.isInitialized) await this.initialize();
    this.validateInput(text1, text2);

    const simStartTime = performance.now();
    const [embedding1, embedding2] = await Promise.all([
      this.getEmbedding(text1, options),
      this.getEmbedding(text2, options),
    ]);
    const similarity = this.cosineSimilarity(embedding1, embedding2);
    console.log('computeSimilarity:', similarity);
    this.performanceStats.totalSimilarityComputations++;
    this.performanceStats.totalSimilarityTime += performance.now() - simStartTime;
    this.performanceStats.averageSimilarityTime =
      this.performanceStats.totalSimilarityTime / this.performanceStats.totalSimilarityComputations;
    return similarity;
  }

  private contiguousEmbeddingBatch(embeddings: readonly Float32Array[]): Float32Array | null {
    const dimension = embeddings[0]?.length ?? 0;
    if (dimension === 0 || embeddings.some((embedding) => embedding.length !== dimension)) {
      return null;
    }
    const batch = new Float32Array(embeddings.length * dimension);
    for (let index = 0; index < embeddings.length; index++) {
      batch.set(embeddings[index], index * dimension);
    }
    return batch;
  }

  public async computeSimilarityBatch(
    pairs: { text1: string; text2: string }[],
    options: Record<string, any> = {},
  ): Promise<number[]> {
    if (!this.isInitialized) await this.initialize();
    if (!pairs || pairs.length === 0) return [];

    const plan = semanticPolicy.planSemanticSimilarityPairs(
      pairs,
      this.useOffscreen ? 'offscreen' : 'directWorker',
    );
    if (plan.kind === 'offscreen') {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_BATCH_COMPUTE,
        pairs,
        options,
      });
      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to compute similarities in offscreen document');
      }
      return response.similarities;
    }

    const simStartTime = performance.now();
    const embeddings = await this.getEmbeddingsBatch(plan.uniqueTexts, options);
    const batch = this.contiguousEmbeddingBatch(embeddings);
    const similarities = batch
      ? semanticPolicy.semanticPairSimilarityScores(pairs, batch, embeddings[0].length)
      : plan.pairEmbeddingIndices.map(([left, right]) =>
          this.cosineSimilarity(embeddings[left], embeddings[right]),
        );
    this.performanceStats.totalSimilarityComputations += pairs.length;
    this.performanceStats.totalSimilarityTime += performance.now() - simStartTime;
    this.performanceStats.averageSimilarityTime =
      this.performanceStats.totalSimilarityTime / this.performanceStats.totalSimilarityComputations;
    return similarities;
  }

  public async computeSimilarityMatrix(
    texts1: string[],
    texts2: string[],
    options: Record<string, any> = {},
  ): Promise<number[][]> {
    if (!this.isInitialized) await this.initialize();
    if (!texts1 || !texts2 || texts1.length === 0 || texts2.length === 0) return [];

    const simStartTime = performance.now();
    const plan = semanticPolicy.planSemanticSimilarityMatrix(texts1, texts2);
    const embeddings = await this.getEmbeddingsBatch(plan.uniqueTexts, options);
    const leftRows = plan.leftEmbeddingIndices.map((index) => embeddings[index]);
    const rightRows = plan.rightEmbeddingIndices.map((index) => embeddings[index]);

    if (this.useSIMD && this.simdMath) {
      try {
        const matrix = await this.simdMath.similarityMatrix(leftRows, rightRows);
        this.performanceStats.totalSimilarityComputations += texts1.length * texts2.length;
        this.performanceStats.totalSimilarityTime += performance.now() - simStartTime;
        this.performanceStats.averageSimilarityTime =
          this.performanceStats.totalSimilarityTime / this.performanceStats.totalSimilarityComputations;
        return matrix;
      } catch (error) {
        console.warn('SIMD matrix computation failed, falling back to Rust:', error);
      }
    }

    const batch = this.contiguousEmbeddingBatch(embeddings);
    const matrix = batch
      ? semanticPolicy.semanticSimilarityMatrixScores(
          texts1,
          texts2,
          batch,
          embeddings[0].length,
        )
      : plan.leftEmbeddingIndices.map((left) =>
          plan.rightEmbeddingIndices.map((right) => this.cosineSimilarity(embeddings[left], embeddings[right])),
        );
    this.performanceStats.totalSimilarityComputations += texts1.length * texts2.length;
    this.performanceStats.totalSimilarityTime += performance.now() - simStartTime;
    this.performanceStats.averageSimilarityTime =
      this.performanceStats.totalSimilarityTime / this.performanceStats.totalSimilarityComputations;
    return matrix;
  }

  public cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      console.warn('Cosine similarity: Invalid vectors provided.', vecA, vecB);
      return 0;
    }

    // SIMD path is async; this method must stay synchronous for back-compat,
    // so we always run the JS version here. Use cosineSimilaritySIMD() when
    // an async path is acceptable.
    if (this.useSIMD && this.simdMath) {
      try {
        return this.cosineSimilarityJS(vecA, vecB);
      } catch (error) {
        console.warn('SIMD cosine similarity failed, falling back to JavaScript:', error);
        return this.cosineSimilarityJS(vecA, vecB);
      }
    }

    return this.cosineSimilarityJS(vecA, vecB);
  }

  private cosineSimilarityJS(vecA: Float32Array, vecB: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /** Async SIMD-accelerated cosine similarity. */
  public async cosineSimilaritySIMD(vecA: Float32Array, vecB: Float32Array): Promise<number> {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      console.warn('Cosine similarity: Invalid vectors provided.', vecA, vecB);
      return 0;
    }

    if (this.useSIMD && this.simdMath) {
      try {
        return await this.simdMath.cosineSimilarity(vecA, vecB);
      } catch (error) {
        console.warn('SIMD cosine similarity failed, falling back to JavaScript:', error);
      }
    }

    return this.cosineSimilarityJS(vecA, vecB);
  }

  public normalizeVector(vector: Float32Array): Float32Array {
    return semanticPolicy.normalizeSemanticVector(vector);
  }

  public validateInput(text1: string, text2: string | 'valid_dummy'): void {
    semanticPolicy.validateSemanticSimilarityInput(text1);
    if (text2 !== 'valid_dummy') {
      semanticPolicy.validateSemanticSimilarityInput(text2);
    }
    const roughCharLimit = this.config.maxLength * 5;
    if (
      text1.length > roughCharLimit ||
      (text2 !== 'valid_dummy' && text2.length > roughCharLimit)
    ) {
      console.warn('Input text may be too long; the tokenizer will truncate it.');
    }
  }

  private getCacheKey(text: string, _options: Record<string, any> = {}): string {
    return text; // Options currently not used to vary embedding, simplify key
  }

  public getPerformanceStats(): Record<string, any> {
    return {
      ...this.performanceStats,
      cacheStats: {
        ...this.cacheStats,
        embedding: {
          ...this.cacheStats.embedding,
          hitRate:
            this.cacheStats.embedding.hits + this.cacheStats.embedding.misses > 0
              ? this.cacheStats.embedding.hits /
                (this.cacheStats.embedding.hits + this.cacheStats.embedding.misses)
              : 0,
        },
        tokenization: {
          ...this.cacheStats.tokenization,
          hitRate:
            this.cacheStats.tokenization.hits + this.cacheStats.tokenization.misses > 0
              ? this.cacheStats.tokenization.hits /
                (this.cacheStats.tokenization.hits + this.cacheStats.tokenization.misses)
              : 0,
        },
      },
      memoryUsage: this.getMemoryUsage(),
      isInitialized: this.isInitialized,
      isInitializing: this.isInitializing,
      config: this.config,
      pendingWorkerTasks: this.workerTaskQueue.length,
      runningWorkerTasks: this.runningWorkerTasks,
    };
  }

  private async waitForWorkerSlot(): Promise<void> {
    return new Promise((resolve) => {
      this.workerTaskQueue.push(resolve);
    });
  }

  private processWorkerQueue(): void {
    if (this.workerTaskQueue.length > 0 && this.runningWorkerTasks < this.config.concurrentLimit) {
      const resolve = this.workerTaskQueue.shift();
      if (resolve) resolve();
    }
  }

  public async getWorkerStats(): Promise<WorkerStats | null> {
    if (!this.worker || !this.isInitialized) return null;

    try {
      const response = await this._sendMessageToWorker('getStats');
      return response as WorkerStats;
    } catch (error) {
      console.warn('Failed to get worker stats:', error);
      return null;
    }
  }

  public async clearWorkerBuffers(): Promise<void> {
    if (!this.worker || !this.isInitialized) return;

    try {
      await this._sendMessageToWorker('clearBuffers');
      console.log('SemanticSimilarityEngine: Worker buffers cleared.');
    } catch (error) {
      console.warn('Failed to clear worker buffers:', error);
    }
  }

  public clearAllCaches(): void {
    this.embeddingCache.clear();
    this.tokenizationCache.clear();
    this.cacheStats = {
      embedding: { hits: 0, misses: 0, size: 0 },
      tokenization: { hits: 0, misses: 0, size: 0 },
    };
    console.log('SemanticSimilarityEngine: All caches cleared.');
  }

  public getMemoryUsage(): {
    embeddingCacheUsage: number;
    tokenizationCacheUsage: number;
    totalCacheUsage: number;
  } {
    const embeddingStats = this.embeddingCache.getStats();
    const tokenizationStats = this.tokenizationCache.getStats();

    return {
      embeddingCacheUsage: embeddingStats.usage,
      tokenizationCacheUsage: tokenizationStats.usage,
      totalCacheUsage: (embeddingStats.usage + tokenizationStats.usage) / 2,
    };
  }

  public async dispose(): Promise<void> {
    console.log('SemanticSimilarityEngine: Disposing...');

    await this.clearWorkerBuffers();

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    if (this.simdMath) {
      this.simdMath.dispose();
      this.simdMath = null;
    }

    this.tokenizer = null;
    this.embeddingCache.clear();
    this.tokenizationCache.clear();
    this.pendingMessages.clear();
    this.workerTaskQueue = [];
    this.isInitialized = false;
    this.isInitializing = false;
    this.initPromise = null;
    this.useSIMD = false;
    console.log('SemanticSimilarityEngine: Disposed.');
  }
}
