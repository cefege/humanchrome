//! Portable semantic-index policy while browser hosts retain inference, ANN, and persistence effects.

use std::cmp::Ordering;

use indexmap::{IndexMap, IndexSet};

use crate::arguments::JsString;

/// The number of ANN candidates requested before collapsing chunks into tab results.
pub const TAB_SEARCH_CANDIDATE_LIMIT: usize = 50;
/// The maximum number of tab results returned by the browser tool.
pub const TAB_SEARCH_RESULT_LIMIT: usize = 10;

/// Controls whether a page title becomes its own embedding chunk.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TitleInclusion {
    /// Add a title chunk when its trimmed UTF-16 length exceeds five units.
    #[default]
    Include,
    /// Never add a separate title chunk.
    Exclude,
}

/// Settings for the browser's portable text chunking policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkingOptions {
    /// Maximum whitespace-separated words collected into a normal chunk.
    pub max_words_per_chunk: usize,
    /// Number of trailing sentences repeated in the next normal chunk.
    pub overlap_sentences: usize,
    /// Strict UTF-16 length threshold for chunks that opt into a minimum.
    pub min_chunk_length: usize,
    /// Whether a qualifying title is represented as a separate chunk.
    pub title_inclusion: TitleInclusion,
}

impl Default for ChunkingOptions {
    fn default() -> Self {
        Self {
            max_words_per_chunk: 80,
            overlap_sentences: 1,
            min_chunk_length: 20,
            title_inclusion: TitleInclusion::Include,
        }
    }
}

/// One serializable text fragment passed to the embedding host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextChunk {
    /// Fragment contents, retaining JavaScript UTF-16 units when necessary.
    pub text: JsString,
    /// Existing browser-visible chunk source label.
    pub source: String,
    /// Existing browser-visible chunk index.
    pub index: usize,
    /// Existing browser-visible whitespace-separated word count.
    pub word_count: usize,
}

/// Splits page text according to the existing `TextChunker` policy.
///
/// The implementation operates on UTF-16 units so JavaScript length, `substring`, and lone
/// surrogate behavior remain observable at the WASM boundary.
#[must_use]
pub fn chunk_text(
    content: &JsString,
    title: Option<&JsString>,
    options: ChunkingOptions,
) -> Vec<TextChunk> {
    let mut chunks = Vec::new();
    if options.title_inclusion == TitleInclusion::Include
        && let Some(title) = title
    {
        let trimmed = trim_ecmascript(&js_units(title));
        if !trimmed.is_empty() && trimmed.len() > 5 {
            chunks.push(TextChunk {
                word_count: word_count(&trimmed),
                text: js_string_from_units(trimmed),
                source: "title".to_owned(),
                index: 0,
            });
        }
    }

    let clean_content = trim_ecmascript(&js_units(content));
    if clean_content.is_empty() {
        return chunks;
    }

    let sentences = split_into_sentences(&clean_content);
    if sentences.is_empty() {
        return fallback_chunks(&clean_content, chunks, options);
    }

    if sentences
        .iter()
        .any(|sentence| word_count(sentence) > options.max_words_per_chunk)
    {
        return mixed_chunks(&sentences, chunks, options);
    }
    grouped_chunks(&sentences, chunks, options)
}

/// Limits a page's generated chunks before the host requests embeddings.
#[must_use]
pub fn chunks_for_indexing(chunks: &[TextChunk], max_chunks_per_page: usize) -> &[TextChunk] {
    &chunks[..chunks.len().min(max_chunks_per_page)]
}

/// Constructs the browser's duplicate-index key without applying URL normalization.
#[must_use]
pub fn indexed_page_key(url: &JsString, title: &JsString) -> JsString {
    let mut key = url.clone();
    key.push_str("_");
    key.push_js_string(title);
    key
}

/// Tracks already-indexed page keys without browser storage or timer effects.
#[derive(Clone, Debug, Default)]
pub struct IndexedPages {
    pages: IndexSet<JsString>,
}

impl IndexedPages {
    /// Returns whether the exact URL/title pair has already been recorded.
    #[must_use]
    pub fn contains(&self, url: &JsString, title: &JsString) -> bool {
        self.pages.contains(&indexed_page_key(url, title))
    }

    /// Records a page after all of its selected chunks have been offered to the host.
    pub fn insert(&mut self, url: &JsString, title: &JsString) {
        self.pages.insert(indexed_page_key(url, title));
    }

    /// Clears remembered page keys during a model switch or full index clear.
    pub fn clear(&mut self) {
        self.pages.clear();
    }

    /// Returns the browser-visible indexed-page count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.pages.len()
    }

    /// Returns whether no pages have been recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }
}

/// Gives the browser host its unchanged page-index eligibility decision.
#[must_use]
pub fn is_indexable_content_url(url: &str) -> bool {
    ![
        "chrome://",
        "chrome-extension://",
        "edge://",
        "about:",
        "moz-extension://",
        "file:",
    ]
    .iter()
    .any(|prefix| url.starts_with(prefix))
}

/// Gives the browser host its existing rebuild-index eligibility decision.
#[must_use]
pub fn is_rebuild_indexable_url(url: &str) -> bool {
    !["chrome://", "chrome-extension://", "edge://", "about:"]
        .iter()
        .any(|prefix| url.starts_with(prefix))
}

/// Identifies a chunk in the browser's persisted HNSW document mapping.
#[derive(Clone, Debug, PartialEq)]
pub struct VectorDocument {
    /// Browser-visible document identifier.
    pub id: String,
    /// Owning browser tab.
    pub tab_id: i64,
    /// Source page URL.
    pub url: JsString,
    /// Source page title.
    pub title: JsString,
    /// Chunk metadata and text.
    pub chunk: TextChunk,
    /// Contiguous embedding values retained in the existing document-map shape.
    pub embedding: Vec<f32>,
    /// Timestamp supplied by the host instead of reading a clock in policy code.
    pub timestamp_ms: i64,
}

/// Search-result metadata projected without copying the stored embedding.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchDocument {
    /// Browser-visible document identifier.
    pub id: String,
    /// Owning browser tab.
    pub tab_id: i64,
    /// Source page URL.
    pub url: JsString,
    /// Source page title.
    pub title: JsString,
    /// Chunk metadata and text.
    pub chunk: TextChunk,
    /// Original document timestamp.
    pub timestamp_ms: i64,
}

impl VectorDocument {
    /// Projects search-visible metadata without cloning the document's vector allocation.
    #[must_use]
    pub fn search_document(&self) -> SearchDocument {
        SearchDocument {
            id: self.id.clone(),
            tab_id: self.tab_id,
            url: self.url.clone(),
            title: self.title.clone(),
            chunk: self.chunk.clone(),
            timestamp_ms: self.timestamp_ms,
        }
    }
}

/// A mapped ANN neighbor with its original cosine distance and derived score.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    /// Matching document metadata, deliberately excluding its stored embedding.
    pub document: SearchDocument,
    /// `1 - distance`, matching the browser's cosine-distance conversion.
    pub similarity: f64,
    /// Original HNSW distance.
    pub distance: f64,
}

