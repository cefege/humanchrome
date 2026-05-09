/**
 * chrome_clear_browsing_data tests.
 *
 * Wraps chrome.browsingData.remove. Tests stub the API and assert the
 * contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearBrowsingDataTool } from '@/entrypoints/background/tools/browser/clear-browsing-data';

let removeMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  removeMock = vi.fn().mockResolvedValue(undefined);
  (globalThis.chrome as any).browsingData = { remove: removeMock };
});

afterEach(() => {
  delete (globalThis.chrome as any).browsingData;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_clear_browsing_data', () => {
  it('errors when chrome.browsingData is undefined', async () => {
    delete (globalThis.chrome as any).browsingData;
    const res = await clearBrowsingDataTool.execute({ dataTypes: ['cookies'] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.browsingData is unavailable');
  });

  it('rejects when dataTypes is missing', async () => {
    const res = await clearBrowsingDataTool.execute({} as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('dataTypes');
  });

  it('rejects when dataTypes is empty', async () => {
    const res = await clearBrowsingDataTool.execute({ dataTypes: [] });
    expect(res.isError).toBe(true);
  });

  it('rejects unknown dataTypes naming the offender', async () => {
    const res = await clearBrowsingDataTool.execute({
      dataTypes: ['cookies', 'unknownThing'],
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('unknownThing');
  });

  it('forwards a single dataType to chrome.browsingData.remove', async () => {
    const res = await clearBrowsingDataTool.execute({ dataTypes: ['cookies'] });
    expect(res.isError).toBe(false);
    expect(removeMock).toHaveBeenCalledWith({ since: 0 }, { cookies: true });
    expect(parseBody(res).removed).toEqual(['cookies']);
  });

  it('forwards multiple dataTypes', async () => {
    await clearBrowsingDataTool.execute({
      dataTypes: ['cookies', 'cache', 'history'],
    });
    expect(removeMock).toHaveBeenCalledWith(
      { since: 0 },
      { cookies: true, cache: true, history: true },
    );
  });

  it('forwards `since` for time-bounded removal', async () => {
    await clearBrowsingDataTool.execute({ dataTypes: ['cookies'], since: 1700000000 });
    expect(removeMock).toHaveBeenCalledWith({ since: 1700000000 }, { cookies: true });
  });

  it('forwards `origins` for origin-scoped removal', async () => {
    await clearBrowsingDataTool.execute({
      dataTypes: ['cookies'],
      origins: ['https://example.com'],
    });
    expect(removeMock).toHaveBeenCalledWith(
      { since: 0, origins: ['https://example.com'] },
      { cookies: true },
    );
  });

  it('returns the origins list in the response when provided', async () => {
    const body = parseBody(
      await clearBrowsingDataTool.execute({
        dataTypes: ['cookies'],
        origins: ['https://example.com'],
      }),
    );
    expect(body.origins).toEqual(['https://example.com']);
  });

  it('returns null origins when not provided', async () => {
    const body = parseBody(await clearBrowsingDataTool.execute({ dataTypes: ['cookies'] }));
    expect(body.origins).toBeNull();
  });

  it('surfaces a chrome.browsingData rejection', async () => {
    removeMock.mockRejectedValueOnce(new Error('quota error'));
    const res = await clearBrowsingDataTool.execute({ dataTypes: ['cookies'] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('quota error');
  });

  it('accepts every documented dataType', async () => {
    const all = [
      'cookies',
      'localStorage',
      'indexedDB',
      'cache',
      'cacheStorage',
      'history',
      'downloads',
      'formData',
      'passwords',
      'serviceWorkers',
      'webSQL',
      'fileSystems',
      'pluginData',
      'appcache',
    ];
    const res = await clearBrowsingDataTool.execute({ dataTypes: all });
    expect(res.isError).toBe(false);
  });
});
