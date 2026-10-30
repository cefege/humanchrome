//! Rust-owned lossless-key LRU policy for browser embedding and tokenization payload handles.

use std::collections::HashMap;
use std::rc::Rc;

use crate::arguments::JsString;

/// The capacity used when JavaScript receives a capacity that does not compare greater than zero.
pub const DEFAULT_EMBEDDING_CACHE_CAPACITY: f64 = 100.0;
const EVICTION_TAIL_SCAN_LIMIT: usize = 5;
const MILLISECONDS_PER_MINUTE: f64 = 60_000.0;

/// Observable cache statistics in the legacy JavaScript shape.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmbeddingCacheStats {
    /// Number of cached entries.
    pub size: usize,
    /// Configured capacity after the legacy fallback rule.
    pub capacity: f64,
    /// Current `size / capacity` ratio.
    pub usage: f64,
}

#[derive(Debug)]
struct Node<T> {
    key: Rc<JsString>,
    value: T,
    previous: Option<usize>,
    next: Option<usize>,
    frequency: f64,
    last_accessed: f64,
}

/// A lossless-key, recency-ordered cache with the legacy five-tail eviction heuristic.
///
/// The cache owns values of any type. Browser bindings store opaque JavaScript handles, so
/// embeddings remain in their original typed-array allocations rather than being copied through
/// WebAssembly memory.
#[derive(Debug)]
pub struct EmbeddingCache<T> {
    capacity: f64,
    entries: HashMap<Rc<JsString>, usize>,
    nodes: Vec<Option<Node<T>>>,
    vacant_nodes: Vec<usize>,
    head: Option<usize>,
    tail: Option<usize>,
}

impl<T> EmbeddingCache<T> {
    /// Creates a cache with JavaScript's `capacity > 0 ? capacity : 100` rule.
    #[must_use]
    pub fn new(capacity: f64) -> Self {
        Self {
            capacity: normalized_capacity(capacity),
            entries: HashMap::new(),
            nodes: Vec::new(),
            vacant_nodes: Vec::new(),
            head: None,
            tail: None,
        }
    }

    /// Returns the value for `key`, refreshing its frequency, access time, and recency.
    pub fn get(&mut self, key: &JsString, now: f64) -> Option<&T> {
        let node_id = *self.entries.get(key)?;
        {
            let node = self.node_mut(node_id);
            node.frequency += 1.0;
            node.last_accessed = now;
        }
        self.move_to_head(node_id);
        Some(&self.node(node_id).value)
    }

    /// Inserts or replaces a value at `key`, using `logarithm` for legacy eviction scoring.
    ///
    /// Replacing an existing value intentionally changes recency only. It does not refresh the
    /// existing frequency or timestamp, matching the legacy cache.
    pub fn set(&mut self, key: JsString, value: T, now: f64, logarithm: fn(f64) -> f64) {
        if let Some(&node_id) = self.entries.get(&key) {
            self.node_mut(node_id).value = value;
            self.move_to_head(node_id);
            return;
        }

        if (self.entries.len() as f64) >= self.capacity {
            let victim = self.find_victim_node(now, logarithm);
            let key = self.remove_node(victim);
            self.entries.remove(&key);
        }

        let key = Rc::new(key);
        let node_id = self.allocate_node(Rc::clone(&key), value, now);
        self.entries.insert(key, node_id);
        self.add_to_head(node_id);
    }

    /// Returns whether `key` is present without changing its recency or statistics.
    #[must_use]
    pub fn has(&self, key: &JsString) -> bool {
        self.entries.contains_key(key)
    }

