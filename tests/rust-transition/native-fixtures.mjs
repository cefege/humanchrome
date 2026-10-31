import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { frame, isolatedRun, NativePeer, executable } from './process-host.mjs';

const ping = { type: 'ping_from_extension' };

export async function framingFixture() {
  return isolatedRun(async (scope) => {
    const [command, args] = executable();
    const peer = new NativePeer(scope.spawn(command, args));
    const observed = [];
    const bytes = frame(ping);
    // Force delivery across distinct turns, not just multiple writes coalesced by a pipe.
    peer.child.stdin.write(bytes.subarray(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 25));
    peer.child.stdin.write(bytes.subarray(2, 7));
    await new Promise((resolve) => setTimeout(resolve, 25));
    peer.child.stdin.write(bytes.subarray(7));
    observed.push({ scenario: 'split-header-body', frames: [await peer.next()] });
    peer.child.stdin.write(Buffer.concat([frame(ping), frame(ping)]));
    observed.push({ scenario: 'coalesced', frames: [await peer.next(), await peer.next()] });
    for (const size of [0, 16 * 1024 * 1024 + 1]) {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(size);
      const rejection = await peer.exchange(header);
      const recovered = await peer.exchange(frame(ping));
      observed.push({ scenario: `length-${size}`, frames: [rejection, recovered] });
    }
    for (const value of [Buffer.from('{'), null, [], {}, { type: 'future_message', future: true }]) {
      observed.push({ scenario: `invalid-${JSON.stringify(value)}`, frames: [await peer.exchange(frame(value))] });
    }
    peer.child.stdin.write(Buffer.concat(Array.from({ length: 105 }, () => frame(ping))));
    const frames = [];
    for (let index = 0; index < 105; index++) frames.push(await peer.next());
    observed.push({ scenario: 'yield-after-100', frames });
    assert.equal(observed[0].frames[0].type, 'pong_to_extension');
    assert(frames.every((message) => message.type === 'pong_to_extension'));
    return observed;
  });
}

function extensionResponse(message) {
  if (message.type === 'rr_list_published_flows') return { status: 'success', items: [] };
  if (message.type === 'call_tool') {
    return { content: [{ type: 'text', text: JSON.stringify({ tool: message.payload.name, args: message.payload.args, clientId: message.clientId }) }], opaqueExtensionField: { retained: true } };
  }
  return undefined;
}

export async function httpFixture(mode = 'lazy') {
  return isolatedRun(async (scope) => {
    const [command, args] = executable();
    const peer = new NativePeer(scope.spawn(command, args, { HUMANCHROME_TOOL_MODE: mode }), extensionResponse);
    const started = await peer.exchange(frame({ type: 'start', payload: { port: scope.port, extensionId: 'rust-transition-fixture', instanceId: 'rust-transition-fixture' } }));
    assert.equal(started.type, 'server_started', JSON.stringify(started));
    const base = `http://127.0.0.1:${scope.port}`;
    async function request(path, init = {}) {
      // Node fetch may discard an overridden Host; use the actual HTTP wire.
      const { status, headers, text } = await new Promise((resolve, reject) => {
        const request = httpRequest(`${base}${path}`, {
          method: init.method ?? 'GET', headers: init.headers,
          signal: AbortSignal.timeout(15_000),
        }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => resolve({
            status: response.statusCode, headers: response.headers,
            text: Buffer.concat(chunks).toString(),
          }));
        });
        request.on('error', reject);
        request.end(init.body);
      });
      // Transport timestamps are the only header value normalized here.
      if (headers.date) headers.date = '<timestamp>';
      let body;
      if (headers['content-type']?.includes('text/event-stream')) {
        body = text.split(/\r?\n\r?\n/).filter(Boolean).map((event) => event.split(/\r?\n/).map((line) => line.startsWith('data:') ? { data: JSON.parse(line.slice(5).trim()) } : line));
      } else {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      return { status, headers, body };
    }
    const rpcHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const rpc = (method, params, id, clientId) => request('/mcp', {
      method: 'POST', headers: { ...rpcHeaders, 'x-humanchrome-session': clientId },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const observed = { started, ping: await request('/ping') };
    observed.catalog = await request('/api/tools');
    observed.openapi = await request('/api/openapi.json');
    observed.concurrentLists = await Promise.all([
      rpc('tools/list', {}, 1, 'client-a'), rpc('tools/list', {}, 2, 'client-b'),
    ]);
    for (const result of observed.concurrentLists) {
      assert.equal(result.status, 200);
      assert.equal(result.headers['mcp-session-id'], undefined);
    }
    observed.initialize = [];
    for (const protocolVersion of ['2026-07-28', '2025-06-18']) {
      observed.initialize.push(await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'rust-transition', version: '1' } }, protocolVersion, 'init-client'));
    }
    const call = (name, toolArgs, id) => mode === 'lazy'
      ? rpc('tools/call', { name: 'humanchrome', arguments: { name, args: toolArgs } }, id, 'policy-client')
      : rpc('tools/call', { name, arguments: toolArgs }, id, 'policy-client');
    observed.help = await call('chrome_help', { query: 'click' }, 3);
    observed.alias = await call('get_windows_and_tabs', {}, 4);
    observed.typo = await call('chrome_clik', {}, 5);
    observed.sunset = await call('chrome_get_cookies', {}, 6);
    observed.restMalformed = await request('/api/tools/chrome_click_element', { method: 'POST', headers: rpcHeaders, body: JSON.stringify({ args: {}, clientId: 'smuggled' }) });
    observed.hostRejected = await request('/api/tools/chrome_click_element', { method: 'POST', headers: { ...rpcHeaders, host: 'attacker.invalid' }, body: '{"args":{}}' });
    observed.originRejected = await request('/api/tools/chrome_click_element', { method: 'POST', headers: { ...rpcHeaders, origin: 'https://attacker.invalid' }, body: '{"args":{}}' });
    assert.equal(observed.restMalformed.status, 400);
    assert.equal(observed.hostRejected.status, 403);
    assert.equal(observed.originRejected.status, 403);
    return normalize(observed, scope);
  });
}

export function normalize(value, { directory, port }) {
  const ids = new Map();
  function visit(item, key) {
    if (typeof item === 'number') {
      return (key === 'port' || key === 'requestedPort') && item === port ? '<allocated-port>' : item;
    }
    if (typeof item === 'string') {
      if (key === 'description') return item;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)) {
        if (!ids.has(item)) ids.set(item, `<uuid-${ids.size + 1}>`);
        return ids.get(item);
      }
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(item)) return '<timestamp>';
      if (item === directory || item.startsWith(`${directory}/`)) {
        return '<temporary-directory>' + item.slice(directory.length);
      }
      if (/^https?:\/\//.test(item)) return item.replaceAll(`:${port}`, ':<allocated-port>');
      return item;
    }
    if (Array.isArray(item)) return item.map((value) => visit(value, key));
    if (item && typeof item === 'object') {
      // Errors and catalog text are evidence, never normalization targets.
      if (item.isError || item.error) return item;
      return Object.fromEntries(Object.entries(item).map(([field, val]) => [field, visit(val, field)]));
    }
    return item;
  }
  return visit(value);
}
