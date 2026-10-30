import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, constants, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { ROOT, NativePeer, firstDifference, frame, isolatedRun } from './process-host.mjs';

const RUST_FIXTURE = join(ROOT, 'target/release/examples', `native-primitives${process.platform === 'win32' ? '.exe' : ''}`);
const REQUEST_TIMEOUT_MS = 35;
const loneHigh = String.fromCharCode(0xd800);
const opaqueUnicode = {
  text: loneHigh,
  [loneHigh]: 'unpaired key',
  '\uFFFD': 'distinct replacement-character key',
  nested: [String.fromCharCode(0xdfff), '😀', null],
};

await requireExecutable(RUST_FIXTURE, 'cargo build -p humanchrome-native --release --example native-primitives');

const expected = JSON.parse(await readFile(join(ROOT, 'tests/rust-transition/native-primitives-reference.json'), 'utf8'));
const actual = normalize(await observe());
if (JSON.stringify(expected) !== JSON.stringify(actual)) {
  const difference = firstDifference(expected, actual);
  throw new Error(
    `Native host primitive behavior diverged at ${difference.path}: expected=${JSON.stringify(difference.left)} actual=${JSON.stringify(difference.right)}`,
  );
}
process.stderr.write('PASS native-primitives Rust ordered observations preserve the original process contract\n');
process.stdout.write(`${JSON.stringify(actual)}\n`);

async function observe() {
  return isolatedRun(async (scope) => {
    const run = async (name, scenario) => {
      process.stderr.write(`RUN native-primitives rust.${name}\n`);
      const result = await scenario(scope);
      process.stderr.write(`OBSERVED native-primitives rust.${name}\n`);
      return result;
    };
    const framing = await run('framing', observeFraming);
    const requests = await run('requests', observeRequests);
    const lifecycle = await run('lifecycle', observeLifecycle);
    const staleSocket = await run('stale-socket', observeStaleSocket);
    const signalShutdown = await run('signal-shutdown', observeSignalShutdown);
    const standalone = await run('standalone', observeStandalone);
    return { framing, requests, lifecycle, staleSocket, signalShutdown, standalone };
  });
}

async function observeFraming(scope) {
  const fixture = await startPrimary(scope, { HC_DAEMON_IDLE_TIMEOUT_MS: '250' });
  try {
    const output = [];
    const ping = { type: 'ping_from_extension' };
    const bytes = frame(ping);
    fixture.peer.child.stdin.write(bytes.subarray(0, 2));
    await delay(5);
    fixture.peer.child.stdin.write(bytes.subarray(2, 7));
    await delay(5);
    fixture.peer.child.stdin.write(bytes.subarray(7));
    output.push({ scenario: 'split-header-body', frames: [await fixture.peer.next()] });

    fixture.peer.child.stdin.write(Buffer.concat([frame(ping), frame(ping)]));
    output.push({ scenario: 'coalesced', frames: [await fixture.peer.next(), await fixture.peer.next()] });

    for (const size of [0, 16 * 1024 * 1024 + 1]) {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(size);
      const rejection = await fixture.peer.exchange(header);
      const recovered = await fixture.peer.exchange(frame(ping));
      output.push({ scenario: `length-${size}`, frames: [rejection, recovered] });
    }
    const boundaryPrefix = '{"type":"future_message","payload":"';
    const boundaryBody = Buffer.alloc(16 * 1024 * 1024, 0x78);
    boundaryBody.write(boundaryPrefix);
    boundaryBody.write('"}', boundaryBody.length - 2);
    output.push({
      scenario: 'exact-16-MiB-frame-is-accepted',
      frames: [await fixture.peer.exchange(frame(boundaryBody))],
    });

    for (const value of [Buffer.from('{'), null, [], {}, { type: 'future_message', future: true }]) {
      output.push({ scenario: `invalid-${JSON.stringify(value)}`, frames: [await fixture.peer.exchange(frame(value))] });
    }
    output.push({
      scenario: 'valid-JSON-with-escaped-unpaired-surrogates',
      frames: [await fixture.peer.exchange(frame({ type: 'future_message', payload: opaqueUnicode }))],
    });

    fixture.peer.child.stdin.write(Buffer.concat(Array.from({ length: 105 }, () => frame(ping))));
    const frames = [];
    for (let index = 0; index < 105; index += 1) frames.push(await fixture.peer.next());
    assert(frames.every((message) => message.type === 'pong_to_extension'));
    output.push({ scenario: 'yield-after-100', frames });
    return output;
  } finally {
    fixture.peer.child.kill('SIGTERM');
    await waitForExit(fixture.peer.child);
  }
}

