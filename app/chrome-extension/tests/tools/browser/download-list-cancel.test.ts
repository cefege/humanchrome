/**
 * chrome_download_list + chrome_download_cancel tests (IMP-0007).
 *
 * Locks the contract: list returns the trimmed result set after the
 * filename filter is applied; cancel rejects without a numeric
 * downloadId, succeeds for an unknown id (Chrome's silent no-op), and
 * reports the post-cancel state so callers can distinguish a real
 * cancel from a no-op against an already-finished download.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadListTool,
  downloadCancelTool,
} from '@/entrypoints/background/tools/browser/download';

let searchMock: ReturnType<typeof vi.fn>;
let cancelMock: ReturnType<typeof vi.fn>;

const sampleItems = [
  {
    id: 1,
    url: 'https://example.com/report.pdf',
    filename: '/Users/x/Downloads/report.pdf',
    state: 'in_progress',
    totalBytes: 1000,
    bytesReceived: 500,
    startTime: '2026-05-09T20:00:00Z',
    mime: 'application/pdf',
  },
  {
    id: 2,
    url: 'https://example.com/data.csv',
    filename: '/Users/x/Downloads/data.csv',
    state: 'complete',
    totalBytes: 2000,
    bytesReceived: 2000,
    startTime: '2026-05-09T19:00:00Z',
    endTime: '2026-05-09T19:00:05Z',
    mime: 'text/csv',
  },
  {
    id: 3,
    url: 'https://example.com/photo.png',
    filename: '/Users/x/Downloads/holiday-photo.png',
    state: 'complete',
    totalBytes: 50000,
    bytesReceived: 50000,
    startTime: '2026-05-09T18:00:00Z',
    endTime: '2026-05-09T18:00:01Z',
    mime: 'image/png',
  },
];

beforeEach(() => {
  searchMock = vi.fn().mockResolvedValue(sampleItems);
  cancelMock = vi.fn().mockResolvedValue(undefined);
  (globalThis.chrome as any).downloads = {
    search: searchMock,
    cancel: cancelMock,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).downloads;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_download_list', () => {
  it('returns all items when no filter is supplied', async () => {
    const body = parseBody(await downloadListTool.execute({}));
    expect(body.count).toBe(3);
    expect(body.items.map((i: any) => i.id)).toEqual([1, 2, 3]);
    expect(searchMock).toHaveBeenCalledWith({});
  });

  it('forwards state filter to chrome.downloads.search except for "all"', async () => {
    await downloadListTool.execute({ state: 'in_progress' });
    expect(searchMock).toHaveBeenCalledWith({ state: 'in_progress' });

    searchMock.mockClear();
    await downloadListTool.execute({ state: 'all' });
    expect(searchMock).toHaveBeenCalledWith({});
  });

  it('applies case-insensitive filenameContains substring filter on the basename', async () => {
    const body = parseBody(await downloadListTool.execute({ filenameContains: 'PHOTO' }));
    expect(body.count).toBe(1);
    expect(body.items[0].id).toBe(3);
  });

  it('clamps limit to [1, 100] and truncates results client-side', async () => {
    const body = parseBody(await downloadListTool.execute({ limit: 1 }));
    expect(body.count).toBe(1);
    expect(body.items[0].id).toBe(1);
  });

  it('clamps limit=0 up to 1', async () => {
    const body = parseBody(await downloadListTool.execute({ limit: 0 }));
    expect(body.count).toBe(1);
  });

  it('clamps limit=999 down to 100', async () => {
    // 100 is the cap; with 3 items in the mock we get 3 back, but the call
    // succeeds without throwing.
    const body = parseBody(await downloadListTool.execute({ limit: 999 }));
    expect(body.count).toBe(3);
  });

  it('returns UNKNOWN error when chrome.downloads is missing', async () => {
    delete (globalThis.chrome as any).downloads;
    const res = await downloadListTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
    expect((res.content[0] as any).text).toContain('downloads');
  });

  it('classifies search rejections as UNKNOWN', async () => {
    searchMock.mockRejectedValueOnce(new Error('disk full'));
    const res = await downloadListTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
    expect((res.content[0] as any).text).toContain('disk full');
  });
});

describe('chrome_download_cancel', () => {
  it('rejects when downloadId is missing', async () => {
    const res = await downloadCancelTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
    expect((res.content[0] as any).text).toContain('downloadId');
  });

  it('rejects when downloadId is not a number', async () => {
    const res = await downloadCancelTool.execute({ downloadId: 'abc' as unknown as number });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
  });

  it('cancels and reports post-state from chrome.downloads.search', async () => {
    searchMock.mockResolvedValueOnce([{ ...sampleItems[0], state: 'interrupted' }]);
    const body = parseBody(await downloadCancelTool.execute({ downloadId: 1 }));
    expect(body).toEqual({ cancelled: true, downloadId: 1, postState: 'interrupted' });
    expect(cancelMock).toHaveBeenCalledWith(1);
  });

  it('reports postState="unknown" when post-cancel search returns nothing', async () => {
    searchMock.mockResolvedValueOnce([]);
    const body = parseBody(await downloadCancelTool.execute({ downloadId: 99 }));
    expect(body).toEqual({ cancelled: true, downloadId: 99, postState: 'unknown' });
  });

  it('still returns success when post-cancel search throws', async () => {
    searchMock.mockRejectedValueOnce(new Error('search failed'));
    const body = parseBody(await downloadCancelTool.execute({ downloadId: 7 }));
    expect(body).toEqual({ cancelled: true, downloadId: 7, postState: 'unknown' });
  });

  it('classifies cancel rejection as UNKNOWN', async () => {
    cancelMock.mockRejectedValueOnce(new Error('not cancellable'));
    const res = await downloadCancelTool.execute({ downloadId: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
    expect((res.content[0] as any).text).toContain('not cancellable');
  });

  it('returns UNKNOWN error when chrome.downloads is missing', async () => {
    delete (globalThis.chrome as any).downloads;
    const res = await downloadCancelTool.execute({ downloadId: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
    expect((res.content[0] as any).text).toContain('downloads');
  });
});
