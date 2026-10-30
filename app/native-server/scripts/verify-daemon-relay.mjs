#!/usr/bin/env node
/**
 * IMP-0120 live verification.
 *
 * Spawns real bridge processes (not mocks) in an isolated registry dir
 * and walks the regression scenario end-to-end:
 *
 *   1. Spawn bridge1. Its disposable Native Messaging process starts the
 *      detached daemon and forwards a length-prefixed START frame. Verify
 *      the daemon HTTP owner responds to /ping.
 *   2. Close bridge1's stdin (simulating Chrome terminating its native host
 *      during SW reload). Bridge1 exits, but the detached daemon and /ping
 *      remain available with exactly one registry owner.
 *   3. Spawn bridge2 against the same isolated registry. It becomes a relay
 *      and forwards a fresh START frame to the existing daemon.
 *   4. Verify the existing HTTP owner and its native request state survive
 *      the relay replacement with a real request/response round trip.
 *
 * Exits 0 on success, non-zero with diagnostics on failure.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NATIVE_BIN = resolve(HERE, '..', '..', '..', 'target', 'release', `humanchrome-nativehost${process.platform === 'win32' ? '.exe' : ''}`);
const TEST_NATIVE_BIN = process.env.HC_TEST_NATIVE_BIN;

function bridgeCommand() {
  const candidate = resolve(TEST_NATIVE_BIN ?? DEFAULT_NATIVE_BIN);
  if (!existsSync(candidate)) {
    throw new Error(`native host executable does not exist: ${candidate}; run pnpm build:native or set HC_TEST_NATIVE_BIN`);
  }
  return { command: candidate, args: [] };
}

const tmp = mkdtempSync(join(tmpdir(), 'hc-verify-'));
const registryDir = join(tmp, 'instances');
const socketPath = join(tmp, 'bridge-daemon.sock');
const port = 13900 + Math.floor(Math.random() * 1000);
const home = join(tmp, 'home');
const runtime = join(tmp, 'runtime');
const agentDataDir = join(runtime, 'agent-data');
const fleetRoot = join(runtime, 'fleet');
mkdirSync(home, { recursive: true });
mkdirSync(registryDir, { recursive: true });
mkdirSync(agentDataDir, { recursive: true });
mkdirSync(fleetRoot, { recursive: true });


const procs = [];
function detachedOwners() {
  if (!existsSync(registryDir)) return [];
  return readdirSync(registryDir)
    .filter((entry) => entry.endsWith('.json'))
    .flatMap((entry) => {
      try {
        const record = JSON.parse(readFileSync(join(registryDir, entry), 'utf8'));
        return record.port === port && Number.isInteger(record.pid) ? [record.pid] : [];
      } catch {
        return [];
      }
    });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertSingleDetachedOwner(relayPid) {
  const owners = detachedOwners();
  if (owners.length !== 1 || owners[0] === relayPid || !processAlive(owners[0])) {
    throw new Error(`expected one live detached daemon owner, received ${JSON.stringify(owners)}`);
  }
  return owners[0];
}

function stopDetachedOwners() {
  for (const pid of detachedOwners()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* The isolated owner may already have exited. */
    }
  }
}

function cleanup() {
  stopDetachedOwners();
  for (const p of procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`native relay did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

function spawnBridge(name) {
  const { command, args } = bridgeCommand();
  const child = spawn(command, args, {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      HC_DISABLE_DAEMON: '0',
      HC_BRIDGE_PORT: String(port),
      HUMANCHROME_PORT: String(port),
      HUMANCHROME_URL: '',
      HUMANCHROME_TOKEN: '',
      MCP_HTTP_PORT: String(port),
      MCP_ALLOWED_WORKSPACE_BASE: home,
      MCP_AGENT_PROJECT_ROOT: home,
      CHROME_MCP_AGENT_DB_FILE: join(runtime, 'agent.db'),
      CHROME_MCP_AGENT_DATA_DIR: agentDataDir,
      HC_FLEET_ROOT: fleetRoot,
      HC_FLEET_PROFILE: '',
      HC_COORDINATOR_DATABASE_URL: '',
      HC_CHROME_BINARY: '',
      HC_INSTANCE_REGISTRY_DIR: registryDir,
      HC_BRIDGE_DAEMON_SOCKET: socketPath,
      HC_DAEMON_IDLE_TIMEOUT_MS: '600000', // 10 min so the daemon doesn't time out during the test
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name} stderr] ${chunk}`));
  procs.push(child);
  return child;
}

function framed(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function collectFramed(stream, onFrame) {
  let buf = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        onFrame(JSON.parse(body.toString()));
      } catch (err) {
        console.error('[verify] failed to parse frame:', err.message);
      }
    }
  });
}

async function ping(p) {
  const res = await fetch(`http://127.0.0.1:${p}/ping`, { signal: AbortSignal.timeout(2000) });
  return res.ok ? await res.json() : null;
}

