import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ROOT, allocatePort, isolatedRun } from './process-host.mjs';

const execFile = promisify(execFileCallback);
const token = 'aa'.repeat(32);
const leaseOne = '11111111-1111-4111-8111-111111111111';
const leaseTwo = '22222222-2222-4222-8222-222222222222';
const leaseThree = '33333333-3333-4333-8333-333333333333';
const leaseFour = '44444444-4444-4111-8111-444444444444';
const fixtureBinary = join(
  ROOT,
  'target',
  'release',
  'examples',
  `worker_fixture${process.platform === 'win32' ? '.exe' : ''}`,
);

export async function verify() {
  await requireExecutable(
    fixtureBinary,
    'cargo build -p humanchrome-native --release --example worker_fixture',
  );
  const tailscaleHost = await localTailscaleIpv4();
  await isolatedRun(async (scope) => {
    await mkdir(scope.env.HC_FLEET_ROOT, { recursive: true });
    const fences = join(scope.env.HC_FLEET_ROOT, 'worker-fences.sqlite');
    createLegacyFenceDatabase(fences);
    const bridge = await startBridge();
    const workerPort = await allocatePort();
    const base = `http://${tailscaleHost}:${workerPort}`;
    let worker;
    try {
      worker = await startWorker(scope, { tailscaleHost, workerPort, bridgePort: bridge.port, fences });
      await claim(base, leaseOne, 1);
      const completed = await leased(base, leaseOne, 1, '/v1/worker/profiles/browser/browser/api/tools/complete', { method: 'POST' });
      assert.equal(completed.status, 200, 'fixed-length mutation must return successfully');
      await completed.arrayBuffer();
      const empty = await leased(base, leaseOne, 1, '/v1/worker/profiles/browser/browser/api/tools/empty', { method: 'POST' });
      assert.equal(empty.status, 204, 'completed fixed-length mutation must not quarantine the next action');
      await empty.arrayBuffer();
      const redirect = await leased(base, leaseOne, 1, '/v1/worker/profiles/browser/browser/api/tools/redirect', { method: 'POST', redirect: 'manual' });
      assert.equal(redirect.status, 303, 'worker must expose the upstream response, not follow action redirects');
      assert.equal(redirect.headers.get('location'), '/redirect-target');
      assert.equal(await redirect.text(), 'must not follow');
      await abandonProxy(base, leaseOne, 1, 'POST');
      assert.equal(bridge.requests('click'), 1, 'the mutating proxy retried a disconnected action');
      await stopWorker(worker, 'SIGKILL');

      worker = await startWorker(scope, { tailscaleHost, workerPort, bridgePort: bridge.port, fences });
      await expectError(
        claimResponse(base, leaseTwo, 1),
        409,
        'stale_lease',
        'reopened legacy fence rejects a same-generation identity',
      );
      await expectError(
        leased(base, leaseOne, 1, '/v1/worker/profiles/browser/browser/api/tools/click', { method: 'POST' }),
        409,
        'outcome_unknown',
        'restarted worker retains the disconnected mutation outcome quarantine',
      );

      await stopWorker(worker, 'SIGTERM');
      worker = undefined;
      expireLease(fences, 'browser');
      worker = await startWorker(scope, { tailscaleHost, workerPort, bridgePort: bridge.port, fences });
      await expectError(
        release(base, leaseOne, 1),
        409,
        'stale_lease',
        'an expired owner cannot release a disconnected mutating request',
      );
      await expectError(
        claimResponse(base, leaseTwo, 2),
        409,
        'lease_conflict',
        'durable in_flight blocks reassignment after process restart and lease expiry',
      );

      const recovery = await authenticated(base, '/v1/worker/profiles/browser/recover', { method: 'POST' });
      assert.equal(recovery.status, 200, `explicit recovery failed: ${await recovery.text()}`);
      await claim(base, leaseTwo, 2);

      await abandonProxy(base, leaseTwo, 2, 'POST');
      const restart = await untilStatus(
        () => leased(base, leaseTwo, 2, '/v1/worker/profiles/browser/restart', { method: 'POST' }),
        200,
        'owning restart did not clear mutating uncertainty',
      );
      assert.equal(restart.status, 200, `owning restart did not clear mutating uncertainty: ${await restart.text()}`);
      const released = await release(base, leaseTwo, 2);
      assert.equal(released.status, 204, `release after owning restart failed: ${await released.text()}`);

      await claim(base, leaseThree, 3);
      const read = await openProxy(base, leaseThree, 3, 'GET');
      expireLease(fences, 'browser');
      await expectError(
        claimResponse(base, leaseFour, 4),
        409,
        'lease_conflict',
        'a newer lease cannot hand off an active response stream',
      );
      assert.ok(read.body, 'active read returned no streaming body');
      await read.body.cancel();
      const handoff = await untilStatus(
        () => claimResponse(base, leaseFour, 4),
        200,
        'newer lease remained blocked after the active response stream closed',
      );
      assert.equal(handoff.status, 200, `lease handoff failed after stream closure: ${await handoff.text()}`);
      const handoffReleased = await release(base, leaseFour, 4);
      assert.equal(handoffReleased.status, 204, `release after stream handoff failed: ${await handoffReleased.text()}`);
      await expectError(
        claimResponse(base, leaseThree, 3),
        409,
        'stale_lease',
        'released and recovered fences retain the highest generation',
      );
    } finally {
      if (worker) await stopWorker(worker, 'SIGTERM');
      await bridge.close();
    }
  });
  console.log('PASS fleet worker: real WorkerHttp legacy SQLite reopen, exact generation fencing, disconnect/kill quarantine, explicit recovery/restart, no mutation replay, and active-stream handoff exclusion');
}

