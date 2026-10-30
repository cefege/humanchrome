import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executable, frame, isolatedRun, NativePeer } from './process-host.mjs';
import { protocolFixture } from './native-protocol-fixtures.mjs';
import { routingFixture } from './native-routing-fixtures.mjs';
import { restFixture } from './native-rest-fixtures.mjs';
import { verify as fileOperationsFixture } from './file-operations-suite.mjs';
import { verify as stdioProxyFixture } from './stdio-proxy-suite.mjs';

// Observable file bytes and response shape are tested in a per-process temporary
// HOME/TMPDIR, never against the installed extension or user profile.
async function exercise() {
  return isolatedRun(async (scope) => {
    const [command, args] = executable();
    const peer = new NativePeer(scope.spawn(command, args));
    const destination = join(scope.directory, 'nested', 'file.txt');
    async function operation(requestId, payload) {
      const response = await peer.exchange(frame({ type: 'file_operation', requestId, payload }));
      assert.equal(response.type, 'file_operation_response');
      assert.equal(response.responseToRequestId, requestId);
      return response.payload;
    }
    const save = await operation('save', { action: 'saveToPath', destPath: destination, textData: 'héllo', base64Data: 'AA==' });
    assert.equal(save.success, true);
    assert.equal(save.size, Buffer.byteLength('héllo'));
    assert.equal(await readFile(destination, 'utf8'), 'héllo');
    const verify = await operation('verify', { action: 'prepareFile', filePath: destination });
    assert.equal(verify.success, true);
    assert.equal(verify.size, Buffer.byteLength('héllo'));
    const outside = await operation('outside', { action: 'readBase64File', filePath: destination });
    assert.equal(outside.success, false);
    assert.match(outside.error, /only allowed inside the bridge temp directory/);
    const bad = await operation('bad', { action: 'saveToPath' });
    assert.deepEqual(bad, { success: false, error: 'destPath is required for saveToPath' });
    const saved = await operation('upload', { action: 'prepareFile', base64Data: 'data:application/octet-stream;base64,AAH/', fileName: 'fixture.bin' });
    assert.equal(saved.success, true);
    assert.equal(saved.size, 3);
    const read = await operation('read', { action: 'readBase64File', filePath: saved.filePath });
    assert.equal(read.success, true);
    assert.equal(read.base64Data, 'AAH/');
    const cleanup = await operation('cleanup', { action: 'cleanupFile', filePath: saved.filePath });
    assert.equal(cleanup.success, true);
    const reread = await operation('reread', { action: 'readBase64File', filePath: saved.filePath });
    assert.equal(reread.success, false);
    assert.match(reread.error, /File does not exist/);
    return { saveSize: save.size, verifySize: verify.size, outside: outside.error, bad, uploadSize: saved.size, encoded: read.base64Data, cleanup: cleanup.message };
  });
}

async function exerciseLosslessRest() {
  return isolatedRun(async (scope) => {
    const [command, args] = executable();
    const peer = new NativePeer(scope.spawn(command, args), (message) => {
      if (message.type === 'rr_list_published_flows') return { status: 'success', items: [] };
      if (message.type === 'call_tool') {
        return { status: 'success', data: { content: [{ type: 'text', text: JSON.stringify(message.payload.args) }] } };
      }
    });
    const started = await peer.exchange(frame({ type: 'start', payload: { port: scope.port, extensionId: 'lossless-test' } }));
    assert.equal(started.type, 'server_started');
    const response = await fetch(`http://127.0.0.1:${scope.port}/api/tools/chrome_get_windows_and_tabs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'lossless-test' },
      body: '{"args":{"\\ud800":"\\udfff","nested":{"value":"\\ud800"}}}',
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    const echoed = JSON.parse(result.content[0].text);
    assert.equal(echoed['\ud800'], '\udfff');
    assert.equal(echoed.nested.value, '\ud800');
    return echoed;
  });
}

export async function verify() {
  const { native } = JSON.parse(await readFile(join(import.meta.dirname, 'typescript-baseline.json'), 'utf8'));
  assert.deepEqual(await exercise(), native.files, 'native file-operation contract drift');
  assert.deepEqual(await exerciseLosslessRest(), native.losslessRest, 'lossless REST contract drift');
  assert.deepEqual(await protocolFixture(), native.protocol, 'MCP Accept/protocol/HTTP-method boundary contract drift');
  assert.deepEqual(await routingFixture(), native.routing, 'aliases, flows, raw, metadata, idempotency, errors and filesystem sinks preserve UTF-16');
  assert.deepEqual(await restFixture(), native.rest, 'REST parser, authentication precedence and JSON poisoning contract drift');
  await fileOperationsFixture();
  await stdioProxyFixture();
  console.log('PASS native files: real isolated writes, UTF-8, scoped reads, base64 round-trip and cleanup');
}
