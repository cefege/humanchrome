#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const extension = join(root, 'app/chrome-extension');
const { build } = createRequire(new URL('../packages/shared/package.json', import.meta.url))('esbuild');
await mkdir(join(extension, 'public/workers'), { recursive: true });
await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: [join(extension, 'workers/similarity.worker.js')],
    outfile: join(extension, 'public/workers/similarity.worker.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    plugins: [{
      name: 'onnx-runtime-module',
      setup(bundler) {
        bundler.onLoad({ filter: /[\\/]ort\.min\.js$/ }, async ({ path }) => ({
          // The shipped classic vendor selects its CommonJS export using local bindings.
          // Bundle that real export; module workers have no global `ort`.
          contents: `const module = { exports: {} }; const exports = module.exports;\n` +
            await readFile(path, 'utf8') + '\nexport default module.exports;\n',
          loader: 'js',
        }));
      },
    }],
  }),
  build({
    absWorkingDir: root,
    entryPoints: [join(extension, 'inject-scripts/selector-engine-entry.ts')],
    outfile: join(extension, 'inject-scripts/selector-engine-bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
]);
console.log('Browser assets: statically bundled semantic worker and selector IIFE');