    /// Drops all values and restores an empty recency list.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.nodes.clear();
        self.vacant_nodes.clear();
        self.head = None;
        self.tail = None;
    }

    /// Returns the number of entries currently retained.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns whether the cache is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Returns the legacy `size`, `capacity`, and `usage` values.
    #[must_use]
    pub fn stats(&self) -> EmbeddingCacheStats {
        let size = self.len();
        EmbeddingCacheStats {
            size,
            capacity: self.capacity,
            usage: size as f64 / self.capacity,
        }
    }

    fn allocate_node(&mut self, key: Rc<JsString>, value: T, now: f64) -> usize {
        let node = Node {
            key,
            value,
            previous: None,
            next: None,
            frequency: 1.0,
            last_accessed: now,
        };
        match self.vacant_nodes.pop() {
            Some(node_id) => {
                self.nodes[node_id] = Some(node);
                node_id
            }
            None => {
                self.nodes.push(Some(node));
                self.nodes.len() - 1
            }
        }
    }

    fn add_to_head(&mut self, node_id: usize) {
        let former_head = self.head;
        {
            let node = self.node_mut(node_id);
            node.previous = None;
            node.next = former_head;
        }
        if let Some(former_head) = former_head {
            self.node_mut(former_head).previous = Some(node_id);
        } else {
            self.tail = Some(node_id);
        }
        self.head = Some(node_id);
    }

    fn detach(&mut self, node_id: usize) {
        let (previous, next) = {
            let node = self.node_mut(node_id);
            (node.previous.take(), node.next.take())
        };
        if let Some(previous) = previous {
            self.node_mut(previous).next = next;
        } else {
            self.head = next;
        }
        if let Some(next) = next {
            self.node_mut(next).previous = previous;
        } else {
            self.tail = previous;
        }
    }

    fn move_to_head(&mut self, node_id: usize) {
        if self.head == Some(node_id) {
            return;
        }
        self.detach(node_id);
        self.add_to_head(node_id);
    }

    fn remove_node(&mut self, node_id: usize) -> Rc<JsString> {
        self.detach(node_id);
        let node = self.nodes[node_id]
            .take()
            .expect("cache index always points to an allocated node");
        self.vacant_nodes.push(node_id);
        node.key
    }

    fn find_victim_node(&self, now: f64, logarithm: fn(f64) -> f64) -> usize {
        let mut victim = self.tail.expect("full cache has a tail node");
        let mut minimum_score = self.eviction_score(victim, now, logarithm);
        let mut current = self.node(victim).previous;
        let maximum_checked = EVICTION_TAIL_SCAN_LIMIT.min(self.entries.len());
        let mut checked = 1;

        while let Some(node_id) = current {
            if checked >= maximum_checked {
                break;
            }
            let score = self.eviction_score(node_id, now, logarithm);
            if score < minimum_score {
                minimum_score = score;
                victim = node_id;
            }
            current = self.node(node_id).previous;
            checked += 1;
        }

        victim
    }

    fn eviction_score(&self, node_id: usize, now: f64, logarithm: fn(f64) -> f64) -> f64 {
        let node = self.node(node_id);
        let age_minutes = (now - node.last_accessed) / MILLISECONDS_PER_MINUTE;
        let time_weight = 1.0 / (1.0 + age_minutes);
        logarithm(node.frequency + 1.0) * time_weight
    }

    fn node(&self, node_id: usize) -> &Node<T> {
        self.nodes[node_id]
            .as_ref()
            .expect("linked cache node is allocated")
    }

    fn node_mut(&mut self, node_id: usize) -> &mut Node<T> {
        self.nodes[node_id]
            .as_mut()
            .expect("linked cache node is allocated")
    }
}

impl<T> Default for EmbeddingCache<T> {
    fn default() -> Self {
        Self::new(DEFAULT_EMBEDDING_CACHE_CAPACITY)
    }
}

fn normalized_capacity(capacity: f64) -> f64 {
    if capacity > 0.0 {
        capacity
    } else {
        DEFAULT_EMBEDDING_CACHE_CAPACITY
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(value: &str) -> JsString {
        JsString::from_string(value)
    }

    #[test]
    fn replacement_moves_to_head_without_refreshing_eviction_history() {
        let mut cache = EmbeddingCache::new(3.0);
        let a = key("a");
        let b = key("b");
        let c = key("c");
        let d = key("d");
        cache.set(a.clone(), "first", 0.0, f64::ln);
        cache.set(b.clone(), "old", 1.0, f64::ln);
        cache.set(c.clone(), "third", 2.0, f64::ln);
        assert_eq!(cache.get(&a, 3.0), Some(&"first"));

        cache.set(b.clone(), "replacement", 4.0, f64::ln);
        cache.set(d, "fourth", 60_000.0, f64::ln);

        assert!(cache.has(&a));
        assert!(!cache.has(&b), "an update must not refresh b's timestamp");
        assert!(cache.has(&c));
    }

    #[test]
    fn replacement_keeps_frequency_accumulated_by_get() {
        let mut cache = EmbeddingCache::new(3.0);
        let a = key("a");
        let b = key("b");
        let c = key("c");
        let d = key("d");
        cache.set(a.clone(), "a", 0.0, f64::ln);
        cache.set(b.clone(), "old", 1.0, f64::ln);
        assert_eq!(cache.get(&b, 2.0), Some(&"old"));
        cache.set(c.clone(), "c", 30_000.0, f64::ln);
        assert_eq!(cache.get(&a, 50_000.0), Some(&"a"));

        cache.set(b.clone(), "replacement", 50_001.0, f64::ln);
        cache.set(d, "d", 60_000.0, f64::ln);

        assert!(cache.has(&b), "replacement must retain b's frequency");
        assert!(
            !cache.has(&c),
            "the lower-scoring c entry is evicted instead"
        );
    }

    #[test]
    fn eviction_considers_only_the_five_least_recent_entries() {
        let mut cache = EmbeddingCache::new(6.0);
        let keys: Vec<JsString> = (b'a'..=b'g')
            .map(|letter| key(&(letter as char).to_string()))
            .collect();
        for (index, key) in keys.iter().take(6).enumerate() {
            cache.set(key.clone(), index, index as f64, f64::ln);
        }

        cache.set(keys[0].clone(), 99, 6.0, f64::ln);
        cache.set(keys[6].clone(), 100, 60_000.0, f64::ln);

        assert!(
            cache.has(&keys[0]),
            "the head is outside the five-tail scan"
        );
        assert!(!cache.has(&keys[1]), "the oldest scanned entry is evicted");
    }

    #[test]
    fn non_positive_capacity_uses_the_legacy_default() {
        let cache = EmbeddingCache::<()>::new(-0.0);
        assert_eq!(
            cache.stats(),
            EmbeddingCacheStats {
                size: 0,
                capacity: DEFAULT_EMBEDDING_CACHE_CAPACITY,
                usage: 0.0,
            }
        );
    }
}
