//! Bounded dispatcher idempotency cache with injected time.

use hashlink::LinkedHashMap;
use humanchrome_core::{arguments::JsString, json_document::JsonDocument};
use serde_json::{Map, Value};

/// The production idempotency retention period in milliseconds.
pub const DEFAULT_TTL_MS: u64 = 30_000;
/// The production maximum number of idempotency records.
pub const DEFAULT_MAX_ENTRIES: usize = 1_000;

#[derive(Clone, Debug)]
struct CachedEntry {
    result: JsonDocument,
    expires_at: u64,
}

/// A bounded LRU cache for `(clientId, toolName, idemKey)` dispatcher results.
///
/// `clock` returns Unix-epoch milliseconds. The cache intentionally keeps the JavaScript
/// key concatenation, including its colon collisions, and moves hits to the newest LRU
/// position without extending their expiration time.
pub struct IdemCache<C> {
    clock: C,
    ttl_ms: u64,
    max_entries: usize,
    /// Entries are ordered from least to most recently used.
    entries: LinkedHashMap<JsString, CachedEntry>,
}

impl<C> IdemCache<C>
where
    C: Fn() -> u64,
{
    /// Creates a cache with the production TTL and capacity.
    #[must_use]
    pub fn new(clock: C) -> Self {
        Self::with_limits(clock, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES)
    }

    /// Creates a cache with an injected clock and explicit limits for deterministic tests.
    #[must_use]
    pub fn with_limits(clock: C, ttl_ms: u64, max_entries: usize) -> Self {
        Self {
            clock,
            ttl_ms,
            max_entries,
            entries: LinkedHashMap::with_capacity(max_entries.min(DEFAULT_MAX_ENTRIES)),
        }
    }

    /// Returns the number of stored entries, including expired records not yet inspected.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns whether no records are stored.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Drops all cached records without changing the configured limits.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Records a success or error result under its JavaScript composite key.
    pub fn record(&mut self, key: JsString, result: JsonDocument) {
        let expires_at = (self.clock)().saturating_add(self.ttl_ms);
        self.entries.remove(&key);
        self.entries.insert(key, CachedEntry { result, expires_at });
        while self.entries.len() > self.max_entries {
            let _ = self.entries.pop_front();
        }
    }

    /// Returns a replay result with `_meta.idempotent_hit: true`, or `None` on a miss.
    ///
    /// The TTL is deliberately not refreshed on a cache hit. Expiry eviction uses the legacy
    /// early-break walk over LRU order, even though moving a hit makes that order differ from
    /// expiration order.
    pub fn lookup(&mut self, key: &JsString) -> Option<JsonDocument> {
        let now = (self.clock)();
        self.evict_expired(now);
        let entry = self.entries.get(key)?;
        if entry.expires_at <= now {
            self.entries.remove(key);
            return None;
        }
        let replay = with_idempotent_hit(entry.result.clone());
        let _ = self.entries.to_back(key);
        Some(replay)
    }

    fn evict_expired(&mut self, now: u64) {
        while self
            .entries
            .front()
            .is_some_and(|(_, entry)| entry.expires_at <= now)
        {
            let _ = self.entries.pop_front();
        }
    }
}

/// Retains JavaScript's colon-concatenated key semantics, including UTF-16 keys.
#[must_use]
pub fn make_key(
    client_id: Option<&str>,
    tool_name: &str,
    idem_key: Option<&JsString>,
) -> Option<JsString> {
    let idem_key = idem_key.filter(|key| key.as_utf8() != Some(""))?;
    if tool_name.is_empty() {
        return None;
    }
    let mut key = JsString::from_owned_string(format!("{}:{tool_name}:", client_id.unwrap_or("_")));
    key.push_js_string(idem_key);
    Some(key)
}