/// A raw neighbor returned by the retained HNSW adapter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnnNeighbor {
    /// HNSW's document label.
    pub label: u32,
    /// HNSW's cosine distance.
    pub distance: f64,
}

/// A browser-tool row after the existing per-tab collapse and snippet policy.
#[derive(Clone, Debug, PartialEq)]
pub struct TabSearchResult {
    /// Matching browser tab.
    pub tab_id: i64,
    /// Indexed page URL.
    pub url: JsString,
    /// Indexed page title.
    pub title: JsString,
    /// The selected chunk's `1 - distance` score.
    pub semantic_score: f64,
    /// Readable preview from the selected chunk.
    pub matched_snippet: JsString,
    /// Original chunk source label.
    pub chunk_source: String,
    /// Original document timestamp.
    pub timestamp_ms: i64,
}

/// Documents selected for the browser's existing automatic-retention pass.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AutoCleanupPlan {
    /// Oldest entries removed when the mapping reaches its element cap.
    pub least_recently_used_labels: Vec<u32>,
    /// Remaining entries older than the configured retention cutoff.
    pub expired_labels: Vec<u32>,
}

/// Builds the existing time-dependent document identifier without accessing a global clock.
#[must_use]
pub fn document_id(tab_id: i64, chunk_index: usize, now_ms: i64) -> String {
    format!("tab_{tab_id}_chunk_{chunk_index}_{now_ms}")
}

/// Validates a model embedding before the retained HNSW adapter receives it.
///
/// # Errors
///
/// Returns the browser's existing dimension or non-finite-value error wording.
pub fn validate_embedding(vector: &[f32], dimension: usize) -> Result<(), SemanticPolicyError> {
    if vector.len() != dimension {
        return Err(SemanticPolicyError::invalid_embedding_dimension(
            dimension,
            vector.len(),
        ));
    }
    for (index, value) in vector.iter().copied().enumerate() {
        if !value.is_finite() {
            return Err(SemanticPolicyError::invalid_embedding_value(index, value));
        }
    }
    Ok(())
}

/// Validates a query embedding before the retained HNSW adapter receives it.
///
/// # Errors
///
/// Returns the browser's existing dimension or non-finite-value error wording.
pub fn validate_query_embedding(
    vector: &[f32],
    dimension: usize,
) -> Result<(), SemanticPolicyError> {
    if vector.len() != dimension {
        return Err(SemanticPolicyError::invalid_query_dimension(
            dimension,
            vector.len(),
        ));
    }
    for (index, value) in vector.iter().copied().enumerate() {
        if !value.is_finite() {
            return Err(SemanticPolicyError::invalid_query_value(index, value));
        }
    }
    Ok(())
}

/// Holds browser document-map decisions while HNSW and IndexedDB remain host effects.
#[derive(Clone, Debug, Default)]
pub struct VectorDocumentMap {
    documents: IndexMap<u32, VectorDocument>,
    tab_documents: IndexMap<i64, IndexSet<u32>>,
    next_label: u32,
}

impl VectorDocumentMap {
    /// Restores the browser's saved mapping shape without changing its on-disk format.
    #[must_use]
    pub fn from_persisted<D, T, L>(
        documents: D,
        tab_documents: T,
        saved_next_label: Option<u32>,
    ) -> Self
    where
        D: IntoIterator<Item = (u32, VectorDocument)>,
        T: IntoIterator<Item = (i64, L)>,
        L: IntoIterator<Item = u32>,
    {
        let documents: IndexMap<u32, VectorDocument> = documents.into_iter().collect();
        let tab_documents = tab_documents
            .into_iter()
            .map(|(tab_id, labels)| (tab_id, labels.into_iter().collect()))
            .collect();
        let next_label = saved_next_label.unwrap_or_else(|| next_label_after(&documents));
        Self {
            documents,
            tab_documents,
            next_label,
        }
    }

    /// Applies the initialization rule that recalculates labels from mapped documents.
    pub fn apply_initialized_index_count(&mut self, index_count: u32) {
        self.next_label = if self.documents.is_empty() {
            index_count
        } else {
            next_label_after(&self.documents)
        };
    }

    /// Reserves the next label before the host submits a vector to HNSW.
    ///
    /// The reservation intentionally persists when the host ANN call fails, matching JavaScript's
    /// post-increment expression before `addPoint`.
    pub fn reserve_label(&mut self) -> u32 {
        let label = self.next_label;
        self.next_label = self.next_label.wrapping_add(1);
        label
    }

    /// Commits metadata only after the host has successfully added its vector to HNSW.
    pub fn insert(&mut self, label: u32, document: VectorDocument) {
        let tab_id = document.tab_id;
        self.documents.insert(label, document);
        self.tab_documents.entry(tab_id).or_default().insert(label);
    }

    /// Removes tab mappings without marking HNSW entries deleted, matching `removeTabDocuments`.
    pub fn remove_tab(&mut self, tab_id: i64) -> Vec<u32> {
        let Some(labels) = self.tab_documents.shift_remove(&tab_id) else {
            return Vec::new();
        };
        let labels: Vec<u32> = labels.into_iter().collect();
        for label in &labels {
            self.documents.shift_remove(label);
        }
        labels
    }

    /// Removes one document mapping and returns it for the host's mark-delete effect.
    pub fn remove_label(&mut self, label: u32) -> Option<VectorDocument> {
        let document = self.documents.shift_remove(&label)?;
        if let Some(labels) = self.tab_documents.get_mut(&document.tab_id) {
            labels.shift_remove(&label);
            if labels.is_empty() {
                self.tab_documents.shift_remove(&document.tab_id);
            }
        }
        Some(document)
    }

    /// Selects the oldest labels using JavaScript's stable timestamp-only ordering.
    #[must_use]
    pub fn oldest_labels(&self, count: usize) -> Vec<u32> {
        let mut entries: Vec<(u32, &VectorDocument)> = self
            .documents
            .iter()
            .map(|(label, document)| (*label, document))
            .collect();
        entries.sort_by_key(|(_, document)| document.timestamp_ms);
        entries
            .into_iter()
            .take(count)
            .map(|(label, _)| label)
            .collect()
    }

    /// Selects labels with timestamps strictly before the supplied cutoff.
    #[must_use]
    pub fn expired_labels(&self, cutoff_ms: i64) -> Vec<u32> {
        self.documents
            .iter()
            .filter_map(|(label, document)| (document.timestamp_ms < cutoff_ms).then_some(*label))
            .collect()
    }

    /// Computes automatic cleanup labels with host-supplied current time.
    #[must_use]
    pub fn auto_cleanup_plan(
        &self,
        max_elements: usize,
        max_retention_days: Option<f64>,
        now_ms: i64,
    ) -> AutoCleanupPlan {
        let least_recently_used_labels = if self.documents.len() >= max_elements {
            self.oldest_labels(max_elements / 5)
        } else {
            Vec::new()
        };
        let least_recently_used: IndexSet<u32> =
            least_recently_used_labels.iter().copied().collect();
        let expired_labels = max_retention_days
            .filter(|days| *days > 0.0)
            .map(|days| {
                let cutoff = now_ms as f64 - days * 24.0 * 60.0 * 60.0 * 1000.0;
                self.documents
                    .iter()
                    .filter_map(|(label, document)| {
                        (!least_recently_used.contains(label)
                            && (document.timestamp_ms as f64) < cutoff)
                            .then_some(*label)
                    })
                    .collect()
            })
            .unwrap_or_default();
        AutoCleanupPlan {
            least_recently_used_labels,
            expired_labels,
        }
    }