async function observeRequests(scope) {
  const fixture = await startPrimary(scope, { HC_DAEMON_IDLE_TIMEOUT_MS: '250' });
  try {
    const omitted = await requestRoundTrip(fixture, { messageType: 'request_data' }, {});
    const explicitNull = await requestRoundTrip(
      fixture,
      { messageType: 'request_data', payload: null },
      { payload: null },
    );
    const nullError = await requestRoundTrip(
      fixture,
      { messageType: 'request_data', payload: { errorShape: 'null' } },
      { error: null, payload: { nullErrorIsNotFailure: true } },
    );

    const extensionError = await requestRoundTrip(
      fixture,
      { messageType: 'request_data', payload: { retained: true } },
      { error: { reason: 'opaque' } },
    );
    const tool = await requestRoundTrip(
      fixture,
      { messageType: 'call_tool', payload: { name: 'chrome_help', args: { query: 'click' } }, clientId: 'tool-client' },
      { payload: { content: [{ type: 'text', text: 'extension result' }], opaqueExtensionField: { retained: true } } },
    );
    const opaqueRoundTrip = await requestRoundTrip(
      fixture,
      { messageType: 'request_data', payload: opaqueUnicode },
      { payload: opaqueUnicode },
    );
    const opaqueToolArgs = await requestRoundTrip(
      fixture,
      { messageType: 'call_tool', payload: { name: 'chrome_javascript', args: opaqueUnicode }, clientId: 'unicode-client' },
      { payload: { preserved: true } },
    );
    const opaqueError = await requestRoundTrip(
      fixture,
      { messageType: 'request_data' },
      { error: ['prefix', loneHigh, null] },
    );
    const correlationTerminal = control(fixture.port, '/__test/request', {
      messageType: 'request_data',
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      timeoutMs: 1000,
    });
    const correlationOutbound = await fixture.peer.next();
    fixture.peer.child.stdin.write(Buffer.concat([
      frame({ responseToRequestId: correlationOutbound.requestId.toUpperCase(), payload: { match: 'wrong-case' } }),
      frame({ responseToRequestId: correlationOutbound.requestId.replaceAll('-', ''), payload: { match: 'wrong-format' } }),
      frame({ responseToRequestId: correlationOutbound.requestId, payload: { match: 'exact' } }),
    ]));
    const correlation = { outbound: correlationOutbound, terminal: await correlationTerminal };

    const preparedWriteFailure = await control(fixture.port, '/__test/request', {
      messageType: 'call_tool', payload: { name: 'chrome_help' }, timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const admittedAfterWriteFailure = await requestRoundTrip(
      fixture,
      { messageType: 'request_data', payload: { after: 'write-failure' } },
      { payload: { admitted: true } },
    );

    const timeoutPromise = control(fixture.port, '/__test/request', {
      messageType: 'request_data', payload: { deadlineInstalledBeforeWrite: true }, timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const timeoutOutbound = await fixture.peer.next();
    const timeout = await timeoutPromise;
    fixture.peer.child.stdin.write(frame({ responseToRequestId: timeoutOutbound.requestId, payload: { late: true } }));
    const admittedAfterTimeout = await requestRoundTrip(
      fixture,
      { messageType: 'request_data', payload: { after: 'timeout' } },
      { payload: { admitted: true } },
    );

    const perClient = await observeBatch(fixture, 51, {
      messageType: 'request_data', payload: { cap: 'client' }, clientId: 'cap-client', timeoutMs: 5_000,
    });
    const admittedAfterClientCap = await requestRoundTrip(
      fixture,
      { messageType: 'request_data', payload: { after: 'client-cap' }, clientId: 'cap-client' },
      { payload: { admitted: true } },
    );

    const global = await observeBatch(fixture, 1_001, {
      messageType: 'request_data', payload: { cap: 'global' }, timeoutMs: 5_000,
    });
    const admittedAfterGlobalCap = await requestRoundTrip(
      fixture,
      { messageType: 'request_data', payload: { after: 'global-cap' } },
      { payload: { admitted: true } },
    );

    return {
      omitted,
      explicitNull,
      nullError,
      extensionError,
      tool,
      opaqueRoundTrip,
      opaqueToolArgs,
      opaqueError,
      correlation,
      preparedWriteFailure,
      admittedAfterWriteFailure,
      timeout: { outbound: timeoutOutbound, terminal: timeout },
      admittedAfterTimeout,
      perClient,
      admittedAfterClientCap,
      global,
      admittedAfterGlobalCap,
    };
  } finally {
    fixture.peer.child.kill('SIGTERM');
    await waitForExit(fixture.peer.child);
  }
}

async function observeBatch(fixture, count, request) {
  const started = await control(fixture.port, '/__test/batch', { ...request, count });
  assert.equal(started.status, 200, JSON.stringify(started));
  const batchId = started.body.batchId;
  const expectedAccepted = count === 51 ? 50 : 1_000;
  const outbound = [];
  for (let index = 0; index < expectedAccepted; index += 1) outbound.push(await fixture.peer.next());
  const before = await waitForBatch(fixture.port, batchId, (results) => results.filter(Boolean).length >= 1);
  for (const [index, message] of outbound.entries()) {
    fixture.peer.child.stdin.write(frame({ responseToRequestId: message.requestId, payload: { slot: index } }));
  }
  const after = await waitForBatch(fixture.port, batchId, (results) => results.every(Boolean));
  return {
    outbound: { count: outbound.length, first: outbound[0], last: outbound.at(-1) },
    before: summarizeBatch(before.body.results),
    after: summarizeBatch(after.body.results),
  };
}

async function observeLifecycle(scope) {
  // Allow the relay handshake to complete before testing primary idle expiry.
  const fixture = await startPrimary(scope, { HC_DAEMON_IDLE_TIMEOUT_MS: '2000' });
  const relay = await startRelay(scope);
  const relayPeer = new NativePeer(relay);
  try {
    assert.equal((await relayPeer.exchange(frame({ type: 'ping_from_extension' }))).type, 'pong_to_extension');
    const request = control(fixture.port, '/__test/request', {
      messageType: 'request_data', payload: { source: 'relay' }, timeoutMs: 500,
    });
    const outbound = await relayPeer.next();
    relayPeer.child.stdin.end();
    const sourceLoss = await request;
    await waitForExit(relayPeer.child);
    await delay(15);
    const unavailable = await control(fixture.port, '/__test/request', {
      messageType: 'request_data', payload: { source: 'absent' }, timeoutMs: REQUEST_TIMEOUT_MS,
    });

    const replacement = await startRelay(scope);
    const replacementPeer = new NativePeer(replacement);
    assert.equal((await replacementPeer.exchange(frame({ type: 'ping_from_extension' }))).type, 'pong_to_extension');
    const reconnected = await requestRoundTrip(
      { ...fixture, peer: replacementPeer },
      { messageType: 'request_data', payload: { source: 'replacement' } },
      { payload: { reconnected: true } },
    );
    replacementPeer.child.stdin.end();
    await waitForExit(replacementPeer.child);
    const primaryExit = await waitForExit(fixture.peer.child);
    const socketRemoved = await missing(scope.env.HC_BRIDGE_DAEMON_SOCKET);
    return {
      initialToRelay: { ping: 'pong_to_extension', outbound },
      sourceLoss,
      unavailable,
      reconnected,
      idlePrimaryExit: primaryExit,
      socketRemoved,
    };
  } finally {
    relayPeer.child.kill('SIGTERM');
    fixture.peer.child.kill('SIGTERM');
    await Promise.all([waitForExit(relayPeer.child), waitForExit(fixture.peer.child)]);
  }
}

async function observeStaleSocket(scope) {
  await rm(scope.env.HC_BRIDGE_DAEMON_SOCKET, { force: true });
  await writeFile(scope.env.HC_BRIDGE_DAEMON_SOCKET, 'stale native socket marker');
  const fixture = await startPrimary(scope, { HC_DAEMON_IDLE_TIMEOUT_MS: '250' });
  try {
    const staleRecovered = await present(scope.env.HC_BRIDGE_DAEMON_SOCKET);
    const connections = new Set();
    const live = createServer((socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      socket.on('error', () => {});
      socket.resume();
    });
    const liveSocket = join(scope.directory, 'live-native.sock');
    await new Promise((resolve, reject) => {
      live.once('error', reject);
      live.listen(liveSocket, resolve);
    });
    const connection = once(live, 'connection', { signal: AbortSignal.timeout(5000) });
    const candidate = scope.spawn(...command(scope.port, true), {
      HC_DISABLE_DAEMON: '0',
      HC_BRIDGE_DAEMON_SOCKET: liveSocket,
    });
    await connection;
    const liveSocketPreserved = await present(liveSocket);
    candidate.kill('SIGTERM');
    await waitForExit(candidate);
    for (const socket of connections) socket.destroy();
    await new Promise((resolve, reject) => live.close((error) => error ? reject(error) : resolve()));
    return { staleRecovered, liveSocketPreserved };
  } finally {
    fixture.peer.child.kill('SIGTERM');
    await waitForExit(fixture.peer.child);
  }
}

async function observeSignalShutdown(scope) {
  const [executable, args] = command(scope.port);
  const child = scope.spawn(executable, args, { HC_DISABLE_DAEMON: '0' });
  const peer = new NativePeer(child);
  try {
    await peer.exchange(frame({ type: 'ping_from_extension' }));
    await mkdir(scope.env.HC_INSTANCE_REGISTRY_DIR, { recursive: true });
    const ownRecord = join(scope.env.HC_INSTANCE_REGISTRY_DIR, `${child.pid}.json`);
    await writeFile(ownRecord, JSON.stringify({ pid: child.pid, port: scope.port }));
    child.kill('SIGTERM');
    return {
      exit: await waitForExit(child),
      ownRegistryRemoved: await missing(ownRecord),
      socketRemoved: await missing(scope.env.HC_BRIDGE_DAEMON_SOCKET),
    };
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
  }
}

async function observeStandalone(scope) {
  const child = scope.spawn(...command(scope.port), { HC_DISABLE_DAEMON: '1' });
  await waitForControl(scope.port);
  child.stdin.end();
  return waitForExit(child);
}

async function startPrimary(scope, overrides = {}) {
  const [executable, args] = command(scope.port);
  const child = scope.spawn(executable, args, { HC_DISABLE_DAEMON: '0', ...overrides });
  const peer = new NativePeer(child);
  await waitForControl(scope.port);
  return { peer, port: scope.port };
}

async function startRelay(scope) {
  const [executable, args] = command(scope.port, true);
  return scope.spawn(executable, args, { HC_DISABLE_DAEMON: '0' });
}

function command(port, relay = false) {
  return [RUST_FIXTURE, relay ? ['--relay'] : ['--control-port', String(port)]];
}

async function requestRoundTrip(fixture, request, response) {
  const terminal = control(fixture.port, '/__test/request', request);
  const outbound = await fixture.peer.next();
  fixture.peer.child.stdin.write(frame({ responseToRequestId: outbound.requestId, ...response }));
  return { outbound, terminal: await terminal };
}

async function control(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

async function readBatch(port, batchId) {
  const response = await fetch(`http://127.0.0.1:${port}/__test/batch/${encodeURIComponent(batchId)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForBatch(port, batchId, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await readBatch(port, batchId);
    if (result.status === 200 && predicate(result.body.results)) return result;
    await delay(5);
  }
  throw new Error(`batch ${batchId} did not reach its expected terminal state`);
}

function summarizeBatch(results) {
  const summary = { pending: 0, resolved: 0, rejected: [] };
  for (const result of results) {
    if (!result) summary.pending += 1;
    else if (result.outcome === 'resolved') summary.resolved += 1;
    else summary.rejected.push(result.error);
  }
  summary.rejected.sort();
  return summary;
}

async function waitForControl(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__test/batch/missing`, { signal: AbortSignal.timeout(250) });
      if (response.status === 404) return;
    } catch {}
    await delay(10);
  }
  throw new Error(`fixture control endpoint did not bind on ${port}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let exit;
  try {
    exit = await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`Fixture did not exit within 5s: ${child.spawnargs.join(' ')}`, { cause: error });
  }
  const [code, signal] = exit;
  return { code, signal };
}

async function present(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function missing(path) {
  return !(await present(path));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalize(value) {
  const ids = new Map();
  const visit = (item) => {
    if (typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)) {
      if (!ids.has(item)) ids.set(item, `<uuid-${ids.size + 1}>`);
      return ids.get(item);
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    return item;
  };
  return visit(value);
}



async function requireExecutable(path, command) {
  return requireFile(path, command, constants.X_OK);
}

async function requireFile(path, command, mode = constants.R_OK) {
  try {
    await access(path, mode);
  } catch {
    throw new Error(`missing prerequisite ${path}; run ${command}`);
  }
}
