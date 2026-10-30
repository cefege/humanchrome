import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { ROOT, allocatePort, isolatedRun } from './process-host.mjs';
import { normalize } from './native-fixtures.mjs';
import { agentFleetReference } from './agent-fleet-reference.mjs';

const coordinatorBinary = process.env.HC_TEST_CLI_BIN ?? join(
  ROOT,
  'target/release',
  `humanchrome-bridge${process.platform === 'win32' ? '.exe' : ''}`,
);
const databaseUrl = disposableDatabaseUrl();
const nonAdminToken = 'd6'.repeat(32);
const diagnostics = new WeakMap();

await requireFile(
  coordinatorBinary,
  'cargo build -p humanchrome-native --release --bin humanchrome-bridge',
  constants.X_OK,
);

const requireFromNativePackage = createRequire(join(ROOT, 'app/native-server/package.json'));
let Pool;
try {
  ({ Pool } = requireFromNativePackage('pg'));
} catch {
  throw new Error('Missing PostgreSQL test driver; install workspace dependencies');
}

export async function exercise() {
  return isolatedRun(async (scope) => {
    const coordinatorId = `rt-${randomUUID().replaceAll('-', '').slice(0, 29)}`;
    const workerPort = await allocatePort();
    const workerToken = 'w'.repeat(64);
    const clientToken = 'c'.repeat(64);
    const profileName = 'worker-a:profile-a';
    const probe = { renewals: 0, streams: new Set(), purpose: 'fixture-purpose' };
    const server = await startWorker(workerPort, workerToken, probe);
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });

    let primary;
    try {
      await createLegacySchema(pool);
      const configPath = join(scope.directory, 'coordinator.json');
      await writeFile(
        configPath,
        JSON.stringify({
          id: coordinatorId,
          host: '127.0.0.1',
          port: scope.port,
          leaseTtlSec: 15,
          clients: [
            { id: 'operator', token: clientToken, admin: true },
            { id: 'browser-client', token: nonAdminToken, admin: false },
          ],
          workers: [{ id: 'worker-a', url: `http://127.0.0.1:${workerPort}`, token: workerToken }],
        }),
      );

      primary = startCoordinator(scope, configPath);
      await waitForReady(primary, scope.port);
      await assertReload(scope, configPath, primary);
      await assertLockExcluded(scope, configPath);
      const observed = await publicSurface(scope, clientToken);

      const initial = await reserve(scope.port, clientToken, profileName);
      assert.equal(initial.status, 200, 'initial durable route reservation must reach the worker');
      assert.equal(initial.headers.get('x-humanchrome-profile'), profileName);
      assert.deepEqual(await initial.json(), { tools: [] });

      const beforeExpiry = await bindingSnapshot(pool, coordinatorId);
      assert.equal(beforeExpiry.rowCount, 1, 'initial reservation must persist one route binding');
      await activeProxyLifecycle(scope, clientToken, profileName, coordinatorId, pool, probe, primary, 'SIGHUP');
      await activeProxyLifecycle(scope, clientToken, profileName, coordinatorId, pool, probe, primary, 'SIGTERM');
      primary = undefined;
      assert.equal(await expireLease(pool, coordinatorId), 1, 'fixture must expire the persisted lease');

      primary = startCoordinator(scope, configPath);
      await waitForReady(primary, scope.port);

      const expired = await reserve(scope.port, clientToken, profileName);
      assert.equal(expired.status, 409, 'an expired route binding must not allocate another profile');
      assert.deepEqual(await expired.json(), { error: 'lease_expired', message: 'lease_expired' });

      const afterExpiry = await bindingSnapshot(pool, coordinatorId);
      assert.deepEqual(afterExpiry.rows, beforeExpiry.rows, 'reopen must retain the expired binding without reallocating it');
      await stop(primary, 'SIGINT');
      primary = undefined;
      return normalize(observed, scope);
    } finally {
      if (primary) await stop(primary);
      await pool.end();
      await closeServer(server);
    }
  });

}

