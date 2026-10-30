/**
 * Persistent HNSW vector index with JavaScript document and tab mappings.
 */
import { loadHnswlib } from 'hnswlib-wasm-static';
import type { TextChunk } from './text-chunker';
import { INDEXER_HOST_MESSAGES } from '@/common/content-indexer-messages';

export interface VectorDocument {
  id: string;
  tabId: number;
  url: string;
  title: string;
  chunk: TextChunk;
  embedding: Float32Array;
  timestamp: number;
}

export interface SearchResult {
  document: VectorDocument;
  similarity: number;
  distance: number;
}

export interface VectorDatabaseConfig {
  dimension: number;
  maxElements: number;
  efConstruction: number;
  M: number;
  efSearch: number;
  indexFileName: string;
  enableAutoCleanup?: boolean;
  maxRetentionDays?: number;
}

const DB_NAME = 'VectorDatabaseStorage';
const DB_VERSION = 1;
const STORE_NAME = 'documentMappings';

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
  return promise;
}

interface PersistedMappings {
  documents: [number, VectorDocument][];
  tabDocuments: [number, number[]][];
  nextLabel?: number;
}

function persistedMappingFromStoredValue(value: unknown): PersistedMappings | null {
  if (isPersistedMappings(value)) return value;
  if (typeof value === 'object' && value !== null && 'data' in value) {
    return isPersistedMappings(value.data) ? value.data : null;
  }
  return null;
}

interface HnswVector {
  push_back(value: number): void;
  delete?(): void;
}

interface HnswSearchResult {
  neighbors: number[];
  distances: number[];
}

interface HnswIndex {
  initIndex(maxElements: number, m: number, efConstruction: number, randomSeed: number): void;
  setEfSearch(efSearch: number): void;
  readIndex(fileName: string, maxElements: number): Promise<void>;
  writeIndex(fileName: string): Promise<void>;
  deleteIndex(fileName: string): Promise<void>;
  getCurrentCount(): number;
  addPoint(
    vector: HnswVector | Float32Array | number[],
    label: number,
    replaceDeleted: boolean,
  ): void;
  searchKnn(
    vector: HnswVector | Float32Array | number[],
    topK: number,
    filter?: undefined,
  ): HnswSearchResult;
  markDelete(label: number): void;
}

interface HnswModule {
  EmscriptenFileSystemManager: {
    setDebugLogs(enabled: boolean): void;
    checkFileExists(fileName: string): boolean;
    deleteFile(fileName: string): void;
    syncFS(populate: boolean, callback: () => void): void;
  };
  VectorFloat?: new () => HnswVector;
  HierarchicalNSW: new (space: string, dimension: number, fileName: string) => HnswIndex;
}

let globalHnswlib: HnswModule | null = null;
let globalHnswlibInitPromise: Promise<HnswModule> | null = null;
let syncInProgress = false;
let pendingSyncPromise: Promise<void> | null = null;

const VECTOR_METADATA_PREFIX = 'hnswlib_document_mappings_';
const VECTOR_METADATA_KEYS = [
  `${VECTOR_METADATA_PREFIX}tab_content_index.dat`,
  `${VECTOR_METADATA_PREFIX}content_index.dat`,
  `${VECTOR_METADATA_PREFIX}vector_index.dat`,
] as const;

function vectorMetadataKey(indexFileName: string): string {
  return `${VECTOR_METADATA_PREFIX}${indexFileName}`;
}

function isPersistedMappings(value: unknown): value is PersistedMappings {
  return (
    typeof value === 'object' &&
    value !== null &&
    'documents' in value &&
    'tabDocuments' in value &&
    Array.isArray(value.documents) &&
    Array.isArray(value.tabDocuments) &&
    (!('nextLabel' in value) ||
      value.nextLabel === undefined ||
      typeof value.nextLabel === 'number')
  );
}

async function requestVectorMetadataHost(
  type:
    | typeof INDEXER_HOST_MESSAGES.GET_VECTOR_METADATA
    | typeof INDEXER_HOST_MESSAGES.SET_VECTOR_METADATA
    | typeof INDEXER_HOST_MESSAGES.REMOVE_VECTOR_METADATA,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const response: unknown = await chrome.runtime.sendMessage({
    target: 'background',
    type,
    ...payload,
  });

  if (
    typeof response !== 'object' ||
    response === null ||
    !('success' in response) ||
    response.success !== true
  ) {
    const error =
      typeof response === 'object' &&
      response !== null &&
      'error' in response &&
      typeof response.error === 'string'
        ? response.error
        : `Vector metadata host request failed: ${type}`;
    throw new Error(error);
  }

  return 'result' in response ? response.result : undefined;
}

