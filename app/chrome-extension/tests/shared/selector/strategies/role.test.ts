/**
 * Role strategy tests (IMP-0098).
 *
 * Covers:
 *   - implicit role inference for common interactive HTML tags
 *   - explicit role attribute overrides
 *   - accessible-name filtering (contains + exact)
 *   - parseRoleSelector serialization round-trip
 *   - generate() emits a role candidate when applicable
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  roleStrategy,
  getElementRole,
  getImplicitRole,
  resolveByRole,
  parseRoleSelector,
} from '@/shared/selector/strategies/role';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('getImplicitRole', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it.each([
    ['<button>x</button>', 'button'],
    ['<a href="/x">link</a>', 'link'],
    ['<a>just a span</a>', undefined],
    ['<input />', 'textbox'],
    ['<input type="text" />', 'textbox'],
    ['<input type="checkbox" />', 'checkbox'],
    ['<input type="radio" />', 'radio'],
    ['<input type="submit" />', 'button'],
    ['<input type="hidden" />', undefined],
    ['<textarea></textarea>', 'textbox'],
    ['<select></select>', 'combobox'],
    ['<select multiple></select>', 'listbox'],
    ['<select size="4"></select>', 'listbox'],
    ['<option>one</option>', 'option'],
    ['<h1>Title</h1>', 'heading'],
    ['<h6>Sub</h6>', 'heading'],
    ['<img alt="logo" />', 'img'],
    ['<img alt="" />', undefined],
    ['<ul></ul>', 'list'],
    ['<nav></nav>', 'navigation'],
    ['<main></main>', 'main'],
    ['<dialog></dialog>', 'dialog'],
    ['<hr />', 'separator'],
  ])('infers role for %s as %s', (html, expected) => {
    setBody(html);
    const el = document.body.firstElementChild as Element;
    expect(getImplicitRole(el)).toBe(expected);
  });

  it('explicit role attribute takes precedence', () => {
    setBody('<div role="button">click</div>');
    const el = document.querySelector('div')!;
    expect(getElementRole(el)).toBe('button');
  });

  it('explicit multi-role uses first token only', () => {
    setBody('<div role="button menuitem">click</div>');
    const el = document.querySelector('div')!;
    expect(getElementRole(el)).toBe('button');
  });

  it('<header> outside a sectioning ancestor is banner', () => {
    setBody('<header>x</header>');
    const el = document.querySelector('header')!;
    expect(getImplicitRole(el)).toBe('banner');
  });

  it('<header> inside <article> has no banner role', () => {
    setBody('<article><header>x</header></article>');
    const el = document.querySelector('header')!;
    expect(getImplicitRole(el)).toBe(undefined);
  });
});

describe('resolveByRole', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('finds every element matching a role', () => {
    setBody('<button>A</button><button>B</button>');
    const matches = resolveByRole(document, 'button');
    expect(matches).toHaveLength(2);
  });

  it('filters by accessible name (contains, case-insensitive default)', () => {
    setBody('<button>Submit</button><button>Cancel</button>');
    const matches = resolveByRole(document, 'button', 'sub');
    expect(matches).toHaveLength(1);
    expect(matches[0].textContent).toBe('Submit');
  });

  it('filters by accessible name (exact match)', () => {
    setBody('<button>Submit</button><button>Submit Form</button>');
    const matches = resolveByRole(document, 'button', 'Submit', true);
    expect(matches).toHaveLength(1);
    expect(matches[0].textContent).toBe('Submit');
  });

  it('returns empty when no element has the role', () => {
    setBody('<div>x</div>');
    expect(resolveByRole(document, 'button')).toEqual([]);
  });

  it('returns empty when accessible name does not match', () => {
    setBody('<button>Submit</button>');
    expect(resolveByRole(document, 'button', 'Cancel')).toEqual([]);
  });

  it('honors explicit role attribute', () => {
    setBody('<div role="checkbox">x</div>');
    const matches = resolveByRole(document, 'checkbox');
    expect(matches).toHaveLength(1);
  });

  it('aria-label provides accessible name for role match', () => {
    setBody('<button aria-label="Send">x</button>');
    const matches = resolveByRole(document, 'button', 'Send', true);
    expect(matches).toHaveLength(1);
  });
});

describe('parseRoleSelector', () => {
  it('parses bare role', () => {
    expect(parseRoleSelector('button')).toEqual({ role: 'button' });
  });

  it('parses role with name', () => {
    expect(parseRoleSelector('button[name="Submit"]')).toEqual({
      role: 'button',
      name: 'Submit',
    });
  });

  it('parses role with name and exact flag', () => {
    expect(parseRoleSelector('button[name="Submit",exact=true]')).toEqual({
      role: 'button',
      name: 'Submit',
      exact: true,
    });
  });

  it('returns empty object for unrecognized format', () => {
    expect(parseRoleSelector('!!!')).toEqual({});
  });

  it('normalizes role to lowercase', () => {
    expect(parseRoleSelector('BUTTON')).toEqual({ role: 'button' });
  });

  it('handles single-quoted strings', () => {
    expect(parseRoleSelector("button[name='Submit']")).toEqual({
      role: 'button',
      name: 'Submit',
    });
  });
});

describe('roleStrategy.generate', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('emits a role candidate when the element has a role', () => {
    setBody('<button aria-label="Send">x</button>');
    const ctx: any = {
      element: document.querySelector('button'),
      root: document,
      options: {
        maxCandidates: 10,
        includeText: true,
        includeAria: true,
        includeCssUnique: true,
        includeCssPath: true,
        testIdAttributes: [],
        textMaxLength: 64,
        textTags: ['button'],
      },
      helpers: {
        cssEscape: (v: string) => v,
        isUnique: () => true,
        safeQueryAll: () => [],
      },
    };
    const cands = roleStrategy.generate(ctx);
    expect(cands).toHaveLength(1);
    const c = cands[0] as any;
    expect(c.type).toBe('role');
    expect(c.role).toBe('button');
    expect(c.name).toBe('Send');
  });

  it('emits no candidate when no role applies', () => {
    setBody('<div></div>');
    const ctx: any = {
      element: document.querySelector('div'),
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
      helpers: {
        cssEscape: (v: string) => v,
        isUnique: () => true,
        safeQueryAll: () => [],
      },
    };
    const cands = roleStrategy.generate(ctx);
    expect(cands).toHaveLength(0);
  });
});

describe('roleStrategy.resolve', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('resolves via parsed selector value', () => {
    setBody('<button>Submit</button>');
    const out = roleStrategy.resolve('button[name="Submit"]', document);
    expect(out).toHaveLength(1);
  });

  it('resolves via explicit extras', () => {
    setBody('<button>Submit</button><button>Cancel</button>');
    const out = roleStrategy.resolve('button', document, { role: 'button', name: 'Cancel' });
    expect(out).toHaveLength(1);
    expect(out[0].textContent).toBe('Cancel');
  });
});
