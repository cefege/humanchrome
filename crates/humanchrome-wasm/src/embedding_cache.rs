//! WASM handle for Rust-owned embedding-cache policy and JavaScript-owned payload resources.

use humanchrome_core::embedding_cache::EmbeddingCache;
use js_sys::Math;
use wasm_bindgen::prelude::*;

/// Stateful embedding-cache policy retaining opaque JavaScript payload handles.
///
/// Keys cross this boundary as JSON string literals so unpaired UTF-16 surrogates are retained in
/// the core [`humanchrome_core::arguments::JsString`] representation. Values stay as JavaScript
/// handles: returning or evicting one changes handle ownership only and never copies a typed-array
/// embedding into WebAssembly memory.
#[wasm_bindgen]
pub struct RustEmbeddingCache {
    cache: EmbeddingCache<JsValue>,
}

#[wasm_bindgen]
impl RustEmbeddingCache {
    /// Creates a cache using the legacy capacity fallback behavior.
    #[wasm_bindgen(constructor)]
    pub fn new(capacity: f64) -> Self {
        Self {
            cache: EmbeddingCache::new(capacity),
        }
    }

    /// Returns a cached payload or JavaScript `null` after applying a host-supplied access time.
    pub fn get(&mut self, key_json: &str, now: f64) -> Result<JsValue, JsValue> {
        let key = crate::parse_string(key_json)?;
        Ok(self.cache.get(&key, now).cloned().unwrap_or(JsValue::NULL))
    }
    /// Stores a payload handle using a host-supplied creation time and JavaScript's `Math.log`.
    pub fn set(&mut self, key_json: &str, value: JsValue, now: f64) -> Result<(), JsValue> {
        self.cache
            .set(crate::parse_string(key_json)?, value, now, Math::log);
        Ok(())
    }

    /// Tests for a payload without changing recency, frequency, or access time.
    pub fn has(&self, key_json: &str) -> Result<bool, JsValue> {
        Ok(self.cache.has(&crate::parse_string(key_json)?))
    }

    /// Drops every payload handle and resets the recency list.
    pub fn clear(&mut self) {
        self.cache.clear();
    }

    /// Returns the number of retained payload handles.
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> usize {
        self.cache.len()
    }

    /// Returns the legacy normalized capacity.
    #[wasm_bindgen(getter)]
    pub fn capacity(&self) -> f64 {
        self.cache.stats().capacity
    }

    /// Returns the legacy `size / capacity` ratio.
    #[wasm_bindgen(getter)]
    pub fn usage(&self) -> f64 {
        self.cache.stats().usage
    }
}
