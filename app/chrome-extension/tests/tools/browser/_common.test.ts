/**
 * Locks the shape of `_common.jsonOk`. Drift here breaks every browser
 * tool's success path and every test that does
 * `JSON.parse(res.content[0].text)`. Keep these tests green.
 */

import { describe, expect, it } from 'vitest';

import { jsonOk } from '@/entrypoints/background/tools/browser/_common';

describe('jsonOk', () => {
  it('serializes the body as a single non-error text content block', () => {
    const res = jsonOk({ ok: true, count: 3 });
    expect(res.isError).toBe(false);
    expect(res.content).toHaveLength(1);
    const first = res.content[0] as { type: string; text: string };
    expect(first.type).toBe('text');
    expect(first.text).toBe(JSON.stringify({ ok: true, count: 3 }));
  });

  it('round-trips JSON-parseable shapes (caller does JSON.parse on res.content[0].text)', () => {
    const original = { ok: true, items: [{ id: 1 }, { id: 2 }], nested: { k: 'v' } };
    const res = jsonOk(original);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual(original);
  });

  it('handles an empty body', () => {
    expect((jsonOk({}).content[0] as { text: string }).text).toBe('{}');
  });
});
