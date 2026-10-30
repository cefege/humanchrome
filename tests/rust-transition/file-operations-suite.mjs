import assert from 'node:assert/strict';
import { access, open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { ROOT, executable, frame, isolatedRun, NativePeer } from './process-host.mjs';

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const ADAPTER = process.env.HC_TEST_THIRD_PARTY_ADAPTER ?? join(ROOT, 'app/native-server/dist/adapters/third-party.mjs');
const DOWNLOAD_BYTES = Buffer.from('controlled-download-✓');

// The Rust host invokes the actual optional DevTools formatter; this suite never
// substitutes an analyzer or summary.
const TRACE_FIXTURE = {
  traceEvents: [
    {
      args: { name: 'CrBrowserMain' },
      cat: '__metadata',
      name: 'thread_name',
      ph: 'M',
      pid: 101,
      tid: 1,
      ts: 0,
    },
    {
      args: {
        data: {
          frame: 'FRAME-1',
          frames: [{ frame: 'FRAME-1', name: '', processId: 101, url: 'https://example.test/' }],
          persistentIds: true,
        },
      },
      cat: 'disabled-by-default-devtools.timeline',
      name: 'TracingStartedInBrowser',
      ph: 'I',
      pid: 101,
      s: 't',
      tid: 1,
      ts: 1,
    },
    {
      args: {
        data: {
          documentLoaderURL: 'https://example.test/',
          frame: 'FRAME-1',
          isOutermostMainFrame: true,
          navigationId: 'NAV-1',
          url: 'https://example.test/',
        },
      },
      cat: 'loading,devtools.timeline',
      name: 'navigationStart',
      ph: 'R',
      pid: 101,
      s: 't',
      tid: 1,
      ts: 2,
    },
  ],
};

async function controlledHttpServer(port) {
  const server = createServer((request, response) => {
    switch (request.url) {
      case '/file':
        response.writeHead(200, { 'content-length': DOWNLOAD_BYTES.length });
        response.end(DOWNLOAD_BYTES);
        return;
      case '/redirect':
        response.writeHead(302, { location: '/file' });
        response.end();
        return;
      case '/too-large':
        response.writeHead(200, { 'content-length': MAX_DOWNLOAD_BYTES + 1 });
        response.end();
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
  server.listen(port, '::');
  await once(server, 'listening');
  return server;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function mappedLoopbackUrl(port, route) {
  // IMP-0193 contract: this mapped-loopback form targets only the owned fixture
  // server and remains pending its dedicated security fix.
  return `http://[::ffff:127.0.0.1]:${port}${route}`;
}

async function exercise() {
  return isolatedRun(async (scope) => {
    await access(ADAPTER);
    const server = await controlledHttpServer(scope.port);
    try {
      const [command, args] = executable();
      const peer = new NativePeer(scope.spawn(command, args, {
        HC_TRACE_ANALYZER: ADAPTER,
        HC_TRACE_NODE: process.execPath,
      }));
      const uploads = join(scope.env.TMPDIR, 'humanchrome-uploads');
      const destination = join(scope.directory, 'destination', 'nested', 'result.txt');
      const binaryDestination = join(scope.directory, 'destination', 'result.bin');
      const tracePath = join(scope.directory, 'fixture-trace.json');
      await writeFile(tracePath, JSON.stringify(TRACE_FIXTURE));
      let request = 0;
      async function operation(payload) {
        const requestId = `file-${request += 1}`;
        const response = await peer.exchange(frame({ type: 'file_operation', requestId, payload }));
        assert.equal(response.type, 'file_operation_response');
        assert.equal(response.responseToRequestId, requestId);
        return {
          hasPayload: Object.hasOwn(response, 'payload'),
          payload: response.payload,
        };
      }

      const absent = await operation({ action: 'prepareFile' });
      assert.equal(absent.hasPayload, false, 'prepareFile without a source omits payload');

      const saved = await operation({
        action: 'saveToPath',
        destPath: destination,
        textData: 'héllo from text',
        base64Data: 'bm90LXRoaXM=',
      });
      assert.deepEqual(saved.payload, {
        success: true,
        filePath: destination,
        size: Buffer.byteLength('héllo from text'),
      });
      assert.equal(await readFile(destination, 'utf8'), 'héllo from text');
      const savedBinary = await operation({
        action: 'saveToPath',
        destPath: binaryDestination,
        base64Data: 'data:application/octet-stream;base64,AAH/',
      });
      assert.deepEqual(savedBinary.payload, {
        success: true,
        filePath: binaryDestination,
        size: 3,
      });
      assert.deepEqual(await readFile(binaryDestination), Buffer.from([0, 1, 255]));

      const verified = await operation({ action: 'prepareFile', filePath: destination });
      assert.deepEqual(verified.payload, {
        success: true,
        filePath: destination,
        fileName: 'result.txt',
        size: Buffer.byteLength('héllo from text'),
      });

      const base64 = await operation({
        action: 'prepareFile',
        base64Data: 'data:application/octet-stream;base64,AAH/',
        // IMP-0194 parity: fileName traversal remains observable pending its separate fix.
        fileName: '../escaped-upload.bin',
      });
      assert.equal(base64.payload.success, true);
      assert.equal(relative(uploads, base64.payload.filePath), '../escaped-upload.bin');
      assert.deepEqual(await readFile(base64.payload.filePath), Buffer.from([0, 1, 255]));

      const read = await operation({ action: 'readBase64File', filePath: base64.payload.filePath });
      assert.equal(read.payload.success, false, 'escaped upload is outside readBase64File root');
      assert.match(read.payload.error, /only allowed inside the bridge temp directory/);

      const ordinaryUpload = await operation({
        action: 'prepareFile',
        base64Data: 'data:application/octet-stream;base64,AAH/',
        fileName: 'inside-upload.bin',
      });
      const ordinaryRead = await operation({ action: 'readBase64File', filePath: ordinaryUpload.payload.filePath });
      assert.deepEqual(ordinaryRead.payload, {
        success: true,
        filePath: ordinaryUpload.payload.filePath,
        fileName: 'inside-upload.bin',
        size: 3,
        base64Data: 'AAH/',
      });
      const cleaned = await operation({ action: 'cleanupFile', filePath: ordinaryUpload.payload.filePath });
      assert.deepEqual(cleaned.payload, { success: true, message: 'File cleaned up successfully' });
      const reread = await operation({ action: 'readBase64File', filePath: ordinaryUpload.payload.filePath });
      assert.deepEqual(reread.payload, {
        success: false,
        error: `Failed to read file: File does not exist: ${ordinaryUpload.payload.filePath}`,
      });
      const repeatCleanup = await operation({ action: 'cleanupFile', filePath: ordinaryUpload.payload.filePath });
      assert.deepEqual(repeatCleanup.payload, { success: true, message: 'File cleaned up successfully' });

      const outsideRead = await operation({ action: 'readBase64File', filePath: destination });
      assert.equal(outsideRead.payload.success, false);
      assert.match(outsideRead.payload.error, /only allowed inside the bridge temp directory/);
      const outsideCleanup = await operation({ action: 'cleanupFile', filePath: destination });
      assert.deepEqual(outsideCleanup.payload, {
        success: false,
        error: 'Can only cleanup files in temp directory',
      });

      const oversized = join(uploads, 'oversized.bin');
      const oversizedHandle = await open(oversized, 'w');
      try {
        await oversizedHandle.truncate(MAX_DOWNLOAD_BYTES + 1);
      } finally {
        await oversizedHandle.close();
      }
      const oversizedRead = await operation({ action: 'readBase64File', filePath: oversized });
      assert.deepEqual(oversizedRead.payload, {
        success: false,
        error: `Failed to read file: File too large to read: ${MAX_DOWNLOAD_BYTES + 1} bytes`,
      });

      const downloaded = await operation({
        action: 'prepareFile',
        fileUrl: mappedLoopbackUrl(scope.port, '/file'),
        base64Data: 'ZGlzY2FyZGVkLWJ5LXVybC1wcmVjZWRlbmNl',
        fileName: 'downloaded.bin',
      });
      assert.equal(downloaded.payload.success, true);
      assert.deepEqual(await readFile(downloaded.payload.filePath), DOWNLOAD_BYTES);
      const redirected = await operation({
        action: 'prepareFile',
        fileUrl: mappedLoopbackUrl(scope.port, '/redirect'),
        fileName: 'redirected.bin',
      });
      assert.deepEqual(redirected.payload, {
        success: false,
        error: 'Failed to download file from URL: Error: Redirects not allowed (could re-target an internal IP)',
      });
      const capped = await operation({
        action: 'prepareFile',
        fileUrl: mappedLoopbackUrl(scope.port, '/too-large'),
        fileName: 'capped.bin',
      });
      assert.deepEqual(capped.payload, {
        success: false,
        error: `Failed to download file from URL: Error: File too large: ${MAX_DOWNLOAD_BYTES + 1} bytes (cap ${MAX_DOWNLOAD_BYTES})`,
      });
      const missing = await operation({
        action: 'prepareFile',
        fileUrl: mappedLoopbackUrl(scope.port, '/missing'),
        fileName: 'missing.bin',
      });
      assert.deepEqual(missing.payload, {
        success: false,
        error: 'Failed to download file from URL: Error: Failed to download file: Not Found',
      });

      const trace = await operation({
        action: 'analyzeTrace',
        traceFilePath: tracePath,
        insightName: 'not-present',
      });
      assert.equal(trace.payload.success, true, JSON.stringify({ trace: trace.payload }));
      assert.equal(typeof trace.payload.summary, 'string');
      assert.equal(Object.hasOwn(trace.payload, 'insight'), false);
      const traceAgain = await operation({ action: 'analyzeTrace', traceFilePath: tracePath });
      assert.equal(traceAgain.payload.success, true);
      assert.equal(traceAgain.payload.summary, trace.payload.summary);
      const traceMissingPath = await operation({ action: 'analyzeTrace' });
      assert.deepEqual(traceMissingPath.payload, { success: false, error: 'traceFilePath is required' });

      return {
        absent: absent.hasPayload,
        saved: saved.payload.size,
        verified: verified.payload.size,
        escapedUpload: relative(uploads, base64.payload.filePath),
        // Each implementation has its own temporary root; retain the path within that root.
        upload: { ...ordinaryRead.payload, filePath: relative(uploads, ordinaryRead.payload.filePath) },
        cleanup: cleaned.payload,
        readBoundary: oversizedRead.payload.error,
        downloaded: { size: downloaded.payload.size, bytes: (await readFile(downloaded.payload.filePath)).toString('base64') },
        redirected: redirected.payload,
        capped: capped.payload,
        missing: missing.payload,
        trace: { summary: trace.payload.summary, hasInsight: Object.hasOwn(trace.payload, 'insight') },
      };
    } finally {
      await closeServer(server);
    }
  });
}

export async function verify() {
  const { fileOperations } = JSON.parse(await readFile(join(import.meta.dirname, 'typescript-baseline.json'), 'utf8'));
  assert.deepEqual(await exercise(), fileOperations, 'file-operation public contract drift');
  console.log('PASS file operations: isolated URL/base64/path/read/cleanup/save caps and real DevTools trace adapter agree');
}
