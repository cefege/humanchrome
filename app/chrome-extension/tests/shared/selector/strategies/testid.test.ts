/**
 * TestID strategy tests (IMP-0098 extension — runtime resolve + configurable
 * attribute list).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  testIdStrategy,
  resolveByTestId,
  DEFAULT_TESTID_ATTRIBUTES,
} from '@/shared/selector/strategies/testid';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('DEFAULT_TESTID_ATTRIBUTES', () => {
  it('matches the Playwright + Cypress defaults', () => {
    expect(Array.from(DEFAULT_TESTID_ATTRIBUTES)).toEqual([
      'data-testid',
      'data-cy',
      'data-test',
      'data-qa',
    ]);
  });
});

describe('resolveByTestId', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('finds element by data-testid (default)', () => {
    setBody('<button data-testid="submit-btn">Go</button>');
    const out = resolveByTestId('submit-btn', document);
    expect(out).toHaveLength(1);
  });

  it('finds element by data-cy', () => {
    setBody('<button data-cy="login">x</button>');
    const out = resolveByTestId('login', document);
    expect(out).toHaveLength(1);
  });

  it('honors a custom attribute list', () => {
    setBody('<button data-my-test="alpha">x</button>');
    const out = resolveByTestId('alpha', document, ['data-my-test']);
    expect(out).toHaveLength(1);
  });

  it('returns empty when no attribute matches', () => {
    setBody('<button data-testid="foo">x</button>');
    expect(resolveByTestId('bar', document)).toEqual([]);
  });

  it('dedupes when same element matches multiple attrs', () => {
    setBody('<button data-testid="x" data-cy="x">x</button>');
    expect(resolveByTestId('x', document)).toHaveLength(1);
  });

  it('returns empty for empty value', () => {
    setBody('<button data-testid="x">x</button>');
    expect(resolveByTestId('', document)).toEqual([]);
  });
});

describe('testIdStrategy.resolve', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('resolves via default attribute list', () => {
    setBody('<button data-test="x">x</button>');
    expect(testIdStrategy.resolve('x', document)).toHaveLength(1);
  });

  it('resolves via single attribute override', () => {
    setBody('<button data-testid="alpha">x</button><button data-cy="alpha">y</button>');
    const out = testIdStrategy.resolve('alpha', document, { attribute: 'data-cy' });
    expect(out).toHaveLength(1);
    expect(out[0].textContent).toBe('y');
  });
});
