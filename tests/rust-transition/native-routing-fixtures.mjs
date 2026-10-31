import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executable, frame, isolatedRun, NativePeer } from './process-host.mjs';

export async function routingFixture() {
  return isolatedRun(async (scope) => {
    const [command, argv] = executable();
    let actions = 0;
    const forwarded = [];
    const peer = new NativePeer(scope.spawn(command, argv), (message) => {
      if (message.type === 'rr_list_published_flows') return { status: 'success', items: [{ id: 'fixture-flow', slug: 'fixture', variables: [] }] };
      if (message.type !== 'call_tool') return;
      actions++;
      forwarded.push(message.payload);
      const args = message.payload.args;
      if (args.fail) return { status: 'error', error: args.fail };
      return { status: 'success', data: {
        content: [{ type: 'text', text: JSON.stringify({ result: args.value ?? args }) }],
        _meta: { source: '\ud800', request: actions }, opaque: '\udfff',
      } };
    });
    assert.equal((await peer.exchange(frame({ type: 'start', payload: { port: scope.port, extensionId: 'routing-fixture' } }))).type, 'server_started');
    const base = `http://127.0.0.1:${scope.port}`;
    async function rest(name, args) {
      const response = await fetch(`${base}/api/tools/${name}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': 'route-client' },
        body: JSON.stringify({ args }), signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    let nextId = 0;
    async function lazy(name, args, extra = {}) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-humanchrome-session': 'route-client' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name: 'humanchrome', arguments: { name, args, ...extra } } }),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      const event = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
      assert(event, text);
      return JSON.parse(event.slice(5).trim()).result;
    }
    const weird = { '\ud800': '\udfff', nested: { value: '\ud800' } };
    const lossless = await rest('chrome_get_windows_and_tabs', weird);
    assert.deepEqual(JSON.parse(lossless.content[0].text).result, weird);
    assert.equal(lossless.opaque, '\udfff');
    assert.equal(lossless._meta.source, '\ud800');
    const alias = await rest('get_windows_and_tabs', weird);
    assert.equal(forwarded.at(-1).name, 'chrome_get_windows_and_tabs');
    const flow = await lazy('flow.fixture', { ...weird, timeoutMs: 4321 });
    assert.deepEqual(forwarded.at(-1), { name: 'record_replay_flow_run', args: { flowId: 'fixture-flow', args: weird, timeoutMs: 4321 } });
    const raw = await lazy('chrome_get_windows_and_tabs', weird, { raw: true, idemKey: 'lossless\ud800' });
    assert.equal(forwarded.at(-1).args.raw, true);
    const beforeReplay = actions;
    const replay = await lazy('chrome_get_windows_and_tabs', weird, { raw: true, idemKey: 'lossless\ud800' });
    assert.equal(actions, beforeReplay);
    assert.equal(replay._meta.idempotent_hit, true);
    assert.equal(replay._meta.source, '\ud800');
    const structured = '{"error":{"code":"TAB_CLOSED","message":"gone","details":{"id":7}}}';
    const failure = await rest('chrome_get_windows_and_tabs', { fail: structured });
    assert.equal(failure.content[0].text, structured);
    const plainFailure = await rest('chrome_get_windows_and_tabs', { fail: 'timeout' });
    assert.deepEqual(JSON.parse(plainFailure.content[0].text), { error: { code: 'UNKNOWN', message: 'timeout' } });
    const help = await lazy('chrome_help', { query: 'click\ud800', limit: 3 });
    assert.equal(JSON.parse(help.content[0].text).query, 'click\ud800');
    const structuredUtf16 = '{"error":{"code":"TAB_CLOSED","message":"\\ud800","details":{"id":7}}}';
    const utf16Failure = await rest('chrome_get_windows_and_tabs', { fail: structuredUtf16 });
    assert.equal(utf16Failure.content[0].text, structuredUtf16);
    const target = join(scope.directory, 'sink', 'output.json');
    const sink = await rest('chrome_javascript', { value: weird, writeResultTo: target });
    assert.equal(forwarded.at(-1).args.writeResultTo, undefined);
    assert.equal(await readFile(target, 'utf8'), JSON.stringify(weird, null, 2));
    assert.equal(sink._meta.source, '\ud800');
    const ack = JSON.parse(sink.content[0].text);
    assert.equal(ack.bytes, Buffer.byteLength(JSON.stringify(weird, null, 2)));
    delete ack.writtenTo;
    const invalidSink = await rest('chrome_javascript', { writeResultTo: 'relative.json' });
    assert.equal(JSON.parse(invalidSink.content[0].text).error.code, 'INVALID_ARGS');
    // Request counters are deterministic; filesystem paths never enter the compared payload.
    return { lossless, alias, flow, raw, replay, failure, plainFailure, help, utf16Failure, ack, invalidSink, actions };
  });
}