    /// Maps and stably ranks raw ANN neighbors, ignoring labels missing from persisted metadata.
    #[must_use]
    pub fn resolve_neighbors(&self, neighbors: &[AnnNeighbor]) -> Vec<SearchHit> {
        let mut results: Vec<SearchHit> = neighbors
            .iter()
            .filter_map(|neighbor| {
                self.documents
                    .get(&neighbor.label)
                    .map(|document| SearchHit {
                        document: document.search_document(),
                        similarity: 1.0 - neighbor.distance,
                        distance: neighbor.distance,
                    })
            })
            .collect();
        results.sort_by(|left, right| javascript_descending(left.similarity, right.similarity));
        results
    }

    /// Iterates persisted documents in insertion order without cloning their embeddings.
    pub fn document_entries(&self) -> impl ExactSizeIterator<Item = (u32, &VectorDocument)> + '_ {
        self.documents
            .iter()
            .map(|(label, document)| (*label, document))
    }

    /// Iterates persisted tab-label mappings in insertion order without cloning label sets.
    pub fn tab_document_entries(
        &self,
    ) -> impl ExactSizeIterator<Item = (i64, &IndexSet<u32>)> + '_ {
        self.tab_documents
            .iter()
            .map(|(tab_id, labels)| (*tab_id, labels))
    }

    /// Returns the next browser HNSW label.
    #[must_use]
    pub fn next_label(&self) -> u32 {
        self.next_label
    }

    /// Returns the mapped document count.
    #[must_use]
    pub fn document_count(&self) -> usize {
        self.documents.len()
    }

    /// Returns the mapped tab count.
    #[must_use]
    pub fn tab_count(&self) -> usize {
        self.tab_documents.len()
    }
}

/// Observable components of `VectorDatabase.getStats().indexSize`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VectorStorageSize {
    /// Persisted label and JSON document-mapping estimate.
    pub document_mappings: usize,
    /// Stored Float32 vector bytes.
    pub vectors: usize,
    /// Estimated HNSW graph bytes.
    pub index_structure: usize,
    /// Sum of every browser-visible estimate component.
    pub total: usize,
}

/// Reproduces the browser's observable vector-storage estimate.
///
/// `document_json_utf16_lengths` must be supplied by the serialization host as
/// `JSON.stringify(document).length`; retaining JSON stringification in JavaScript preserves its
/// intrinsic numeric and lone-surrogate semantics without putting application policy in the host.
#[must_use]
pub fn estimate_vector_storage(
    document_json_utf16_lengths: &[usize],
    tab_label_counts: &[usize],
    dimension: usize,
) -> VectorStorageSize {
    let document_mappings = document_json_utf16_lengths
        .iter()
        .fold(0_usize, |size, length| {
            size.saturating_add(8)
                .saturating_add(length.saturating_mul(2))
        })
        .saturating_add(tab_label_counts.iter().fold(0_usize, |size, count| {
            size.saturating_add(8)
                .saturating_add(count.saturating_mul(8))
                .saturating_add(32)
        }));
    let vectors = document_json_utf16_lengths
        .len()
        .saturating_mul(dimension)
        .saturating_mul(4);
    let index_structure = if document_json_utf16_lengths.is_empty() {
        0
    } else {
        ((vectors as f64 * 0.3).floor() as usize)
            .saturating_add(document_json_utf16_lengths.len().saturating_mul(64))
    };
    VectorStorageSize {
        document_mappings,
        vectors,
        index_structure,
        total: document_mappings
            .saturating_add(vectors)
            .saturating_add(index_structure),
    }
}

/// Converts retained HNSW results into the browser tool's tab-oriented response rows.
#[must_use]
pub fn collapse_tab_search_results(results: &[SearchHit]) -> Vec<TabSearchResult> {
    let mut tabs: IndexMap<i64, TabSearchResult> = IndexMap::new();
    for result in results.iter().take(TAB_SEARCH_CANDIDATE_LIMIT) {
        let candidate = TabSearchResult {
            tab_id: result.document.tab_id,
            url: result.document.url.clone(),
            title: result.document.title.clone(),
            semantic_score: result.similarity,
            matched_snippet: extract_snippet(&result.document.chunk.text, 200),
            chunk_source: result.document.chunk.source.clone(),
            timestamp_ms: result.document.timestamp_ms,
        };
        match tabs.get_mut(&candidate.tab_id) {
            Some(existing) if candidate.semantic_score > existing.semantic_score => {
                *existing = candidate;
            }
            Some(_) => {}
            None => {
                tabs.insert(candidate.tab_id, candidate);
            }
        }
    }

    let mut results: Vec<TabSearchResult> = tabs.into_values().collect();
    results.sort_by(|left, right| javascript_descending(left.semantic_score, right.semantic_score));
    results.truncate(TAB_SEARCH_RESULT_LIMIT);
    results
}

/// Applies the browser tool's sentence-aware 200 UTF-16-unit preview policy.
#[must_use]
pub fn extract_snippet(text: &JsString, max_length: usize) -> JsString {
    let units = js_units(text);
    if units.len() <= max_length {
        return text.clone();
    }
    let truncated = &units[..max_length];
    let last_sentence_end = [b'.' as u16, b'!' as u16, b'?' as u16, 0x3002]
        .into_iter()
        .filter_map(|needle| truncated.iter().rposition(|unit| *unit == needle))
        .max();
    if let Some(index) = last_sentence_end
        && index > max_length.saturating_mul(7) / 10
    {
        return js_string_from_units(truncated[..=index].to_vec());
    }
    if let Some(index) = truncated.iter().rposition(|unit| *unit == u16::from(b' '))
        && index > max_length.saturating_mul(8) / 10
    {
        let mut snippet = js_string_from_units(truncated[..index].to_vec());
        snippet.push_str("...");
        return snippet;
    }
    let mut snippet = js_string_from_units(truncated.to_vec());
    snippet.push_str("...");
    snippet
}

/// Describes a contiguous batch of last-hidden-state tensor data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmbeddingBatchShape {
    /// Number of input rows.
    pub batch_size: usize,
    /// Number of tokens in each padded row.
    pub sequence_length: usize,
    /// Number of model dimensions per token.
    pub hidden_size: usize,
}

impl EmbeddingBatchShape {
    /// Returns the required hidden-state scalar count without overflowing.
    #[must_use]
    pub fn hidden_state_len(self) -> Option<usize> {
        self.batch_size
            .checked_mul(self.sequence_length)?
            .checked_mul(self.hidden_size)
    }

    /// Returns the required mask scalar count without overflowing.
    #[must_use]
    pub fn attention_mask_len(self) -> Option<usize> {
        self.batch_size.checked_mul(self.sequence_length)
    }

