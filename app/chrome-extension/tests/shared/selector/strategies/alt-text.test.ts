/**
 * Alt-text strategy tests (IMP-0098 — getByAltText parity).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { altTextStrategy, resolveByAltText } from '@/shared/selector/strategies/alt-text';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('resolveByAltText', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('finds img by alt (substring)', () => {
    setBody('<img alt="Company Logo" />');
    expect(resolveByAltText(document, 'Logo')).toHaveLength(1);
  });

  it('finds area by alt', () => {
    setBody('<area alt="Home" href="/" />');
    expect(resolveByAltText(document, 'Home')).toHaveLength(1);
  });

  it('finds input[type=image] by alt', () => {
    setBody('<input type="image" alt="Submit" />');
    expect(resolveByAltText(document, 'Submit')).toHaveLength(1);
  });

  it('does not match div with alt attribute (only img/area/input[type=image])', () => {
    setBody('<div alt="x">x</div>');
    expect(resolveByAltText(document, 'x')).toEqual([]);
  });

  it('exact mode is case-sensitive after normalization', () => {
    setBody('<img alt="Logo" />');
    expect(resolveByAltText(document, 'logo', true)).toEqual([]);
    expect(resolveByAltText(document, 'Logo', true)).toHaveLength(1);
  });
});

describe('altTextStrategy.generate', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('emits an alt candidate', () => {
    setBody('<img alt="Hero" />');
    const el = document.querySelector('img')!;
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
    const cands = altTextStrategy.generate(ctx);
    expect(cands).toHaveLength(1);
    expect((cands[0] as any).text).toBe('Hero');
  });

  it('emits nothing for empty alt', () => {
    setBody('<img alt="" />');
    const el = document.querySelector('img')!;
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
    expect(altTextStrategy.generate(ctx)).toEqual([]);
  });
});
