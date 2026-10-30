//! Typed WASM bindings for browser semantic-index policy.

use humanchrome_core::arguments::JsString;
use humanchrome_core::json_document::JsonDocument;
use humanchrome_core::semantic::{
    self, AnnNeighbor, ChunkingOptions, EmbeddingBatchMode, EmbeddingBatchShape, IndexedPages,
    TextChunk, TitleInclusion, VectorDocument, VectorDocumentMap,
};
use wasm_bindgen::prelude::*;

/// Returns the Rust-owned ANN request count for the retained HNSW host effect.
#[wasm_bindgen]
pub fn semantic_ann_candidate_count(requested: Option<f64>) -> f64 {
    semantic::ann_candidate_count(requested)
}

fn json_string(value: &JsString) -> String {
    value.json_string_literal()
}

fn json_array(values: impl IntoIterator<Item = String>) -> String {
    format!("[{}]", values.into_iter().collect::<Vec<_>>().join(","))
}

fn json_object(values: impl IntoIterator<Item = (&'static str, String)>) -> String {
    let values = values
        .into_iter()
        .map(|(key, value)| format!("\"{key}\":{value}"))
        .collect::<Vec<_>>();
    format!("{{{}}}", values.join(","))
}

fn parse_array(text: &str) -> Result<Vec<JsonDocument>, JsValue> {
    crate::parse_json(text)?
        .into_array_values()
        .ok_or_else(|| crate::error("Expected a JSON array"))
}

fn field(document: &JsonDocument, key: &str) -> Option<JsonDocument> {
    document.get(key).map(|value| value.to_owned())
}

fn json_string_field(document: &JsonDocument, key: &str) -> Result<JsString, JsValue> {
    let Some(value) = field(document, key) else {
        return Err(crate::error(format!("Missing required field: {key}")));
    };
    if !value.as_ref().is_string() {
        return Err(crate::error(format!("Expected string field: {key}")));
    }
    crate::parse_string(&value.to_json_text())
}

fn optional_json_string_field(
    document: &JsonDocument,
    key: &str,
) -> Result<Option<JsString>, JsValue> {
    field(document, key)
        .filter(|value| !value.as_ref().is_null())
        .map(|value| {
            if !value.as_ref().is_string() {
                return Err(crate::error(format!("Expected string field: {key}")));
            }
            crate::parse_string(&value.to_json_text())
        })
        .transpose()
}

fn integer_field(document: &JsonDocument, key: &str) -> Result<i64, JsValue> {
    field(document, key)
        .and_then(|value| value.as_ref().as_f64())
        .filter(|value| value.is_finite() && value.fract() == 0.0)
        .and_then(|value| i64::try_from(value as i128).ok())
        .ok_or_else(|| crate::error(format!("Expected integer field: {key}")))
}

fn usize_field(document: &JsonDocument, key: &str) -> Result<usize, JsValue> {
    let value = integer_field(document, key)?;
    usize::try_from(value).map_err(|_| crate::error(format!("Expected non-negative field: {key}")))
}

fn f64_field(document: &JsonDocument, key: &str) -> Result<f64, JsValue> {
    field(document, key)
        .and_then(|value| value.as_ref().as_f64())
        .ok_or_else(|| crate::error(format!("Expected numeric field: {key}")))
}

fn document_from_json(
    document: JsonDocument,
    embedding: Vec<f32>,
) -> Result<VectorDocument, JsValue> {
    let chunk =
        field(&document, "chunk").ok_or_else(|| crate::error("Missing required field: chunk"))?;
    let source = json_string_field(&chunk, "source")?.to_string_lossy();
    Ok(VectorDocument {
        id: json_string_field(&document, "id")?.to_string_lossy(),
        tab_id: integer_field(&document, "tabId")?,
        url: json_string_field(&document, "url")?,
        title: json_string_field(&document, "title")?,
        chunk: TextChunk {
            text: json_string_field(&chunk, "text")?,
            source,
            index: usize_field(&chunk, "index")?,
            word_count: usize_field(&chunk, "wordCount")?,
        },
        embedding,
        timestamp_ms: integer_field(&document, "timestamp")?,
    })
}

fn text_chunk_json(chunk: &TextChunk) -> String {
    json_object([
        ("text", json_string(&chunk.text)),
        (
            "source",
            serde_json::to_string(&chunk.source).expect("string serializes"),
        ),
        ("index", chunk.index.to_string()),
        ("wordCount", chunk.word_count.to_string()),
    ])
}

fn document_json(document: &VectorDocument) -> String {
    json_object([
        (
            "id",
            serde_json::to_string(&document.id).expect("string serializes"),
        ),
        ("tabId", document.tab_id.to_string()),
        ("url", json_string(&document.url)),
        ("title", json_string(&document.title)),
        ("chunk", text_chunk_json(&document.chunk)),
        (
            "embedding",
            json_array(document.embedding.iter().map(|value| value.to_string())),
        ),
        ("timestamp", document.timestamp_ms.to_string()),
    ])
}

fn title_inclusion(value: Option<&JsonDocument>) -> TitleInclusion {
    match value.and_then(|value| value.as_ref().as_bool()) {
        Some(false) => TitleInclusion::Exclude,
        _ => TitleInclusion::Include,
    }
}

fn chunking_options(document: &JsonDocument) -> Result<ChunkingOptions, JsValue> {
    let defaults = ChunkingOptions::default();
    let non_negative = |key: &str, default: usize| -> Result<usize, JsValue> {
        match field(document, key) {
            None => Ok(default),
            Some(value) => value
                .as_ref()
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
                .and_then(|value| usize::try_from(value as u128).ok())
                .ok_or_else(|| crate::error(format!("Expected non-negative integer field: {key}"))),
        }
    };
    Ok(ChunkingOptions {
        max_words_per_chunk: non_negative("maxWordsPerChunk", defaults.max_words_per_chunk)?,
        overlap_sentences: non_negative("overlapSentences", defaults.overlap_sentences)?,
        min_chunk_length: non_negative("minChunkLength", defaults.min_chunk_length)?,
        title_inclusion: title_inclusion(field(document, "includeTitle").as_ref()),
    })
}

/// Rust-owned document mapping and label reservation state.
#[wasm_bindgen]
pub struct SemanticIndex {
    documents: VectorDocumentMap,
    indexed_pages: IndexedPages,
    pooled_embedding: Vec<f32>,
}

#[wasm_bindgen]
impl SemanticIndex {
    /// Creates an empty mapping. The host retains HNSW and persistence effects.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            documents: VectorDocumentMap::default(),
            indexed_pages: IndexedPages::default(),
            pooled_embedding: Vec::new(),
        }
    }

    /// Restores the existing persisted `documents`, `tabDocuments`, and `nextLabel` shape.
    pub fn restore(&mut self, persisted_json: &str) -> Result<(), JsValue> {
        let persisted = crate::parse_json(persisted_json)?;
        let documents = field(&persisted, "documents")
            .ok_or_else(|| crate::error("Missing required field: documents"))?
            .into_array_values()
            .ok_or_else(|| crate::error("Expected documents array"))?;
        let mut mapped = Vec::with_capacity(documents.len());
        for pair in documents {
            let mut values = pair
                .into_array_values()
                .filter(|values| values.len() == 2)
                .ok_or_else(|| crate::error("Expected [label, document] mapping"))?;
            let document = values
                .pop()
                .expect("validated persisted mapping has a document");
            let label = values
                .pop()
                .expect("validated persisted mapping has a label")
                .as_ref()
                .as_f64()
                .filter(|value| value.is_finite() && value.fract() == 0.0 && *value >= 0.0)
                .and_then(|value| u32::try_from(value as u128).ok())
                .ok_or_else(|| crate::error("Invalid persisted document label"))?;
            let embedding = field(&document, "embedding")
                .ok_or_else(|| crate::error("Missing required field: embedding"))?
                .into_array_values()
                .ok_or_else(|| crate::error("Expected embedding array"))?
                .into_iter()
                .map(|value| value.as_ref().as_f64().map(|value| value as f32))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| crate::error("Expected numeric embedding"))?;
            mapped.push((label, document_from_json(document, embedding)?));
        }
        let tab_documents = field(&persisted, "tabDocuments")
            .ok_or_else(|| crate::error("Missing required field: tabDocuments"))?
            .into_array_values()
            .ok_or_else(|| crate::error("Expected tabDocuments array"))?
            .into_iter()
            .map(|pair| {
                let mut values = pair
                    .into_array_values()
                    .filter(|values| values.len() == 2)?;
                let labels = values
                    .pop()?
                    .into_array_values()?
                    .into_iter()
                    .map(|value| u32::try_from(value.as_ref().as_f64()? as u128).ok())
                    .collect::<Option<Vec<_>>>()?;
                let tab_id = values.pop()?.as_ref().as_f64()? as i64;
                Some((tab_id, labels))
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| crate::error("Invalid tabDocuments mapping"))?;
        let next_label = field(&persisted, "nextLabel")
            .filter(|value| !value.as_ref().is_null())
            .map(|value| {
                value
                    .as_ref()
                    .as_f64()
                    .filter(|value| value.is_finite() && value.fract() == 0.0 && *value >= 0.0)
                    .and_then(|value| u32::try_from(value as u128).ok())
                    .ok_or_else(|| crate::error("Invalid nextLabel"))
            })
            .transpose()?;
        self.documents = VectorDocumentMap::from_persisted(mapped, tab_documents, next_label);
        Ok(())
    }

    /// Reconciles the next label after the retained HNSW index has been opened.
    pub fn apply_initialized_index_count(&mut self, index_count: u32) {
        self.documents.apply_initialized_index_count(index_count);
    }

    /// Serializes the existing mapping format without serializing embeddings through a host copy.
    pub fn snapshot(&self) -> String {
        let documents = self
            .documents
            .document_entries()
            .map(|(label, document)| json_array([label.to_string(), document_json(document)]));
        let tab_documents = self
            .documents
            .tab_document_entries()
            .map(|(tab_id, labels)| {
                json_array([
                    tab_id.to_string(),
                    json_array(labels.iter().map(u32::to_string)),
                ])
            });
        json_object([
            ("documents", json_array(documents)),
            ("tabDocuments", json_array(tab_documents)),
            ("nextLabel", self.documents.next_label().to_string()),
        ])
    }

    /// Returns the number of persisted document mappings without projecting their embeddings.
    pub fn document_count(&self) -> usize {
        self.documents.document_count()
    }

    /// Returns the number of tab-to-label mappings without projecting document metadata.
    pub fn tab_count(&self) -> usize {
        self.documents.tab_count()
    }

    /// Reserves an HNSW label before the host adds its vector.
    pub fn reserve_label(&mut self) -> u32 {
        self.documents.reserve_label()
    }

    /// Checks the exact raw URL/title duplicate key in Rust-owned indexing state.
    pub fn has_indexed_page(&self, url_json: &str, title_json: &str) -> Result<bool, JsValue> {
        let url = crate::parse_string(url_json)?;
        let title = crate::parse_string(title_json)?;
        Ok(self.indexed_pages.contains(&url, &title))
    }

    /// Records a page only after its selected chunks have been offered to the host.
    pub fn mark_indexed_page(&mut self, url_json: &str, title_json: &str) -> Result<(), JsValue> {
        let url = crate::parse_string(url_json)?;
        let title = crate::parse_string(title_json)?;
        self.indexed_pages.insert(&url, &title);
        Ok(())
    }

    /// Clears duplicate-page state during a full index or model clear.
    pub fn clear_indexed_pages(&mut self) {
        self.indexed_pages.clear();
    }

    /// Returns the browser-visible number of remembered duplicate keys.
    pub fn indexed_page_count(&self) -> usize {
        self.indexed_pages.len()
    }

    /// Moves one contiguous embedding into the owned mapping after successful host ANN insertion.
    pub fn commit_document(
        &mut self,
        label: u32,
        document_json: &str,
        embedding: Vec<f32>,
    ) -> Result<(), JsValue> {
        self.documents.insert(
            label,
            document_from_json(crate::parse_json(document_json)?, embedding)?,
        );
        Ok(())
    }

    /// Removes all document mappings for a tab and returns labels for host HNSW deletion.
    pub fn remove_tab(&mut self, tab_id: i64) -> String {
        json_array(
            self.documents
                .remove_tab(tab_id)
                .into_iter()
                .map(|label| label.to_string()),
        )
    }

    /// Removes one mapping and returns its persisted document when present.
    pub fn remove_label(&mut self, label: u32) -> Option<String> {
        self.documents
            .remove_label(label)
            .map(|document| document_json(&document))
    }

    /// Computes LRU and time-retention decisions with host-supplied time.
    pub fn auto_cleanup_plan(
        &self,
        max_elements: usize,
        max_retention_days: Option<f64>,
        now_ms: i64,
    ) -> String {
        let plan = self
            .documents
            .auto_cleanup_plan(max_elements, max_retention_days, now_ms);
        json_object([
            (
                "leastRecentlyUsedLabels",
                json_array(
                    plan.least_recently_used_labels
                        .into_iter()
                        .map(|label| label.to_string()),
                ),
            ),
            (
                "expiredLabels",
                json_array(
                    plan.expired_labels
                        .into_iter()
                        .map(|label| label.to_string()),
                ),
            ),
        ])
    }

    /// Maps HNSW neighbors, applies top-50-before-dedup, and returns the browser's top ten rows.
    pub fn search_results(&self, neighbors_json: &str) -> Result<String, JsValue> {
        let neighbors = parse_array(neighbors_json)?
            .into_iter()
            .map(|value| {
                let label = f64_field(&value, "label")?;
                let label =
                    u32::try_from(label as u128).map_err(|_| crate::error("Invalid HNSW label"))?;
                Ok(AnnNeighbor {
                    label,
                    distance: f64_field(&value, "distance")?,
                })
            })
            .collect::<Result<Vec<_>, JsValue>>()?;
        let hits = self.documents.resolve_neighbors(&neighbors);
        let rows = semantic::collapse_tab_search_results(&hits)
            .into_iter()
            .map(|row| {
                json_object([
                    ("tabId", row.tab_id.to_string()),
                    ("url", json_string(&row.url)),
                    ("title", json_string(&row.title)),
                    ("semanticScore", row.semantic_score.to_string()),
                    ("matchedSnippet", json_string(&row.matched_snippet)),
                    (
                        "chunkSource",
                        serde_json::to_string(&row.chunk_source).expect("string serializes"),
                    ),
                    ("timestamp", row.timestamp_ms.to_string()),
                ])
            });
        Ok(json_array(rows))
    }

    /// Moves a contiguous normalized output batch to JavaScript after retained ONNX pooling.
    pub fn mean_pool_normalized(
        &mut self,
        hidden_state: Vec<f32>,
        attention_mask: Vec<i32>,
        batch_size: usize,
        sequence_length: usize,
        hidden_size: usize,
    ) -> Result<Vec<f32>, JsValue> {
        semantic::mean_pool_normalized_batch(
            &hidden_state,
            &attention_mask,
            EmbeddingBatchShape {
                batch_size,
                sequence_length,
                hidden_size,
            },
            &mut self.pooled_embedding,
        )
        .map_err(crate::error)?;
        Ok(std::mem::take(&mut self.pooled_embedding))
    }
}

