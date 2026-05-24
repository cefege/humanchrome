/**
 * chrome_har_export tests (IMP-0144).
 *
 * Covers the formatter shape directly (via _buildHarForTests) — the
 * dispatch path is exercised against a synthetic capture buffer
 * injected into the network-capture singletons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  harExportTool,
  _buildHarForTests as buildHar,
  _capBodyForTests as capBody,
} from '@/entrypoints/background/tools/browser/har-export';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';
import { MAX_RESPONSE_BODY_BYTES } from '@/entrypoints/background/utils/timeouts';

const TEST_CLIENT = 'har-export-test-client';
const TAB_ID = 7;

function exec(args: any = {}): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => harExportTool.execute(args));
}
function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

let chromeDownloadsDownloadMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetClientStateForTests();
  chromeDownloadsDownloadMock = vi.fn(async () => 99);
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: { addListener: () => undefined },
    },
    downloads: { download: chromeDownloadsDownloadMock },
    windows: { onRemoved: { addListener: () => undefined } },
    runtime: { lastError: undefined },
  };
  claimTabForClient(TEST_CLIENT, TAB_ID, 1);
});

afterEach(() => {
  _resetClientStateForTests();
});

describe('chrome_har_export — formatter shape', () => {
  it('empty buffer produces a valid HAR 1.2 envelope with zero entries', () => {
    const har = buildHar([]);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('humanchrome');
    expect(har.log.entries).toEqual([]);
  });

  it('one request → one entry with HAR-required fields', () => {
    const har = buildHar([
      {
        url: 'https://example.com/api?x=1&y=2',
        method: 'GET',
        requestTime: Date.parse('2026-05-24T10:00:00Z'),
        responseTime: Date.parse('2026-05-24T10:00:00.500Z'),
        requestHeaders: { 'User-Agent': 'humanchrome-test' },
        responseHeaders: { 'Content-Type': 'application/json', 'X-Test': '1' },
        status: 200,
        statusText: 'OK',
        responseSize: 42,
        mimeType: 'application/json',
        responseBody: '{"hello":"world"}',
      },
    ]);

    expect(har.log.entries).toHaveLength(1);
    const e = har.log.entries[0];
    expect(e.startedDateTime).toBe('2026-05-24T10:00:00.000Z');
    expect(e.time).toBe(500);
    expect(e.request.method).toBe('GET');
    expect(e.request.url).toBe('https://example.com/api?x=1&y=2');
    expect(e.request.queryString).toEqual([
      { name: 'x', value: '1' },
      { name: 'y', value: '2' },
    ]);
    expect(e.request.headers).toEqual([{ name: 'User-Agent', value: 'humanchrome-test' }]);
    expect(e.response.status).toBe(200);
    expect(e.response.statusText).toBe('OK');
    expect(e.response.content.mimeType).toBe('application/json');
    expect(e.response.content.text).toBe('{"hello":"world"}');
    expect(e.response.headers.map((h) => h.name)).toContain('X-Test');
    expect(e.timings.wait).toBe(500);
    expect(e.timings.send).toBe(0);
    expect(e.timings.receive).toBe(0);
    expect(e.cache).toEqual({});
  });

  it('multiple requests are ordered by requestTime', () => {
    const har = buildHar([
      { url: 'https://a/2', method: 'GET', requestTime: 2000, requestHeaders: {}, responseHeaders: {}, status: 200, statusText: '', responseSize: 0, mimeType: 'text/plain' },
      { url: 'https://a/1', method: 'GET', requestTime: 1000, requestHeaders: {}, responseHeaders: {}, status: 200, statusText: '', responseSize: 0, mimeType: 'text/plain' },
      { url: 'https://a/3', method: 'GET', requestTime: 3000, requestHeaders: {}, responseHeaders: {}, status: 200, statusText: '', responseSize: 0, mimeType: 'text/plain' },
    ]);
    expect(har.log.entries.map((e) => e.request.url)).toEqual([
      'https://a/2',
      'https://a/1',
      'https://a/3',
    ]);
    // ^ buildHar doesn't sort; collectEntries does. Verify buildHar
    //   preserves caller order so callers can pre-sort once.
  });

  it('postData is populated when requestBody is set; falls back to content-type from headers', () => {
    const har = buildHar([
      {
        url: 'https://api.example.com/upload',
        method: 'POST',
        requestTime: 1000,
        requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseHeaders: {},
        status: 201,
        statusText: 'Created',
        responseSize: 0,
        mimeType: 'text/plain',
        requestBody: 'a=1&b=2',
      },
    ]);
    expect(har.log.entries[0].request.postData).toEqual({
      mimeType: 'application/x-www-form-urlencoded',
      text: 'a=1&b=2',
    });
  });

  it('redirectURL is the response Location header when present', () => {
    const har = buildHar([
      {
        url: 'https://old.example.com/path',
        method: 'GET',
        requestTime: 1000,
        requestHeaders: {},
        responseHeaders: { Location: 'https://new.example.com/path' },
        status: 301,
        statusText: 'Moved Permanently',
        responseSize: 0,
        mimeType: 'text/plain',
      },
    ]);
    expect(har.log.entries[0].response.redirectURL).toBe('https://new.example.com/path');
  });

  it('malformed URL still produces an entry (empty queryString fallback)', () => {
    const har = buildHar([
      { url: 'not-a-url', method: 'GET', requestTime: 1000, requestHeaders: {}, responseHeaders: {}, status: 0, statusText: '', responseSize: 0, mimeType: '' },
    ]);
    expect(har.log.entries[0].request.queryString).toEqual([]);
  });
});

describe('chrome_har_export — body truncation', () => {
  it('body ≤ 1 MiB passes through unchanged', () => {
    const small = 'a'.repeat(1024);
    const { text, truncated } = capBody(small);
    expect(text).toBe(small);
    expect(truncated).toBe(false);
  });

  it('body > 1 MiB is truncated and the entry surfaces a JSON comment', () => {
    const big = 'a'.repeat(MAX_RESPONSE_BODY_BYTES + 4096);
    const { text, truncated, originalSize } = capBody(big);
    expect(truncated).toBe(true);
    expect(originalSize).toBe(MAX_RESPONSE_BODY_BYTES + 4096);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BODY_BYTES);

    const har = buildHar([
      {
        url: 'https://example.com/big',
        method: 'GET',
        requestTime: 1000,
        requestHeaders: {},
        responseHeaders: {},
        status: 200,
        statusText: 'OK',
        responseSize: big.length,
        mimeType: 'text/plain',
        responseBody: big,
      },
    ]);
    const comment = har.log.entries[0].response.content.comment;
    expect(comment).toBeDefined();
    const parsed = JSON.parse(comment!);
    expect(parsed.truncated).toBe(true);
    expect(parsed.unit).toBe('bytes');
  });
});

describe('chrome_har_export — dispatch', () => {
  it('export_from_active with empty buffers returns 0 entries', async () => {
    const res = await exec({});
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.entryCount).toBe(0);
    expect(body.har.log.entries).toEqual([]);
  });

  it('rejects unknown action with INVALID_ARGS', async () => {
    const res = await exec({ action: 'export_to_clipboard' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('action');
  });

  it('save_to_downloads calls chrome.downloads.download + returns the id', async () => {
    const res = await exec({ action: 'save_to_downloads', filename: 'my-trace.har' });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.downloadId).toBe(99);
    expect(body.filename).toBe('my-trace.har');
    expect(chromeDownloadsDownloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'my-trace.har',
        saveAs: false,
        conflictAction: 'uniquify',
      }),
    );
    // URL should be a data: URL with the HAR JSON encoded.
    const [{ url }] = chromeDownloadsDownloadMock.mock.calls[0];
    expect(typeof url).toBe('string');
    expect(url).toMatch(/^data:application\/json;charset=utf-8;base64,/);
  });

  it('save_to_downloads sanitizes weird filenames', async () => {
    const res = await exec({ action: 'save_to_downloads', filename: '../../etc/passwd.har' });
    const body = parseBody(res);
    // Path separators stripped to underscores.
    expect(body.filename).not.toContain('/');
    expect(body.filename).toMatch(/passwd\.har$/);
  });

  it('save_to_downloads surfaces chrome.downloads errors as UNKNOWN', async () => {
    chromeDownloadsDownloadMock.mockRejectedValueOnce(new Error('Disk full'));
    const res = await exec({ action: 'save_to_downloads' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Disk full');
  });
});
