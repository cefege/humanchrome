/**
 * Regression tests for file-handler security fixes shipped in round 3:
 *  - SSRF guard on `prepareFile` (assertSafeUrl): blocks loopback / RFC1918 /
 *    link-local / cloud-metadata endpoints, blocks non-http(s) schemes, and
 *    blocks DNS-rebinding (hostname that resolves to a private IP).
 *  - Path-traversal guard on `readBase64File`: only files inside the bridge
 *    temp directory may be read, and oversize files are rejected.
 *
 * All network calls are mocked — `node-fetch` and `dns/promises#lookup` are
 * stubbed at the module boundary so the suite never hits the real internet
 * or DNS resolver. Each test resets the mocks via `jest.clearAllMocks()`.
 */
import { describe, test, expect, beforeEach, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// --------------------------------------------------------------------------
// Mock node-fetch (default export is a function). When the SSRF check passes
// in `downloadFile`, we hand back a tiny in-memory response so the rest of
// the pipeline doesn't try to use real network.
// --------------------------------------------------------------------------
jest.mock('node-fetch', () => {
  const fn = jest.fn(async () => ({
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: { get: (_k: string) => null },
    buffer: async () => Buffer.from('hello-world'),
  }));
  return { __esModule: true, default: fn };
});

// --------------------------------------------------------------------------
// Mock dns/promises#lookup. By default we resolve hostnames to a public IP
// (8.8.8.8) so the safe-URL check sees a non-private result. Individual
// tests override the implementation to simulate DNS rebinding etc.
// --------------------------------------------------------------------------
jest.mock('dns/promises', () => ({
  lookup: jest.fn(async (_host: string, _opts?: unknown) => [{ address: '8.8.8.8', family: 4 }]),
}));

// Pull in mocks after declaration so we can drive their behaviour per test.
const fetchMock: jest.Mock = require('node-fetch').default;
const dnsMock: { lookup: jest.Mock } = require('dns/promises');

// Import the class AFTER the mocks are registered so its `import fetch from
// 'node-fetch'` resolves to our stub. We import the named export rather than
// the default singleton so each test gets its own temp dir state.
import { FileHandler } from './file-handler';

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

let handler: FileHandler;
let tempDir: string;

beforeAll(() => {
  handler = new FileHandler();
  tempDir = path.join(os.tmpdir(), 'humanchrome-uploads');
});

afterAll(() => {
  // Best-effort cleanup of any files our tests wrote.
  try {
    const entries = fs.readdirSync(tempDir);
    for (const f of entries) {
      if (f.startsWith('regression-')) {
        try {
          fs.unlinkSync(path.join(tempDir, f));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the dns mock back to the safe default. Individual SSRF tests can
  // override this when they want to exercise rebinding-style scenarios.
  dnsMock.lookup.mockImplementation(async () => [{ address: '8.8.8.8', family: 4 }]);
  // Reset fetch mock to a benign 200 OK with a small body.
  fetchMock.mockImplementation(async () => ({
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: { get: (_k: string) => null },
    buffer: async () => Buffer.from('hello-world'),
  }));
});

// ===========================================================================
// SSRF guard — direct IP literals
// ===========================================================================

describe('FileHandler.prepareFile — SSRF guard rejects unsafe URLs', () => {
  // Each table entry is `[label, url]`. We expect `prepareFile` to surface a
  // failure result rather than throw — `handleFileRequest` wraps all errors
  // and returns `{ success: false, error: ... }`. We also assert that
  // `node-fetch` was never invoked, proving the guard ran *before* any
  // outbound HTTP attempt.
  const cases: Array<[string, string]> = [
    ['AWS metadata IP', 'http://169.254.169.254/latest/meta-data'],
    ['RFC1918 10/8', 'http://10.0.0.1/'],
    ['RFC1918 172.16/12', 'http://172.16.0.1/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['IPv4 loopback', 'http://127.0.0.1/'],
    ['localhost name', 'http://localhost/'],
    ['file:// scheme', 'file:///etc/passwd'],
    ['ftp:// scheme', 'ftp://example.com/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
  ];

  test.each(cases)('rejects %s (%s)', async (_label, fileUrl) => {
    const res = await handler.handleFileRequest({ action: 'prepareFile', fileUrl });
    expect(res.success).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('FileHandler.prepareFile — DNS resolution', () => {
  test('allows public hostname when DNS resolves to a public IP', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    const res = await handler.handleFileRequest({
      action: 'prepareFile',
      fileUrl: 'http://example.com/',
      fileName: 'regression-public.bin',
    });
    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Sanity: the URL passed to fetch should be the original one (not mutated).
    const calledWith = fetchMock.mock.calls[0]?.[0];
    expect(String(calledWith)).toContain('example.com');
  });

  test('rejects hostname that resolves to a private IP (DNS rebinding defence)', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    const res = await handler.handleFileRequest({
      action: 'prepareFile',
      fileUrl: 'http://internal.corp/',
      fileName: 'regression-rebind.bin',
    });
    expect(res.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects when *any* resolved address is private (mixed-family answer)', async () => {
    // Simulates a DNS answer where one record is public and one is private.
    // The guard must fail closed and refuse the request.
    dnsMock.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    const res = await handler.handleFileRequest({
      action: 'prepareFile',
      fileUrl: 'http://mixed.example/',
    });
    expect(res.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// readBase64File — path traversal & size cap
// ===========================================================================

describe('FileHandler.readBase64File — path-traversal & size guards', () => {
  test('rejects absolute path outside the bridge temp directory', async () => {
    const res = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: '/etc/passwd',
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/temp directory/i);
  });

  test('rejects path-traversal attempts that resolve outside tempDir', async () => {
    // path.resolve('../../etc/passwd') lands at /etc/passwd on POSIX; on any
    // OS it's outside the humanchrome-uploads dir.
    const traversal = '../../etc/passwd';
    const res = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: traversal,
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/temp directory/i);
  });

  test('reads a legitimate file inside tempDir and returns base64', async () => {
    const fileName = `regression-legit-${Date.now()}.txt`;
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, 'unit-test-payload');

    const res = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath,
    });

    expect(res.success).toBe(true);
    expect(res.fileName).toBe(fileName);
    expect(Buffer.from(res.base64Data, 'base64').toString()).toBe('unit-test-payload');
  });

  test('rejects a file larger than MAX_DOWNLOAD_BYTES', async () => {
    // We don't actually want to allocate 100 MB on disk — create a *sparse*
    // file via ftruncate. On every mainstream filesystem this reports the
    // requested size via stat without consuming blocks, so the size guard
    // sees a "huge" file in O(ms).
    const oversizePath = path.join(tempDir, `regression-oversize-${Date.now()}.bin`);
    const fd = fs.openSync(oversizePath, 'w');
    try {
      fs.ftruncateSync(fd, MAX_DOWNLOAD_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }

    try {
      const res = await handler.handleFileRequest({
        action: 'readBase64File',
        filePath: oversizePath,
      });
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/too large/i);
    } finally {
      try {
        fs.unlinkSync(oversizePath);
      } catch {
        // ignore — afterAll sweeps regression-* anyway
      }
    }
  });
});
