import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, stat, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ROOT, allocatePort, isolatedRun } from './process-host.mjs';

const execFile = promisify(execFileCallback);
const agent = 'rust-worker-browser-fixture';
const firstLease = '11111111-1111-4111-8111-111111111111';
const staleLease = '22222222-2222-4222-8222-222222222222';
const recoveredLease = '33333333-3333-4333-8333-333333333333';
const readLease = '44444444-4444-4444-8444-444444444444';

/**
 * Proves the production worker's durable fencing semantics against a real
 * provisioned Chrome.  The smaller worker-durability fixture deliberately
 * remains the precise SQLite boundary test; this fixture makes no fake
 * supervisor or bridge substitution.
 */
export async function workerBrowserFixture({ beforeLeases } = {}) {
  assert.equal(process.platform, 'darwin', 'real worker browser proof requires macOS Chrome for Testing');
  return isolatedRun(async (scope) => {
    const cli = await requiredRealpath(process.env.HC_TEST_CLI_BIN ?? join(ROOT, 'target/release/humanchrome-bridge'), 'candidate fleet CLI');
    const native = await requiredRealpath(process.env.HC_TEST_NATIVE_BIN ?? join(ROOT, 'target/release/humanchrome-nativehost'), 'candidate native host');
    const chrome = process.env.HC_CHROME_PATH;
    assert(chrome, 'HC_CHROME_PATH must name an isolated-capable Chrome for Testing binary');
    scope.env.HC_TEST_NATIVE_BIN = native;

    const tailscaleHost = await localTailscaleIpv4();
    const workerRoot = join(scope.directory, 'worker-fleet');
    const fixture = createFixtureServer();
    const profilePorts = await reserveProfilePorts();
    let worker;
    let workerConfig;
    let profile;
    let workerBase;
    let bridgePort;
    try {
      // The temporary HOME owns all manifests.  This symlink only gives CfT
      // read access to the already-unlocked login Keychain; it cannot alter the
      // user's keychain search list, items, or native-host registration.
      const loginKeychain = JSON.parse(execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' }).trim());
      const keychainDirectory = join(scope.env.HOME, 'Library', 'Keychains');
      await mkdir(keychainDirectory, { recursive: true });
      await symlink(loginKeychain, join(keychainDirectory, 'login.keychain-db'));

      await fixture.listen();
      await runCommand(scope, cli, ['register', '--host-path', native, '--browser', 'chrome']);

      const workerPort = await allocatePort(tailscaleHost);
      // Keep the candidate bridge port reserved until the worker's initial
      // provisioning reaches Chrome, preventing an unrelated local listener
      // from being mistaken for a successful profile launch.
      await profilePorts.release(0);
      await runCommand(scope, cli, [
        'fleet', 'worker', 'init', 'rust-browser-worker',
        '--root', workerRoot,
        '--host', tailscaleHost,
        '--port', String(workerPort),
        '--base-port', String(profilePorts.basePort),
        '--seed-source', 'daily=null',
        '--allow-profile', 'fixture',
        '--chrome-path', chrome,
        '--extension-dir', process.env.HC_E2E_EXTENSION_DIR ?? join(ROOT, 'app/chrome-extension/.output/chrome-mv3'),
        '--host-path', native,
      ], true, 180_000);

      workerConfig = JSON.parse(await readFile(join(workerRoot, 'worker.json'), 'utf8'));
      assert.equal(workerConfig.host, tailscaleHost, 'worker must retain the local Tailscale bind identity');
      assert.equal(workerConfig.port, workerPort, 'worker must bind the dedicated allocated port');
      assert.deepEqual(workerConfig.profiles, ['browser', 'fixture'], 'worker enrollment must retain its owned browser plus configured allowlist');
      assert.equal((await stat(join(workerRoot, 'worker.json'))).mode & 0o777, 0o600, 'worker credentials must be owner-only');

      const fleet = JSON.parse(await readFile(join(workerRoot, 'fleet.json'), 'utf8'));
      profile = fleet.profiles.find((entry) => entry.name === 'browser');
      assert(profile, 'worker initialization must provision the owned browser profile');
      bridgePort = profile.port;
      const manifest = JSON.parse(await readFile(join(workerRoot, 'profiles/browser/NativeMessagingHosts/com.humanchrome.nativehost.json'), 'utf8'));
      assert.equal(manifest.path, native, 'worker profile must register the explicit candidate native host privately');

      // Provisioning closes its CDP pipes. Stop that bootstrap process explicitly so this
      // fixture proves the long-lived worker's own Chrome, not adoption of a closing browser.
      // External-process adoption is exercised by fleet-browser-fixture.mjs.
      await runCommand(scope, cli, ['fleet', 'stop', 'browser', '--root', workerRoot, '--host-path', native]);
      workerBase = `http://${tailscaleHost}:${workerPort}`;
      worker = await startWorker(scope, cli, native, workerRoot, workerBase, workerConfig.token);
      const initial = await waitFor(() => inventory(workerBase, workerConfig.token), (value) => value.profiles?.find((entry) => entry.name === 'browser')?.state === 'healthy', 'worker launches owned Chrome');
      const initialProfile = initial.profiles.find((entry) => entry.name === 'browser');
      const initialChromePid = initialProfile.pid;
      assert(Number.isInteger(initialChromePid), `worker browser must report its real Chrome PID: ${JSON.stringify(initialProfile)}`);
      assert.equal(Number(execFileSync('/bin/ps', ['-p', String(initialChromePid), '-o', 'ppid='], { encoding: 'utf8' }).trim()), worker.child.pid, 'worker must retain ownership of the browser process and its CDP pipes');

      const initialNative = await nativeInstance(workerRoot, bridgePort);
      assertCandidateNative(await processCommand(initialNative.pid), native);

      const generationFloor = beforeLeases ? await beforeLeases({
        scope, cli, workerConfig, workerBase, fixtureUrl: fixture.url,
        readFence: () => fence(workerRoot),
        leaderLossUrl: new URL('leader-loss', fixture.url).href,
        leaderLossRequests: () => fixture.leaderLossRequests(),
      }) : 0;
      assert(Number.isSafeInteger(generationFloor) && generationFloor >= 0 && generationFloor < Number.MAX_SAFE_INTEGER - 3);
      const firstGeneration = generationFloor + 1;
      const first = { leaseId: firstLease, generation: firstGeneration };
      await claim(workerBase, workerConfig.token, first);
      const started = await leased(workerBase, workerConfig.token, first, '/v1/worker/profiles/browser/start', { method: 'POST' });
      assert.equal(started.status, 200, `repeated worker start failed: ${await started.text()}`);
      assert.equal((await inventory(workerBase, workerConfig.token)).profiles.find((entry) => entry.name === 'browser').pid, initialChromePid, 'starting an already-running owned profile must not replace Chrome');
      const navigation = await tool(workerBase, workerConfig.token, first, 'chrome_navigate', { url: fixture.url });
      const tabId = navigation.tabId;
      assert.equal(typeof tabId, 'number', `worker navigation must return a real tab: ${JSON.stringify(navigation)}`);
      await tool(workerBase, workerConfig.token, first, 'chrome_wait_for', { tabId, kind: 'load_state', state: 'complete', timeoutMs: 15_000 });
      const beforeDisconnect = await tool(workerBase, workerConfig.token, first, 'chrome_javascript', {
        tabId,
        code: 'return { title: document.title, text: document.querySelector("#state").textContent };',
      });
      assert.deepEqual(JSON.parse(beforeDisconnect.result), { title: 'Rust worker browser fixture', text: 'ready' }, 'worker browser proxy must drive the fixture page');

      const requestAbort = new AbortController();
      const interrupted = rawToolRequest(workerBase, workerConfig.token, first, 'chrome_javascript', {
        tabId,
        code: 'return await (await fetch("/hold")).text();',
      }, requestAbort.signal);
      await waitFor(() => fixture.hasHeld(), Boolean, 'long-running browser action reaches the controlled fixture');
      requestAbort.abort();
      await assert.rejects(interrupted, (error) => error?.name === 'AbortError');
      await waitFor(() => fence(workerRoot), (row) => row?.inFlight > 0, 'disconnect must durably record uncertain mutation before worker death');

      // The client has disconnected after Chrome began the browser action.  A
      // hard worker death makes the next server prove that the durable marker,
      // rather than process memory, fences the outcome.
      await stopWorker(worker, 'SIGKILL');
      worker = undefined;
      worker = await startWorker(scope, cli, native, workerRoot, workerBase, workerConfig.token);
      await waitFor(() => inventory(workerBase, workerConfig.token), (value) => value.profiles?.find((entry) => entry.name === 'browser')?.state === 'healthy', 'restarted worker adopts Chrome after disconnected mutation');

      await expectError(
        rawToolRequest(workerBase, workerConfig.token, first, 'chrome_javascript', { tabId, code: 'return "must not run";' }),
        409,
        'outcome_unknown',
        'unresolved mutation must reject later browser work',
      );
      await expectError(release(workerBase, workerConfig.token, first), 409, 'profile_busy', 'unresolved mutation must reject release');
      await expectError(claimResponse(workerBase, workerConfig.token, { leaseId: staleLease, generation: firstGeneration }), 409, 'stale_lease', 'same generation with another UUID cannot cross the durable fence');
      await expectError(claimResponse(workerBase, workerConfig.token, { leaseId: recoveredLease, generation: firstGeneration + 1 }), 409, 'lease_conflict', 'live uncertain lease cannot be reassigned');

      // Worker recovery is intentionally administrative and cannot clear a
      // still-live lease.  Let the required minimum TTL expire rather than
      // editing the worker's SQLite state.
      await new Promise((resolve) => setTimeout(resolve, 15_250));
      const expired = await release(workerBase, workerConfig.token, first);
      await expectResponseError(expired, 409, 'stale_lease', 'expired owner cannot release uncertain work');

      const beforeRecovery = await waitFor(() => inventory(workerBase, workerConfig.token), (value) => value.profiles?.find((entry) => entry.name === 'browser')?.state === 'healthy', 'live browser before explicit recovery');
      const beforeRecoveryPid = beforeRecovery.profiles.find((entry) => entry.name === 'browser').pid;
      assert.equal(await processExists(beforeRecoveryPid), true, 'recovery must replace a currently live browser, not only an old PID');
      const recovery = await authenticated(workerBase, workerConfig.token, '/v1/worker/profiles/browser/recover', { method: 'POST' });
      assert.equal(recovery.status, 200, `explicit recovery must replace the owned Chrome: ${await recovery.text()}`);
      const recovered = await waitFor(() => inventory(workerBase, workerConfig.token), (value) => {
        const browser = value.profiles?.find((entry) => entry.name === 'browser');
        return browser?.state === 'healthy' && Number.isInteger(browser.pid) && browser.pid !== beforeRecoveryPid;
      }, 'recovery replaces the worker-owned Chrome', 180_000);
      const recoveredProfile = recovered.profiles.find((entry) => entry.name === 'browser');
      await waitFor(() => processExists(beforeRecoveryPid), (alive) => !alive, 'recovery terminates the immediately preceding owned Chrome', 30_000);
      assert.equal((await fence(workerRoot)).inFlight, 0, 'successful recovery must clear durable uncertainty only after Chrome replacement');
      const recoveredNative = await nativeInstance(workerRoot, bridgePort);
      assertCandidateNative(await processCommand(recoveredNative.pid), native);

      const second = { leaseId: recoveredLease, generation: firstGeneration + 1 };
      await claim(workerBase, workerConfig.token, second);
      const recoveredNavigation = await tool(workerBase, workerConfig.token, second, 'chrome_navigate', { url: fixture.url });
      const recoveredTab = recoveredNavigation.tabId;
      await tool(workerBase, workerConfig.token, second, 'chrome_wait_for', { tabId: recoveredTab, kind: 'load_state', state: 'complete', timeoutMs: 15_000 });
      await tool(workerBase, workerConfig.token, second, 'chrome_javascript', { tabId: recoveredTab, code: 'document.querySelector("#state").textContent = "recovered"; return document.querySelector("#state").textContent;' });
      const recoveredState = await tool(workerBase, workerConfig.token, second, 'chrome_javascript', { tabId: recoveredTab, code: 'return document.querySelector("#state").textContent;' });
      assert.equal(recoveredState.result, 'recovered', 'new fenced browser action must run after real recovery');
      await tool(workerBase, workerConfig.token, second, 'chrome_cookies', {
        action: 'set', url: fixture.url, name: 'rust_worker_owned_shutdown',
        value: 'retained', path: '/', sameSite: 'lax',
      });
      const repeatedStart = await leased(workerBase, workerConfig.token, second, '/v1/worker/profiles/browser/start', { method: 'POST' });
      assert.equal(repeatedStart.status, 200, `repeated owned start failed: ${await repeatedStart.text()}`);
      assert.equal((await inventory(workerBase, workerConfig.token)).profiles.find((entry) => entry.name === 'browser').pid, recoveredProfile.pid);
      const released = await release(workerBase, workerConfig.token, second);
      assert.equal(released.status, 204, `recovered lease must release: ${await released.text()}`);

      const read = { leaseId: readLease, generation: firstGeneration + 2 };
      await claim(workerBase, workerConfig.token, read);
      const lostRead = await leased(workerBase, workerConfig.token, read, '/v1/worker/profiles/browser/browser/api/tools', { method: 'GET' });
      if (lostRead.status !== 200) throw new Error(`worker read proxy ${lostRead.status}: ${await lostRead.text()}`);
      await lostRead.body?.cancel();
      await waitFor(() => fence(workerRoot), (row) => row?.inFlight === 0, 'lost read must not create durable uncertainty');
      const readReleased = await waitFor(async () => {
        const response = await release(workerBase, workerConfig.token, read);
        if (response.status !== 204) await response.text();
        return response;
      }, (response) => response.status === 204, 'lost read lease release');
      assert.equal(readReleased.status, 204, `lost read must leave the lease releasable: ${await readReleased.text()}`);

      const workerPid = worker.child.pid;
      assert.equal(worker.child.exitCode, null, 'worker must remain live until the requested shutdown');
      await stopWorker(worker, 'SIGTERM');
      assert.equal(worker.child.exitCode, 0, `owned shutdown must finish without forced cleanup\n${worker.logs()}`);
      worker = undefined;
      const snapshot = JSON.parse(await readFile(join(workerRoot, 'profiles/browser/.hc-session.json'), 'utf8'));
      assert(snapshot.cookies.some((cookie) => cookie.name === 'rust_worker_owned_shutdown' && cookie.value === 'retained'),
        'starting an already-running profile must retain CDP ownership for the shutdown session snapshot');
      return {
        workerPid,
        chromePid: recoveredProfile.pid,
        nativePid: recoveredNative.pid,
        fence: await fence(workerRoot),
      };
    } catch (error) {
      if (worker) console.error(`worker diagnostics:\n${worker.logs()}`);
      if (bridgePort) {
        try {
          const response = await fetch(`http://127.0.0.1:${bridgePort}/ping`, { signal: AbortSignal.timeout(2_000) });
          console.error(`bridge after failure: ${response.status} ${await response.text()}`);
        } catch (probeError) {
          console.error('bridge after failure:', probeError);
        }
      }
      throw error;
    } finally {
      fixture.releaseHold();
      if (worker) await stopWorker(worker, 'SIGTERM');
      await stopOwnedBrowsers(scope, workerRoot);
      await profilePorts.release();
      await fixture.close();
    }
  });
}

async function requiredRealpath(path, description) {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`missing ${description}: ${path}`);
  }
  return realpath(path);
}

