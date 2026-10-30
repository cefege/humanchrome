import { embeddingCachePolicy } from 'humanchrome-shared';

/**
 * Browser resource cache with Rust-owned eviction, recency, and frequency policy.
 *
 * Values remain in the host realm, so typed-array backing buffers, tokenizer outputs, and UI
 * response objects retain their original resource identity. All production keys are strings;
 * keeping that boundary explicit preserves JavaScript's exact cache-key semantics.
 */
class LRUCache<K extends string = string, V = unknown> {
  private readonly cache: embeddingCachePolicy.RustEmbeddingCache<V>;

  constructor(capacity: number) {
    this.cache = new embeddingCachePolicy.RustEmbeddingCache<V>(capacity);
  }

  get(key: K): V | null {
    return this.cache.get(key);
  }

  set(key: K, value: V): void {
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  getStats(): { size: number; capacity: number; usage: number } {
    return this.cache.getStats();
  }
}

export default LRUCache;