/// Chunks content using JavaScript UTF-16 semantics and returns browser chunk records.
#[wasm_bindgen]
pub fn semantic_chunk_text(input_json: &str) -> Result<String, JsValue> {
    let input = crate::parse_json(input_json)?;
    let content = json_string_field(&input, "content")?;
    let title = optional_json_string_field(&input, "title")?;
    let options = field(&input, "options")
        .map(|value| chunking_options(&value))
        .transpose()?
        .unwrap_or_default();
    Ok(json_array(
        semantic::chunk_text(&content, title.as_ref(), options)
            .iter()
            .map(text_chunk_json),
    ))
}

/// Chunks content then applies the page chunk cap before host embedding work.
#[wasm_bindgen]
pub fn semantic_chunks_for_indexing(
    input_json: &str,
    max_chunks_per_page: usize,
) -> Result<String, JsValue> {
    let input = crate::parse_json(input_json)?;
    let content = json_string_field(&input, "content")?;
    let title = optional_json_string_field(&input, "title")?;
    let options = field(&input, "options")
        .map(|value| chunking_options(&value))
        .transpose()?
        .unwrap_or_default();
    let chunks = semantic::chunk_text(&content, title.as_ref(), options);
    Ok(json_array(
        semantic::chunks_for_indexing(&chunks, max_chunks_per_page)
            .iter()
            .map(text_chunk_json),
    ))
}

