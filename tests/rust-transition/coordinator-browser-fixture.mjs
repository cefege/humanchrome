import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './process-host.mjs';
import { disposableDatabaseUrl } from './coordinator-state-safety-fixture.mjs';
import { workerBrowserFixture } from './worker-browser-fixture.mjs';

const require = createRequire(join(ROOT, 'app/native-server/package.json'));

export async function verify() {
  const databaseUrl = disposableDatabaseUrl();
  await workerBrowserFixture({ beforeLeases: (context) => exerciseCoordinator(context, databaseUrl) });
  console.log('PASS real coordinator → worker → Rust nativehost → Chrome: official MCP SDK navigation/DOM calls, durable lease release, worker crash fencing and recovery');
}

async function exerciseCoordinator({ scope, cli, workerConfig, workerBase, fixtureUrl, readFence, leaderLossUrl, leaderLossRequests }, databaseUrl) {
  const token = 'c7'.repeat(32);
  const agent = 'coordinator-browser-sdk';
  const base = `http://127.0.0.1:${scope.port}`;
  const config = join(scope.directory, 'browser-coordinator.json');
  const coordinatorId = `cb-${randomUUID().replaceAll('-', '').slice(0, 29)}`;
  await writeFile(config, JSON.stringify({
    id: coordinatorId,
    host: '127.0.0.1', port: scope.port, leaseTtlSec: 15,
    clients: [{ id: 'browser-operator', token, admin: true }],
    workers: [{ id: workerConfig.id, url: workerBase, token: workerConfig.token }],
  }), { mode: 0o600 });
  const child = scope.spawn(cli, ['fleet', 'coordinator', '--config', config], { HC_COORDINATOR_DATABASE_URL: databaseUrl });
  const exited = once(child, 'exit');
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs += chunk; });
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  let client = new Client({ name: agent, version: '1.0.0' }, { capabilities: {} });
  try {
    const expectedProfile = `${workerConfig.id}:browser`;
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, `coordinator exited before readiness: ${logs}`);
      try {
        const response = await fetch(`${base}/v1/profiles`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_000) });
        const profiles = await response.json();
        ready = response.ok && Array.isArray(profiles) && profiles.some((profile) => profile.name === expectedProfile && profile.state === 'healthy');
        if (ready) break;
      } catch { /* Poll only readiness; never replay browser actions. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, `coordinator did not observe the real worker profile: ${logs}`);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/v1/pool/any/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, 'x-humanchrome-agent': agent } },
    });
    await client.connect(transport, { signal: AbortSignal.timeout(20_000) });
    const catalog = await client.listTools();
    assert(catalog.tools.some((tool) => tool.name === 'humanchrome'), 'pooled MCP must expose the browser dispatcher, not fleet management');
    async function tool(name, args) {
      const result = await client.callTool({ name: 'humanchrome', arguments: { name, args } }, undefined, { signal: AbortSignal.timeout(30_000) });
      assert.notEqual(result.isError, true, `real coordinator ${name}: ${JSON.stringify(result)}`);
      const text = result.content.find((block) => block.type === 'text')?.text;
      assert(text, `real coordinator ${name} omitted its browser result`);
      return JSON.parse(text);
    }
    const navigation = await tool('chrome_navigate', { url: fixtureUrl });
    assert.equal(typeof navigation.tabId, 'number', 'coordinator must return an actual browser tab');
    await tool('chrome_wait_for', { tabId: navigation.tabId, kind: 'load_state', state: 'complete', timeoutMs: 15_000 });
    const observed = await tool('chrome_javascript', { tabId: navigation.tabId, code: 'return { title: document.title, text: document.querySelector("#state").textContent };' });
    assert.deepEqual(JSON.parse(observed.result), { title: 'Rust worker browser fixture', text: 'ready' });
    await client.close();
    const released = await fetch(`${base}/v1/leases/${agent}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'x-humanchrome-agent': agent }, signal: AbortSignal.timeout(10_000) });
    assert.equal(released.status, 200, `coordinator lease release failed: ${await released.text()}`);
    const row = readFence();
    assert(row?.released, 'coordinator release must reach the durable worker fence');
    assert.equal(row.inFlight, 0, 'completed SDK calls must leave no mutation uncertainty');
    assert(Number.isSafeInteger(row.generation) && row.generation > 0, 'coordinator must supply an actual database generation');
    client = new Client({ name: `${agent}-leader-loss`, version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/pool/any/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, 'x-humanchrome-agent': agent } },
    }), { signal: AbortSignal.timeout(20_000) });
    const baseline = await tool('chrome_navigate', { url: `${leaderLossUrl}?before` });
    await tool('chrome_wait_for', { tabId: baseline.tabId, kind: 'load_state', state: 'complete', timeoutMs: 15_000 });
    assert.equal(leaderLossRequests(), 1, 'the real browser must reach the side-effect observer before leader loss');
    const active = readFence();
    assert(active.generation > row.generation && !active.released, 'new SDK connection must hold a newer live worker lease');
    const { Client: PgClient } = require('pg');
    const database = new PgClient({ connectionString: databaseUrl });
    await database.connect();
    try {
      const owners = await database.query(
        `SELECT lock.pid FROM pg_locks AS lock
         CROSS JOIN (SELECT hashtextextended('humanchrome-coordinator:' || $1, 0) AS advisory_key) AS expected
         WHERE lock.locktype='advisory' AND lock.granted AND lock.objsubid=1
           AND lock.database=(SELECT oid FROM pg_database WHERE datname=current_database())
           AND lock.classid::text::bigint=((expected.advisory_key >> 32) & 4294967295)
           AND lock.objid::text::bigint=(expected.advisory_key & 4294967295)`,
        [coordinatorId],
      );
      assert.equal(owners.rowCount, 1, 'fault injection must identify exactly the owned coordinator lock');
      const killed = await database.query('SELECT pg_terminate_backend($1) AS terminated', [owners.rows[0].pid]);
      assert.equal(killed.rows[0].terminated, true);
    } finally { await database.end(); }
    const denied = await fetch(`${base}/v1/pool/any/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-humanchrome-agent': agent, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'lost-leader', method: 'tools/call', params: { name: 'humanchrome', arguments: { name: 'chrome_navigate', args: { url: `${leaderLossUrl}?after` } } } }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(denied.status, 503, `leader loss must fail before browser dispatch: ${await denied.text()}`);
    assert.equal(leaderLossRequests(), 1, 'a leader-lost coordinator must not navigate the real browser');
    await client.close();
    // The worker must retain the last valid lease until its real minimum TTL expires.
    await new Promise((resolve) => setTimeout(resolve, 15_250));
    return active.generation;
  } catch (error) {
    console.error(`real coordinator diagnostics:\n${logs}`);
    throw error;
  } finally {
    await client.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      let result;
      try { result = await exited; } finally { clearTimeout(timer); }
      assert.deepEqual(result, [0, null], `real coordinator must shut down cleanly: ${logs}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  verify().catch((error) => { console.error(error); process.exitCode = 1; });
}
