/**
 * chrome_history_delete tool tests.
 *
 * Pins the three deletion paths (single URL, time range, full wipe), the
 * "must be strictly true" guard on `all`, the mutual-exclusivity guard, and
 * the date-parse error path that mirrors `chrome_history`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseISO } from 'date-fns';

const stubs = vi.hoisted(() => ({
  deleteUrl: vi.fn(async () => undefined),
  deleteRange: vi.fn(async () => undefined),
  deleteAll: vi.fn(async () => undefined),
}));

function installChrome() {
  (globalThis as unknown as { chrome: any }).chrome = {
    runtime: {
      id: 'test',
      sendMessage: vi.fn(),
      getURL: (p: string) => `chrome-extension://test${p}`,
    },
    history: {
      deleteUrl: stubs.deleteUrl,
      deleteRange: stubs.deleteRange,
      deleteAll: stubs.deleteAll,
    },
  };
}

async function loadTool(): Promise<
  typeof import('@/entrypoints/background/tools/browser/history-delete')
> {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/history-delete');
}

beforeEach(() => {
  stubs.deleteUrl.mockClear();
  stubs.deleteRange.mockClear();
  stubs.deleteAll.mockClear();
  installChrome();
});

afterEach(() => {
  vi.clearAllMocks();
});

function parseBody(res: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const block = res.content.find((c) => c.type === 'text');
  return JSON.parse(block?.text ?? '{}');
}

describe('chrome_history_delete — url path', () => {
  it('calls chrome.history.deleteUrl with the given URL and reports deleted=1', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({ url: 'https://example.com/page' });

    expect(res.isError).toBe(false);
    expect(stubs.deleteUrl).toHaveBeenCalledWith({ url: 'https://example.com/page' });
    expect(stubs.deleteRange).not.toHaveBeenCalled();
    expect(stubs.deleteAll).not.toHaveBeenCalled();

    const body = parseBody(res);
    expect(body.scope).toBe('url');
    expect(body.deleted).toBe(1);
    expect(body.url).toBe('https://example.com/page');
  });
});

describe('chrome_history_delete — range path', () => {
  it('parses ISO startTime/endTime and forwards them to deleteRange', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({
      startTime: '2024-01-01',
      endTime: '2024-01-31',
    });

    expect(res.isError).toBe(false);
    expect(stubs.deleteRange).toHaveBeenCalledTimes(1);
    const call = stubs.deleteRange.mock.calls[0][0];
    expect(typeof call.startTime).toBe('number');
    expect(typeof call.endTime).toBe('number');
    // parseISO (date-fns) interprets bare YYYY-MM-DD as local-time midnight,
    // matching the production helper's behavior. Don't use `new Date(str)`
    // here — that parses as UTC midnight and disagrees in any non-UTC TZ.
    expect(call.startTime).toBe(parseISO('2024-01-01').getTime());
    expect(call.endTime).toBe(parseISO('2024-01-31').getTime());

    const body = parseBody(res);
    expect(body.scope).toBe('range');
    expect(body.deleted).toBe(-1);
    expect(body.startTime).toBe(call.startTime);
    expect(body.endTime).toBe(call.endTime);
  });

  it('accepts relative time strings like "1 day ago"', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({
      startTime: '7 days ago',
      endTime: 'now',
    });

    expect(res.isError).toBe(false);
    expect(stubs.deleteRange).toHaveBeenCalledTimes(1);
    const { startTime, endTime } = stubs.deleteRange.mock.calls[0][0];
    expect(endTime).toBeGreaterThan(startTime);
    // Roughly 7 days apart — allow generous slack for clock movement during test
    const diffDays = (endTime - startTime) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it('rejects unparseable date strings without calling deleteRange', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({ startTime: 'definitely not a date' });

    expect(res.isError).toBe(true);
    expect(stubs.deleteRange).not.toHaveBeenCalled();
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.message).toMatch(/start time/i);
  });
});

describe('chrome_history_delete — all path', () => {
  it('calls chrome.history.deleteAll when all=true and reports scope=all', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({ all: true });

    expect(res.isError).toBe(false);
    expect(stubs.deleteAll).toHaveBeenCalledTimes(1);
    expect(stubs.deleteUrl).not.toHaveBeenCalled();
    expect(stubs.deleteRange).not.toHaveBeenCalled();

    const body = parseBody(res);
    expect(body.scope).toBe('all');
    expect(body.deleted).toBe(-1);
  });
});

describe('chrome_history_delete — guards', () => {
  it('rejects all=false explicitly', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({ all: false });

    expect(res.isError).toBe(true);
    expect(stubs.deleteAll).not.toHaveBeenCalled();
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.message).toMatch(/strictly `true`/);
  });

  it('rejects calls with no selectors at all', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({});

    expect(res.isError).toBe(true);
    expect(stubs.deleteUrl).not.toHaveBeenCalled();
    expect(stubs.deleteRange).not.toHaveBeenCalled();
    expect(stubs.deleteAll).not.toHaveBeenCalled();
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.message).toMatch(/url.*startTime.*endTime.*all/);
  });

  it('rejects mutually exclusive selectors: url + all', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({ url: 'https://example.com/', all: true });

    expect(res.isError).toBe(true);
    expect(stubs.deleteUrl).not.toHaveBeenCalled();
    expect(stubs.deleteAll).not.toHaveBeenCalled();
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.message).toMatch(/mutually exclusive/i);
  });

  it('rejects mutually exclusive selectors: url + range', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({
      url: 'https://example.com/',
      startTime: '1 day ago',
    });

    expect(res.isError).toBe(true);
    expect(stubs.deleteUrl).not.toHaveBeenCalled();
    expect(stubs.deleteRange).not.toHaveBeenCalled();
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.message).toMatch(/mutually exclusive/i);
  });

  it('rejects mutually exclusive selectors: range + all', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({
      startTime: '1 day ago',
      endTime: 'now',
      all: true,
    });

    expect(res.isError).toBe(true);
    expect(stubs.deleteRange).not.toHaveBeenCalled();
    expect(stubs.deleteAll).not.toHaveBeenCalled();
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.message).toMatch(/mutually exclusive/i);
  });

  it('rejects ranges where startTime > endTime', async () => {
    const { historyDeleteTool } = await loadTool();
    const res = await historyDeleteTool.execute({
      startTime: '2024-12-01',
      endTime: '2024-01-01',
    });

    expect(res.isError).toBe(true);
    expect(stubs.deleteRange).not.toHaveBeenCalled();
    const body = parseBody(res);
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.message).toMatch(/Start time cannot be after end time/i);
  });
});
