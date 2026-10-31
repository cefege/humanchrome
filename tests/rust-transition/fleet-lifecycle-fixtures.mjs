import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, allocatePort, isolatedRun } from './process-host.mjs';
import { observeProtocolEndpoint } from './native-protocol-fixtures.mjs';

const nativeCli = process.env.HC_TEST_CLI_BIN ?? join(ROOT, 'target/release', process.platform === 'win32' ? 'humanchrome-bridge.exe' : 'humanchrome-bridge');
const token = 'cd'.repeat(32);

export async function fleetLifecycleFixture(role) {
  return isolatedRun(async (scope) => {
    const worker = role === 'worker';
    const host = worker ? execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim() : '127.0.0.1';
    if (worker) assert.match(host, /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, 'worker proof requires the local private bind identity');
    const port = worker ? await allocatePort(host) : scope.port;
    const serveArgs = worker ? ['fleet', 'worker', 'serve'] : ['fleet', 'serve'];
    const spawnCli = (args) => scope.spawn(nativeCli, args);
    async function command(args, expectedSuccess = true) {
      const child = spawnCli(args);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      let code;
      let signal;
      try { [code, signal] = await once(child, 'exit'); } finally { clearTimeout(timer); }
      assert.equal(signal, null, `rust ${args.join(' ')} must terminate without forced cleanup: ${output}`);
      if (expectedSuccess) assert.equal(code, 0, `rust ${args.join(' ')}: ${output}`);
      else assert.notEqual(code, 0, `rust unexpected competing supervisor: ${output}`);
      return output;
    }
    await command(['fleet', 'init', '--gateway-port', String(scope.port)]);
    const configPath = join(scope.env.HC_FLEET_ROOT, 'fleet.json');
    const pidPath = join(scope.env.HC_FLEET_ROOT, 'run', worker ? 'worker.pid' : 'serve.pid');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.gateway.host = '127.0.0.1';
    config.token = token;
    config.parked = true;
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    if (worker) await writeFile(join(scope.env.HC_FLEET_ROOT, 'worker.json'), JSON.stringify({
      id: 'isolated-worker', host, port, token, profiles: ['browser', 'reload-fixture'], seedSources: { empty: null },
    }), { mode: 0o600 });
    const base = `http://${host}:${port}`;
    const inventoryPath = worker ? '/v1/worker' : '/v1/profiles';
    const headers = { authorization: `Bearer ${token}` };
    async function profiles() {
      const response = await fetch(`${base}${inventoryPath}`, { headers, signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      const body = await response.json();
      return worker ? body.profiles : body;
    }
    async function until(read, condition, detail) {
      const deadline = Date.now() + 15_000;
      let last;
      while (Date.now() < deadline) {
        try { last = await read(); if (condition(last)) return last; } catch (error) { last = error.message; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`rust ${detail}: ${JSON.stringify(last)}`);
    }
    async function start() {
      const child = spawnCli(serveArgs);
      let logs = '';
      child.stdout.on('data', (chunk) => { logs += chunk; });
      child.stderr.on('data', (chunk) => { logs += chunk; });
      const exited = once(child, 'exit');
      try { await until(profiles, (rows) => Array.isArray(rows), `${role} startup`); }
      catch (error) { throw new Error(`${error.message}\n${logs}`, { cause: error }); }
      return { child, exited, logs: () => logs };
    }
    async function stop(server, signal) {
      server.child.kill(signal);
      const timer = setTimeout(() => server.child.kill('SIGKILL'), 10_000);
      let code;
      let exitSignal;
      try { [code, exitSignal] = await server.exited; } finally { clearTimeout(timer); }
      assert.equal(code, 0, `rust ${signal}: ${exitSignal}\n${server.logs()}`);
      await assert.rejects(stat(pidPath), { code: 'ENOENT' });
    }
    if (worker) {
      config.profiles = [{ name: 'not-allowed', port: 12501, labels: [], enabled: false }];
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      try {
        await command(serveArgs, false);
        await assert.rejects(stat(pidPath), { code: 'ENOENT' });
      } finally {
        config.profiles = [];
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      }
    }
    let server = await start();
    assert.deepEqual(await profiles(), []);
    assert.equal(Number(await readFile(pidPath, 'utf8')), server.child.pid);
    const rootLockPath = join(scope.env.HC_FLEET_ROOT, 'run', 'fleet-root-lock.sqlite');
    const contender = new DatabaseSync(rootLockPath);
    try {
      assert.throws(() => contender.exec('BEGIN EXCLUSIVE'), (error) => error.errcode === 5,
        'rust must hold the legacy SQLite root lock, not only a PID file');
    } finally {
      contender.close();
    }
    const denied = await fetch(`${base}${inventoryPath}`, { signal: AbortSignal.timeout(1000) });
    assert.equal(denied.status, 401);
    const protocol = worker ? undefined : await observeProtocolEndpoint(`${base}/v1/fleet/mcp`, headers);
    await command(serveArgs, false);
    if (worker) await command(['fleet', 'serve'], false);
    assert.deepEqual(await profiles(), [], 'failed duplicate startup must leave the owning service intact');
    config.profiles = [{ name: 'reload-fixture', port: 12500, labels: ['reloaded'], enabled: false }];
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    server.child.kill('SIGHUP');
    const reloaded = await until(profiles, (rows) => rows.some((row) => row.name === 'reload-fixture'), 'SIGHUP config reload');
    assert.equal(reloaded[0].state, 'stopped');
    assert.deepEqual(reloaded[0].labels, ['reloaded']);
    const rejectedReload = once(server.child.stderr, 'data', { signal: AbortSignal.timeout(5000) });
    await writeFile(configPath, '{');
    server.child.kill('SIGHUP');
    await rejectedReload;
    assert.equal(server.child.exitCode, null, 'malformed reload must not terminate the owning service');
    assert.equal((await profiles())[0].name, 'reload-fixture', 'malformed reload must preserve the last validated inventory');
    config.profiles[0].labels = ['after-error'];
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    server.child.kill('SIGHUP');
    await until(profiles, (rows) => rows[0]?.labels.includes('after-error'), 'valid reload after malformed configuration');
    if (!worker) await command(['fleet', 'stop', 'reload-fixture']);
    assert.equal(Number(await readFile(pidPath, 'utf8')), server.child.pid, 'lifecycle forwarding cannot replace the owner');
    await stop(server, 'SIGTERM');
    const legacyLock = new DatabaseSync(rootLockPath);
    legacyLock.exec('BEGIN EXCLUSIVE');
    try {
      await command(serveArgs, false);
      await assert.rejects(stat(pidPath), { code: 'ENOENT' });
    } finally {
      legacyLock.exec('COMMIT');
      legacyLock.close();
    }
    server = await start();
    await stop(server, 'SIGINT');
    return { authorized: true, unauthenticatedStatus: denied.status, duplicateRefused: true, ...(protocol ? { protocol } : {}), reloaded: reloaded.map(({ name, labels, enabled, state }) => ({ name, labels, enabled, state })), shutdown: ['SIGTERM', 'SIGINT'] };
  });
}

 
