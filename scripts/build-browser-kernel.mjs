#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cargo = process.env.CARGO || 'cargo';
const bindgen = process.env.WASM_BINDGEN || 'wasm-bindgen';

const metadata = JSON.parse(execFileSync(cargo, [
  'metadata', '--locked', '--format-version', '1',
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const wasmPackage = metadata.packages.find((entry) => entry.name === 'humanchrome-wasm');
const bindgenDependency = metadata.resolve.nodes.find((entry) => entry.id === wasmPackage.id)
  .deps.find((entry) => entry.name === 'wasm_bindgen');
const bindgenVersion = metadata.packages.find((entry) => entry.id === bindgenDependency.pkg).version;
if (process.argv.includes('--print-bindgen-version')) {
  console.log(bindgenVersion);
  process.exit(0);
}
const installedBindgen = execFileSync(bindgen, ['--version'], { encoding: 'utf8' }).trim();
if (installedBindgen !== `wasm-bindgen ${bindgenVersion}`) {
  throw new Error(`Cargo.lock requires wasm-bindgen-cli ${bindgenVersion}; install with cargo install wasm-bindgen-cli --version ${bindgenVersion} --locked`);
}

execFileSync(cargo, [
  'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown',
  '-p', 'humanchrome-wasm',
], { cwd: root, stdio: 'inherit' });
const generated = join(root, 'packages/shared/generated');
await mkdir(generated, { recursive: true });
execFileSync(bindgen, [
  '--target', 'web', '--omit-default-module-path', '--out-name', 'humanchrome_wasm',
  '--out-dir', generated,
  join(metadata.target_directory, 'wasm32-unknown-unknown/release/humanchrome_wasm.wasm'),
], { cwd: root, stdio: 'inherit' });
// Publish module metadata atomically: concurrent readers must never see a truncated package.json.
const temporaryPackage = join(generated, `.package-${process.pid}.json`);
try {
  await writeFile(temporaryPackage, '{"type":"module"}\n');
  await rename(temporaryPackage, join(generated, 'package.json'));
} finally {
  await rm(temporaryPackage, { force: true });
}
const kernelBytes = await readFile(join(generated, 'humanchrome_wasm_bg.wasm'));
const kernelId = createHash('sha256').update(kernelBytes).digest('hex');
const bindings = await import(pathToFileURL(join(generated, 'humanchrome_wasm.js')).href);
await bindings.default({ module_or_path: kernelBytes });
await writeFile(
  join(generated, 'rust-kernel-id.ts'),
  `export const RUST_KERNEL_ID = '${kernelId}';\n` +
  `export const DEFAULT_OUTPUT_BUDGET_BYTES = ${bindings.output_default_budget_bytes()};\n`,
);

const workers = join(root, 'app/chrome-extension/workers');
await mkdir(workers, { recursive: true });
await copyFile(join(generated, 'humanchrome_wasm_bg.wasm'), join(workers, 'humanchrome_wasm_bg.wasm'));
console.log('Browser kernel: generated typed static glue and packaged workers/humanchrome_wasm_bg.wasm');
