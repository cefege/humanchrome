import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  // Global ignores first - these apply to all configurations
  {
    ignores: [
      'node_modules/',
      'dist/',
      '.output/',
      '.wxt/',
      'logs/',
      '*.log',
      '.cache/',
      '.temp/',
      '.idea/',
      '.DS_Store',
      'Thumbs.db',
      '*.zip',
      '*.tar.gz',
      'stats.html',
      'stats-*.json',
      'pnpm-lock.yaml',
      '**/workers/**',
      'app/**/workers/**',
      'packages/**/workers/**',
      'test-inject-script.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Pin tsconfig discovery root so lint-staged across the monorepo doesn't
  // get confused by sub-configs (chrome-extension has its own).
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: __dirname,
      },
    },
  },
  // Global rule adjustments
  {
    rules: {
      // Allow intentionally empty catch blocks (common in extension code),
      // while keeping other empty blocks reported.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ESLint 10 enabled these as `error` by default. Both surface
      // ~50 violations across the codebase that are stylistic, not
      // correctness — flip back to `off` for the v10 bump and clean up
      // surgically in a follow-up. The 11 native-server callsites where
      // preserve-caught-error materially helps debugging are already
      // fixed in this PR; the rest are dead-code defaults.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['app/**/*.{js,jsx,ts,tsx}', 'packages/**/*.{js,jsx,ts,tsx}'],
    ignores: ['**/workers/**'], // Additional ignores for this specific config
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },

    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  eslintConfigPrettier,
);
