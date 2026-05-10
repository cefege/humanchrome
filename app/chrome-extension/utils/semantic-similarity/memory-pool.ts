/**
 * Float32Array recycler for the embedding engine (IMP-0019 slice 2).
 *
 * Per-token inference allocates a Float32Array of the model's dimension
 * (384 / 768 / 1024). At steady-state load that churns the GC; this pool
 * keeps a small per-size cache so repeated calls reuse buffers.
 *
 * Side-effect-free standalone class — no transformers, no engine state.
 * The engine module hands instances of this pool to its inference loop.
 */
export class EmbeddingMemoryPool {
  private pools: Map<number, Float32Array[]> = new Map();
  private maxPoolSize: number = 10;
  private stats = { allocated: 0, reused: 0, released: 0 };

  /** Get a (possibly recycled) Float32Array of the requested size. */
  getEmbedding(size: number): Float32Array {
    const pool = this.pools.get(size);
    if (pool && pool.length > 0) {
      this.stats.reused++;
      return pool.pop()!;
    }
    this.stats.allocated++;
    return new Float32Array(size);
  }

  /** Return a buffer to the pool (zero-filled for safety). */
  releaseEmbedding(embedding: Float32Array): void {
    const size = embedding.length;
    if (!this.pools.has(size)) {
      this.pools.set(size, []);
    }
    const pool = this.pools.get(size)!;
    if (pool.length < this.maxPoolSize) {
      embedding.fill(0);
      pool.push(embedding);
      this.stats.released++;
    }
  }

  getStats() {
    return { ...this.stats };
  }

  clear(): void {
    this.pools.clear();
    this.stats = { allocated: 0, reused: 0, released: 0 };
  }
}
