/**
 * IMP-0183 — unit tests for the dispatcher idempotency cache.
 *
 * Tests cover the storage primitive (`lookupIdempotentResult` /
 * `recordIdempotentResult`); the end-to-end wiring through `setupTools`
 * is exercised by `dispatcher.contract.test.ts`.
 */
import { afterEach, beforeEach, describe, test, expect } from '@jest/globals';
import {
  lookupIdempotentResult,
  recordIdempotentResult,
  _resetIdemCacheForTest,
  _setIdemCacheConfigForTest,
  _idemCacheSizeForTest,
} from './idem-cache';

const result = (text: string): any => ({
  content: [{ type: 'text', text }],
  isError: false,
});

beforeEach(() => {
  _resetIdemCacheForTest();
});

afterEach(() => {
  _resetIdemCacheForTest();
});

describe('idem-cache lookup/record', () => {
  test('records and returns the cached result for the same triple', () => {
    recordIdempotentResult('client-1', 'chrome_navigate', 'k1', result('first'));
    const hit = lookupIdempotentResult('client-1', 'chrome_navigate', 'k1');
    expect(hit).not.toBeNull();
    expect((hit as any).content[0].text).toBe('first');
    expect((hit as any)._meta.idempotent_hit).toBe(true);
  });

  test('different clientId is a cache miss', () => {
    recordIdempotentResult('client-1', 'chrome_navigate', 'k1', result('a'));
    expect(lookupIdempotentResult('client-2', 'chrome_navigate', 'k1')).toBeNull();
  });

  test('different toolName is a cache miss', () => {
    recordIdempotentResult('client-1', 'chrome_navigate', 'k1', result('a'));
    expect(lookupIdempotentResult('client-1', 'chrome_click_element', 'k1')).toBeNull();
  });

  test('different idemKey is a cache miss', () => {
    recordIdempotentResult('client-1', 'chrome_navigate', 'k1', result('a'));
    expect(lookupIdempotentResult('client-1', 'chrome_navigate', 'k2')).toBeNull();
  });

  test('missing idemKey is always a miss (no caching without a key)', () => {
    recordIdempotentResult('client-1', 'chrome_navigate', undefined, result('a'));
    expect(lookupIdempotentResult('client-1', 'chrome_navigate', undefined)).toBeNull();
    expect(_idemCacheSizeForTest()).toBe(0);
  });

  test('expired entries are evicted on lookup', () => {
    _setIdemCacheConfigForTest({ ttlMs: 1 });
    recordIdempotentResult('client-1', 'chrome_navigate', 'k1', result('a'));
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const hit = lookupIdempotentResult('client-1', 'chrome_navigate', 'k1');
        expect(hit).toBeNull();
        resolve();
      }, 10),
    );
  });

  test('LRU eviction caps cache size', () => {
    _setIdemCacheConfigForTest({ maxEntries: 3, ttlMs: 60_000 });
    recordIdempotentResult('client-1', 'chrome_navigate', 'k1', result('1'));
    recordIdempotentResult('client-1', 'chrome_navigate', 'k2', result('2'));
    recordIdempotentResult('client-1', 'chrome_navigate', 'k3', result('3'));
    expect(_idemCacheSizeForTest()).toBe(3);
    recordIdempotentResult('client-1', 'chrome_navigate', 'k4', result('4'));
    expect(_idemCacheSizeForTest()).toBe(3);
    // k1 should have been evicted (oldest).
    expect(lookupIdempotentResult('client-1', 'chrome_navigate', 'k1')).toBeNull();
    expect(lookupIdempotentResult('client-1', 'chrome_navigate', 'k4')).not.toBeNull();
  });

  test('lookup refreshes LRU position', () => {
    _setIdemCacheConfigForTest({ maxEntries: 3, ttlMs: 60_000 });
    recordIdempotentResult('c', 't', 'k1', result('1'));
    recordIdempotentResult('c', 't', 'k2', result('2'));
    recordIdempotentResult('c', 't', 'k3', result('3'));
    // Touch k1 — should now be the newest.
    lookupIdempotentResult('c', 't', 'k1');
    recordIdempotentResult('c', 't', 'k4', result('4'));
    // k2 should be evicted (oldest after the refresh), not k1.
    expect(lookupIdempotentResult('c', 't', 'k1')).not.toBeNull();
    expect(lookupIdempotentResult('c', 't', 'k2')).toBeNull();
  });

  test('cached error results replay identically', () => {
    const err = { content: [{ type: 'text', text: 'oops' }], isError: true } as any;
    recordIdempotentResult('c', 't', 'k1', err);
    const hit: any = lookupIdempotentResult('c', 't', 'k1');
    expect(hit).not.toBeNull();
    expect(hit.isError).toBe(true);
    expect(hit._meta.idempotent_hit).toBe(true);
  });

  test('_meta on the original result is preserved and augmented', () => {
    const base = {
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      _meta: { suggested_next: ['chrome_click_element'] },
    } as any;
    recordIdempotentResult('c', 't', 'k1', base);
    const hit: any = lookupIdempotentResult('c', 't', 'k1');
    expect(hit._meta.suggested_next).toEqual(['chrome_click_element']);
    expect(hit._meta.idempotent_hit).toBe(true);
  });
});