export async function verify() {
  const reference = await agentFleetReference();
  assert.deepEqual(await exercise(), reference.fleetCoordinator, 'coordinator HTTP/MCP public surface diverged from the captured Node contract');
  console.log('PASS coordinator: Rust HTTP/MCP control, declarative legacy PostgreSQL schema, singleton exclusion, durable expired bindings, SIGHUP reload and SIGTERM/SIGINT shutdown');
}

async function publicSurface(scope, token) {
  const observations = [];
  await assertSdkClient(scope, token);
  let id = 0;
  async function observe(label, path, { method = 'GET', payload, headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${scope.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type');
    const body = contentType?.includes('text/event-stream')
      ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()))
      : text ? JSON.parse(text) : null;
    observations.push({ label, status: response.status, contentType, body });
    return response.status;
  }
  async function rpc(label, method, params, headers) {
    await observe(label, '/v1/fleet/mcp', {
      method: 'POST', headers,
      payload: { jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) },
    });
  }
  for (const path of ['/healthz', '/readyz', '/v1/profiles', '/v1/workers', '/v1/leases']) {
    await observe(path, path);
  }
  await observe('unauthorized', '/v1/profiles', { headers: { authorization: 'Bearer invalid' } });
  const nonAdminHeaders = { authorization: `Bearer ${nonAdminToken}` };
  assert.equal(await observe('non-admin worker inventory', '/v1/workers', { headers: nonAdminHeaders }), 403);
  assert.equal(await observe('non-admin parking', '/v1/park', { method: 'POST', payload: { parked: true }, headers: nonAdminHeaders }), 403);
  for (const version of ['2024-10-07', '2025-06-18', '2025-11-25', '1900-01-01']) {
    await rpc(`initialize-${version}`, 'initialize', {
      protocolVersion: version, capabilities: {}, clientInfo: { name: 'coordinator-fixture', version: '1.0.0' },
    });
  }
  await rpc('missing-sse-accept', 'ping', undefined, { accept: 'application/json' });
  await rpc('unsupported-header-version', 'ping', undefined, { 'mcp-protocol-version': '1900-01-01' });
  await rpc('ping', 'ping');
  await rpc('unknown-method', 'fixture/unknown');
  await rpc('catalog', 'tools/list');
  for (const [name, args] of [
    ['fleet_profiles', {}],
    ['fleet_leases', {}],
    ['fleet_purposes', {}],
    ['fleet_profile', { name: 'worker-a:profile-a', action: 'invalid' }],
    ['fleet_leases', { action: 'release', agent: 'not-the-caller' }],
    ['fleet_park', { parked: 'invalid' }],
    ['fixture_unknown', {}],
  ]) {
    await rpc(`${name}-${JSON.stringify(args)}`, 'tools/call', { name, arguments: args });
  }
  await observe('mcp-get', '/v1/fleet/mcp');
  await observe('mcp-delete', '/v1/fleet/mcp', { method: 'DELETE' });
  return observations;
}

function disposableDatabaseUrl() {
  const value = process.env.HC_TEST_POSTGRES_URL;
  if (!value) {
    throw new Error('HC_TEST_POSTGRES_URL is required and must name a disposable test database');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('HC_TEST_POSTGRES_URL must be a PostgreSQL URL for a disposable test database');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('HC_TEST_POSTGRES_URL must be a PostgreSQL URL for a disposable test database');
  }
  let database;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('HC_TEST_POSTGRES_URL must name an explicit disposable test database');
  }
  const explicitTestName = /(?:^|[-_])(test|tests|testing)(?:$|[-_])/i;
  if (!database || database.includes('/') || !explicitTestName.test(database)) {
    throw new Error('HC_TEST_POSTGRES_URL must name an explicit disposable test database');
  }
  return value;
}