    /// Returns the contiguous normalized embedding scalar count without overflowing.
    #[must_use]
    pub fn embedding_len(self) -> Option<usize> {
        self.batch_size.checked_mul(self.hidden_size)
    }
}

/// Pools and normalizes model output directly into a reusable contiguous output buffer.
///
/// Attention values equal to one contribute to the mean; every other value is ignored exactly as
/// the existing worker-output path does.
///
/// # Errors
///
/// Returns an invalid-worker-output error when either contiguous input length disagrees with
/// `shape`.
pub fn mean_pool_normalized_batch(
    hidden_state: &[f32],
    attention_mask: &[i32],
    shape: EmbeddingBatchShape,
    output: &mut Vec<f32>,
) -> Result<(), SemanticPolicyError> {
    let Some(expected_hidden_len) = shape.hidden_state_len() else {
        return Err(SemanticPolicyError::invalid_worker_output());
    };
    let Some(expected_mask_len) = shape.attention_mask_len() else {
        return Err(SemanticPolicyError::invalid_worker_output());
    };
    let Some(output_len) = shape.embedding_len() else {
        return Err(SemanticPolicyError::invalid_worker_output());
    };
    if hidden_state.len() != expected_hidden_len || attention_mask.len() != expected_mask_len {
        return Err(SemanticPolicyError::invalid_worker_output());
    }

    output.clear();
    output.resize(output_len, 0.0);
    for batch_index in 0..shape.batch_size {
        let output_start = batch_index * shape.hidden_size;
        let mask_start = batch_index * shape.sequence_length;
        let mut valid_tokens = 0usize;
        for token_index in 0..shape.sequence_length {
            if attention_mask[mask_start + token_index] != 1 {
                continue;
            }
            let hidden_start =
                (batch_index * shape.sequence_length + token_index) * shape.hidden_size;
            for dimension in 0..shape.hidden_size {
                output[output_start + dimension] += hidden_state[hidden_start + dimension];
            }
            valid_tokens += 1;
        }
        if valid_tokens != 0 {
            let divisor = valid_tokens as f64;
            for value in &mut output[output_start..output_start + shape.hidden_size] {
                *value = (f64::from(*value) / divisor) as f32;
            }
        }
        normalize_vector_in_place(&mut output[output_start..output_start + shape.hidden_size]);
    }
    Ok(())
}

/// Normalizes a vector in place, preserving a zero vector exactly as the browser does.
pub fn normalize_vector_in_place(vector: &mut [f32]) {
    let norm = vector
        .iter()
        .map(|value| {
            let value = f64::from(*value);
            value * value
        })
        .sum::<f64>()
        .sqrt();
    if norm == 0.0 {
        return;
    }
    for value in vector {
        *value = (f64::from(*value) / norm) as f32;
    }
}

/// Computes the synchronous scalar cosine primitive retained for legacy callers.
#[must_use]
pub fn cosine_similarity_scalar(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() {
        return 0.0;
    }
    let (dot, left_norm, right_norm) = left.iter().zip(right).fold(
        (0.0_f64, 0.0_f64, 0.0_f64),
        |(dot, left_norm, right_norm), (left, right)| {
            let left = f64::from(*left);
            let right = f64::from(*right);
            (
                dot + left * right,
                left_norm + left * left,
                right_norm + right * right,
            )
        },
    );
    let magnitude = left_norm.sqrt() * right_norm.sqrt();
    if magnitude == 0.0 {
        0.0
    } else {
        dot / magnitude
    }
}

/// Validates a caller-owned contiguous vector batch before handing it to the retained SIMD engine.
#[must_use]
pub fn is_valid_contiguous_batch(vectors: &[f32], vector_dimension: usize) -> bool {
    vector_dimension != 0 && vectors.len().is_multiple_of(vector_dimension)
}

/// Packs vectors into a reusable contiguous SIMD input buffer.
///
/// This implements `Float32Array#set(vector, row_offset)` against the entire backing allocation:
/// a long row may overwrite following rows, and only an overrun past the full batch is rejected.
pub fn pack_similarity_vectors(
    vectors: &[&[f32]],
    vector_dimension: usize,
    output: &mut Vec<f32>,
) -> bool {
    output.clear();
    let Some(output_len) = vectors.len().checked_mul(vector_dimension) else {
        return false;
    };
    output.resize(output_len, 0.0);
    for (index, vector) in vectors.iter().enumerate() {
        let Some(start) = index.checked_mul(vector_dimension) else {
            output.clear();
            return false;
        };
        let Some(end) = start.checked_add(vector.len()) else {
            output.clear();
            return false;
        };
        if end > output.len() {
            output.clear();
            return false;
        }
        output[start..end].copy_from_slice(vector);
    }
    true
}

/// Selects whether batch embedding work is delegated one-for-one or deduplicated locally.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbeddingBatchMode {
    /// The offscreen transport receives every cache miss, including duplicate strings.
    Offscreen,
    /// The direct-worker path sends only each first uncached string.
    DirectWorker,
}

/// Locates one requested embedding without copying its vector buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbeddingResultSource {
    /// Reuse the host cache entry associated with this original input index.
    CachedInput(usize),
    /// Reuse this response position from the host inference batch.
    InferenceResponse(usize),
}

/// Plans cache placement, inference deduplication, and output reconstruction for one batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddingBatchPlan {
    /// Original input positions sent to the host inference adapter, in request order.
    pub inference_input_indices: Vec<usize>,
    /// Per-original-input result locations after the host completes inference.
    pub result_sources: Vec<EmbeddingResultSource>,
}

/// Plans one `getEmbeddingsBatch` call using cache observations supplied by its host.
///
/// `cache_hits` is per original input position. The browser cache remains a host effect; this
/// type owns only the direct-worker/offscreen decision and placement policy.
#[must_use]
pub fn plan_embedding_batch(
    texts: &[JsString],
    cache_hits: &[bool],
    mode: EmbeddingBatchMode,
) -> Option<EmbeddingBatchPlan> {
    if texts.len() != cache_hits.len() {
        return None;
    }
    let mut inference_input_indices = Vec::new();
    let mut result_sources = Vec::with_capacity(texts.len());
    let mut first_direct_miss: IndexMap<JsString, usize> = IndexMap::new();
    for (input_index, (text, cache_hit)) in texts.iter().zip(cache_hits).enumerate() {
        if *cache_hit {
            result_sources.push(EmbeddingResultSource::CachedInput(input_index));
            continue;
        }
        let response_index = match mode {
            EmbeddingBatchMode::Offscreen => {
                let response_index = inference_input_indices.len();
                inference_input_indices.push(input_index);
                response_index
            }
            EmbeddingBatchMode::DirectWorker => {
                if let Some(response_index) = first_direct_miss.get(text) {
                    *response_index
                } else {
                    let response_index = inference_input_indices.len();
                    inference_input_indices.push(input_index);
                    first_direct_miss.insert(text.clone(), response_index);
                    response_index
                }
            }
        };
        result_sources.push(EmbeddingResultSource::InferenceResponse(response_index));
    }
    Some(EmbeddingBatchPlan {
        inference_input_indices,
        result_sources,
    })
}

