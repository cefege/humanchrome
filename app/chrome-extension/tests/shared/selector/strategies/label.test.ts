/**
 * Label strategy tests (IMP-0098 — getByLabel parity).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { labelStrategy, resolveByLabel } from '@/shared/selector/strategies/label';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('resolveByLabel', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('finds input via label[for]', () => {
    setBody(`
      <label for="e">Email</label>
      <input id="e" />
    `);
    const out = resolveByLabel(document, 'Email');
    expect(out).toHaveLength(1);
    expect(out[0].tagName).toBe('INPUT');
  });

  it('finds input via wrapping label', () => {
    setBody(`<label>Username <input /></label>`);
    const out = resolveByLabel(document, 'Username');
    expect(out).toHaveLength(1);
  });

  it('finds textarea via aria-label', () => {
    setBody(`<textarea aria-label="Bio"></textarea>`);
    const out = resolveByLabel(document, 'Bio');
    expect(out).toHaveLength(1);
  });

  it('contains is the default match mode (case-insensitive substring)', () => {
    setBody(`<label for="e">Email Address</label><input id="e" />`);
    const out = resolveByLabel(document, 'email');
    expect(out).toHaveLength(1);
  });

  it('exact mode rejects partial matches', () => {
    setBody(`<label for="e">Email Address</label><input id="e" />`);
    expect(resolveByLabel(document, 'Email', true)).toEqual([]);
    expect(resolveByLabel(document, 'Email Address', true)).toHaveLength(1);
  });

  it('does not match non-labellable elements', () => {
    setBody('<div aria-label="Name">x</div>');
    expect(resolveByLabel(document, 'Name')).toEqual([]);
  });

  it('skips type=hidden inputs', () => {
    setBody('<input type="hidden" aria-label="csrf" />');
    expect(resolveByLabel(document, 'csrf')).toEqual([]);
  });

  it('returns empty for empty target text', () => {
    setBody(`<label for="e">Email</label><input id="e" />`);
    expect(resolveByLabel(document, '')).toEqual([]);
  });
});

describe('labelStrategy.generate', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('emits a label candidate for a labelled control', () => {
    setBody(`<label for="e">Email</label><input id="e" />`);
    const input = document.querySelector('input')!;
    const ctx: any = {
      element: input,
      root: document,
      options: {
        maxCandidates: 10,
        includeText: true,
        includeAria: true,
        includeCssUnique: true,
        includeCssPath: true,
        testIdAttributes: [],
        textMaxLength: 64,
        textTags: [],
      },
      helpers: { cssEscape: (v: string) => v, isUnique: () => true, safeQueryAll: () => [] },
    };
    const cands = labelStrategy.generate(ctx);
    expect(cands).toHaveLength(1);
    expect((cands[0] as any).type).toBe('label');
    expect((cands[0] as any).text).toBe('Email');
  });

  it('emits nothing for a div', () => {
    setBody('<div>x</div>');
    const div = document.querySelector('div')!;
    const ctx: any = {
      element: div,
      root: document,
      options: {
        maxCandidates: 10,
        includeText: true,
        includeAria: true,
        includeCssUnique: true,
        includeCssPath: true,
        testIdAttributes: [],
        textMaxLength: 64,
        textTags: [],
      },
      helpers: { cssEscape: (v: string) => v, isUnique: () => true, safeQueryAll: () => [] },
    };
    expect(labelStrategy.generate(ctx)).toEqual([]);
  });
});