async function getVectorMetadata(key: string): Promise<PersistedMappings | null> {
  const result = await requestVectorMetadataHost(INDEXER_HOST_MESSAGES.GET_VECTOR_METADATA, {
    key,
  });
  if (typeof result !== 'object' || result === null || !('value' in result)) return null;
  const mapping = persistedMappingFromStoredValue(result.value);
  if (result.value !== undefined && !mapping) {
    throw new Error(`Vector metadata host returned invalid mapping for ${key}`);
  }
  return mapping;
}

async function setVectorMetadata(key: string, value: PersistedMappings): Promise<void> {
  await requestVectorMetadataHost(INDEXER_HOST_MESSAGES.SET_VECTOR_METADATA, { key, value });
}

async function removeVectorMetadata(keys: readonly string[]): Promise<void> {
  await requestVectorMetadataHost(INDEXER_HOST_MESSAGES.REMOVE_VECTOR_METADATA, { keys });
}

class IndexedDBHelper {
  private static dbPromise: Promise<IDBDatabase> | null = null;

  private static async getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
      this.dbPromise = promise;
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('indexFileName', 'indexFileName', { unique: false });
        }
      };
    }
    return this.dbPromise;
  }

  static async saveData(indexFileName: string, data: PersistedMappings): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const complete = transactionCompletion(transaction);
    transaction
      .objectStore(STORE_NAME)
      .put({ id: indexFileName, indexFileName, data, timestamp: Date.now() });
    await complete;
  }

  static async loadData(indexFileName: string): Promise<PersistedMappings | null> {
    const db = await this.getDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const stored = await requestCompletion<unknown>(
      transaction.objectStore(STORE_NAME).get(indexFileName),
    );
    return persistedMappingFromStoredValue(stored);
  }

  static async deleteData(indexFileName: string): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const complete = transactionCompletion(transaction);
    transaction.objectStore(STORE_NAME).delete(indexFileName);
    await complete;
  }

  static async clearAllData(): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const complete = transactionCompletion(transaction);
    transaction.objectStore(STORE_NAME).clear();
    await complete;
  }
}

function requestCompletion<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

async function initializeGlobalHnswlib(): Promise<HnswModule> {
  if (globalHnswlib) return globalHnswlib;
  globalHnswlibInitPromise ??= loadHnswlib().then((module) => {
    // The package ships an untyped Emscripten module; this is the complete surface we use.
    const hnswlib = module as unknown as HnswModule;
    globalHnswlib = hnswlib;
    return hnswlib;
  });
  try {
    return await globalHnswlibInitPromise;
  } catch (error) {
    globalHnswlibInitPromise = null;
    throw error;
  }
}

async function syncGlobalFileSystem(direction: 'read' | 'write'): Promise<void> {
  if (!globalHnswlib) return;
  if (syncInProgress && pendingSyncPromise) return pendingSyncPromise;
  syncInProgress = true;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  pendingSyncPromise = promise;
  const timeout = setTimeout(() => reject(new Error('Sync timeout')), 5000);
  try {
    globalHnswlib.EmscriptenFileSystemManager.syncFS(direction === 'read', () => {
      clearTimeout(timeout);
      resolve();
    });
  } catch (error) {
    clearTimeout(timeout);
    reject(error);
  }
  try {
    await pendingSyncPromise;
  } catch (error) {
    console.warn(`VectorDatabase: Failed to sync filesystem (${direction}):`, error);
  } finally {
    syncInProgress = false;
    pendingSyncPromise = null;
  }
}

export class VectorDatabase {
  private index!: HnswIndex;
  private isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;
  private readonly documents = new Map<number, VectorDocument>();
  private readonly tabDocuments = new Map<number, Set<number>>();
  private readonly indexedPages = new Set<string>();
  private nextLabel = 0;
  private readonly config: VectorDatabaseConfig;

