/**
 * IMP-0180 — contract test for tool description style.
 *
 * Enforces the fixed skeleton documented in `tool-schemas/style.md`:
 *   - ≤80 estimated tokens per description (chars/4 heuristic)
 *   - contains the literal substring `Example:`
 *   - no markdown headers (`# `, `## `, etc.)
 *   - no trailing newlines
 *
 * This is "the only authority" — when this test passes, the rewrite is
 * accepted. Banned-patterns and byte-stability are covered by
 * `tool-index.snapshot.test.ts` (IMP-0181); this test is purely about
 * per-tool description shape.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from './tools';

const TOKEN_TARGET = 80;
const CHARS_PER_TOKEN = 4;
const estTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

describe('IMP-0180 tool description style', () => {
  it('every tool has a description', () => {
    const missing = TOOL_SCHEMAS.filter((t) => !t.description || t.description.trim() === '');
    expect(missing.map((t) => t.name)).toEqual([]);
  });

  it('no description exceeds 80 tokens', () => {
    const over = TOOL_SCHEMAS.filter((t) => estTokens(t.description ?? '') > TOKEN_TARGET).map(
      (t) => ({ name: t.name, tokens: estTokens(t.description ?? '') }),
    );
    if (over.length > 0) {
      throw new Error(
        'Tools with descriptions over the 80-token IMP-0180 budget:\n' +
          over.map((o) => `  ${o.name}: ${o.tokens} tokens`).join('\n'),
      );
    }
    expect(over).toEqual([]);
  });

  it('every description contains the literal "Example:" tag', () => {
    const missing = TOOL_SCHEMAS.filter((t) => !/Example:/.test(t.description ?? '')).map(
      (t) => t.name,
    );
    if (missing.length > 0) {
      throw new Error(
        'Tools missing the IMP-0180 `Example:` clause:\n  ' + missing.join('\n  '),
      );
    }
    expect(missing).toEqual([]);
  });

  it('no description contains markdown headers', () => {
    const offenders = TOOL_SCHEMAS.filter((t) => /^#{1,6}\s/m.test(t.description ?? '')).map(
      (t) => t.name,
    );
    expect(offenders).toEqual([]);
  });

  it('no description has trailing whitespace or trailing newlines', () => {
    const offenders = TOOL_SCHEMAS.filter((t) => /\s$/.test(t.description ?? '')).map(
      (t) => t.name,
    );
    expect(offenders).toEqual([]);
  });
});