/// Reconstructs original input order as borrowed buffers after host inference completes.
///
/// Returns `None` when host cache or inference output does not match the supplied plan.
#[must_use]
pub fn reconstruct_embedding_batch<'a, T>(
    plan: &EmbeddingBatchPlan,
    cached_by_input: &[Option<&'a T>],
    inference_results: &[&'a T],
) -> Option<Vec<&'a T>> {
    plan.result_sources
        .iter()
        .map(|source| match source {
            EmbeddingResultSource::CachedInput(input_index) => {
                cached_by_input.get(*input_index).copied().flatten()
            }
            EmbeddingResultSource::InferenceResponse(response_index) => {
                inference_results.get(*response_index).copied()
            }
        })
        .collect()
}

/// Two text inputs for the direct-worker similarity-batch policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimilarityPair {
    /// First text.
    pub text1: JsString,
    /// Second text.
    pub text2: JsString,
}

/// A deduplicated embedding lookup followed by pair-result reconstruction indices.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimilarityPairsPlan {
    /// Texts in JavaScript `Set` insertion order.
    pub unique_texts: Vec<JsString>,
    /// `(left, right)` indexes into `unique_texts` for every original pair.
    pub pair_embedding_indices: Vec<(usize, usize)>,
}

/// A deduplicated embedding lookup followed by matrix-result reconstruction indices.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimilarityMatrixPlan {
    /// Texts in JavaScript `Set([...left, ...right])` insertion order.
    pub unique_texts: Vec<JsString>,
    /// Row indexes into `unique_texts`.
    pub left_embedding_indices: Vec<usize>,
    /// Column indexes into `unique_texts`.
    pub right_embedding_indices: Vec<usize>,
}

/// The direct-worker validation error surfaced before an embedding request is sent.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Input text must not be empty")]
pub struct EmptySimilarityTextError;

/// Preserves the separate pair-similarity execution paths used by the semantic engine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairSimilarityExecutionPlan {
    /// The offscreen adapter receives original pairs and owns its existing transport request.
    Offscreen,
    /// The direct-worker adapter receives deduplicated embedding work and reconstructed scores.
    DirectWorker(SimilarityPairsPlan),
}

/// Plans pair similarity without applying direct-worker deduplication to the offscreen path.
///
/// # Errors
///
/// Direct-worker requests retain the existing validation error; offscreen requests are forwarded
/// untouched to preserve their current handler-owned behavior.
pub fn plan_pair_similarity_execution(
    pairs: &[SimilarityPair],
    mode: EmbeddingBatchMode,
) -> Result<PairSimilarityExecutionPlan, EmptySimilarityTextError> {
    match mode {
        EmbeddingBatchMode::Offscreen => Ok(PairSimilarityExecutionPlan::Offscreen),
        EmbeddingBatchMode::DirectWorker => {
            plan_similarity_pairs(pairs).map(PairSimilarityExecutionPlan::DirectWorker)
        }
    }
}

/// Browser-visible validation failures for host values before they become typed text.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SimilarityInputError {
    /// The host supplied a non-string JavaScript value.
    #[error("Input must be a string")]
    NotString,
    /// The host supplied only ECMAScript whitespace.
    #[error("Input text must not be empty")]
    Empty,
}

/// Validates a host text value using the existing type and trim rules.
///
/// `None` represents every non-string host value; the WASM facade must preserve that distinction
/// before constructing a [`JsString`].
///
/// # Errors
///
/// Returns the browser's existing type or empty-input error wording.
pub fn validate_similarity_host_input(
    value: Option<&JsString>,
) -> Result<(), SimilarityInputError> {
    let Some(value) = value else {
        return Err(SimilarityInputError::NotString);
    };
    if trim_ecmascript(&js_units(value)).is_empty() {
        return Err(SimilarityInputError::Empty);
    }
    Ok(())
}

/// Plans direct-worker pair similarity while preserving JavaScript first-occurrence text order.
///
/// # Errors
///
/// Returns the existing empty-input error before any host inference is requested.
pub fn plan_similarity_pairs(
    pairs: &[SimilarityPair],
) -> Result<SimilarityPairsPlan, EmptySimilarityTextError> {
    let mut unique_indexes: IndexMap<JsString, usize> = IndexMap::new();
    let mut unique_texts = Vec::new();
    let mut pair_embedding_indices = Vec::with_capacity(pairs.len());
    for pair in pairs {
        validate_similarity_text(&pair.text1)?;
        validate_similarity_text(&pair.text2)?;
        let left = add_unique_text(&mut unique_indexes, &mut unique_texts, &pair.text1);
        let right = add_unique_text(&mut unique_indexes, &mut unique_texts, &pair.text2);
        pair_embedding_indices.push((left, right));
    }
    Ok(SimilarityPairsPlan {
        unique_texts,
        pair_embedding_indices,
    })
}

/// Plans direct-worker matrix similarity while preserving JavaScript first-occurrence text order.
///
/// # Errors
///
/// Returns the existing empty-input error before any host inference is requested.
pub fn plan_similarity_matrix(
    left: &[JsString],
    right: &[JsString],
) -> Result<SimilarityMatrixPlan, EmptySimilarityTextError> {
    if left.is_empty() || right.is_empty() {
        return Ok(SimilarityMatrixPlan {
            unique_texts: Vec::new(),
            left_embedding_indices: Vec::new(),
            right_embedding_indices: Vec::new(),
        });
    }
    let mut unique_indexes: IndexMap<JsString, usize> = IndexMap::new();
    let mut unique_texts = Vec::new();
    let left_embedding_indices = left
        .iter()
        .map(|text| {
            validate_similarity_text(text)?;
            Ok(add_unique_text(
                &mut unique_indexes,
                &mut unique_texts,
                text,
            ))
        })
        .collect::<Result<Vec<_>, EmptySimilarityTextError>>()?;
    let right_embedding_indices = right
        .iter()
        .map(|text| {
            validate_similarity_text(text)?;
            Ok(add_unique_text(
                &mut unique_indexes,
                &mut unique_texts,
                text,
            ))
        })
        .collect::<Result<Vec<_>, EmptySimilarityTextError>>()?;
    Ok(SimilarityMatrixPlan {
        unique_texts,
        left_embedding_indices,
        right_embedding_indices,
    })
}

/// Reconstructs pair scores from deduplicated embeddings without allocating vector copies.
#[must_use]
pub fn reconstruct_pair_similarities(
    plan: &SimilarityPairsPlan,
    embeddings: &[&[f32]],
) -> Vec<f64> {
    plan.pair_embedding_indices
        .iter()
        .map(
            |(left, right)| match (embeddings.get(*left), embeddings.get(*right)) {
                (Some(left), Some(right)) => cosine_similarity_scalar(left, right),
                _ => 0.0,
            },
        )
        .collect()
}