fn with_idempotent_hit(result: JsonDocument) -> JsonDocument {
    let result = match result.into_value() {
        Ok(Value::Object(mut object))
            if !object
                .get("_meta")
                .is_some_and(|meta| meta.is_array() || meta.is_string()) =>
        {
            let meta = object.entry("_meta".to_owned()).or_insert(Value::Null);
            if !meta.is_object() {
                *meta = Value::Object(Map::new());
            }
            meta.as_object_mut()
                .expect("metadata is an object")
                .insert("idempotent_hit".to_owned(), Value::Bool(true));
            return JsonDocument::from(Value::Object(object));
        }
        Ok(value) => JsonDocument::from(value),
        Err(document) => document,
    };
    // JavaScript object spread also exposes array indices and UTF-16 string units.
    let mut fields = result.into_spread_fields();
    let meta_index = fields
        .iter()
        .position(|(key, _)| key.as_utf8() == Some("_meta"));
    let meta = meta_index
        .map(|index| std::mem::replace(&mut fields[index].1, JsonDocument::from(Value::Null)))
        .unwrap_or_else(|| JsonDocument::from(Value::Null));
    let mut meta_fields = meta.into_spread_fields();
    if let Some((_, value)) = meta_fields
        .iter_mut()
        .find(|(key, _)| key.as_utf8() == Some("idempotent_hit"))
    {
        *value = JsonDocument::from(true);
    } else {
        meta_fields.push((JsString::from("idempotent_hit"), JsonDocument::from(true)));
    }
    let meta = JsonDocument::object_lossless(meta_fields);
    if let Some(index) = meta_index {
        fields[index].1 = meta;
    } else {
        fields.push((JsString::from("_meta"), meta));
    }
    JsonDocument::object_lossless(fields)
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    use humanchrome_core::{arguments::JsString, json_document::JsonDocument};
    use serde_json::json;

    use super::{IdemCache, make_key};

    fn key(client: &str, tool: &str, text: &str) -> JsString {
        make_key(Some(client), tool, Some(&JsString::from(text))).expect("nonempty cache key")
    }

    fn test_cache(
        now: Rc<Cell<u64>>,
        ttl_ms: u64,
        max_entries: usize,
    ) -> IdemCache<impl Fn() -> u64> {
        IdemCache::with_limits(move || now.get(), ttl_ms, max_entries)
    }

    #[test]
    fn replays_successes_and_errors_with_merged_metadata() {
        let mut cache = test_cache(Rc::new(Cell::new(100)), 30_000, 3);
        let failure = key("client", "chrome_click", "one");
        let success = key("client", "chrome_click", "two");
        cache.record(
            failure.clone(),
            JsonDocument::from(json!({
                "content": [{"type":"text","text":"failure"}], "isError":true,
                "_meta":{"suggested_next":["chrome_help"]}
            })),
        );
        cache.record(
            success.clone(),
            JsonDocument::from(json!({
                "content":[{"type":"text","text":"success"}], "isError":false
            })),
        );
        assert_eq!(
            cache
                .lookup(&failure)
                .expect("failure replay")
                .into_value()
                .expect("ordinary JSON"),
            json!({
                "content":[{"type":"text","text":"failure"}], "isError":true,
                "_meta":{"suggested_next":["chrome_help"],"idempotent_hit":true}
            })
        );
        assert_eq!(
            cache
                .lookup(&success)
                .expect("success replay")
                .into_value()
                .expect("ordinary JSON"),
            json!({
                "content":[{"type":"text","text":"success"}], "isError":false,
                "_meta":{"idempotent_hit":true}
            })
        );
    }

    #[test]
    fn original_colon_key_collisions_are_observable() {
        let mut cache = test_cache(Rc::new(Cell::new(0)), 30_000, 3);
        cache.record(
            key("a", "b:c", "d"),
            JsonDocument::from(json!({"content":["first"]})),
        );
        assert_eq!(
            cache
                .lookup(&key("a:b", "c", "d"))
                .expect("legacy collision")
                .into_value()
                .expect("ordinary JSON"),
            json!({"content":["first"],"_meta":{"idempotent_hit":true}})
        );
    }

    #[test]
    fn hit_refreshes_lru_without_extending_ttl() {
        let now = Rc::new(Cell::new(0));
        let mut cache = test_cache(now.clone(), 10, 2);
        let old = key("c", "tool", "old");
        let new = key("c", "tool", "new");
        cache.record(old.clone(), JsonDocument::from(json!({"value":"old"})));
        now.set(1);
        cache.record(new.clone(), JsonDocument::from(json!({"value":"new"})));
        now.set(2);
        assert!(cache.lookup(&old).is_some());
        now.set(10);
        assert!(cache.lookup(&new).is_some());
        // The live entry at the LRU front retains the legacy early-break behavior.
        assert_eq!(cache.len(), 2);
        assert!(cache.lookup(&old).is_none());
    }

    #[test]
    fn capacity_evicts_least_recently_used_entry() {
        let mut cache = test_cache(Rc::new(Cell::new(0)), 100, 2);
        let one = key("c", "tool", "one");
        let two = key("c", "tool", "two");
        let three = key("c", "tool", "three");
        cache.record(one.clone(), JsonDocument::from(json!({"value":1})));
        cache.record(two.clone(), JsonDocument::from(json!({"value":2})));
        assert!(cache.lookup(&one).is_some());
        cache.record(three.clone(), JsonDocument::from(json!({"value":3})));
        assert!(cache.lookup(&one).is_some());
        assert!(cache.lookup(&two).is_none());
        assert!(cache.lookup(&three).is_some());
    }

    #[test]
    fn replay_retains_unpaired_keys_results_and_metadata_order() {
        let mut cache = test_cache(Rc::new(Cell::new(0)), 100, 2);
        let key = make_key(
            Some("client"),
            "tool",
            Some(&JsString::from_json_string_literal(r#""\ud800""#).expect("UTF-16 key")),
        )
        .expect("key");
        cache.record(
            key.clone(),
            JsonDocument::parse(
                r#"{"_meta":{"\ud800":"kept","idempotent_hit":false},"text":"\udfff"}"#,
            )
            .expect("UTF-16 result"),
        );
        assert_eq!(
            cache.lookup(&key).expect("replay").to_json_text(),
            r#"{"_meta":{"\ud800":"kept","idempotent_hit":true},"text":"\udfff"}"#
        );
        assert!(
            cache
                .lookup(
                    &super::make_key(Some("client"), "tool", Some(&JsString::from("�")))
                        .expect("replacement key")
                )
                .is_none()
        );
    }

    #[test]
    fn replay_spreads_array_results_and_utf16_metadata_units() {
        let mut cache = test_cache(Rc::new(Cell::new(0)), 100, 2);
        let array_key = key("c", "tool", "array");
        cache.record(array_key.clone(), JsonDocument::from(json!(["one", "two"])));
        assert_eq!(
            cache
                .lookup(&array_key)
                .expect("array replay")
                .into_value()
                .expect("ordinary JSON"),
            json!({"0":"one","1":"two","_meta":{"idempotent_hit":true}})
        );
        let string_key = key("c", "tool", "string");
        cache.record(
            string_key.clone(),
            JsonDocument::from(json!({"_meta":"😀"})),
        );
        assert_eq!(
            cache
                .lookup(&string_key)
                .expect("metadata replay")
                .to_json_text(),
            r#"{"_meta":{"0":"\ud83d","1":"\ude00","idempotent_hit":true}}"#
        );
    }
}
