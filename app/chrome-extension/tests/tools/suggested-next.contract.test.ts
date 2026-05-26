/**
 * IMP-0182 — contract test for the `_meta.suggested_next` hint shape.
 *
 * Each opt-in tool returns its own hints; we don't assert WHICH tools an
 * individual hint list contains (those are tool-author judgment calls
 * that should be free to evolve). This test pins the SHAPE:
 *   - `_meta.suggested_next` is an array of non-empty strings
 *   - capped at MAX_SUGGESTED_NEXT (4) entries
 *   - de-duplicated, no empties
 *   - never attached to an error result (the IMP-0178 envelope is the
 *     recovery surface)
 *
 * The `withSuggestedNext` helper enforces all of the above; tools that
 * use it inherit the invariants for free. The end-to-end checks below
 * exercise a couple of wired tools through their public `execute()` so
 * regressions in either the helper or the wiring fail loudly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withSuggestedNext,
  MAX_SUGGESTED_NEXT,
} from '@/entrypoints/background/tools/browser/_common';
import { windowTool } from '@/entrypoints/background/tools/browser/window';
import { sessionsTool } from '@/entrypoints/background/tools/browser/sessions';

function getMeta(res: any) {
  return res?._meta ?? {};
}

describe('IMP-0182 withSuggestedNext helper', () => {
  const okResult: any = { content: [{ type: 'text' as const, text: '{}' }], isError: false };

  it('attaches _meta.suggested_next to a success result', () => {
    const out: any = withSuggestedNext(okResult, ['chrome_click_element']);
    expect(out._meta.suggested_next).toEqual(['chrome_click_element']);
  });

  it('is a no-op on error results', () => {
    const err: any = { content: [{ type: 'text' as const, text: '{}' }], isError: true };
    const out: any = withSuggestedNext(err, ['x']);
    expect(out._meta).toBeUndefined();
  });

  it('caps at MAX_SUGGESTED_NEXT entries', () => {
    const hints = Array.from({ length: 10 }, (_, i) => `tool_${i}`);
    const out: any = withSuggestedNext(okResult, hints);
    expect(out._meta.suggested_next).toHaveLength(MAX_SUGGESTED_NEXT);
    expect(out._meta.suggested_next[0]).toBe('tool_0');
  });

  it('deduplicates and drops empties / non-strings', () => {
    const out: any = withSuggestedNext(okResult, ['a', '', 'a', 'b', null as any, 'c']);
    expect(out._meta.suggested_next).toEqual(['a', 'b', 'c']);
  });

  it('omits _meta entirely when no valid hints are provided', () => {
    const out: any = withSuggestedNext(okResult, ['', null as any]);
    expect(out._meta).toBeUndefined();
  });

  it('preserves any prior _meta fields', () => {
    const withMeta: any = { ...okResult, _meta: { trace: 'rid_1' } };
    const out: any = withSuggestedNext(withMeta, ['a']);
    expect(out._meta.trace).toBe('rid_1');
    expect(out._meta.suggested_next).toEqual(['a']);
  });
});

describe('IMP-0182 wired tools surface suggested_next', () => {
  beforeEach(() => {
    (globalThis.chrome as any).windows = {
      getAll: vi.fn().mockResolvedValue([{ id: 1, tabs: [{ id: 7, url: 'about:blank' }] }]),
    };
    (globalThis.chrome as any).sessions = {
      getRecentlyClosed: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({}),
    };
    (globalThis.chrome as any).tabs = {
      query: vi.fn().mockResolvedValue([{ id: 7 }]),
      get: vi.fn().mockResolvedValue({ id: 7 }),
    };
  });

  it('chrome_get_windows_and_tabs returns suggested_next', async () => {
    const res = await (windowTool as any).execute();
    const meta = getMeta(res);
    expect(Array.isArray(meta.suggested_next)).toBe(true);
    expect(meta.suggested_next.length).toBeGreaterThan(0);
    expect(meta.suggested_next.length).toBeLessThanOrEqual(MAX_SUGGESTED_NEXT);
    for (const n of meta.suggested_next) {
      expect(typeof n).toBe('string');
      expect(n.length).toBeGreaterThan(0);
    }
  });

  it('chrome_sessions get_recently_closed returns suggested_next', async () => {
    const res = await sessionsTool.execute({ action: 'get_recently_closed' } as any);
    const meta = getMeta(res);
    expect(Array.isArray(meta.suggested_next)).toBe(true);
    expect(meta.suggested_next.length).toBeGreaterThan(0);
    expect(meta.suggested_next.length).toBeLessThanOrEqual(MAX_SUGGESTED_NEXT);
  });
});