/// Reconstructs matrix scores from deduplicated embeddings without allocating vector copies.
#[must_use]
pub fn reconstruct_similarity_matrix(
    plan: &SimilarityMatrixPlan,
    embeddings: &[&[f32]],
) -> Vec<Vec<f64>> {
    plan.left_embedding_indices
        .iter()
        .map(|left| {
            plan.right_embedding_indices
                .iter()
                .map(
                    |right| match (embeddings.get(*left), embeddings.get(*right)) {
                        (Some(left), Some(right)) => cosine_similarity_scalar(left, right),
                        _ => 0.0,
                    },
                )
                .collect()
        })
        .collect()
}

/// Semantic policy errors whose messages intentionally match browser-visible failures.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SemanticPolicyError {
    /// The model output shape cannot be pooled safely.
    #[error("Invalid worker output for embedding extraction.")]
    InvalidWorkerOutput,
    /// A document vector disagrees with the selected model dimension.
    #[error("Invalid embedding dimension: expected {expected}, got {actual}")]
    InvalidEmbeddingDimension { expected: usize, actual: usize },
    /// A document vector has a non-finite component.
    #[error("Invalid embedding value at index {index}: {value}")]
    InvalidEmbeddingValue { index: usize, value: String },
    /// A query vector disagrees with the selected model dimension.
    #[error("Invalid query embedding dimension: expected {expected}, got {actual}")]
    InvalidQueryDimension { expected: usize, actual: usize },
    /// A query vector has a non-finite component.
    #[error("Invalid query embedding value at index {index}: {value}")]
    InvalidQueryValue { index: usize, value: String },
}

impl SemanticPolicyError {
    fn invalid_worker_output() -> Self {
        Self::InvalidWorkerOutput
    }

    fn invalid_embedding_dimension(expected: usize, actual: usize) -> Self {
        Self::InvalidEmbeddingDimension { expected, actual }
    }

    fn invalid_embedding_value(index: usize, value: f32) -> Self {
        Self::InvalidEmbeddingValue {
            index,
            value: javascript_number(value),
        }
    }

    fn invalid_query_dimension(expected: usize, actual: usize) -> Self {
        Self::InvalidQueryDimension { expected, actual }
    }

    fn invalid_query_value(index: usize, value: f32) -> Self {
        Self::InvalidQueryValue {
            index,
            value: javascript_number(value),
        }
    }
}

fn next_label_after(documents: &IndexMap<u32, VectorDocument>) -> u32 {
    documents
        .keys()
        .copied()
        .max()
        .map_or(0, |label| label.wrapping_add(1))
}

fn javascript_descending(left: f64, right: f64) -> Ordering {
    let comparison = right - left;
    if comparison.is_nan() || comparison == 0.0 {
        Ordering::Equal
    } else if comparison < 0.0 {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

fn javascript_number(value: f32) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value == f32::INFINITY {
        "Infinity".to_owned()
    } else if value == f32::NEG_INFINITY {
        "-Infinity".to_owned()
    } else {
        value.to_string()
    }
}

fn validate_similarity_text(text: &JsString) -> Result<(), EmptySimilarityTextError> {
    (!trim_ecmascript(&js_units(text)).is_empty())
        .then_some(())
        .ok_or(EmptySimilarityTextError)
}

fn add_unique_text(
    indexes: &mut IndexMap<JsString, usize>,
    texts: &mut Vec<JsString>,
    text: &JsString,
) -> usize {
    if let Some(index) = indexes.get(text) {
        return *index;
    }
    let index = texts.len();
    indexes.insert(text.clone(), index);
    texts.push(text.clone());
    index
}

fn split_into_sentences(content: &[u16]) -> Vec<Vec<u16>> {
    let cjk_separated = append_line_break_after_cjk_terminal(content);
    let latin_separated = replace_latin_sentence_breaks(&cjk_separated);
    let line_separated = replace_line_terminal_punctuation(&latin_separated);
    let quoted_separated = replace_cjk_quoted_terminal(&line_separated);
    let processed = collapse_newline_runs(&quoted_separated);
    let sentences: Vec<Vec<u16>> = split_on_line_feed(&processed)
        .into_iter()
        .map(|sentence| trim_ecmascript(&sentence))
        .filter(|sentence| sentence.len() > 15)
        .collect();
    if sentences.len() < 3 && content.len() > 500 {
        aggressive_sentence_splitting(content)
    } else {
        sentences
    }
}

fn aggressive_sentence_splitting(content: &[u16]) -> Vec<Vec<u16>> {
    let mut separated = Vec::with_capacity(content.len());
    let mut index = 0;
    while index < content.len() {
        let unit = content[index];
        separated.push(unit);
        if matches!(
            unit,
            46 | 33 | 63 | 0x3002 | 0xff01 | 0xff1f | 59 | 0xff1b | 58 | 0xff1a
        ) {
            separated.push(u16::from(b'\n'));
            index += 1;
            continue;
        }
        if matches!(unit, 41 | 0xff09) {
            let mut lookahead = index + 1;
            while lookahead < content.len() && is_ecmascript_whitespace(content[lookahead]) {
                lookahead += 1;
            }
            if lookahead < content.len()
                && (is_ascii_upper(content[lookahead]) || is_cjk(content[lookahead]))
            {
                separated.push(u16::from(b'\n'));
            }
        }
        index += 1;
    }
    let sentences: Vec<Vec<u16>> = split_on_line_feed(&separated)
        .into_iter()
        .map(|sentence| trim_ecmascript(&sentence))
        .filter(|sentence| sentence.len() > 15)
        .collect();
    let mut output = Vec::new();
    for sentence in sentences {
        let words = split_words(&sentence);
        if words.len() <= 80 {
            output.push(sentence);
            continue;
        }
        for start in (0..words.len()).step_by(75) {
            let end = (start + 80).min(words.len());
            let chunk = join_words(&words[start..end]);
            if chunk.len() > 15 {
                output.push(chunk);
            }
        }
    }
    output
}

fn grouped_chunks(
    sentences: &[Vec<u16>],
    mut chunks: Vec<TextChunk>,
    options: ChunkingOptions,
) -> Vec<TextChunk> {
    let mut chunk_index = chunks.len();
    let mut sentence_index = 0;
    while sentence_index < sentences.len() {
        let mut current = Vec::new();
        let mut word_total = 0usize;
        let mut used = 0usize;
        while sentence_index + used < sentences.len() && word_total < options.max_words_per_chunk {
            let sentence = &sentences[sentence_index + used];
            let sentence_words = word_count(sentence);
            if word_total + sentence_words > options.max_words_per_chunk && word_total > 0 {
                break;
            }
            if !current.is_empty() {
                current.push(u16::from(b' '));
            }
            current.extend_from_slice(sentence);
            word_total += sentence_words;
            used += 1;
        }
        let current = trim_ecmascript(&current);
        if current.len() > options.min_chunk_length {
            chunks.push(TextChunk {
                text: js_string_from_units(current),
                source: format!("content_chunk_{chunk_index}"),
                index: chunk_index,
                word_count: word_total,
            });
            chunk_index += 1;
        }
        sentence_index += used.saturating_sub(options.overlap_sentences).max(1);
    }
    chunks
}

fn mixed_chunks(
    sentences: &[Vec<u16>],
    mut chunks: Vec<TextChunk>,
    options: ChunkingOptions,
) -> Vec<TextChunk> {
    let mut chunk_index = chunks.len();
    for sentence in sentences {
        let words = split_words(sentence);
        if words.len() <= options.max_words_per_chunk {
            chunks.push(TextChunk {
                text: js_string_from_units(trim_ecmascript(sentence)),
                source: format!("sentence_chunk_{chunk_index}"),
                index: chunk_index,
                word_count: words.len(),
            });
            chunk_index += 1;
            continue;
        }
        let step = options.max_words_per_chunk;
        if step == 0 {
            continue;
        }
        for start in (0..words.len()).step_by(step) {
            let end = (start + step).min(words.len());
            let text = join_words(&words[start..end]);
            if text.len() > options.min_chunk_length {
                chunks.push(TextChunk {
                    text: js_string_from_units(text),
                    source: format!("long_sentence_chunk_{chunk_index}_part_{}", start / step),
                    index: chunk_index,
                    word_count: end - start,
                });
            }
        }
        chunk_index += 1;
    }
    chunks
}

fn fallback_chunks(
    content: &[u16],
    mut chunks: Vec<TextChunk>,
    options: ChunkingOptions,
) -> Vec<TextChunk> {
    let paragraphs: Vec<Vec<u16>> = split_paragraphs(content)
        .into_iter()
        .filter(|paragraph| trim_ecmascript(paragraph).len() > options.min_chunk_length)
        .collect();
    let mut chunk_index = chunks.len();
    if paragraphs.len() > 1 {
        for (paragraph_index, paragraph) in paragraphs.iter().enumerate() {
            let words = split_words(&trim_ecmascript(paragraph));
            for start in (0..words.len()).step_by(150) {
                let end = (start + 150).min(words.len());
                let text = join_words(&words[start..end]);
                if text.len() > options.min_chunk_length {
                    chunks.push(TextChunk {
                        text: js_string_from_units(text),
                        source: format!("paragraph_{paragraph_index}_chunk_{}", start / 150),
                        index: chunk_index,
                        word_count: end - start,
                    });
                    chunk_index += 1;
                }
            }
        }
    } else {
        let words = split_words(&trim_ecmascript(content));
        for start in (0..words.len()).step_by(150) {
            let end = (start + 150).min(words.len());
            let text = join_words(&words[start..end]);
            if text.len() > options.min_chunk_length {
                chunks.push(TextChunk {
                    text: js_string_from_units(text),
                    source: format!("content_chunk_{}", start / 150),
                    index: chunk_index,
                    word_count: end - start,
                });
                chunk_index += 1;
            }
        }
    }
    chunks
}

fn append_line_break_after_cjk_terminal(input: &[u16]) -> Vec<u16> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let unit = input[index];
        output.push(unit);
        index += 1;
        if !matches!(unit, 0x3002 | 0xff01 | 0xff1f) {
            continue;
        }
        while index < input.len() && is_ecmascript_whitespace(input[index]) {
            index += 1;
        }
        output.push(u16::from(b'\n'));
    }
    output
}

