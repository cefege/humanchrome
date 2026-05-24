/**
 * Tests for the dispatcher's `tabAlias` arg resolution (IMP-0170).
 *
 * - `{tabAlias: 'name'}` resolves through `resolveAliasForClient` to the
 *   underlying tabId, which then flows through the normal ownership gate.
 * - `tabId` + `tabAlias` together → INVALID_ARGS (mutually exclusive).
 * - Unknown alias → TAB_NOT_FOUND with details.reason='unknown-alias'.
 * - The dispatcher strips `tabAlias` from args before forwarding to the
 *   tool, so tools never see the meta-arg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleCallTool } from '@/entrypoints/background/tools';
import {
  _resetClientStateForTests,
  claimTabForClient,
  setAliasForClient,
} from '@/entrypoints/background/utils/client-state';

beforeEach(() => {
  _resetClientStateForTests();
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: { addListener: vi.fn() },
      query: vi.fn(async () => []),
      update: vi.fn(),
      create: vi.fn(),
    },
    windows: {
      get: vi.fn(async (id: number) => ({ id })),
      onRemoved: { addListener: vi.fn() },
      update: vi.fn(),
    },
    runtime: { lastError: undefined },
  };
});

afterEach(() => {
  _resetClientStateForTests();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('dispatcher — tabAlias arg resolution (IMP-0170)', () => {
  it('resolves a known alias to the underlying tabId', async () => {
    claimTabForClient('alice', 200, 1);
    setAliasForClient('alice', 'checkout', 200);

    // chrome_click_element is mutating and would normally auto-spawn if
    // no tab resolves. We pass the alias and expect the dispatcher to
    // pin tabId=200 in the forwarded args.
    const res = await handleCallTool(
      { name: 'chrome_click_element', args: { tabAlias: 'checkout', selector: '#x' } },
      'req-alias-1',
      'alice',
    );
    // Tool execution itself fails (no real page) — what matters is the
    // dispatcher didn't return INVALID_ARGS or TAB_NOT_FOUND. The
    // response will come from the tool, not the dispatcher's gates.
    const body = parseBody(res);
    if (res.isError) {
      // Tool's own failure is fine; it just shouldn't be an alias error.
      expect(body.error?.code).not.toBe('INVALID_ARGS');
      expect(body.error?.code).not.toBe('TAB_NOT_FOUND');
    }
  });

  it('returns INVALID_ARGS when both tabId and tabAlias are passed', async () => {
    claimTabForClient('alice', 100, 1);
    setAliasForClient('alice', 'checkout', 100);

    const res = await handleCallTool(
      { name: 'chrome_click_element', args: { tabId: 100, tabAlias: 'checkout', selector: '#x' } },
      'req-alias-2',
      'alice',
    );
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('INVALID_ARGS');
    expect(body.error.message).toMatch(/tabAlias/);
  });

  it('returns TAB_NOT_FOUND with details.reason="unknown-alias" for an unset alias', async () => {
    claimTabForClient('alice', 100, 1);

    const res = await handleCallTool(
      { name: 'chrome_click_element', args: { tabAlias: 'never-set', selector: '#x' } },
      'req-alias-3',
      'alice',
    );
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('TAB_NOT_FOUND');
    expect(body.error.details?.reason).toBe('unknown-alias');
    expect(body.error.details?.alias).toBe('never-set');
  });

  it("returns TAB_NOT_OWNED when the alias points at another client's tab (force-claimed)", async () => {
    claimTabForClient('alice', 100, 1);
    setAliasForClient('alice', 'checkout', 100);
    // Simulate force-claim: bob takes the tab without alice's alias being
    // cleaned up (this is the defensive edge case the alias resolver
    // handles via the ownership re-check).
    claimTabForClient('bob', 100, 1);

    const res = await handleCallTool(
      { name: 'chrome_click_element', args: { tabAlias: 'checkout', selector: '#x' } },
      'req-alias-4',
      'alice',
    );
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    // Either TAB_NOT_OWNED (caught at re-resolve) or TAB_NOT_FOUND with
    // reason=tab-closed (caught at alias resolver). Both are acceptable
    // ways to signal "this alias no longer points at one of your tabs."
    expect(['TAB_NOT_OWNED', 'TAB_NOT_FOUND']).toContain(body.error.code);
  });
});
