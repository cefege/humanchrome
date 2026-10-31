import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, captureProcess, isolatedRun } from './process-host.mjs';
import { agentFleetReference } from './agent-fleet-reference.mjs';

const gatewayToken = 'ab'.repeat(32);
const peerToken = 'ef'.repeat(32);

export async function verify() {
  const reference = await agentFleetReference();
  assert.deepEqual(await exercise(), reference.fleetPeer, 'gateway peer authentication, pool routing and cross-agent exclusion diverged from the captured Node contract');
  console.log('PASS gateway federation: authenticated remote inventory, qualified/pool routing, exclusive leases, release/handoff and no action redirect/replay');
}

async function exercise() {
  return isolatedRun(async (scope) => {
    const binary = process.env.HC_TEST_CLI_BIN ?? join(ROOT, 'target/release/humanchrome-bridge');
    await captureProcess(binary, ['fleet', 'init', '--gateway-port', String(scope.port)], scope);
    let actions = 0;
    let redirects = 0;
    let unauthorized = 0;
    const sockets = new Set();
    const peer = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${peerToken}`) {
        unauthorized += 1;
        response.writeHead(401).end();
        return;
      }
      if (request.url === '/v1/profiles') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
          { name: 'remote', port: 12501, enabled: true, labels: ['research'], purpose: 'reader', state: 'healthy' },
        ]));
      } else if (request.url === '/v1/node/remote/api/tools/click') {
        request.resume();
        request.once('end', () => {
          actions += 1;
          response.writeHead(303, { location: '/redirect-target' }).end();
        });
      } else if (request.url === '/redirect-target') {
        redirects += 1;
        response.writeHead(200).end();
      } else if (request.url === '/v1/leases/agent-a') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"released":1}');
      } else {
        response.writeHead(404).end();
      }
    });
    peer.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    peer.listen(0, '127.0.0.1');
    await once(peer, 'listening');
    let server;
    let exited;
    let logs = '';
    try {
      const configPath = join(scope.env.HC_FLEET_ROOT, 'fleet.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.gateway.host = '127.0.0.1';
      config.token = gatewayToken;
      config.parked = true;
      config.nodes = [{ id: 'peer-a', host: '127.0.0.1', port: peer.address().port, token: peerToken }];
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      server = scope.spawn(binary, ['fleet', 'serve']);
      exited = once(server, 'exit');
      for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { logs += chunk; });
      const base = `http://127.0.0.1:${scope.port}`;
      const headers = (agent) => ({ authorization: `Bearer ${gatewayToken}`, 'x-humanchrome-agent': agent });
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (Date.now() < deadline) {
        assert.equal(server.exitCode, null, `rust gateway exited during startup: ${logs}`);
        try {
          const response = await fetch(`${base}/v1/profiles`, { headers: headers('agent-a'), signal: AbortSignal.timeout(1_000) });
          const profiles = await response.json();
          ready = response.ok && profiles.some((profile) => profile.name === 'peer-a:remote' && profile.state === 'healthy');
          if (ready) break;
        } catch { /* Inventory readiness only; never retry browser actions. */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(ready, `Rust gateway did not discover its authenticated peer: ${logs}`);
      async function action(path, agent) {
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: headers(agent), redirect: 'manual', signal: AbortSignal.timeout(5_000) });
        await response.arrayBuffer();
        return response;
      }
      const named = '/v1/profiles/peer-a:remote/api/tools/click';
      const first = await action(named, 'agent-a');
      assert.equal(first.status, 303, 'qualified remote action must preserve redirect rather than replay it');
      assert.equal(actions, 1);
      assert.equal(redirects, 0, 'gateway must not follow the action redirect');
      const blocked = await action(named, 'agent-b');
      assert.equal(blocked.status, 409, 'another agent cannot steal the remote profile');
      assert.equal(actions, 1, 'rejected cross-agent action must not reach the peer');
      const pooled = await action('/v1/pool/research/api/tools/click', 'agent-a');
      assert.equal(pooled.status, 303, 'label pool must retain the same agent-owned remote profile');
      assert.equal(actions, 2);
      const released = await fetch(`${base}/v1/leases/agent-a`, { method: 'DELETE', headers: headers('agent-a'), signal: AbortSignal.timeout(5_000) });
      await released.arrayBuffer();
      assert.equal(released.status, 200);
      const handoff = await action(named, 'agent-b');
      assert.equal(handoff.status, 303, 'explicit release must allow a different agent to acquire the remote profile');
      assert.equal(actions, 3, 'each accepted mutation must reach the peer exactly once');
      assert.equal(redirects, 0);
      assert.equal(unauthorized, 0, 'federation must use the configured peer credential, not caller or bridge credentials');
      return { first: first.status, blocked: blocked.status, pooled: pooled.status, handoff: handoff.status, actions, redirects };
    } finally {
      if (server?.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM');
        const timer = setTimeout(() => server.kill('SIGKILL'), 10_000);
        let result;
        try { result = await exited; } finally { clearTimeout(timer); }
        assert.deepEqual(result, [0, null], `rust gateway did not exit cleanly: ${logs}`);
      }
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => peer.close((error) => error ? reject(error) : resolve()));
    }
  });
}

 

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  verify().catch((error) => { console.error(error); process.exitCode = 1; });
}
