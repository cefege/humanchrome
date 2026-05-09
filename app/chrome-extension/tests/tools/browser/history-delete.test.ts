/**
 * HistoryDeleteTool unit tests.
 *
 * Covers the three deletion modes (single-url, time range, wipe-all) and
 * the input-validation guards: missing mode, multi-mode, missing range
 * bound, malformed dates, inverted range, and the `confirmDeleteAll`
 * safety on `all: true`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { historyDeleteTool } from '@/entrypoints/background/tools/browser/history';

interface HistoryStubs {
  deleteUrl: ReturnType<typeof vi.fn>;
  deleteRange: ReturnType<typeof vi.fn>;
  deleteAll: ReturnType<typeof vi.fn>;
}

function installHistoryStubs(): HistoryStubs {
  const stubs: HistoryStubs = {
    deleteUrl: vi.fn().mockResolvedValue(undefined),
    deleteRange: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
  };
  (globalThis.chrome as any).history = stubs;
  return stubs;
}

function parseBody(text: string): any {
  return JSON.parse(text);
}

describe('HistoryDeleteTool', () => {
  let stubs: HistoryStubs;

  beforeEach(() => {
    stubs = installHistoryStubs();
  });

  afterEach(() => {
    delete (globalThis.chrome as any).history;
  });

  it('deletes a single URL via chrome.history.deleteUrl', async () => {
    const res = await historyDeleteTool.execute({ url: 'https://example.com/page' });

    expect(res.isError).toBe(false);
    expect(stubs.deleteUrl).toHaveBeenCalledWith({ url: 'https://example.com/page' });
    expect(stubs.deleteRange).not.toHaveBeenCalled();
    expect(stubs.deleteAll).not.toHaveBeenCalled();
    const body = parseBody((res.content[0] as any).text);
    expect(body.mode).toBe('url');
    expect(body.success).toBe(true);
  });

  it('deletes a time range via chrome.history.deleteRange with parsed dates', async () => {
    const res = await historyDeleteTool.execute({
      startTime: '2024-01-01',
      endTime: '2024-01-02',
    });

    expect(res.isError).toBe(false);
    expect(stubs.deleteRange).toHaveBeenCalledTimes(1);
    const call = stubs.deleteRange.mock.calls[0][0];
    expect(typeof call.startTime).toBe('number');
    expect(typeof call.endTime).toBe('number');
    expect(call.startTime).toBeLessThan(call.endTime);
    const body = parseBody((res.content[0] as any).text);
    expect(body.mode).toBe('range');
  });

  it('wipes all history when all + confirmDeleteAll are true', async () => {
    const res = await historyDeleteTool.execute({ all: true, confirmDeleteAll: true });

    expect(res.isError).toBe(false);
    expect(stubs.deleteAll).toHaveBeenCalledTimes(1);
    const body = parseBody((res.content[0] as any).text);
    expect(body.mode).toBe('all');
  });

  it('refuses all: true without confirmDeleteAll', async () => {
    const res = await historyDeleteTool.execute({ all: true });

    expect(res.isError).toBe(true);
    expect(stubs.deleteAll).not.toHaveBeenCalled();
  });

  it('rejects calls with no mode selected', async () => {
    const res = await historyDeleteTool.execute({});

    expect(res.isError).toBe(true);
    expect(stubs.deleteUrl).not.toHaveBeenCalled();
    expect(stubs.deleteRange).not.toHaveBeenCalled();
    expect(stubs.deleteAll).not.toHaveBeenCalled();
  });

  it('rejects mixing url + range modes', async () => {
    const res = await historyDeleteTool.execute({
      url: 'https://example.com',
      startTime: '2024-01-01',
      endTime: '2024-01-02',
    });

    expect(res.isError).toBe(true);
    expect(stubs.deleteUrl).not.toHaveBeenCalled();
    expect(stubs.deleteRange).not.toHaveBeenCalled();
  });

  it('requires both startTime and endTime for range mode', async () => {
    const res = await historyDeleteTool.execute({ startTime: '2024-01-01' });

    expect(res.isError).toBe(true);
    expect(stubs.deleteRange).not.toHaveBeenCalled();
  });

  it('rejects malformed date strings', async () => {
    const res = await historyDeleteTool.execute({
      startTime: 'not-a-date',
      endTime: '2024-01-02',
    });

    expect(res.isError).toBe(true);
    expect(stubs.deleteRange).not.toHaveBeenCalled();
  });

  it('rejects inverted ranges (start after end)', async () => {
    const res = await historyDeleteTool.execute({
      startTime: '2024-02-01',
      endTime: '2024-01-01',
    });

    expect(res.isError).toBe(true);
    expect(stubs.deleteRange).not.toHaveBeenCalled();
  });

  it('surfaces chrome.history rejections as error responses', async () => {
    stubs.deleteUrl.mockRejectedValueOnce(new Error('quota exceeded'));

    const res = await historyDeleteTool.execute({ url: 'https://example.com' });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('quota exceeded');
  });
});