fn replace_latin_sentence_breaks(input: &[u16]) -> Vec<u16> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let unit = input[index];
        if matches!(unit, 46 | 33 | 63) {
            let quote_end = if matches!(input.get(index + 1), Some(&quote) if quote == u16::from(b'\"') || quote == u16::from(b'\''))
            {
                index + 2
            } else {
                index + 1
            };
            let mut whitespace_end = quote_end;
            while whitespace_end < input.len() && is_ecmascript_whitespace(input[whitespace_end]) {
                whitespace_end += 1;
            }
            if whitespace_end > quote_end
                && input
                    .get(whitespace_end)
                    .is_some_and(|unit| is_ascii_upper(*unit))
            {
                output.extend_from_slice(&input[index..quote_end]);
                output.push(u16::from(b'\n'));
                index = whitespace_end;
                continue;
            }
        }
        output.push(unit);
        index += 1;
    }
    output
}

fn replace_line_terminal_punctuation(input: &[u16]) -> Vec<u16> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let unit = input[index];
        output.push(unit);
        index += 1;
        if !matches!(unit, 46 | 33 | 63) {
            continue;
        }
        let mut end = index;
        while end < input.len()
            && is_ecmascript_whitespace(input[end])
            && input[end] != u16::from(b'\n')
        {
            end += 1;
        }
        if end == input.len() || input.get(end) == Some(&u16::from(b'\n')) {
            output.push(u16::from(b'\n'));
            index = end;
        }
    }
    output
}

fn replace_cjk_quoted_terminal(input: &[u16]) -> Vec<u16> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let unit = input[index];
        if matches!(unit, 0x3002 | 0xff01 | 0xff1f)
            && input.get(index + 1) == Some(&u16::from(b'\"'))
        {
            output.push(unit);
            output.push(u16::from(b'\"'));
            index += 2;
            while index < input.len() && is_ecmascript_whitespace(input[index]) {
                index += 1;
            }
            output.push(u16::from(b'\n'));
            continue;
        }
        output.push(unit);
        index += 1;
    }
    output
}

fn collapse_newline_runs(input: &[u16]) -> Vec<u16> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] != u16::from(b'\n') {
            output.push(input[index]);
            index += 1;
            continue;
        }
        let mut end = index + 1;
        let mut has_second_newline = false;
        while end < input.len() && is_ecmascript_whitespace(input[end]) {
            has_second_newline |= input[end] == u16::from(b'\n');
            end += 1;
        }
        output.push(u16::from(b'\n'));
        index = if has_second_newline { end } else { index + 1 };
    }
    output
}