async function createLegacySchema(pool) {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS hc_fleet_generation;
    CREATE TABLE IF NOT EXISTS hc_fleet_profiles (
      coordinator text NOT NULL, profile text NOT NULL, worker text NOT NULL,
      snapshot jsonb NOT NULL, available boolean NOT NULL,
      observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (coordinator, profile)
    );
    CREATE TABLE IF NOT EXISTS hc_fleet_leases (
      coordinator text NOT NULL, profile text NOT NULL, client_id text NOT NULL,
      agent text NOT NULL, lease_id text NOT NULL, generation bigint NOT NULL,
      expires_at timestamptz NOT NULL, released boolean NOT NULL DEFAULT false,
      PRIMARY KEY (coordinator, profile)
    );
    CREATE TABLE IF NOT EXISTS hc_fleet_bindings (
      coordinator text NOT NULL, client_id text NOT NULL, agent text NOT NULL,
      route text NOT NULL, profile text NOT NULL, lease_id text NOT NULL,
      PRIMARY KEY (coordinator, client_id, agent, route)
    );
  `);
}

async function activeProxyLifecycle(scope, token, profile, coordinatorId, pool, probe, child, signal) {
  const response = await fetch(`http://127.0.0.1:${scope.port}/v1/profiles/${encodeURIComponent(profile)}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-humanchrome-agent': 'fixture', 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, `active proxy ${response.status}`);
  const reader = response.body.getReader();
  await reader.read();
  async function expiration() {
    const result = await pool.query(
      'SELECT extract(epoch from expires_at)*1000 AS deadline FROM hc_fleet_leases WHERE coordinator=$1 AND profile=$2',
      [coordinatorId, profile],
    );
    return Number(result.rows[0].deadline);
  }
  try {
    const before = await expiration();
    const renewals = probe.renewals;
    const heartbeatDeadline = Date.now() + 10_000;
    let renewed = before;
    while (renewed <= before + 3000 && Date.now() < heartbeatDeadline) {
      await delay(50);
      renewed = await expiration();
    }
    assert(renewed > before + 3000 && probe.renewals > renewals, 'active response must renew both the worker fence and PostgreSQL lease');
    const ended = reader.read().then((result) => result.done, () => true);
    if (signal === 'SIGHUP') child.kill(signal);
    else await stop(child, signal);
    let timer;
    try {
      assert.equal(await Promise.race([
        ended,
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${signal} left the client proxy stream open`)), 5000); }),
      ]), true);
    } finally { clearTimeout(timer); }
    const closedDeadline = Date.now() + 5000;
    while (probe.streams.size && Date.now() < closedDeadline) await delay(25);
    assert.equal(probe.streams.size, 0, `${signal} must disconnect the owning upstream worker response`);
    if (signal === 'SIGHUP') await waitForReady(child, scope.port);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function startWorker(port, token, probe) {
  const server = createServer((request, response) => {
    request.resume();
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/worker') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'worker-a',
        profiles: [{
          name: 'profile-a',
          port: 12345,
          labels: ['any'],
          enabled: true,
          purpose: probe.purpose,
          state: 'healthy',
          pid: null,
          leasedBy: null,
          lastError: null,
          startedBy: null,
        }],
      }));
      return;
    }
    if (request.method === 'PUT' && request.url === '/v1/worker/profiles/profile-a/lease') {
      probe.renewals++;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/worker/profiles/profile-a/browser/api/tools') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tools: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/worker/profiles/profile-a/browser/mcp') {
      probe.streams.add(response);
      response.once('close', () => probe.streams.delete(response));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"fixture"}}\n\n');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function reserve(port, token, profile) {
  return fetch(`http://127.0.0.1:${port}/v1/profiles/${encodeURIComponent(profile)}/api/tools`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-humanchrome-agent': 'fixture',
    },
    signal: AbortSignal.timeout(10_000),
  });
}

async function bindingSnapshot(pool, coordinatorId) {
  return pool.query(
    `SELECT binding.lease_id, lease.generation
     FROM hc_fleet_bindings AS binding
     JOIN hc_fleet_leases AS lease
       ON lease.coordinator=binding.coordinator AND lease.profile=binding.profile AND lease.lease_id=binding.lease_id
     WHERE binding.coordinator=$1 AND binding.client_id='operator' AND binding.agent='fixture' AND binding.route=$2`,
    [coordinatorId, 'profile:worker-a:profile-a'],
  );
}

async function expireLease(pool, coordinatorId) {
  const result = await pool.query(
    `UPDATE hc_fleet_leases SET expires_at=now()-interval '1 second'
     WHERE coordinator=$1 AND client_id='operator' AND agent='fixture' AND released=false`,
    [coordinatorId],
  );
  return result.rowCount;
}

function startCoordinator(scope, configPath) {
  const args = ['fleet', 'coordinator', '--config', configPath];
  const child = scope.spawn(coordinatorBinary, args, { HC_COORDINATOR_DATABASE_URL: databaseUrl });
  diagnostics.set(child, '');
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => diagnostics.set(child, diagnostics.get(child) + chunk.toString()));
  }
  return child;
}

