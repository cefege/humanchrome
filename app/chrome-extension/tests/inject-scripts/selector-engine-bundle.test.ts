import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { generateExtendedSelectorTarget } from '@/shared/selector';

interface RecorderRealm {
  __rrSelectorEngine?: {
    generateExtendedSelectorTarget: typeof generateExtendedSelectorTarget;
    computeFingerprint: (element: Element) => string;
  };
  __hcInitializeRustKernel?: (bytes: number[]) => Promise<void>;
  __hcRustReady?: Promise<void>;
  __hcRustKernelId?: string;
}

const realm = globalThis as typeof globalThis & RecorderRealm;
let source: string;
let bytes: number[];

beforeAll(async () => {
  source = await readFile(resolve(import.meta.dirname, '../../inject-scripts/selector-engine-bundle.js'), 'utf8');
  bytes = Array.from(await readFile(resolve(import.meta.dirname, '../../../../packages/shared/generated/humanchrome_wasm_bg.wasm')));
});

beforeEach(() => {
  document.body.innerHTML = '';
  delete realm.__rrSelectorEngine;
  delete realm.__hcRustReady;
  delete realm.__hcRustKernelId;
  // executeScript files are classic scripts, not imported modules.
  new Function(source).call(globalThis);
});

describe('packaged recorder selector bootstrap', () => {
  it('publishes the engine only after the JSON-byte bootstrap and selects the first button', async () => {
    expect(realm.__rrSelectorEngine).toBeUndefined();
    document.body.innerHTML = '<button id="fallback-id" data-testid="cta">Sign in</button>';
    const button = document.querySelector('button')!;
    await realm.__hcInitializeRustKernel!(bytes);
    const target = realm.__rrSelectorEngine!.generateExtendedSelectorTarget(button);
    expect(target.candidates[0].strategy).toBe('testid');
    expect(document.querySelector(target.selector!)).toBe(button);
    expect(target.fingerprint).toContain('button');
    expect(target.domPath).toEqual([0, 1, 0]);
  });

  it('folds contextual Unicode tag casing while retaining fingerprint text case', async () => {
    await realm.__hcInitializeRustKernel!(bytes);
    const element = document.createElement('ΟΣ');
    element.textContent = 'ΟΣ';
    expect(realm.__rrSelectorEngine!.computeFingerprint(element)).toBe('ος|text=ΟΣ');
  });

  it('retains a ready engine across reinjection before another recorded event', async () => {
    await realm.__hcInitializeRustKernel!(bytes);
    const first = realm.__rrSelectorEngine;
    new Function(source).call(globalThis);
    await realm.__hcInitializeRustKernel!([]);
    expect(realm.__rrSelectorEngine).toBe(first);
    document.body.innerHTML = '<input data-testid="email" aria-label="Email" />';
    const input = document.querySelector('input')!;
    const target = realm.__rrSelectorEngine!.generateExtendedSelectorTarget(input);
    expect(document.querySelector(target.selector!)).toBe(input);
    expect(target.candidates[0].strategy).toBe('testid');
  });
});