async function localTailscaleIpv4() {
  let stdout;
  try {
    ({ stdout } = await execFile('tailscale', ['ip', '-4']));
  } catch (error) {
    throw new Error(`worker browser fixture requires a local Tailscale IPv4 address (tailscale ip -4 failed: ${error.message})`);
  }
  const addresses = stdout.trim().split(/\s+/).filter((value) => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(value));
  assert.equal(addresses.length, 1, `expected exactly one local Tailscale IPv4 address, got ${stdout.trim() || '(none)'}`);
  return addresses[0];
}

function createFixtureServer() {
  let held;
  let leaderLossCount = 0;
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/leader-loss?')) leaderLossCount += 1;
    if (request.url === '/hold') {
      held = response;
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Rust worker browser fixture</title><p id="state">ready</p>');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    get url() {
      const address = server.address();
      assert(address && typeof address !== 'string', 'fixture server must be listening');
      return `http://127.0.0.1:${address.port}/`;
    },
    async listen() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
    },
    hasHeld() {
      return held !== undefined;
    },
    leaderLossRequests() {
      return leaderLossCount;
    },
    releaseHold() {
      if (held && !held.writableEnded) held.end('released');
      held = undefined;
    },
    async close() {
      this.releaseHold();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function runCommand(scope, cli, args, succeeds = true, deadline = 30_000) {
  const child = scope.spawn(cli, args);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
  let code;
  try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
  const diagnostic = `${args.join(' ')}: exit ${code}\n${stdout}\n${stderr}`;
  if (succeeds) assert.equal(code, 0, diagnostic);
  else assert.notEqual(code, 0, diagnostic);
  return { stdout, stderr, code };
}

async function startWorker(scope, cli, native, root, base, token) {
  const child = scope.spawn(cli, ['fleet', 'worker', 'serve', '--root', root, '--host-path', native]);
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const exited = once(child, 'exit');
  try {
    await waitFor(() => inventory(base, token), (value) => Array.isArray(value.profiles), 'worker HTTP startup');
  } catch (error) {
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  }
  return { child, exited, logs: () => logs };
}

async function stopWorker(worker, signal) {
  if (!worker?.child.pid || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill(signal);
  const timer = setTimeout(() => worker.child.kill('SIGKILL'), 15_000);
  try { await worker.exited; } finally { clearTimeout(timer); }
}

async function inventory(base, token) {
  const response = await authenticated(base, token, '/v1/worker');
  if (response.status !== 200) assert.fail(`worker inventory failed: ${await response.text()}`);
  return response.json();
}

function claimResponse(base, token, lease) {
  return authenticated(base, token, '/v1/worker/profiles/browser/lease', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, leaseId: lease.leaseId, generation: lease.generation, ttlSec: 15 }),
  });
}

