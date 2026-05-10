import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import { defineConfig } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  // Global ignores - these apply to all configurations
  {
    ignores: [
      'dist/**',
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'logs/**',
      '*.log',
      '.cache/**',
      '.temp/**',
      '.vscode/**',
      '!.vscode/extensions.json',
      '.idea/**',
      '.DS_Store',
      'Thumbs.db',
      '*.zip',
      '*.tar.gz',
      'stats.html',
      'stats-*.json',
      'libs/**',
      'workers/**',
      'public/libs/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,vue}'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.browser,
        chrome: 'readonly',
      },
    },
  },
  {
    // Node-side scripts (smoke tests, build helpers) need Node globals.
    files: ['**/*.mjs', '**/*.cjs', '**/scripts/**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
      // ESLint 10 enabled these as `error` by default. Both surface
      // ~50 stylistic violations across the codebase; flip back to `off`
      // for the v10 bump and clean up surgically as a follow-up.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  pluginVue.configs['flat/essential'],
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: tseslint.parser } } },
  // Tools/browser is the LLM-facing surface — keep it free of `as any` so
  // signatures stay trustworthy. Use a typed shim or eslint-disable with a
  // one-line reason when a chrome.* gap really does need an escape hatch.
  {
    files: ['entrypoints/background/tools/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: true }],
    },
  },
  // Legacy files that pre-date the rule. Downgraded to `warn` so the CI
  // gate keeps NEW tool code clean while the existing surface gets cleaned
  // incrementally (tracked by IMP backlog). Drop entries from this list
  // as files reach zero violations.
  {
    files: [
      'entrypoints/background/tools/base-browser.ts',
      'entrypoints/background/tools/index.ts',
      'entrypoints/background/tools/record-replay.ts',
      'entrypoints/background/tools/browser/bookmark.ts',
      'entrypoints/background/tools/browser/computer.ts',
      'entrypoints/background/tools/browser/computer/cdp-helper.ts',
      'entrypoints/background/tools/browser/console.ts',
      'entrypoints/background/tools/browser/network-capture-debugger.ts',
      'entrypoints/background/tools/browser/network-capture-web-request.ts',
      'entrypoints/background/tools/browser/network-capture.ts',
      'entrypoints/background/tools/browser/network-request.ts',
      'entrypoints/background/tools/browser/performance.ts',
      'entrypoints/background/tools/browser/read-page.ts',
      'entrypoints/background/tools/browser/screenshot.ts',
      'entrypoints/background/tools/browser/userscript.ts',
      'entrypoints/background/tools/browser/web-fetcher.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': ['warn', { ignoreRestArgs: true }],
    },
  },
  // Prettier configuration - must be placed last to override previous rules
  prettierConfig,
]);
