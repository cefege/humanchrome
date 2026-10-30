import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initializeRustBindings } from './src/rust-bindings';

await initializeRustBindings(
  await readFile(resolve(import.meta.dirname, './generated/humanchrome_wasm_bg.wasm')),
);