/// Builds an unchanged index duplicate key from raw URL and title JSON string literals.
#[wasm_bindgen]
pub fn semantic_indexed_page_key(url_json: &str, title_json: &str) -> Result<String, JsValue> {
    Ok(json_string(&semantic::indexed_page_key(
        &crate::parse_string(url_json)?,
        &crate::parse_string(title_json)?,
    )))
}

/// Applies the existing content-index URL predicate without host normalization.
#[wasm_bindgen]
pub fn semantic_is_indexable_content_url(url_json: &str) -> Result<bool, JsValue> {
    let url = crate::parse_string(url_json)?;
    Ok(semantic::is_indexable_content_url(&url.to_string_lossy()))
}

/// Applies the existing rebuild-index URL predicate without host normalization.
#[wasm_bindgen]
pub fn semantic_is_rebuild_indexable_url(url_json: &str) -> Result<bool, JsValue> {
    let url = crate::parse_string(url_json)?;
    Ok(semantic::is_rebuild_indexable_url(&url.to_string_lossy()))
}

/// Validates a contiguous batch supplied as a `Float32Array`.
#[wasm_bindgen]
pub fn semantic_is_valid_contiguous_batch(vectors: Vec<f32>, dimension: usize) -> bool {
    semantic::is_valid_contiguous_batch(&vectors, dimension)
}

