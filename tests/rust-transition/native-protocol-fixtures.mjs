import assert from 'node:assert/strict';
import { executable, frame, isolatedRun, NativePeer } from './process-host.mjs';

export async function protocolFixture() {
  return isolatedRun(async (scope) => {
    const [command, args] = executable();
    const peer = new NativePeer(scope.spawn(command, args), (message) => {
      if (message.type === 'rr_list_published_flows') return { status: 'success', items: [] };
    });
    assert.equal((await peer.exchange(frame({ type: 'start', payload: { port: scope.port, extensionId: 'protocol-fixture' } }))).type, 'server_started');
    return observeProtocolEndpoint(`http://127.0.0.1:${scope.port}/mcp`);
  });
}

export async function observeProtocolEndpoint(url, headers = {}) {
    const observed = [];
    const initialize = (label, protocolVersion) => ({
      label,
      accept: 'application/json, text/event-stream',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'rust-transition', version: '1.0.0' },
        },
      },
    });
    const cases = [
      { label: 'both', accept: 'application/json, text/event-stream' },
      { label: 'json', accept: 'application/json' },
      { label: 'sse', accept: 'text/event-stream' },
      { label: 'wildcard', accept: '*/*' },
      { label: 'unsupported-version', accept: 'application/json, text/event-stream', version: '1900-01-01' },
      { label: 'supported-version', accept: 'application/json, text/event-stream', version: '2025-06-18' },
      { label: 'non-json-content-type', accept: 'application/json, text/event-stream', contentType: 'text/plain' },
      initialize('initialize-2024-10-07', '2024-10-07'),
      initialize('initialize-2025-06-18', '2025-06-18'),
      initialize('initialize-latest', '2025-11-25'),
      initialize('initialize-unsupported-fallback', '1900-01-01'),
      { label: 'get', method: 'GET', accept: 'text/event-stream' },
      { label: 'delete', method: 'DELETE', accept: 'application/json, text/event-stream' },
      { label: 'notification', accept: 'application/json, text/event-stream', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } },
      { label: 'invalid-request', accept: 'application/json, text/event-stream', payload: {} },
      { label: 'invalid-boolean-id', accept: 'application/json, text/event-stream', payload: { jsonrpc: '2.0', id: true, method: 'ping' } },
      { label: 'invalid-array-params', accept: 'application/json, text/event-stream', payload: { jsonrpc: '2.0', id: 1, method: 'ping', params: [] } },
      { label: 'missing-tool-name', accept: 'application/json, text/event-stream', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} } },
      ...[null, [], 42, 'text'].map((argumentsValue) => ({
        label: `invalid-arguments-${JSON.stringify(argumentsValue)}`,
        accept: 'application/json, text/event-stream',
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'humanchrome', arguments: argumentsValue } },
      })),
      { label: 'lossless-id', accept: 'application/json, text/event-stream', payload: { jsonrpc: '2.0', id: '\ud800', method: 'ping' } },
      { label: 'lossless-method', accept: 'application/json, text/event-stream', payload: { jsonrpc: '2.0', id: 1, method: '\ud800' } },
      { label: 'lossless-dispatch-name', accept: 'application/json, text/event-stream', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'humanchrome', arguments: { name: '\ud800x' } } } },
    ];
    for (const scenario of cases) {
      const method = scenario.method ?? 'POST';
      const response = await fetch(url, {
        method,
        headers: { ...headers, accept: scenario.accept, 'content-type': scenario.contentType ?? 'application/json', ...(scenario.version ? { 'mcp-protocol-version': scenario.version } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(scenario.payload ?? { jsonrpc: '2.0', id: 1, method: 'ping' }) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let body;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        body = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()));
      } else {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      observed.push({ label: scenario.label, status: response.status, contentType: response.headers.get('content-type'), body });
    }
    return observed;
}
