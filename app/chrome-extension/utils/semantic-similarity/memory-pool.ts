/** Float32Array recycler for the embedding engine. */
export class EmbeddingMemoryPool {
  private readonly pools = new Map<number, Float32Array[]>();
  private readonly maxPoolSize = 10;
  private stats = { allocated: 0, reused: 0, released: 0 };

  getEmbedding(size: number): Float32Array {
    const pool = this.pools.get(size);
    if (pool?.length) {
      this.stats.reused++;
      return pool.pop()!;
    }
    this.stats.allocated++;
    return new Float32Array(size);
  }

  releaseEmbedding(embedding: Float32Array): void {
    const pool = this.pools.get(embedding.length) ?? [];
    if (!this.pools.has(embedding.length)) this.pools.set(embedding.length, pool);
    if (pool.length < this.maxPoolSize) {
      embedding.fill(0);
      pool.push(embedding);
      this.stats.released++;
    }
  }

  getStats(): { allocated: number; reused: number; released: number } {
    return { ...this.stats };
  }

  clear(): void {
    this.pools.clear();
    this.stats = { allocated: 0, reused: 0, released: 0 };
  }
}