/// Computes the synchronous scalar cosine compatibility primitive.
#[wasm_bindgen]
pub fn semantic_cosine_similarity(left: Vec<f32>, right: Vec<f32>) -> f64 {
    semantic::cosine_similarity_scalar(&left, &right)
}

/// Normalizes an owned contiguous vector while preserving the zero-vector compatibility case.
#[wasm_bindgen]
pub fn semantic_normalize_vector(mut vector: Vec<f32>) -> Vec<f32> {
    semantic::normalize_vector_in_place(&mut vector);
    vector
}

/// Validates a document embedding before the host submits it to HNSW.
#[wasm_bindgen]
pub fn semantic_validate_embedding(embedding: Vec<f32>, dimension: usize) -> Result<(), JsValue> {
    semantic::validate_embedding(&embedding, dimension).map_err(crate::error)
}

/// Validates a query embedding before the host queries HNSW.
#[wasm_bindgen]
pub fn semantic_validate_query_embedding(
    embedding: Vec<f32>,
    dimension: usize,
) -> Result<(), JsValue> {
    semantic::validate_query_embedding(&embedding, dimension).map_err(crate::error)
}

/// Validates a host similarity input while retaining non-string versus empty-string errors.
#[wasm_bindgen]
pub fn semantic_validate_similarity_input(value_json: &str) -> Result<(), JsValue> {
    let value = crate::parse_json(value_json)?;
    let string = value
        .as_ref()
        .is_string()
        .then(|| crate::parse_string(&value.to_json_text()))
        .transpose()?;
    semantic::validate_similarity_host_input(string.as_ref()).map_err(crate::error)
}

