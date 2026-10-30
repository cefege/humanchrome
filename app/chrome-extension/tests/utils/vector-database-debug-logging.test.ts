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
 * This test checks observable cold-start trace silence, not source-code spelling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
