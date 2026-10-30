import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, isolatedRun } from './process-host.mjs';
import { fleetLifecycleFixture } from './fleet-lifecycle-fixtures.mjs';
import { fleetBrowserFixture } from './fleet-browser-fixture.mjs';
import { verify as coordinatorBrowserFixture } from './coordinator-browser-fixture.mjs';
import { verify as nativeCliFixture } from './native-cli-suite.mjs';
import { agentFleetReference } from './agent-fleet-reference.mjs';

const nativeCli = join(ROOT, 'target/release', process.platform === 'win32' ? 'humanchrome-bridge.exe' : 'humanchrome-bridge');
const explicitToken = 'a1'.repeat(32);

export async function observeCli() {
  return isolatedRun(async (scope) => {
    const configPath = join(scope.env.HC_FLEET_ROOT, 'fleet.json');
    async function run(args, succeeds = true) {
      const child = scope.spawn(nativeCli, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      let code;
      try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
      const diagnostic = `Rust ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`;
      if (succeeds) assert.equal(code, 0, diagnostic);
      else assert.notEqual(code, 0, diagnostic);
      return { stdout, stderr, code };
    }
    const read = async () => JSON.parse(await readFile(configPath, 'utf8'));
    const initialOutput = await run(['fleet', 'init', '--gateway-port', String(scope.port), '--base-port', '12500']);
    const snippet = JSON.parse(initialOutput.stdout);
    assert.equal(snippet.mcpServers.humanchrome.url, `http://<mac-host>:${scope.port}/v1/pool/any/mcp`);
    assert.equal(snippet.mcpServers.humanchrome.headers.Authorization, undefined);
    let config = await read();
    assert.equal(config.token, null);
    assert.match(config.bridgeToken, /^[0-9a-f]{64}$/i);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    let bytes = await readFile(configPath, 'utf8');
    await run(['fleet', 'init'], false);
    assert.equal(await readFile(configPath, 'utf8'), bytes, 'reinitialization cannot replace credentials');
    const originalBridgeToken = config.bridgeToken;
    await run(['fleet', 'init', '--token', explicitToken]);
    config = await read();
    assert.equal(config.token, explicitToken);
    assert.equal(config.bridgeToken, originalBridgeToken);
    bytes = await readFile(configPath, 'utf8');
    assert.equal((await run(['fleet', 'init', '--print-token'])).stdout.trim(), `LAN token: ${explicitToken}`);
    assert.equal(await readFile(configPath, 'utf8'), bytes);
    await run(['fleet', 'init', '--token', 'invalid'], false);
    assert.equal(await readFile(configPath, 'utf8'), bytes, 'invalid credentials cannot mutate config');
    await run(['fleet', 'init', '--force-new-token']);
    config = await read();
    assert.notEqual(config.bridgeToken, originalBridgeToken);
    assert.notEqual(config.token, explicitToken);
    assert.match(config.token, /^[0-9a-f]{64}$/i);
    assert.equal(config.gateway.port, scope.port, 'rotation retains configured listener');
    const rotatedBridge = config.bridgeToken;
    await run(['fleet', 'init', '--token', 'none']);
    config = await read();
    assert.equal(config.token, null);
    assert.equal(config.bridgeToken, rotatedBridge);
    await run(['fleet', 'init', '--force-new-token', '--token', 'none']);
    config = await read();
    assert.equal(config.token, null, 'explicit open mode takes precedence after rotation');
    assert.notEqual(config.bridgeToken, rotatedBridge);

    await run(['fleet', 'node', 'add', 'peer-a', '127.0.0.1', '--port', '12901', '--token', 'private-peer-token']);
    let nodes = JSON.parse((await run(['fleet', 'node', 'ls'])).stdout);
    assert.deepEqual(nodes.nodes, [{ id: 'peer-a', host: '127.0.0.1', port: 12901 }], 'peer diagnostics must not expose credentials');
    await run(['fleet', 'node', 'add', 'peer-a', 'localhost', '--port', '12902']);
    config = await read();
    assert.deepEqual(config.nodes, [{ id: 'peer-a', host: 'localhost', port: 12902, token: '' }]);
    await run(['fleet', 'node', 'add', 'bad:id', 'localhost'], false);
    await run(['fleet', 'node', 'rm', 'peer-a']);
    assert.deepEqual((await read()).nodes, []);
    await run(['fleet', 'node', 'rm', 'peer-a'], false);

    // Persisted input, not a fake browser: these disabled profiles never launch Chrome.
    config = await read();
    config.profiles = [
      { name: 'fixture-a', port: 12500, labels: ['work'], enabled: false },
      { name: 'fixture-b', port: 12501, labels: [], enabled: false },
    ];
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    assert.deepEqual(JSON.parse((await run(['fleet', 'profile', 'ls'])).stdout), config.profiles);
    await run(['fleet', 'profile', 'enable', 'fixture-a']);
    assert.equal((await read()).profiles[0].enabled, true);
    await run(['fleet', 'profile', 'disable', 'fixture-a']);
    assert.equal((await read()).profiles[0].enabled, false);
    await run(['fleet', 'purpose', 'add', 'mail', 'fixture-a']);
    assert.equal((await read()).profiles[0].purpose, 'mail');
    await run(['fleet', 'purpose', 'add', 'mail', 'fixture-b'], false);
    const purposes = JSON.parse((await run(['fleet', 'purpose', 'ls', '--json'])).stdout);
    await run(['fleet', 'purpose', 'rm', 'mail']);
    assert.equal(Object.hasOwn((await read()).profiles[0], 'purpose'), false);
    await run(['fleet', 'down']);
    assert.equal((await read()).parked, true);
    await run(['fleet', 'up']);
    assert.equal((await read()).parked, false);
    const status = JSON.parse((await run(['fleet', 'status'])).stdout);
    assert.equal(status.serve, 'down');
    assert.equal(Object.hasOwn(status, 'leases'), false, 'offline status cannot claim an observed lease list');
    await run(['fleet', 'profile', 'rm', 'fixture-b']);
    assert.deepEqual((await read()).profiles.map((profile) => profile.name), ['fixture-a']);
    await run(['fleet', 'profile', 'verify', 'missing-profile'], false);
    await run(['fleet', 'node', 'add', 'peer-a', 'localhost', '--port', '0'], false);
    await run(['fleet', 'init', '--unknown'], false);
    config = await read();
    return {
      credentialTransitions: ['open', 'explicit', 'rotated', 'reopened', 'rotated-open'],
      profiles: config.profiles,
      nodes: config.nodes,
      parked: config.parked,
      purposes,
      status,
    };
  });
}

export async function verify() {
  const reference = await agentFleetReference();
  const { verify: coordinatorFixture } = await import('./fleet-coordinator-suite.mjs');
  const { verify: workerFixture } = await import('./worker-durability-fixture.mjs');
  const { verify: coordinatorStateFixture } = await import('./coordinator-state-safety-fixture.mjs');
  const { verify: peerFixture } = await import('./fleet-peer-fixture.mjs');
  await coordinatorFixture();
  await coordinatorStateFixture();
  await peerFixture();
  assert.deepEqual(await observeCli(), reference.fleetCli, 'fleet CLI diverged from the captured Node contract');
  await nativeCliFixture();
  for (const role of ['gateway', 'worker']) {
    assert.deepEqual(await fleetLifecycleFixture(role), reference.fleetLifecycle[role], `${role} lifecycle diverged from the captured Node contract`);
  }
  await workerFixture();
  await coordinatorBrowserFixture();
  await fleetBrowserFixture();
  console.log('PASS fleet CLI: Rust credential rotation/open-mode, peers, purposes, profile state and diagnostics');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  verify().catch((error) => { console.error(error); process.exitCode = 1; });
}