async function claim(base, token, lease) {
  const response = await claimResponse(base, token, lease);
  assert.equal(response.status, 200, `claim generation ${lease.generation} failed: ${await response.text()}`);
}

function release(base, token, lease) {
  return leased(base, token, lease, '/v1/worker/profiles/browser/lease', { method: 'DELETE' });
}

async function tool(base, token, lease, name, args) {
  const response = await rawToolRequest(base, token, lease, name, args);
  if (response.status !== 200) assert.fail(`worker ${name} failed: ${await response.text()}`);
  const result = await response.json();
  assert.notEqual(result.isError, true, `worker ${name} tool result: ${JSON.stringify(result)}`);
  const text = result.content?.find((block) => block.type === 'text')?.text;
  assert(text, `worker ${name} omitted JSON text: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

function rawToolRequest(base, token, lease, name, args, signal) {
  return leased(base, token, lease, `/v1/worker/profiles/browser/browser/api/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
    signal,
  });
}

function authenticated(base, token, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetch(`${base}${path}`, { signal: AbortSignal.timeout(125_000), ...init, headers });
}

function leased(base, token, lease, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-humanchrome-lease', lease.leaseId);
  headers.set('x-humanchrome-agent', agent);
  headers.set('x-humanchrome-generation', String(lease.generation));
  return authenticated(base, token, path, { ...init, headers });
}

