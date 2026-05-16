/**
 * Title strategy tests (IMP-0098 — getByTitle parity).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { titleStrategy, resolveByTitle } from '@/shared/selector/strategies/title';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('resolveByTitle', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('finds any element with matching title', () => {
    setBody('<span title="Help text">?</span><div title="Hint">!</div>');
    expect(resolveByTitle(document, 'Help')).toHaveLength(1);
    expect(resolveByTitle(document, 'Hint')).toHaveLength(1);
  });

  it('exact mode requires full match', () => {
    setBody('<span title="Tooltip"></span>');
    expect(resolveByTitle(document, 'Tooltip', true)).toHaveLength(1);
    expect(resolveByTitle(document, 'Tool', true)).toEqual([]);
  });

  it('returns empty when target missing', () => {
    setBody('<span></span>');
    expect(resolveByTitle(document, 'foo')).toEqual([]);
  });
});

describe('titleStrategy.generate', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('emits a title candidate when title present', () => {
    setBody('<a title="Close">x</a>');
    const a = document.querySelector('a')!;
    const ctx: any = {
      element: a,
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
    const cands = titleStrategy.generate(ctx);
    expect(cands).toHaveLength(1);
    expect((cands[0] as any).text).toBe('Close');
  });
});
