/**
 * Placeholder strategy tests (IMP-0098 — getByPlaceholder parity).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  placeholderStrategy,
  resolveByPlaceholder,
} from '@/shared/selector/strategies/placeholder';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('resolveByPlaceholder', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('finds inputs by placeholder substring (case-insensitive)', () => {
    setBody('<input placeholder="Search for products" />');
    expect(resolveByPlaceholder(document, 'search')).toHaveLength(1);
    expect(resolveByPlaceholder(document, 'PRODUCTS')).toHaveLength(1);
  });

  it('finds textarea by placeholder', () => {
    setBody('<textarea placeholder="Your message"></textarea>');
    expect(resolveByPlaceholder(document, 'message')).toHaveLength(1);
  });

  it('exact mode rejects partials', () => {
    setBody('<input placeholder="Search for products" />');
    expect(resolveByPlaceholder(document, 'Search', true)).toEqual([]);
    expect(resolveByPlaceholder(document, 'Search for products', true)).toHaveLength(1);
  });

  it('returns empty for missing placeholder', () => {
    setBody('<input />');
    expect(resolveByPlaceholder(document, 'foo')).toEqual([]);
  });

  it('does not match non-input/textarea', () => {
    setBody('<div placeholder="x">x</div>');
    expect(resolveByPlaceholder(document, 'x')).toEqual([]);
  });
});

describe('placeholderStrategy.generate', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('emits a placeholder candidate', () => {
    setBody('<input placeholder="Email" />');
    const el = document.querySelector('input')!;
    const ctx: any = {
      element: el,
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
    const cands = placeholderStrategy.generate(ctx);
    expect(cands).toHaveLength(1);
    expect((cands[0] as any).text).toBe('Email');
  });
});
