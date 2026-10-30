import type { SemanticIndex as WasmSemanticIndex } from '../generated/humanchrome_wasm';
import { getRustKernel } from './rust-bindings';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface TextChunk {
  text: string;
  source: string;
  index: number;
  wordCount: number;
}

export interface ChunkingOptions {
  maxWordsPerChunk?: number;
  overlapSentences?: number;
  minChunkLength?: number;
  includeTitle?: boolean;
}

export interface SemanticDocument {
  id: string;
  tabId: number;
  url: string;
  title: string;
  chunk: TextChunk;
  embedding: Float32Array;
  timestamp: number;
}

export interface PersistedSemanticIndex {
  documents: Array<[number, SemanticDocument]>;
  tabDocuments: Array<[number, number[]]>;
  nextLabel?: number;
}

export interface AutoCleanupPlan {
  leastRecentlyUsedLabels: number[];
  expiredLabels: number[];
}

export interface AnnNeighbor {
  label: number;
  distance: number;
}

export interface TabSearchResult {
  tabId: number;
  url: string;
  title: string;
  semanticScore: number;
  matchedSnippet: string;
  chunkSource: string;
  timestamp: number;
}

export type EmbeddingBatchMode = 'offscreen' | 'directWorker';

export interface EmbeddingBatchPlan {
  inferenceInputIndices: number[];
  resultSources: Array<{ kind: 'cachedInput' | 'inferenceResponse'; index: number }>;
}

export interface SimilarityPair {
  text1: string;
  text2: string;
}

export type PairSimilarityExecutionPlan =
  | { kind: 'offscreen' }
  | { kind: 'directWorker'; uniqueTexts: string[]; pairEmbeddingIndices: Array<[number, number]> };

export interface SimilarityMatrixPlan {
  uniqueTexts: string[];
  leftEmbeddingIndices: number[];
  rightEmbeddingIndices: number[];
}

export interface VectorStorageSize {
  documentMappings: number;
  vectors: number;
  indexStructure: number;
  total: number;
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

function persistedProjection(value: PersistedSemanticIndex): Omit<PersistedSemanticIndex, 'documents'> & {
  documents: Array<[number, Omit<SemanticDocument, 'embedding'> & { embedding: number[] }]>;
} {
  return {
    ...value,
    documents: value.documents.map(([label, document]) => [
      label,
      { ...document, embedding: Array.from(document.embedding) },
    ]),
  };
}

/** Owns reusable Rust document-map and pooling state while host effects remain outside this facade. */
export class RustSemanticIndex {
  readonly #handle: WasmSemanticIndex;

  constructor() {
    const kernel = getRustKernel();
    this.#handle = new kernel.SemanticIndex();
  }

  restore(value: PersistedSemanticIndex): void {
    this.#handle.restore(encode(persistedProjection(value)));
  }