async function main() {
  console.log(`[verify] tmp=${tmp}`);
  console.log(`[verify] socketPath=${socketPath}`);
  console.log(`[verify] port=${port}`);

  // 1. Spawn bridge1, start the detached daemon, and send START through it.
  console.log('[verify] step 1: spawn bridge1 (starts detached daemon)');
  const b1 = spawnBridge('bridge1');
  const b1Frames = [];
  collectFramed(b1.stdout, (f) => b1Frames.push(f));

  b1.stdin.write(
    framed({
      type: 'start',
      payload: { port, extensionId: 'verify-ext', instanceId: 'verify-inst-1' },
    }),
  );

  // Wait for SERVER_STARTED frame.
  let waited = 0;
  while (waited < 5000) {
    if (b1Frames.some((f) => f.type === 'server_started')) break;
    await sleep(100);
    waited += 100;
  }
  if (!b1Frames.some((f) => f.type === 'server_started')) {
    console.error('[verify] FAIL: bridge1 did not emit server_started within 5s');
    console.error('[verify] frames received:', JSON.stringify(b1Frames, null, 2));
    process.exit(1);
  }
  console.log('[verify] ✓ bridge1 emitted server_started');

  const probe1 = await ping(port);
  if (!probe1 || probe1.status !== 'ok') {
    console.error('[verify] FAIL: /ping did not return ok after start');
    process.exit(1);
  }
  console.log('[verify] ✓ /ping returned ok on initial source');

  // 2. Chrome can terminate its Native Messaging child on reload. The
  // disposable relay must exit without taking the detached HTTP owner down.
  console.log('[verify] step 2: close bridge1 stdin (simulate Chrome reload)');
  b1.stdin.end();
  await waitForExit(b1, 5_000);
  if (b1.exitCode === null && b1.signalCode === null) {
    console.error('[verify] FAIL: bridge1 did not exit after native input closed');
    process.exit(1);
  }
  console.log('[verify] ✓ bridge1 exited after stdin close');

  let daemonPid;
  try {
    daemonPid = assertSingleDetachedOwner(b1.pid);
  } catch (error) {
    console.error(`[verify] FAIL: ${error.message}`);
    process.exit(1);
  }
  console.log(`[verify] ✓ detached daemon owner ${daemonPid} survived bridge1 exit`);

  const probe2 = await ping(port);
  if (!probe2 || probe2.status !== 'ok') {
    console.error('[verify] FAIL: /ping did not return ok after Chrome-style relay exit');
    process.exit(1);
  }
  console.log('[verify] ✓ /ping still returned ok after relay exit');

  // 3. Spawn bridge2 as the replacement relay.
  console.log('[verify] step 3: spawn bridge2 (replacement relay)');
  const b2 = spawnBridge('bridge2');
  const b2Frames = [];
  collectFramed(b2.stdout, (f) => b2Frames.push(f));

  // The relay shuttles stdin to daemon UDS — the daemon processes the START
  // and reports SERVER_STARTED back. The bridge2's stdout carries the
  // daemon's response, framed.
  b2.stdin.write(
    framed({
      type: 'start',
      payload: { port, extensionId: 'verify-ext', instanceId: 'verify-inst-2' },
    }),
  );

  waited = 0;
  while (waited < 5000) {
    // Daemon already running → it replies with `error: Server is already running`
    // OR `server_started`. Either confirms the relay round-trips bytes.
    if (b2Frames.length > 0) break;
    await sleep(100);
    waited += 100;
  }
  if (b2Frames.length === 0) {
    console.error('[verify] FAIL: bridge2 (relay) did not receive any frame from daemon');
    process.exit(1);
  }
  console.log(
    `[verify] ✓ bridge2 received frame from daemon via relay: ${JSON.stringify(b2Frames[0])}`,
  );

  // Make the recovered source answer a real request routed through the
  // primary's HTTP server, rather than treating a START acknowledgement as
  // sufficient evidence that relay traffic works in both directions.
  const requestAbort = new AbortController();
  const relayRequest = fetch(`http://127.0.0.1:${port}/ask-extension?probe=relay`, {
    signal: requestAbort.signal,
  });
  waited = 0;
  let forwarded;
  while (waited < 5000) {
    forwarded = b2Frames.find((frame) => frame.type === 'process_data' && frame.requestId);
    if (forwarded) break;
    await sleep(100);
    waited += 100;
  }
  if (!forwarded) {
    requestAbort.abort();
    console.error('[verify] FAIL: bridge2 did not receive the relayed process_data request');
    process.exit(1);
  }
  b2.stdin.write(
    framed({ responseToRequestId: forwarded.requestId, payload: { relay: 'roundtrip-ok' } }),
  );
  const relayResponse = await relayRequest;
  const relayBody = await relayResponse.json();
  if (
    relayResponse.status !== 200 ||
    relayBody?.status !== 'success' ||
    relayBody?.data?.relay !== 'roundtrip-ok'
  ) {
    console.error(`[verify] FAIL: relayed HTTP roundtrip returned ${JSON.stringify(relayBody)}`);
    process.exit(1);
  }
  console.log('[verify] ✓ relay forwarded a request and correlated response through the primary');

  const probe3 = await ping(port);
  if (!probe3 || probe3.status !== 'ok') {
    console.error('[verify] FAIL: /ping did not return ok after relay handoff');
    process.exit(1);
  }
  console.log('[verify] ✓ /ping returned ok after relay swap — HTTP never went down');

  try {
    assertSingleDetachedOwner(b2.pid);
  } catch (error) {
    console.error(`[verify] FAIL: ${error.message}`);
    process.exit(1);
  }
  console.log('[verify] ✓ relay replacement preserved the single daemon owner');

  console.log('');
  console.log('[verify] ALL CHECKS PASSED — detached daemon survives Chrome-style native-host termination');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] uncaught:', err);
  process.exit(1);
});