/// Plans cache placement and direct-worker versus offscreen inference work.
#[wasm_bindgen]
pub fn semantic_plan_embedding_batch(
    texts_json: &str,
    cache_hits_json: &str,
    mode: &str,
) -> Result<Option<String>, JsValue> {
    let texts = parse_array(texts_json)?
        .into_iter()
        .map(|value| crate::parse_string(&value.to_json_text()))
        .collect::<Result<Vec<_>, _>>()?;
    let cache_hits = parse_array(cache_hits_json)?
        .into_iter()
        .map(|value| {
            value
                .as_ref()
                .as_bool()
                .ok_or_else(|| crate::error("Expected boolean cache hit"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mode = match mode {
        "offscreen" => EmbeddingBatchMode::Offscreen,
        "directWorker" => EmbeddingBatchMode::DirectWorker,
        _ => return Err(crate::error("Unknown embedding batch mode")),
    };
    Ok(
        semantic::plan_embedding_batch(&texts, &cache_hits, mode).map(|plan| {
            json_object([
                (
                    "inferenceInputIndices",
                    json_array(plan.inference_input_indices.iter().map(usize::to_string)),
                ),
                (
                    "resultSources",
                    json_array(plan.result_sources.iter().map(|source| match source {
                        semantic::EmbeddingResultSource::CachedInput(index) => json_object([
                            ("kind", "\"cachedInput\"".into()),
                            ("index", index.to_string()),
                        ]),
                        semantic::EmbeddingResultSource::InferenceResponse(index) => json_object([
                            ("kind", "\"inferenceResponse\"".into()),
                            ("index", index.to_string()),
                        ]),
                    })),
                ),
            ])
        }),
    )
}

/// Plans pair similarity without duplicating direct-worker deduplication in the host.
#[wasm_bindgen]
pub fn semantic_plan_similarity_pairs(pairs_json: &str, mode: &str) -> Result<String, JsValue> {
    let pairs = parse_array(pairs_json)?
        .into_iter()
        .map(|pair| {
            Ok(semantic::SimilarityPair {
                text1: json_string_field(&pair, "text1")?,
                text2: json_string_field(&pair, "text2")?,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    let mode = match mode {
        "offscreen" => EmbeddingBatchMode::Offscreen,
        "directWorker" => EmbeddingBatchMode::DirectWorker,
        _ => return Err(crate::error("Unknown embedding batch mode")),
    };
    match semantic::plan_pair_similarity_execution(&pairs, mode).map_err(crate::error)? {
        semantic::PairSimilarityExecutionPlan::Offscreen => Ok("{\"kind\":\"offscreen\"}".into()),
        semantic::PairSimilarityExecutionPlan::DirectWorker(plan) => Ok(json_object([
            ("kind", "\"directWorker\"".into()),
            (
                "uniqueTexts",
                json_array(plan.unique_texts.iter().map(json_string)),
            ),
            (
                "pairEmbeddingIndices",
                json_array(
                    plan.pair_embedding_indices
                        .iter()
                        .map(|(left, right)| json_array([left.to_string(), right.to_string()])),
                ),
            ),
        ])),
    }
}

/// Plans matrix similarity with one first-occurrence ordered embedding request.
#[wasm_bindgen]
pub fn semantic_plan_similarity_matrix(
    left_json: &str,
    right_json: &str,
) -> Result<String, JsValue> {
    let read = |text: &str| -> Result<Vec<JsString>, JsValue> {
        parse_array(text)?
            .into_iter()
            .map(|value| crate::parse_string(&value.to_json_text()))
            .collect()
    };
    let plan = semantic::plan_similarity_matrix(&read(left_json)?, &read(right_json)?)
        .map_err(crate::error)?;
    Ok(json_object([
        (
            "uniqueTexts",
            json_array(plan.unique_texts.iter().map(json_string)),
        ),
        (
            "leftEmbeddingIndices",
            json_array(plan.left_embedding_indices.iter().map(usize::to_string)),
        ),
        (
            "rightEmbeddingIndices",
            json_array(plan.right_embedding_indices.iter().map(usize::to_string)),
        ),
    ]))
}

fn contiguous_rows(values: &[f32], dimension: usize) -> Result<Vec<&[f32]>, JsValue> {
    if !semantic::is_valid_contiguous_batch(values, dimension) {
        return Err(crate::error("Invalid contiguous embedding batch"));
    }
    Ok(values.chunks_exact(dimension).collect())
}

/// Reconstructs direct-worker pair scores from one contiguous embedding result batch.
#[wasm_bindgen]
pub fn semantic_pair_similarity_scores(
    pairs_json: &str,
    embeddings: Vec<f32>,
    dimension: usize,
) -> Result<String, JsValue> {
    let pairs = parse_array(pairs_json)?
        .into_iter()
        .map(|pair| {
            Ok(semantic::SimilarityPair {
                text1: json_string_field(&pair, "text1")?,
                text2: json_string_field(&pair, "text2")?,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    let plan = semantic::plan_similarity_pairs(&pairs).map_err(crate::error)?;
    let rows = contiguous_rows(&embeddings, dimension)?;
    if rows.len() != plan.unique_texts.len() {
        return Err(crate::error(
            "Embedding result count does not match similarity plan",
        ));
    }
    Ok(json_array(
        semantic::reconstruct_pair_similarities(&plan, &rows)
            .into_iter()
            .map(|score| score.to_string()),
    ))
}

/// Reconstructs a direct-worker similarity matrix from one contiguous embedding result batch.
#[wasm_bindgen]
pub fn semantic_similarity_matrix_scores(
    left_json: &str,
    right_json: &str,
    embeddings: Vec<f32>,
    dimension: usize,
) -> Result<String, JsValue> {
    let read = |text: &str| -> Result<Vec<JsString>, JsValue> {
        parse_array(text)?
            .into_iter()
            .map(|value| crate::parse_string(&value.to_json_text()))
            .collect()
    };
    let plan = semantic::plan_similarity_matrix(&read(left_json)?, &read(right_json)?)
        .map_err(crate::error)?;
    let rows = contiguous_rows(&embeddings, dimension)?;
    if rows.len() != plan.unique_texts.len() {
        return Err(crate::error(
            "Embedding result count does not match similarity plan",
        ));
    }
    Ok(json_array(
        semantic::reconstruct_similarity_matrix(&plan, &rows)
            .into_iter()
            .map(|row| json_array(row.into_iter().map(|score| score.to_string()))),
    ))
}

/// Estimates persisted vector storage from host JSON-length observations without reserializing documents.
#[wasm_bindgen]
pub fn semantic_estimate_storage(
    document_json_utf16_lengths: &str,
    tab_label_counts: &str,
    dimension: usize,
) -> Result<String, JsValue> {
    let parse_counts = |text: &str| -> Result<Vec<usize>, JsValue> {
        parse_array(text)?
            .into_iter()
            .map(|value| {
                value
                    .as_ref()
                    .as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
                    .and_then(|value| usize::try_from(value as u128).ok())
                    .ok_or_else(|| crate::error("Expected non-negative integer size"))
            })
            .collect()
    };
    let storage = semantic::estimate_vector_storage(
        &parse_counts(document_json_utf16_lengths)?,
        &parse_counts(tab_label_counts)?,
        dimension,
    );
    Ok(json_object([
        ("documentMappings", storage.document_mappings.to_string()),
        ("vectors", storage.vectors.to_string()),
        ("indexStructure", storage.index_structure.to_string()),
        ("total", storage.total.to_string()),
    ]))
}

/// Builds the current host-time document identifier without reading a browser clock.
#[wasm_bindgen]
pub fn semantic_document_id(tab_id: i64, chunk_index: usize, now_ms: i64) -> String {
    semantic::document_id(tab_id, chunk_index, now_ms)
}
