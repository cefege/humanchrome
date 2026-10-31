import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { generateExtendedSelectorTarget } from '@/shared/selector';

interface RecorderRealm {
  __rrSelectorEngine?: {
    generateExtendedSelectorTarget: typeof generateExtendedSelectorTarget;
    computeFingerprint: (element: Element) => string;
  };
}

const realm = globalThis as typeof globalThis & RecorderRealm;
let source: string;

beforeAll(async () => {
  source = await readFile(
    resolve(import.meta.dirname, '../../inject-scripts/selector-engine-bundle.js'),
    'utf8',
  );
});

beforeEach(() => {
  document.body.innerHTML = '';
  delete realm.__rrSelectorEngine;
  // executeScript files are classic scripts, not imported modules.
  new Function(source).call(globalThis);
});

describe('packaged recorder selector bootstrap', () => {
  it('publishes the synchronous engine and selects the first button', () => {
    expect(realm.__rrSelectorEngine).toBeDefined();
    document.body.innerHTML = '<button id="fallback-id" data-testid="cta">Sign in</button>';
    const button = document.querySelector('button')!;
    const target = realm.__rrSelectorEngine!.generateExtendedSelectorTarget(button);
    expect(target.candidates[0].strategy).toBe('testid');
    expect(document.querySelector(target.selector!)).toBe(button);
    expect(target.fingerprint).toContain('button');
    expect(target.domPath).toEqual([0, 1, 0]);
  });

  it('folds contextual Unicode tag casing while retaining fingerprint text case', () => {
    const element = document.createElement('ΟΣ');
    element.textContent = 'ΟΣ';
    expect(realm.__rrSelectorEngine!.computeFingerprint(element)).toBe('ος|text=ΟΣ');
  });

  it('retains the ready engine across reinjection before another recorded event', () => {
    const first = realm.__rrSelectorEngine;
    new Function(source).call(globalThis);
    expect(realm.__rrSelectorEngine).toBe(first);
    document.body.innerHTML = '<input data-testid="email" aria-label="Email" />';
    const input = document.querySelector('input')!;
    const target = realm.__rrSelectorEngine!.generateExtendedSelectorTarget(input);
    expect(document.querySelector(target.selector!)).toBe(input);
    expect(target.candidates[0].strategy).toBe('testid');
  });
  it('retains the persisted recorder label and placeholder candidate contract', () => {
    document.body.innerHTML =
      '<label for="email-in">Email address</label><input id="email-in" placeholder="you@example.com" />';
    const input = document.querySelector('input')!;
    const target = realm.__rrSelectorEngine!.generateExtendedSelectorTarget(input);

    expect(document.querySelector(target.selector!)).toBe(input);
    expect(target.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'aria',
          value: 'textbox[name="Email address"]',
          role: 'textbox',
          name: 'Email address',
          weight: 30,
          strategy: 'label',
        }),
        expect.objectContaining({
          type: 'attr',
          value: target.selector,
          weight: 25,
          strategy: 'placeholder',
        }),
      ]),
    );
  });
});