  constructor(config?: Partial<VectorDatabaseConfig>) {
    this.config = {
      dimension: 384,
      maxElements: 100000,
      efConstruction: 200,
      M: 48,
      efSearch: 50,
      indexFileName: 'tab_content_index.dat',
      enableAutoCleanup: true,
      maxRetentionDays: 30,
      ...config,
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.isInitializing && this.initPromise) return this.initPromise;
    this.isInitializing = true;
    this.initPromise = this.doInitialize().finally(() => {
      this.isInitializing = false;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      const hnswlib = await initializeGlobalHnswlib();
      hnswlib.EmscriptenFileSystemManager.setDebugLogs(false);
      this.index = new hnswlib.HierarchicalNSW(
        'cosine',
        this.config.dimension,
        this.config.indexFileName,
      );
      await this.syncFileSystem('read');
      if (hnswlib.EmscriptenFileSystemManager.checkFileExists(this.config.indexFileName)) {
        try {
          await this.index.readIndex(this.config.indexFileName, this.config.maxElements);
          this.index.setEfSearch(this.config.efSearch);
          await this.loadDocumentMappings();
          this.nextLabel =
            this.documents.size > 0
              ? Math.max(...this.documents.keys()) + 1
              : this.index.getCurrentCount();
        } catch (error) {
          console.warn('VectorDatabase: Failed to load existing index, creating new one:', error);
          this.initializeEmptyIndex();
        }
      } else {
        this.initializeEmptyIndex();
      }
      this.isInitialized = true;
    } catch (error) {
      this.isInitialized = false;
      throw error;
    }
  }

  private initializeEmptyIndex(): void {
    this.index.initIndex(this.config.maxElements, this.config.M, this.config.efConstruction, 200);
    this.index.setEfSearch(this.config.efSearch);
    this.documents.clear();
    this.tabDocuments.clear();
    this.indexedPages.clear();
    this.nextLabel = 0;
  }

  public async addDocument(
    tabId: number,
    url: string,
    title: string,
    chunk: TextChunk,
    embedding: Float32Array,
  ): Promise<number> {
    if (!this.isInitialized) await this.initialize();
    if (!embedding || embedding.length !== this.config.dimension) {
      throw new Error(
        `Invalid embedding dimension: expected ${this.config.dimension}, got ${embedding?.length || 0}`,
      );
    }
    for (let index = 0; index < embedding.length; index++) {
      if (!Number.isFinite(embedding[index]))
        throw new Error(`Invalid embedding value at index ${index}: ${embedding[index]}`);
    }
    const label = this.nextLabel++;
    await this.addPoint(embedding, label);
    const document: VectorDocument = {
      id: `tab_${tabId}_chunk_${chunk.index}_${Date.now()}`,
      tabId,
      url,
      title,
      chunk,
      embedding,
      timestamp: Date.now(),
    };
    this.documents.set(label, document);
    const labels = this.tabDocuments.get(tabId) ?? new Set<number>();
    labels.add(label);
    this.tabDocuments.set(tabId, labels);
    await this.saveIndex();
    await this.saveDocumentMappings();
    if (this.config.enableAutoCleanup) await this.checkAndPerformAutoCleanup();
    return label;
  }

  private async addPoint(embedding: Float32Array, label: number): Promise<void> {
    let vector: HnswVector | undefined;
    try {
      if (globalHnswlib?.VectorFloat) {
        vector = new globalHnswlib.VectorFloat();
        for (const value of embedding) vector.push_back(value);
        this.index.addPoint(vector, label, false);
        vector.delete?.();
      } else {
        this.index.addPoint(Array.from(embedding), label, false);
      }
    } catch {
      vector?.delete?.();
      try {
        this.index.addPoint(embedding, label, false);
      } catch {
        this.index.addPoint([...embedding], label, false);
      }
    }
  }

  public async search(queryEmbedding: Float32Array, topK = 10): Promise<SearchResult[]> {
    if (!this.isInitialized) await this.initialize();
    if (!queryEmbedding || queryEmbedding.length !== this.config.dimension) {
      throw new Error(
        `Invalid query embedding dimension: expected ${this.config.dimension}, got ${queryEmbedding?.length || 0}`,
      );
    }
    if (this.index.getCurrentCount() === 0) return [];
    if (this.documents.size === 0) {
      await this.loadDocumentMappings();
      if (this.documents.size === 0) return [];
    }
    const neighbors = this.searchNeighbors(queryEmbedding, topK);
    const results: SearchResult[] = [];
    for (let index = 0; index < neighbors.neighbors.length; index++) {
      const document = this.documents.get(neighbors.neighbors[index]);
      if (document)
        results.push({
          document,
          distance: neighbors.distances[index],
          similarity: 1 - neighbors.distances[index],
        });
    }
    return results.sort((left, right) => right.similarity - left.similarity);
  }

  private searchNeighbors(queryEmbedding: Float32Array, topK: number): HnswSearchResult {
    let vector: HnswVector | undefined;
    try {
      if (globalHnswlib?.VectorFloat) {
        vector = new globalHnswlib.VectorFloat();
        for (const value of queryEmbedding) vector.push_back(value);
        const result = this.index.searchKnn(vector, topK, undefined);
        vector.delete?.();
        return result;
      }
      return this.index.searchKnn(Array.from(queryEmbedding), topK, undefined);
    } catch {
      vector?.delete?.();
      try {
        return this.index.searchKnn(queryEmbedding, topK, undefined);
      } catch {
        return this.index.searchKnn([...queryEmbedding], topK, undefined);
      }
    }
  }

  public async removeTabDocuments(tabId: number): Promise<void> {
    if (!this.isInitialized) await this.initialize();
    const labels = this.tabDocuments.get(tabId);
    if (!labels) return;
    for (const label of labels) this.removeDocumentByLabel(label);
    await this.saveDocumentMappings();
  }

  public hasIndexedPage(url: string, title: string): boolean {
    return this.indexedPages.has(`${url}_${title}`);
  }

  public markIndexedPage(url: string, title: string): void {
    this.indexedPages.add(`${url}_${title}`);
  }

  public clearIndexedPages(): void {
    this.indexedPages.clear();
  }

  public indexedPageCount(): number {
    return this.indexedPages.size;
  }

  public getStats(): {
    totalDocuments: number;
    totalTabs: number;
    indexSize: number;
    isInitialized: boolean;
  } {
    return {
      totalDocuments: this.documents.size,
      totalTabs: this.tabDocuments.size,
      indexSize: this.documents.size * (this.config.dimension * 4 + 64),
      isInitialized: this.isInitialized,
    };
  }

  public async clear(): Promise<void> {
    this.documents.clear();
    this.tabDocuments.clear();
    this.indexedPages.clear();
    this.nextLabel = 0;
    if (this.isInitialized && this.index) {
      try {
        if (globalHnswlib?.EmscriptenFileSystemManager.checkFileExists(this.config.indexFileName)) {
          globalHnswlib.EmscriptenFileSystemManager.deleteFile(this.config.indexFileName);
          await this.syncFileSystem('write');
        }
        await this.index.deleteIndex(this.config.indexFileName);
      } catch (error) {
        console.warn('VectorDatabase: Failed to clear HNSW index file:', error);
      }
      this.initializeEmptyIndex();
      await this.forceSaveIndex();
    }
    try {
      await IndexedDBHelper.deleteData(this.config.indexFileName);
    } catch {
      await removeVectorMetadata([vectorMetadataKey(this.config.indexFileName)]);
    }
    await this.saveDocumentMappings();
  }

  private async checkAndPerformAutoCleanup(): Promise<void> {
    const labels: number[] = [];
    if (this.documents.size >= this.config.maxElements) {
      labels.push(
        ...[...this.documents.entries()]
          .sort((left, right) => left[1].timestamp - right[1].timestamp)
          .slice(0, Math.floor(this.config.maxElements * 0.2))
          .map(([label]) => label),
      );
    }
    if (this.config.maxRetentionDays && this.config.maxRetentionDays > 0) {
      const cutoff = Date.now() - this.config.maxRetentionDays * 86_400_000;
      labels.push(
        ...[...this.documents]
          .filter(([, document]) => document.timestamp < cutoff)
          .map(([label]) => label),
      );
    }
    if (labels.length === 0) return;
    for (const label of new Set(labels)) this.removeDocumentByLabel(label);
    await this.saveIndex();
    await this.saveDocumentMappings();
  }

  private removeDocumentByLabel(label: number): void {
    const document = this.documents.get(label);
    if (!document) return;
    try {
      this.index.markDelete(label);
    } catch (error) {
      console.warn(`VectorDatabase: Failed to mark delete in index for label ${label}:`, error);
    }
    this.documents.delete(label);
    const labels = this.tabDocuments.get(document.tabId);
    labels?.delete(label);
    if (labels?.size === 0) this.tabDocuments.delete(document.tabId);
  }

  private async forceSaveIndex(): Promise<void> {
    try {
      await this.index.writeIndex(this.config.indexFileName);
      await this.syncFileSystem('write');
    } catch (error) {
      console.error('VectorDatabase: Failed to force save index:', error);
    }
  }

  private async saveIndex(): Promise<void> {
    try {
      await this.index.writeIndex(this.config.indexFileName);
      if (this.documents.size % 10 === 0) await this.syncFileSystem('write');
    } catch (error) {
      console.error('VectorDatabase: Failed to save index:', error);
    }
  }

  private async saveDocumentMappings(): Promise<void> {
    const mapping: PersistedMappings = {
      documents: [...this.documents],
      tabDocuments: [...this.tabDocuments].map(([tabId, labels]) => [tabId, [...labels]]),
      nextLabel: this.nextLabel,
    };
    try {
      await IndexedDBHelper.saveData(this.config.indexFileName, mapping);
    } catch (error) {
      console.warn(
        'VectorDatabase: Failed to save to IndexedDB, falling back to metadata host:',
        error,
      );
      await setVectorMetadata(vectorMetadataKey(this.config.indexFileName), mapping);
    }
  }

  public async loadDocumentMappings(): Promise<void> {
    let mapping: PersistedMappings | null = null;
    try {
      mapping = await IndexedDBHelper.loadData(this.config.indexFileName);
    } catch (error) {
      console.warn('VectorDatabase: Failed to read IndexedDB mappings:', error);
    }
    if (!mapping) {
      try {
        mapping = await getVectorMetadata(vectorMetadataKey(this.config.indexFileName));
        if (mapping) await IndexedDBHelper.saveData(this.config.indexFileName, mapping);
      } catch (error) {
        console.warn('VectorDatabase: Failed to read metadata host mapping:', error);
      }
    }
    if (!mapping) return;
    this.documents.clear();
    this.tabDocuments.clear();
    for (const [label, document] of mapping.documents) this.documents.set(label, document);
    for (const [tabId, labels] of mapping.tabDocuments)
      this.tabDocuments.set(tabId, new Set(labels));
    this.nextLabel =
      mapping.nextLabel ?? (this.documents.size ? Math.max(...this.documents.keys()) + 1 : 0);
  }

  private async syncFileSystem(direction: 'read' | 'write'): Promise<void> {
    await syncGlobalFileSystem(direction);
  }
}

let globalVectorDatabase: VectorDatabase | null = null;
let currentDimension: number | null = null;

export async function getGlobalVectorDatabase(
  config?: Partial<VectorDatabaseConfig>,
): Promise<VectorDatabase> {
  const dimension = config?.dimension || 384;
  if (globalVectorDatabase && currentDimension !== null && currentDimension !== dimension) {
    await globalVectorDatabase.clear();
    globalVectorDatabase = null;
  }
  if (!globalVectorDatabase) {
    globalVectorDatabase = new VectorDatabase(config);
    currentDimension = dimension;
  }
  await globalVectorDatabase.initialize();
  return globalVectorDatabase;
}

export function getGlobalVectorDatabaseSync(
  config?: Partial<VectorDatabaseConfig>,
): VectorDatabase {
  const dimension = config?.dimension || 384;
  if (!globalVectorDatabase) {
    globalVectorDatabase = new VectorDatabase(config);
    currentDimension = dimension;
  }
  return globalVectorDatabase;
}

export async function resetGlobalVectorDatabase(): Promise<void> {
  if (globalVectorDatabase) await globalVectorDatabase.clear();
  globalVectorDatabase = null;
  currentDimension = null;
}

export async function clearAllVectorData(): Promise<void> {
  await resetGlobalVectorDatabase();
  try {
    await IndexedDBHelper.clearAllData();
  } catch (error) {
    console.warn('VectorDatabase: Failed to clear document mappings:', error);
  }
  await initializeGlobalHnswlib();
  await syncGlobalFileSystem('read');
  for (const fileName of ['tab_content_index.dat', 'content_index.dat', 'vector_index.dat']) {
    try {
      if (globalHnswlib?.EmscriptenFileSystemManager.checkFileExists(fileName)) {
        globalHnswlib.EmscriptenFileSystemManager.deleteFile(fileName);
      }
    } catch (error) {
      console.warn(`VectorDatabase: Failed to delete ${fileName}:`, error);
    }
  }
  await syncGlobalFileSystem('write');
  await removeVectorMetadata(VECTOR_METADATA_KEYS);
}
