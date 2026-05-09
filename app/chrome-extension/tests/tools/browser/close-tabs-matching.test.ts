/**
 * chrome_close_tabs_matching tests (IMP-0050).
 *
 * Covers the three filter axes, their AND combination, the
 * exceptTabIds preservation, the windowId scoping, dryRun, the empty
 * filter rejection (no "close everything" calls), the regex form
 * with bad-pattern fallback, and the IMP-0062 last-tab-guard wiring
 * via safeRemoveTabs (we mock the helper and assert it was called).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safeRemoveSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/utils/last-tab-guard', () => ({
  safeRemoveTabs: safeRemoveSpy,
  initLastTabGuardListeners: () => {},
}));

import {
  _resetTabCreationTrackerForTest,
  _setTabCreatedAtForTest,
} from '@/entrypoints/background/utils/tab-creation-tracker';
import { closeTabsMatchingTool } from '@/entrypoints/background/tools/browser/close-tabs-matching';

interface FakeTab {
  id: number;
  windowId?: number;
  url?: string;
  title?: string;
}

let tabsInBrowser: FakeTab[];

function installChromeMock() {
  tabsInBrowser = [];
  (globalThis.chrome as any).tabs.query = vi.fn(async (filter: any = {}) => {
    if (typeof filter.windowId === 'number') {
      return tabsInBrowser.filter((t) => t.windowId === filter.windowId);
    }
    return tabsInBrowser;
  });
}

function parse(res: any): any {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  installChromeMock();
  _resetTabCreationTrackerForTest();
  safeRemoveSpy.mockClear().mockResolvedValue(undefined);
});

afterEach(() => {
  _resetTabCreationTrackerForTest();
});

describe('chrome_close_tabs_matching — guards', () => {
  it('rejects calls with no filter (no "close everything" footgun)', async () => {
    tabsInBrowser = [
      { id: 1, windowId: 1, url: 'https://a.example/', title: 'A' },
      { id: 2, windowId: 1, url: 'https://b.example/', title: 'B' },
    ];

    const res = await closeTabsMatchingTool.execute({});

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/INVALID_ARGS/);
    expect(safeRemoveSpy).not.toHaveBeenCalled();
  });

  it('rejects calls with empty-string filters (no implicit match-all)', async () => {
    const res = await closeTabsMatchingTool.execute({ urlMatches: '   ' });
    expect(res.isError).toBe(true);
    expect(safeRemoveSpy).not.toHaveBeenCalled();
  });
});

describe('chrome_close_tabs_matching — substring filters', () => {
  it('matches urlMatches as a case-insensitive substring', async () => {
    tabsInBrowser = [
      { id: 1, windowId: 1, url: 'https://EXAMPLE.com/page', title: 'A' },
      { id: 2, windowId: 1, url: 'https://other.com/x', title: 'B' },
      { id: 3, windowId: 1, url: 'https://example.com/y', title: 'C' },
    ];

    const res = await closeTabsMatchingTool.execute({ urlMatches: 'example.com' });

    const body = parse(res);
    expect(body.tabIds.sort()).toEqual([1, 3]);
    expect(safeRemoveSpy).toHaveBeenCalledWith([1, 3]);
  });

  it('combines urlMatches and titleMatches with AND', async () => {
    tabsInBrowser = [
      { id: 1, url: 'https://example.com/a', title: 'matching title' },
      { id: 2, url: 'https://example.com/b', title: 'other' },
      { id: 3, url: 'https://other.com/c', title: 'matching title' },
    ];

    const res = await closeTabsMatchingTool.execute({
      urlMatches: 'example.com',
      titleMatches: 'matching',
    });

    const body = parse(res);
    expect(body.tabIds).toEqual([1]);
  });
});

describe('chrome_close_tabs_matching — regex matchers', () => {
  it('treats /pattern/flags as a real regex', async () => {
    tabsInBrowser = [
      { id: 1, url: 'https://api.example.com/voyager/conversations', title: '' },
      { id: 2, url: 'https://www.example.com/feed', title: '' },
    ];

    const res = await closeTabsMatchingTool.execute({
      urlMatches: '/voyager\\/api|voyager\\/conversations/i',
    });

    const body = parse(res);
    expect(body.tabIds).toEqual([1]);
  });

  it('falls back to substring match on a malformed regex (no surface error)', async () => {
    tabsInBrowser = [
      { id: 1, url: 'https://example.com/[bad', title: '' },
      { id: 2, url: 'https://other.com/feed', title: '' },
    ];

    // The pattern below is invalid as a regex (`[` is unterminated). The
    // matcher should fall back to a literal substring search and find tab 1.
    const res = await closeTabsMatchingTool.execute({ urlMatches: '/[bad/' });

    const body = parse(res);
    expect(body.tabIds).toEqual([1]);
  });
});

describe('chrome_close_tabs_matching — olderThanMs', () => {
  it('matches only tabs whose recorded creation time is older than the cutoff', async () => {
    const now = Date.now();
    tabsInBrowser = [
      { id: 1, url: 'https://x', title: 'old' },
      { id: 2, url: 'https://y', title: 'fresh' },
      { id: 3, url: 'https://z', title: 'untracked' },
    ];
    _setTabCreatedAtForTest(1, now - 60_000);
    _setTabCreatedAtForTest(2, now - 1_000);
    // tab 3 has no recorded creation timestamp on purpose

    const res = await closeTabsMatchingTool.execute({ olderThanMs: 30_000 });

    const body = parse(res);
    expect(body.tabIds).toEqual([1]);
  });

  it('does not match tabs without a recorded creation time', async () => {
    tabsInBrowser = [{ id: 99, url: 'https://x', title: '' }];

    const res = await closeTabsMatchingTool.execute({ olderThanMs: 1 });

    const body = parse(res);
    expect(body.tabIds).toEqual([]);
    expect(body.scanned).toBe(1);
    expect(safeRemoveSpy).not.toHaveBeenCalled();
  });
});

describe('chrome_close_tabs_matching — preservation + scoping', () => {
  it('honors exceptTabIds even when they would otherwise match', async () => {
    tabsInBrowser = [
      { id: 1, url: 'https://example.com/a', title: '' },
      { id: 2, url: 'https://example.com/b', title: '' },
      { id: 3, url: 'https://example.com/c', title: '' },
    ];

    const res = await closeTabsMatchingTool.execute({
      urlMatches: 'example.com',
      exceptTabIds: [2],
    });

    const body = parse(res);
    expect(body.tabIds.sort()).toEqual([1, 3]);
    expect(safeRemoveSpy).toHaveBeenCalledWith([1, 3]);
  });

  it('scopes the search to a single window when windowId is provided', async () => {
    tabsInBrowser = [
      { id: 1, windowId: 1, url: 'https://example.com/a', title: '' },
      { id: 2, windowId: 2, url: 'https://example.com/b', title: '' },
      { id: 3, windowId: 1, url: 'https://example.com/c', title: '' },
    ];

    const res = await closeTabsMatchingTool.execute({
      urlMatches: 'example.com',
      windowId: 1,
    });

    const body = parse(res);
    expect(body.tabIds.sort()).toEqual([1, 3]);
  });
});

describe('chrome_close_tabs_matching — dryRun', () => {
  it('returns matches without calling safeRemoveTabs', async () => {
    tabsInBrowser = [
      { id: 1, url: 'https://example.com/a', title: '' },
      { id: 2, url: 'https://example.com/b', title: '' },
    ];

    const res = await closeTabsMatchingTool.execute({
      urlMatches: 'example.com',
      dryRun: true,
    });

    const body = parse(res);
    expect(body.dryRun).toBe(true);
    expect(body.tabIds.sort()).toEqual([1, 2]);
    expect(safeRemoveSpy).not.toHaveBeenCalled();
  });
});

describe('chrome_close_tabs_matching — empty match', () => {
  it('returns ok with closed:0 when nothing matches; safeRemoveTabs not called', async () => {
    tabsInBrowser = [{ id: 1, url: 'https://only.example/', title: '' }];

    const res = await closeTabsMatchingTool.execute({ urlMatches: 'no-such-substring' });

    expect(res.isError).toBe(false);
    const body = parse(res);
    expect(body.closed).toBe(0);
    expect(body.matched).toBe(0);
    expect(safeRemoveSpy).not.toHaveBeenCalled();
  });
});

describe('chrome_close_tabs_matching — error envelopes', () => {
  it('returns a structured error when chrome.tabs.query rejects', async () => {
    (globalThis.chrome as any).tabs.query = vi.fn().mockRejectedValue(new Error('window vanished'));

    const res = await closeTabsMatchingTool.execute({ urlMatches: 'example.com', windowId: 9 });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/window vanished/);
  });

  it('returns a structured error when safeRemoveTabs rejects mid-close', async () => {
    tabsInBrowser = [{ id: 1, url: 'https://example.com/a', title: '' }];
    safeRemoveSpy.mockRejectedValueOnce(new Error('chrome.tabs.remove rejected'));

    const res = await closeTabsMatchingTool.execute({ urlMatches: 'example.com' });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/Failed to close tabs/);
  });
});
