import { getRustBindingsInitialization, initializeRustBindings, RUST_KERNEL_ID } from 'humanchrome-shared';

const initializationKey = Symbol.for(`humanchrome.rust-kernel-loading.${RUST_KERNEL_ID}`);
const bytesKey = Symbol.for(`humanchrome.rust-kernel-bytes.${RUST_KERNEL_ID}`);
const realm = globalThis as typeof globalThis & {
  [initializationKey]?: Promise<void>;
  [bytesKey]?: Promise<Uint8Array<ArrayBuffer>>;
};

/** Reuses packaged bytes for the JSON-safe isolated-frame recorder bootstrap. */
export function getPackagedRustKernelBytes(): Promise<Uint8Array<ArrayBuffer>> {
  return realm[bytesKey] ??= (async () => {
    const response = await fetch(chrome.runtime.getURL('workers/humanchrome_wasm_bg.wasm'));
    if (!response.ok) {
      throw new Error(`Packaged Rust policy kernel could not be loaded (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  })();
}

/** Test host supplies the same generated local bytes without a Chrome resource fetch. */
export function _seedRustKernelBytesForTest(bytes: Uint8Array<ArrayBuffer>): void {
  realm[bytesKey] = Promise.resolve(bytes);
}

/** Fetches only the packaged binary; generated JavaScript is statically bundled by shared. */
export function ensureRustKernel(): Promise<void> {
  return realm[initializationKey] ??= getRustBindingsInitialization() ?? (async () => {
    await initializeRustBindings(await getPackagedRustKernelBytes());
  })();
}
