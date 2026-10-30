import initialize, * as kernel from '../generated/humanchrome_wasm.js';
import { RUST_KERNEL_ID } from '../generated/rust-kernel-id.js';

export { RUST_KERNEL_ID };

interface RealmKernel {
  kernel: typeof kernel;
  initialized: boolean;
  initialization: Promise<void>;
}

// Content bundles are independent IIFEs. Their shared host is the realm, not a module cache.
const stateKey = Symbol.for(`humanchrome.rust-kernel.${RUST_KERNEL_ID}`);
const realm = globalThis as typeof globalThis & { [stateKey]?: RealmKernel };

/** Initializes one kernel per realm. The host supplies bytes/module; this layer never fetches. */
export function initializeRustBindings(input: WebAssembly.Module | BufferSource): Promise<void> {
  const existing = realm[stateKey];
  if (existing) return existing.initialization;
  const state: RealmKernel = {
    kernel,
    initialized: false,
    initialization: initialize({ module_or_path: input }).then(() => {
      state.initialized = true;
    }),
  };
  realm[stateKey] = state;
  return state.initialization;
}

/** Allows a host to reuse a byte-bootstrap or test-host initialization without fetching again. */
export function getRustBindingsInitialization(): Promise<void> | undefined {
  return realm[stateKey]?.initialization;
}

/** Policy facades may create state only after their realm's initialization has completed. */
export function getRustKernel(): typeof kernel {
  const state = realm[stateKey];
  if (!state?.initialized) {
    throw new Error('Rust policy kernel has not been initialized in this realm');
  }
  return state.kernel;
}
