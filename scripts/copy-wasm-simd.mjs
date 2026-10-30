#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'packages', 'wasm-simd', 'pkg');
const destination = join(root, 'app', 'chrome-extension', 'workers');

await mkdir(destination, { recursive: true });
await Promise.all([
  copyFile(join(source, 'simd_math.js'), join(destination, 'simd_math.js')),
  copyFile(join(source, 'simd_math_bg.wasm'), join(destination, 'simd_math_bg.wasm')),
]);
console.log('SIMD WASM: copied browser assets');
