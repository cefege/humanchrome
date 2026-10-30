import type { RustEmbeddingCache as RustEmbeddingCacheHandle } from '../generated/humanchrome_wasm';

import { getRustKernel } from './rust-bindings';

export interface EmbeddingCacheStats {
  size: number;
  capacity: number;
  usage: number;
}

/**
 * Synchronous typed wrapper over the Rust-owned embedding-cache policy.
 *
 * The first cache operation obtains a generated WASM handle after the realm has initialized the
 * shared kernel. Values remain JavaScript resources, including typed arrays and tokenizer output;
 * Rust retains only their handles and never serializes their backing buffers.
 */
export class RustEmbeddingCache<T> {
  private handle: RustEmbeddingCacheHandle | undefined;

  public constructor(private readonly requestedCapacity?: number) {}

  public get(key: string): T | null {
    return this.handleForOperation().get(JSON.stringify(key), Date.now()) as T | null;
  }

  public set(key: string, value: T): void {
    this.handleForOperation().set(JSON.stringify(key), value, Date.now());
  }

  public has(key: string): boolean {
    return this.handleForOperation().has(JSON.stringify(key));
  }

  public clear(): void {
    this.handleForOperation().clear();
  }

  public get size(): number {
    return this.handleForOperation().size;
  }

  public getStats(): EmbeddingCacheStats {
    const handle = this.handleForOperation();
    return {
      size: handle.size,
      capacity: handle.capacity,
      usage: handle.usage,
    };
  }

  private handleForOperation(): RustEmbeddingCacheHandle {
    if (!this.handle) {
      // NaN takes Rust's exact `capacity > 0 ? capacity : 100` branch for omitted/null input.
      this.handle = new (getRustKernel().RustEmbeddingCache)(this.requestedCapacity ?? Number.NaN);
    }
    return this.handle;
  }
}
