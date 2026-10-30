import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { executable, frame, isolatedRun, NativePeer } from './process-host.mjs';

export async function restFixture() {
  return isolatedRun(async (scope) => {
    const [command, argv] = executable();
    const peer = new NativePeer(scope.spawn(command, argv, { HUMANCHROME_TOKEN: ' fixture-secret ' }), (message) => {
      if (message.type === 'call_tool') return { status: 'success', data: { content: [{ type: 'text', text: JSON.stringify(message.payload.args) }] } };
    });
    assert.equal((await peer.exchange(frame({ type: 'start', payload: { port: scope.port, extensionId: 'rest-fixture' } }))).type, 'server_started');
    const cases = [
      { label: 'authorized', body: '{"args":{"value":1}}' },
      { label: 'missing-token', body: '{"args":{}}', token: '' },
      { label: 'wrong-token', body: '{"args":{}}', token: 'wrong' },
      { label: 'invalid-before-auth', body: '{"args":', token: '' },
      { label: 'empty-json', body: '' },
      { label: 'null-args', body: '{"args":null}' },
      { label: 'unknown-field', body: '{"args":{},"clientId":"smuggled"}' },
      { label: 'text-body', body: '{"args":{}}', type: 'text/plain' },
      { label: 'unsupported-media', body: '{}', type: 'application/octet-stream' },
      { label: 'safe-constructor', body: '{"args":{"constructor":{"safe":1}}}' },
      { label: 'poisoned-constructor', body: '{"args":{"constructor":{"prototype":{}}}}' },
      { label: 'poisoned-proto', body: '{"args":{"__proto__":{}}}' },
      { label: 'escaped-proto', body: '{"args":{"\\u005f_proto__":{}}}' },
      { label: 'body-limit', body: '', declaredLength: 1024 * 1024 + 1 },
    ];
    const observed = [];
    for (const scenario of cases) {
      const token = scenario.token ?? 'fixture-secret';
      const { status, contentType, text } = await new Promise((resolve, reject) => {
        const request = httpRequest(`http://127.0.0.1:${scope.port}/api/tools/chrome_get_windows_and_tabs`, {
          method: 'POST', agent: false, signal: AbortSignal.timeout(15_000),
          headers: {
            'content-type': scenario.type ?? 'application/json', 'x-client-id': 'rest-fixture',
            'content-length': scenario.declaredLength ?? Buffer.byteLength(scenario.body),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => resolve({
            status: response.statusCode, contentType: response.headers['content-type'],
            text: Buffer.concat(chunks).toString(),
          }));
        });
        request.on('error', (error) => reject(new Error(`rust ${scenario.label}: ${error.message}`, { cause: error })));
        request.end(scenario.body);
      });
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      observed.push({ label: scenario.label, status, contentType, body });
    }
    return observed;
  });
}
