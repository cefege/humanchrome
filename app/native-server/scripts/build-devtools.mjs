import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// DevTools normally generates this module through GN. The server formats English
// summaries without browser locale fetching; keep that build configuration explicit.
const locales = {
  name: 'server-devtools-locales',
  setup(builder) {
    builder.onResolve({ filter: /\/locales\.js$/ }, (args) => {
      if (args.importer.endsWith('/core/i18n/i18nImpl.ts')) {
        return { path: 'server-locales', namespace: 'server-devtools' };
      }
    });
    builder.onLoad({ filter: /.*/, namespace: 'server-devtools' }, () => ({
      contents: `export const LOCALES = ['en-US'];
export const BUNDLED_LOCALES = ['en-US'];
export const DEFAULT_LOCALE = 'en-US';
export const REMOTE_FETCH_PATTERN = '@HOST@/remote/serve_file/@VERSION@/core/i18n/locales/@LOCALE@.json';
export const LOCAL_FETCH_PATTERN = './locales/@LOCALE@.json';`,
      loader: 'js',
    }));
  },
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  legalComments: 'eof',
  banner: { js: 'globalThis.self ??= globalThis;' },
  plugins: [locales],
};
export async function buildEngineAdapters(adapters, dependencyRoot = root) {
  const options = { ...common, nodePaths: [join(dependencyRoot, 'node_modules')] };
  await mkdir(adapters, { recursive: true });
  await build({ ...options, entryPoints: [join(root, 'adapters', 'devtools-entry.ts')], outfile: join(adapters, 'devtools-engine.mjs'), format: 'esm' });
  await copyFile(join(root, 'adapters', 'third-party.mjs'), join(adapters, 'third-party.mjs'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await rm(join(root, 'dist'), { recursive: true, force: true });
  const output = join(root, 'dist', 'adapters');
  await buildEngineAdapters(output);
  console.log('Built optional upstream DevTools and Claude SDK adapter boundary');
}
