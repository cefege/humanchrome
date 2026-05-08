/**
 * Bridge ↔ network integration tests.
 *
 * The other file-handler.test.ts covers SSRF/path guards by mocking `fetch`
 * and DNS. This file goes the other way — it spins up a real localhost HTTP
 * server and confirms the bridge's `downloadFile` round-trips bytes
 * end-to-end without touching Chrome at all. That's the load-bearing
 * "Chrome-decoupled download" path: the bridge fetches resources by URL
 * via Node's native fetch, the result lands in the bridge's temp dir, and
 * we can read it back via `readBase64File`.
 *
 * Localhost would normally fail the SSRF guard, so we override the DNS
 * lookup mock to point our test hostname at 8.8.8.8 (passes the safe-IP
 * check) while routing the actual request to the local server via fetch
 * URL rewriting. This isolates the SSRF behaviour from the
 * fetch-bytes-and-write behaviour we want to exercise here.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';

// Stub global fetch BEFORE importing FileHandler so the module sees the
// rebinding fetch — which translates the safe public-looking host back to
// localhost where our test server is listening.
let serverPort = 0;
const realFetch: typeof fetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
  input: any,
  init?: any,
): Promise<Response> => {
  const original = String(input);
  // The handler resolves the host first via dns/promises (mocked below),
  // then calls fetch with the original URL. Rewrite the host so the
  // request actually reaches our local server.
  const rewritten = original.replace(/https?:\/\/[^/]+/, `http://127.0.0.1:${serverPort}`);
  return await realFetch(rewritten, init);
};

// Mock dns/promises so the safety check sees a public IP for our test host.
jest.mock('dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
}));

import { FileHandler } from './file-handler';

let handler: FileHandler;
let server: http.Server;
let tempDir: string;

const FIXTURE_BYTES = Buffer.from('integration-fixture-content');

beforeAll(async () => {
  handler = new FileHandler();
  tempDir = path.join(os.tmpdir(), 'humanchrome-uploads');

  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === '/fixture.bin') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(FIXTURE_BYTES.length),
        });
        res.end(FIXTURE_BYTES);
        return;
      }
      if (req.url === '/redirect.bin') {
        res.writeHead(302, { Location: '/fixture.bin' });
        res.end();
        return;
      }
      if (req.url === '/notfound.bin') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(500);
      res.end('Server error');
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Sweep any integration- files we wrote to the temp dir.
  try {
    for (const f of fs.readdirSync(tempDir)) {
      if (f.startsWith('integration-')) {
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
  // Reset DNS mock to safe default in case a prior test changed it.
  const dns = require('dns/promises');
  dns.lookup.mockImplementation(async () => [{ address: '8.8.8.8', family: 4 }]);
});

describe('FileHandler.downloadFile — end-to-end via local HTTP server (Chrome-free)', () => {
  test('fetches bytes from a real URL, writes them to the temp dir, reports the path', async () => {
    const res = await handler.handleFileRequest({
      action: 'prepareFile',
      fileUrl: 'http://example.test/fixture.bin',
      fileName: 'integration-roundtrip.bin',
    });

    expect(res.success).toBe(true);
    expect(res.size).toBe(FIXTURE_BYTES.length);
    expect(res.fileName).toBe('integration-roundtrip.bin');
    expect(res.filePath).toMatch(new RegExp(`humanchrome-uploads/integration-roundtrip\\.bin$`));

    const onDisk = fs.readFileSync(res.filePath);
    expect(onDisk.equals(FIXTURE_BYTES)).toBe(true);
  });

  test('downloaded bytes round-trip cleanly through readBase64File', async () => {
    const dl = await handler.handleFileRequest({
      action: 'prepareFile',
      fileUrl: 'http://example.test/fixture.bin',
      fileName: 'integration-readback.bin',
    });
    expect(dl.success).toBe(true);

    const read = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: dl.filePath,
    });
    expect(read.success).toBe(true);
    expect(Buffer.from(read.base64Data, 'base64').equals(FIXTURE_BYTES)).toBe(true);
  });

  test('rejects 3xx redirects (could re-target an internal IP)', async () => {
    const res = await handler.handleFileRequest({
      action: 'prepareFile',
      fileUrl: 'http://example.test/redirect.bin',
      fileName: 'integration-redirect.bin',
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/redirects not allowed/i);
  });

  test('surfaces non-2xx responses as a failure', async () => {
    const res = await handler.handleFileRequest({
      action: 'prepareFile',
      fileUrl: 'http://example.test/notfound.bin',
      fileName: 'integration-404.bin',
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/Failed to download file/i);
  });
});
