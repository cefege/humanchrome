/**
 * IMP-0032 regression guard: ensure utils/vector-database.ts does not
 * emit verbose tracing on its hot paths.
 *
 * Pre-fix the file had ~89 unconditional `console.log` sites across
 * VectorDatabase.search() and addDocument(), plus an unconditional
 * `EmscriptenFileSystemManager.setDebugLogs(true)`. Together they
 * flooded the SW console on every embedding lookup. The fix routes
 * every informational log through a module-level `dlog()` no-op that
 * the bundler can dead-code-eliminate when DEBUG is false.
 *
 * These tests exercise both the static shape of the file (so a future
 * "just add one quick console.log" tempts the next reader less) and
 * the runtime behavior on module import.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTOR_DB_PATH = resolve(__dirname, '../../utils/vector-database.ts');

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe('vector-database debug-logging refactor (IMP-0032)', () => {
  describe('static shape', () => {
    let source: string;

    beforeEach(() => {
      source = readFileSync(VECTOR_DB_PATH, 'utf8');
    });

    it('declares DEBUG as false at the top of the module', () => {
      expect(source).toMatch(/^const DEBUG = false;$/m);
    });

    it('has at most one direct console.log call (inside the dlog definition)', () => {
      const matches = source.match(/console\.log\(/g) || [];
      // The single allowed site is the dlog definition itself, where
      // we invoke the real console.log when DEBUG is true.
      expect(matches.length).toBeLessThanOrEqual(1);
    });

    it('routes setDebugLogs through the DEBUG flag, not a literal true', () => {
      // Pre-fix: setDebugLogs(true). Post-fix: setDebugLogs(DEBUG).
      expect(source).not.toMatch(/setDebugLogs\(true\)/);
      expect(source).toMatch(/setDebugLogs\(DEBUG\)/);
    });

    it('keeps real warnings and errors un-gated (console.warn / console.error stay direct)', () => {
      // Sanity: the perf fix should not muffle legitimate warnings or
      // errors. We expect a non-trivial number of each to remain.
      const warns = source.match(/console\.warn\(/g) || [];
      const errors = source.match(/console\.error\(/g) || [];
      expect(warns.length).toBeGreaterThanOrEqual(20);
      expect(errors.length).toBeGreaterThanOrEqual(20);
    });

    it('exposes a dlog function gated on DEBUG with a no-op false branch', () => {
      // Guard against a future "DEBUG ? real : real" rewrite that would
      // accidentally always invoke console.log. We require both: a dlog
      // declaration ternary on DEBUG, and a no-op arrow somewhere in
      // the file (the false branch).
      expect(source).toMatch(/const dlog[\s\S]{0,120}=\s*DEBUG\b/);
      expect(source).toMatch(/:\s*\(\)\s*=>\s*\{\s*\}/);
    });
  });

  describe('runtime behavior', () => {
    it('does not emit any console.log on module import (cold-start trace silence)', async () => {
      // Importing the module triggers any module-scope side effects
      // (constants, helper definitions). Pre-fix this was silent too —
      // logs only fired when execute paths ran. We pin the cold-start
      // silence so a future change doesn't sneak a top-level log in.
      vi.resetModules();
      consoleLogSpy.mockClear();

      await import('@/utils/vector-database');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
});