async function expectError(responsePromise, status, error, context) {
  const response = await responsePromise;
  await expectResponseError(response, status, error, context);
}

async function expectResponseError(response, status, error, context) {
  const body = await response.json();
  assert.equal(response.status, status, `${context}: ${JSON.stringify(body)}`);
  assert.equal(body.error, error, `${context}: ${JSON.stringify(body)}`);
}

async function nativeInstance(root, port) {
  return waitFor(async () => {
    for (const file of await readdir(join(root, 'registry', 'instances'))) {
      if (!file.endsWith('.json')) continue;
      const record = JSON.parse(await readFile(join(root, 'registry', 'instances', file), 'utf8'));
      if (record.port === port && Number.isInteger(record.pid)) return record;
    }
    return null;
  }, Boolean, 'candidate native bridge registry');
}

function fence(root) {
  const database = new DatabaseSync(join(root, 'worker-fences.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare('SELECT generation, lease_id AS leaseId, released, in_flight AS inFlight FROM worker_fences WHERE profile = ?').get('browser');
    return row && { ...row, released: Boolean(row.released) };
  } finally {
    database.close();
  }
}

async function processCommand(pid) {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
}
function assertCandidateNative(command, native) {
  assert(command === native || command.startsWith(`${native} `), `worker browser must execute the candidate native host directly: ${command}`);
}


async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(read, accept, description, deadlineMs = 30_000, delayMs = 100) {
  const deadline = Date.now() + deadlineMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${description}: ${JSON.stringify(last)}`);
}

async function reserveProfilePorts() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const basePort = randomInt(20_000, 30_000);
    const listeners = [];
    const release = async (index) => {
      const selected = index === undefined ? listeners : [listeners[index]];
      await Promise.all(selected.map((listener) => !listener?.listening ? undefined
        : new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))));
    };
    try {
      const listener = createNetServer((socket) => socket.destroy());
      listeners.push(listener);
      listener.listen(basePort, '127.0.0.1');
      await once(listener, 'listening');
      return { basePort, release };
    } catch (error) {
      await release();
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no isolated profile port available');
}

async function stopOwnedBrowsers(scope, root) {
  const roots = [root, await realpath(root).catch(() => root)];
  async function owned() {
    const listing = scope.spawn('/bin/ps', ['-axo', 'pid=,command=']);
    let rows = '';
    listing.stdout.on('data', (chunk) => { rows += chunk; });
    await once(listing, 'exit');
    return rows.split('\n').flatMap((row) => {
      const match = row.trim().match(/^(\d+)\s+(.*)$/);
      return match && !match[2].includes('--type=') && roots.some((candidate) => match[2].includes(`--user-data-dir=${candidate}/profiles/`))
        ? [Number(match[1])] : [];
    });
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of await owned()) {
      try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    try {
      await waitFor(owned, (pids) => pids.length === 0, `owned Chrome shutdown (${signal})`, 10_000);
      break;
    } catch {
      // SIGTERM is graceful; use SIGKILL before isolatedRun removes profiles.
    }
  }
  assert.deepEqual(await owned(), [], 'owned Chrome must exit before isolated profile deletion');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  workerBrowserFixture().then(
    () => console.log('PASS fleet worker browser: isolated real Chrome fencing, recovery, and lost-read behavior'),
    (error) => { console.error(error); process.exitCode = 1; },
  );
}