async function assertLockExcluded(scope, configPath) {
  const contender = startCoordinator(scope, configPath);
  const [code] = await once(contender, 'exit', { signal: AbortSignal.timeout(10_000) });
  assert.notEqual(code, 0, 'a second coordinator must not acquire the same advisory session lock');
  assert.match(diagnostics.get(contender), /coordinator(?: [a-z0-9-]+)? is already running/, 'contender must fail on the advisory lock, not an unrelated startup error');
}

async function waitForReady(child, port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`coordinator exited before readiness (${child.exitCode ?? child.signalCode})\n${diagnostics.get(child)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(250) });
      if (response.status === 200 && (await response.json()).ready === true) return;
    } catch {
      // The process has not bound its isolated loopback port yet.
    }
    await delay(25);
  }
  throw new Error(`coordinator did not become ready against the disposable test database\n${diagnostics.get(child)}`);
}

async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.exitCode, 0, `coordinator exited unexpectedly\n${diagnostics.get(child)}`);
    return;
  }
  const exited = once(child, 'exit');
  child.kill(signal);
  let result;
  let timer;
  try {
    result = await Promise.race([
      exited,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`coordinator did not drain after ${signal}`)), 5000); }),
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw new Error(`${error.message}\n${diagnostics.get(child)}`);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(result[0], 0, `coordinator must exit gracefully after ${signal}, not ${result[1]}\n${diagnostics.get(child)}`);
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requireFile(path, command, mode = constants.R_OK) {
  try {
    await access(path, mode);
  } catch {
    throw new Error(`Missing prerequisite ${path}; run ${command}`);
  }
}

async function assertReload(scope, configPath, child) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const token = 'r'.repeat(64);
  config.clients.push({ id: 'reloaded', token, admin: true });
  await writeFile(configPath, JSON.stringify(config));
  child.kill('SIGHUP');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`coordinator exited during SIGHUP reload\n${diagnostics.get(child)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${scope.port}/v1/profiles`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch {
      // The old listener drains while the replacement acquires the same store.
    }
    await delay(25);
  }
  throw new Error(`coordinator did not adopt changed credentials after SIGHUP\n${diagnostics.get(child)}`);
}

async function assertSdkClient(scope, token) {
  const { Client } = requireFromNativePackage('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = requireFromNativePackage('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'rust-transition-fleet-sdk', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${scope.port}/v1/fleet/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
  });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert(catalog.tools.some((tool) => tool.name === 'fleet_profiles'), 'SDK discovery must expose the management operation used by the caller');
    const result = await client.callTool({ name: 'fleet_profiles', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content.find((block) => block.type === 'text');
    assert(text, 'SDK tool call must deliver the profile inventory');
    assert.deepEqual(JSON.parse(text.text).map(({ name, state }) => ({ name, state })), [
      { name: 'worker-a:profile-a', state: 'healthy' },
    ], 'the real SDK must decode the coordinator control result');
  } finally {
    await client.close();
  }
}
