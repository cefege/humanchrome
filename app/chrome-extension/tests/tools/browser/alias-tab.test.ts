/**
 * Tests for `browser_alias_tab` (IMP-0169).
 *
 * Validates alias creation, validation, defaults, overwrite semantics,
 * and ownership gate. Tab-close eviction is covered separately in
 * the client-state tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aliasTabTool } from '@/entrypoints/background/tools/browser/alias-tab';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  _handleTabRemovedForTests,
  claimTabForClient,
  recordClientTab,
  resolveAliasForClient,
  listAliasesForClient,
} from '@/entrypoints/background/utils/client-state';

beforeEach(() => {
  _resetClientStateForTests();
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: { onRemoved: { addListener: vi.fn() } },
    windows: { onRemoved: { addListener: vi.fn() } },
    runtime: { lastError: undefined },
  };
});

afterEach(() => {
  _resetClientStateForTests();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('browser_alias_tab (IMP-0169)', () => {
  it('returns INVALID_ARGS when no clientId on the request context', async () => {
    const res = await aliasTabTool.execute({ alias: 'checkout', tabId: 1 });
    const body = parseBody(res);
    expect(res.isError).toBe(true);
    expect(body.error.code).toBe('INVALID_ARGS');
  });

  it('aliases the explicit tabId for the calling client', async () => {
    claimTabForClient('alice', 100, 1);
    const res = await runWithContext({ clientId: 'alice' }, () =>
      aliasTabTool.execute({ alias: 'checkout', tabId: 100 }),
    );
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.alias).toBe('checkout');
    expect(body.tabId).toBe(100);
    expect(body.clientId).toBe('alice');
    expect(resolveAliasForClient('alice', 'checkout')).toEqual({ tabId: 100 });
  });

  it('defaults tabId to the active tab when omitted', async () => {
    claimTabForClient('alice', 100);
    claimTabForClient('alice', 200);
    recordClientTab('alice', 200);
    const res = await runWithContext({ clientId: 'alice' }, () =>
      aliasTabTool.execute({ alias: 'active' }),
    );
    const body = parseBody(res);
    expect(body.tabId).toBe(200);
  });

  it('returns INVALID_ARGS when no tabId and no active tab', async () => {
    const res = await runWithContext({ clientId: 'alice' }, () =>
      aliasTabTool.execute({ alias: 'foo' }),
    );
    const body = parseBody(res);
    expect(res.isError).toBe(true);
    expect(body.error.code).toBe('INVALID_ARGS');
    expect(body.error.details?.arg).toBe('tabId');
  });

  it('returns TAB_NOT_OWNED when targeting a tab owned by another client', async () => {
    claimTabForClient('bob', 500);
    const res = await runWithContext({ clientId: 'alice' }, () =>
      aliasTabTool.execute({ alias: 'sneaky', tabId: 500 }),
    );
    const body = parseBody(res);
    expect(res.isError).toBe(true);
    expect(body.error.code).toBe('TAB_NOT_OWNED');
  });

  it('rejects malformed aliases', async () => {
    claimTabForClient('alice', 1);
    const bad = ['', 'A', '1foo', 'has space', 'has!', 'x'.repeat(33), '_leading', '-leading'];
    for (const alias of bad) {
      const res = await runWithContext({ clientId: 'alice' }, () =>
        aliasTabTool.execute({ alias, tabId: 1 }),
      );
      const body = parseBody(res);
      expect(res.isError, `alias=${JSON.stringify(alias)}`).toBe(true);
      expect(body.error.code).toBe('INVALID_ARGS');
    }
  });

  it('accepts canonical aliases at min and max length', async () => {
    claimTabForClient('alice', 1);
    const good = ['a', 'checkout', 'product-page', 'tab_42', 'x'.repeat(32)];
    for (const alias of good) {
      const res = await runWithContext({ clientId: 'alice' }, () =>
        aliasTabTool.execute({ alias, tabId: 1 }),
      );
      expect(res.isError, `alias=${JSON.stringify(alias)}`).toBe(false);
    }
  });

  it('overwriting an alias returns previousTabId in the response', async () => {
    claimTabForClient('alice', 100);
    claimTabForClient('alice', 200);
    const first = await runWithContext({ clientId: 'alice' }, () =>
      aliasTabTool.execute({ alias: 'checkout', tabId: 100 }),
    );
    expect(parseBody(first).previousTabId).toBeUndefined();

    const second = await runWithContext({ clientId: 'alice' }, () =>
      aliasTabTool.execute({ alias: 'checkout', tabId: 200 }),
    );
    const body = parseBody(second);
    expect(body.tabId).toBe(200);
    expect(body.previousTabId).toBe(100);
  });

  it('isolates aliases per client — alice and bob can both have "checkout"', async () => {
    claimTabForClient('alice', 100);
    claimTabForClient('bob', 200);
    await runWithContext({ clientId: 'alice' }, () =>
      aliasTabTool.execute({ alias: 'checkout', tabId: 100 }),
    );
    await runWithContext({ clientId: 'bob' }, () =>
      aliasTabTool.execute({ alias: 'checkout', tabId: 200 }),
    );
    expect(resolveAliasForClient('alice', 'checkout')).toEqual({ tabId: 100 });
    expect(resolveAliasForClient('bob', 'checkout')).toEqual({ tabId: 200 });
  });

  it('aliases evict when the underlying tab closes', async () => {
    claimTabForClient('alice', 100);
    await runWithContext({ clientId: 'alice' }, () =>
      aliasTabTool.execute({ alias: 'checkout', tabId: 100 }),
    );
    expect(listAliasesForClient('alice')).toEqual({ checkout: 100 });

    _handleTabRemovedForTests(100);

    expect(listAliasesForClient('alice')).toEqual({});
    expect(resolveAliasForClient('alice', 'checkout')).toEqual({ reason: 'unknown-alias' });
  });

  it('resolveAliasForClient returns unknown-alias for never-set aliases', () => {
    claimTabForClient('alice', 100);
    expect(resolveAliasForClient('alice', 'never-set')).toEqual({ reason: 'unknown-alias' });
  });
});