async function localTailscaleIpv4() {
  let stdout;
  try {
    ({ stdout } = await execFile('tailscale', ['ip', '-4']));
  } catch (error) {
    throw new Error(`fleet worker durability fixture requires a local Tailscale IPv4 address (tailscale ip -4 failed: ${error.message})`);
  }
  const addresses = stdout
    .trim()
    .split(/\s+/)
    .filter((value) => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(value));
  assert.equal(addresses.length, 1, `expected exactly one local Tailscale IPv4 address, got ${stdout.trim() || '(none)'}`);
  return addresses[0];
}

async function requireExecutable(path, command) {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`missing worker durability fixture executable: ${path}\nRun: ${command}`);
  }
}

async function startWorker(scope, { tailscaleHost, workerPort, bridgePort, fences }) {
  const child = scope.spawn(fixtureBinary, [
    '--host', tailscaleHost,
    '--port', String(workerPort),
    '--bridge-port', String(bridgePort),
    '--fences', fences,
  ]);
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker fixture readiness timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 10_000);
    const failed = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`worker fixture exited before readiness (${code ?? signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    child.once('exit', failed);
    const check = () => {
      const line = stdout.split('\n').find((value) => value.trim().startsWith('{'));
      if (!line) return;
      try {
        const status = JSON.parse(line);
        if (status.ready === true && status.port === workerPort) {
          clearTimeout(timer);
          child.removeListener('exit', failed);
          resolve();
        }
      } catch {
        // Wait for the complete readiness line.
      }
    };
    child.stdout.on('data', check);
    check();
  });
  return { child };
}

async function stopWorker(worker, signal) {
  if (!worker?.child.pid || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = once(worker.child, 'exit');
  worker.child.kill(signal);
  const timer = setTimeout(() => worker.child.kill('SIGKILL'), 2_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function startBridge() {
  const sockets = new Set();
  const requests = new Map();
  const server = createServer((request, response) => {
    if (request.url === '/api/tools/complete') {
      request.resume();
      const body = '{"completed":true}';
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
      return;
    }
    if (request.url === '/api/tools/empty') {
      request.resume();
      response.writeHead(204, { 'content-length': '0' }).end();
      return;
    }
    if (request.url === '/api/tools/redirect') {
      request.resume();
      response.writeHead(303, { location: '/redirect-target' }).end('must not follow');
      return;
    }
    if (request.url === '/redirect-target') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"unexpectedRedirect":true}');
      return;
    }
    const target = request.url?.match(/^\/api\/tools\/(click|read)$/)?.[1];
    if (!target || !['POST', 'GET'].includes(request.method ?? '')) {
      response.writeHead(404).end();
      return;
    }
    requests.set(target, (requests.get(target) ?? 0) + 1);
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.write('{"stream":');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    requests(target) {
      return requests.get(target) ?? 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function claim(base, leaseId, generation) {
  const response = await claimResponse(base, leaseId, generation);
  assert.equal(response.status, 200, `claim generation ${generation} failed: ${await response.text()}`);
}

function claimResponse(base, leaseId, generation) {
  return authenticated(base, '/v1/worker/profiles/browser/lease', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'durability-fixture', leaseId, generation, ttlSec: 15 }),
  });
}

function release(base, leaseId, generation) {
  return leased(base, leaseId, generation, '/v1/worker/profiles/browser/lease', { method: 'DELETE' });
}

async function abandonProxy(base, leaseId, generation, method) {
  const response = await leased(
    base,
    leaseId,
    generation,
    `/v1/worker/profiles/browser/browser/api/tools/${method === 'GET' ? 'read' : 'click'}`,
    {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
    },
  );
  if (response.status !== 200) {
    assert.fail(`proxy ${method} did not receive fixture bridge response: ${response.status} ${await response.text()}`);
  }
  assert.ok(response.body, `proxy ${method} returned no streaming response body`);
  await response.body.cancel();
  await delay(100);
}

async function openProxy(base, leaseId, generation, method) {
  const response = await leased(
    base,
    leaseId,
    generation,
    `/v1/worker/profiles/browser/browser/api/tools/${method === 'GET' ? 'read' : 'click'}`,
    {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
    },
  );
  if (response.status !== 200) assert.fail(`proxy ${method} did not receive fixture bridge response: ${await response.text()}`);
  return response;
}

async function authenticated(base, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000), ...init, headers });
}

async function leased(base, leaseId, generation, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-humanchrome-lease', leaseId);
  headers.set('x-humanchrome-agent', 'durability-fixture');
  headers.set('x-humanchrome-generation', String(generation));
  return authenticated(base, path, { ...init, headers });
}

async function expectError(responsePromise, status, error, context) {
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status, status, `${context}: ${JSON.stringify(body)}`);
  assert.equal(body.error, error, `${context}: ${JSON.stringify(body)}`);
}

async function untilStatus(request, expectedStatus, context) {
  const deadline = Date.now() + 3_000;
  let last = '';
  while (Date.now() < deadline) {
    const response = await request();
    if (response.status === expectedStatus) return response;
    last = `${response.status}: ${await response.text()}`;
    await delay(25);
  }
  throw new Error(`${context}; last response ${last}`);
}

function createLegacyFenceDatabase(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec(`CREATE TABLE worker_fences (
      profile TEXT PRIMARY KEY NOT NULL,
      generation INTEGER NOT NULL,
      lease_id TEXT,
      agent TEXT,
      expires_at INTEGER,
      released INTEGER NOT NULL DEFAULT 0,
      in_flight INTEGER NOT NULL DEFAULT 0
    )`);
  } finally {
    database.close();
  }
}

function expireLease(path, profile) {
  const database = new DatabaseSync(path);
  try {
    database.prepare('UPDATE worker_fences SET expires_at = 0 WHERE profile = ?').run(profile);
  } finally {
    database.close();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  verify().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