fn split_paragraphs(input: &[u16]) -> Vec<Vec<u16>> {
    let mut paragraphs = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < input.len() {
        if input[index] != u16::from(b'\n') {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        let mut has_second_newline = false;
        while end < input.len() && is_ecmascript_whitespace(input[end]) {
            has_second_newline |= input[end] == u16::from(b'\n');
            end += 1;
        }
        if has_second_newline {
            paragraphs.push(input[start..index].to_vec());
            start = end;
            index = end;
        } else {
            index += 1;
        }
    }
    paragraphs.push(input[start..].to_vec());
    paragraphs
}

fn split_on_line_feed(input: &[u16]) -> Vec<Vec<u16>> {
    input
        .split(|unit| *unit == u16::from(b'\n'))
        .map(ToOwned::to_owned)
        .collect()
}

fn split_words(input: &[u16]) -> Vec<Vec<u16>> {
    let mut words = Vec::new();
    let mut index = 0;
    while index < input.len() {
        while index < input.len() && is_ecmascript_whitespace(input[index]) {
            index += 1;
        }
        let start = index;
        while index < input.len() && !is_ecmascript_whitespace(input[index]) {
            index += 1;
        }
        if start < index {
            words.push(input[start..index].to_vec());
        }
    }
    words
}

fn word_count(input: &[u16]) -> usize {
    split_words(input).len()
}

fn join_words(words: &[Vec<u16>]) -> Vec<u16> {
    let total_len = words.iter().map(Vec::len).sum::<usize>() + words.len().saturating_sub(1);
    let mut output = Vec::with_capacity(total_len);
    for (index, word) in words.iter().enumerate() {
        if index != 0 {
            output.push(u16::from(b' '));
        }
        output.extend_from_slice(word);
    }
    output
}

fn trim_ecmascript(input: &[u16]) -> Vec<u16> {
    let start = input
        .iter()
        .position(|unit| !is_ecmascript_whitespace(*unit))
        .unwrap_or(input.len());
    let end = input
        .iter()
        .rposition(|unit| !is_ecmascript_whitespace(*unit))
        .map_or(start, |index| index + 1);
    input[start..end].to_vec()
}

fn is_ecmascript_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x0009..=0x000d
            | 0x0020
            | 0x00a0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn is_ascii_upper(unit: u16) -> bool {
    matches!(unit, 65..=90)
}

fn is_cjk(unit: u16) -> bool {
    matches!(unit, 0x4e00..=0x9fa5)
}

fn js_units(value: &JsString) -> Vec<u16> {
    value.utf16_units().collect()
}

fn js_string_from_units(units: Vec<u16>) -> JsString {
    JsString::from_utf16_units(units)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from_string(value)
    }

    fn document(tab_id: i64, timestamp_ms: i64, chunk_text: &str) -> VectorDocument {
        VectorDocument {
            id: format!("document-{tab_id}-{timestamp_ms}"),
            tab_id,
            url: text("https://example.test"),
            title: text("Example"),
            chunk: TextChunk {
                text: text(chunk_text),
                source: "content_chunk_0".to_owned(),
                index: 0,
                word_count: 1,
            },
            embedding: vec![1.0],
            timestamp_ms,
        }
    }

    #[test]
    fn chunking_keeps_title_and_sentence_overlap() {
        let content = text(
            "First useful sentence has enough characters. Second useful sentence has enough characters. Third useful sentence has enough characters.",
        );
        let chunks = chunk_text(
            &content,
            Some(&text("A useful page title")),
            ChunkingOptions {
                max_words_per_chunk: 8,
                ..ChunkingOptions::default()
            },
        );
        assert_eq!(chunks.first().expect("title chunk").source, "title");
        assert!(
            chunks
                .iter()
                .skip(1)
                .all(|chunk| chunk.source.starts_with("content_chunk_"))
        );
    }

    #[test]
    fn tab_collapse_uses_first_chunk_for_score_ties_and_caps_after_deduplication() {
        let mut hits = Vec::new();
        for sequence in 0..55_i32 {
            hits.push(SearchHit {
                document: document(
                    i64::from(sequence % 11),
                    i64::from(sequence),
                    &format!("chunk {sequence}"),
                )
                .search_document(),
                similarity: f64::from(sequence),
                distance: 1.0 - f64::from(sequence),
            });
        }
        let results = collapse_tab_search_results(&hits);
        assert_eq!(results.len(), 10);
        assert_eq!(results[0].tab_id, 5);
        assert!(results.iter().all(|result| result.timestamp_ms < 50));
    }

    #[test]
    fn document_labels_are_reserved_before_ann_commit() {
        let mut mapping = VectorDocumentMap::default();
        assert_eq!(mapping.reserve_label(), 0);
        assert_eq!(mapping.reserve_label(), 1);
        mapping.insert(1, document(7, 10, "committed"));
        assert_eq!(mapping.next_label(), 2);
        assert_eq!(mapping.remove_tab(7), vec![1]);
    }

    #[test]
    fn pooled_batch_is_contiguous_and_leaves_zero_rows_zero() {
        let shape = EmbeddingBatchShape {
            batch_size: 2,
            sequence_length: 2,
            hidden_size: 2,
        };
        let hidden = [1.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let mask = [1, 1, 0, 0];
        let mut output = Vec::new();
        mean_pool_normalized_batch(&hidden, &mask, shape, &mut output).expect("valid tensor shape");
        assert_eq!(output, vec![1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn snippets_preserve_lone_surrogates_at_utf16_boundaries() {
        let mut units = Vec::with_capacity(210);
        units.push(0xd800);
        units.extend(std::iter::repeat_n(u16::from(b'a'), 209));
        let snippet = extract_snippet(&JsString::from_utf16_units(units), 200);
        let output: Vec<u16> = snippet.utf16_units().collect();
        assert_eq!(output.first(), Some(&0xd800));
        assert_eq!(output.len(), 203);
        assert_eq!(&output[200..], &[46, 46, 46]);
    }

    #[test]
    fn neighbor_mapping_uses_one_minus_distance_and_skips_stale_labels() {
        let mut mapping = VectorDocumentMap::default();
        mapping.insert(4, document(9, 20, "older"));
        mapping.insert(5, document(9, 21, "newer"));
        let results = mapping.resolve_neighbors(&[
            AnnNeighbor {
                label: 404,
                distance: 0.1,
            },
            AnnNeighbor {
                label: 4,
                distance: 0.4,
            },
            AnnNeighbor {
                label: 5,
                distance: 0.2,
            },
        ]);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].document.id, "document-9-21");
        assert_eq!(results[0].similarity, 0.8);
    }

    #[test]
    fn embedding_batch_plans_preserve_offscreen_and_direct_worker_differences() {
        let texts = [text("first"), text("cached"), text("first")];
        let cache_hits = [false, true, false];
        let offscreen = plan_embedding_batch(&texts, &cache_hits, EmbeddingBatchMode::Offscreen)
            .expect("shape");
        assert_eq!(offscreen.inference_input_indices, vec![0, 2]);
        assert_eq!(
            offscreen.result_sources,
            vec![
                EmbeddingResultSource::InferenceResponse(0),
                EmbeddingResultSource::CachedInput(1),
                EmbeddingResultSource::InferenceResponse(1),
            ]
        );
        let direct = plan_embedding_batch(&texts, &cache_hits, EmbeddingBatchMode::DirectWorker)
            .expect("shape");
        assert_eq!(direct.inference_input_indices, vec![0]);
        assert_eq!(
            direct.result_sources,
            vec![
                EmbeddingResultSource::InferenceResponse(0),
                EmbeddingResultSource::CachedInput(1),
                EmbeddingResultSource::InferenceResponse(0),
            ]
        );
    }

    #[test]
    fn vector_packing_allows_row_spill_until_the_full_buffer_boundary() {
        let mut packed = Vec::new();
        assert!(pack_similarity_vectors(
            &[&[1.0, 2.0, 3.0], &[]],
            2,
            &mut packed
        ));
        assert_eq!(packed, vec![1.0, 2.0, 3.0, 0.0]);
        assert!(!pack_similarity_vectors(
            &[&[1.0, 2.0, 3.0, 4.0, 5.0]],
            2,
            &mut packed
        ));
        assert!(packed.is_empty());
    }

    #[test]
    fn storage_estimate_matches_document_vector_and_graph_components() {
        let size = estimate_vector_storage(&[10], &[2], 384);
        assert_eq!(size.document_mappings, 84);
        assert_eq!(size.vectors, 1536);
        assert_eq!(size.index_structure, 524);
        assert_eq!(size.total, 2144);
    }
}