  snapshot(): PersistedSemanticIndex {
    const value = decode<Omit<PersistedSemanticIndex, 'documents'> & {
      documents: Array<[number, Omit<SemanticDocument, 'embedding'> & { embedding: number[] }]>;
    }>(this.#handle.snapshot());
    return {
      ...value,
      documents: value.documents.map(([label, document]) => [
        label,
        { ...document, embedding: new Float32Array(document.embedding) },
      ]),
    };
  }

  documentCount(): number {
    return this.#handle.document_count();
  }

  tabCount(): number {
    return this.#handle.tab_count();
  }

  /**
   * Reconciles label allocation after the retained HNSW index opens.
   *
   * HNSW remains the host resource; Rust preserves the legacy mapped-versus-unmapped
   * next-label decision.
   */
  applyInitializedIndexCount(indexCount: number): void {
    this.#handle.apply_initialized_index_count(indexCount);
  }

  reserveLabel(): number {
    return this.#handle.reserve_label();
  }

  hasIndexedPage(url: string, title: string): boolean {
    return this.#handle.has_indexed_page(encode(url), encode(title));
  }

  markIndexedPage(url: string, title: string): void {
    this.#handle.mark_indexed_page(encode(url), encode(title));
  }

  clearIndexedPages(): void {
    this.#handle.clear_indexed_pages();
  }

  indexedPageCount(): number {
    return this.#handle.indexed_page_count();
  }

  commitDocument(label: number, document: Omit<SemanticDocument, 'embedding'>, embedding: Float32Array): void {
    this.#handle.commit_document(label, encode(document), embedding);
  }

  removeTab(tabId: number): number[] {
    return decode<number[]>(this.#handle.remove_tab(BigInt(tabId)));
  }

  removeLabel(label: number): SemanticDocument | undefined {
    const value = this.#handle.remove_label(label);
    if (value === undefined) return undefined;
    const document = decode<Omit<SemanticDocument, 'embedding'> & { embedding: number[] }>(value);
    return { ...document, embedding: new Float32Array(document.embedding) };
  }

  autoCleanupPlan(maxElements: number, maxRetentionDays: number | undefined, nowMs: number): AutoCleanupPlan {
    return decode<AutoCleanupPlan>(this.#handle.auto_cleanup_plan(maxElements, maxRetentionDays, BigInt(nowMs)));
  }

  searchResults(neighbors: AnnNeighbor[]): TabSearchResult[] {
    return decode<TabSearchResult[]>(this.#handle.search_results(encode(neighbors)));
  }

  meanPoolNormalized(
    hiddenState: Float32Array,
    attentionMask: Int32Array,
    batchSize: number,
    sequenceLength: number,
    hiddenSize: number,
  ): Float32Array {
    return this.#handle.mean_pool_normalized(hiddenState, attentionMask, batchSize, sequenceLength, hiddenSize);
  }
}

/** Chooses the raw ANN request count in the policy owner, not in the HNSW adapter. */
export function semanticAnnCandidateCount(requested?: number): number {
  return getRustKernel().semantic_ann_candidate_count(requested);
}

/** Chunks page content with the portable UTF-16 policy before host inference. */
export function semanticChunkText(content: string, title?: string, options?: ChunkingOptions): TextChunk[] {
  return decode<TextChunk[]>(getRustKernel().semantic_chunk_text(encode({ content, title, options })));
}

/** Applies the configured page chunk cap in Rust before host embedding requests. */
export function semanticChunksForIndexing(
  content: string,
  maxChunksPerPage: number,
  title?: string,
  options?: ChunkingOptions,
): TextChunk[] {
  return decode<TextChunk[]>(
    getRustKernel().semantic_chunks_for_indexing(encode({ content, title, options }), maxChunksPerPage),
  );
}

/** Returns the existing raw URL/title duplicate key. */
export function semanticIndexedPageKey(url: string, title: string): string {
  return decode<string>(getRustKernel().semantic_indexed_page_key(encode(url), encode(title)));
}

/** Uses Rust content-index URL eligibility policy without URL rewriting. */
export function isSemanticIndexableContentUrl(url: string): boolean {
  return getRustKernel().semantic_is_indexable_content_url(encode(url));
}

/** Uses Rust rebuild-index URL eligibility policy without URL rewriting. */
export function isSemanticRebuildIndexableUrl(url: string): boolean {
  return getRustKernel().semantic_is_rebuild_indexable_url(encode(url));
}

/** Checks the contiguous Float32 batch shape expected by retained SIMD adapters. */
export function isValidSemanticContiguousBatch(vectors: Float32Array, dimension: number): boolean {
  return getRustKernel().semantic_is_valid_contiguous_batch(vectors, dimension);
}

/** Computes the synchronous scalar compatibility cosine primitive. */
export function semanticCosineSimilarity(left: Float32Array, right: Float32Array): number {
  return getRustKernel().semantic_cosine_similarity(left, right);
}

/** Normalizes an owned Float32 vector while preserving zero vectors. */
export function normalizeSemanticVector(vector: Float32Array): Float32Array {
  return getRustKernel().semantic_normalize_vector(vector);
}

/** Validates one vector before it reaches the retained HNSW adapter. */
export function validateSemanticEmbedding(embedding: Float32Array, dimension: number): void {
  getRustKernel().semantic_validate_embedding(embedding, dimension);
}

/** Validates one query vector before it reaches the retained HNSW adapter. */
export function validateSemanticQueryEmbedding(embedding: Float32Array, dimension: number): void {
  getRustKernel().semantic_validate_query_embedding(embedding, dimension);
}

/** Validates raw host similarity input while preserving non-string versus empty text errors. */
export function validateSemanticSimilarityInput(value: unknown): void {
  getRustKernel().semantic_validate_similarity_input(encode(value));
}

/** Plans cache hits, direct-worker deduplication, and inference result reconstruction indexes. */
export function planSemanticEmbeddingBatch(
  texts: string[],
  cacheHits: boolean[],
  mode: EmbeddingBatchMode,
): EmbeddingBatchPlan | undefined {
  const result = getRustKernel().semantic_plan_embedding_batch(encode(texts), encode(cacheHits), mode);
  return result === undefined ? undefined : decode<EmbeddingBatchPlan>(result);
}

/** Keeps offscreen pairs untouched while Rust owns direct-worker deduplication. */
export function planSemanticSimilarityPairs(
  pairs: SimilarityPair[],
  mode: EmbeddingBatchMode,
): PairSimilarityExecutionPlan {
  return decode<PairSimilarityExecutionPlan>(getRustKernel().semantic_plan_similarity_pairs(encode(pairs), mode));
}

/** Plans one ordered deduplicated embedding batch for an all-pairs similarity matrix. */
export function planSemanticSimilarityMatrix(left: string[], right: string[]): SimilarityMatrixPlan {
  return decode<SimilarityMatrixPlan>(getRustKernel().semantic_plan_similarity_matrix(encode(left), encode(right)));
}

/** Reconstructs direct-worker pair scores from contiguous embeddings without cloning rows. */
export function semanticPairSimilarityScores(
  pairs: SimilarityPair[],
  embeddings: Float32Array,
  dimension: number,
): number[] {
  return decode<number[]>(
    getRustKernel().semantic_pair_similarity_scores(encode(pairs), embeddings, dimension),
  );
}

/** Reconstructs a direct-worker matrix from contiguous first-occurrence ordered embeddings. */
export function semanticSimilarityMatrixScores(
  left: string[],
  right: string[],
  embeddings: Float32Array,
  dimension: number,
): number[][] {
  return decode<number[][]>(
    getRustKernel().semantic_similarity_matrix_scores(encode(left), encode(right), embeddings, dimension),
  );
}

/** Estimates persisted document-map and HNSW storage from host stringify-length observations. */
export function estimateSemanticStorage(
  documentJsonUtf16Lengths: number[],
  tabLabelCounts: number[],
  dimension: number,
): VectorStorageSize {
  return decode<VectorStorageSize>(
    getRustKernel().semantic_estimate_storage(
      encode(documentJsonUtf16Lengths),
      encode(tabLabelCounts),
      dimension,
    ),
  );
}

/** Builds the host-time document identifier without reading browser clocks in Rust. */
export function semanticDocumentId(tabId: number, chunkIndex: number, nowMs: number): string {
  return getRustKernel().semantic_document_id(BigInt(tabId), chunkIndex, BigInt(nowMs));
}
