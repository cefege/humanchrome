#!/usr/bin/env node
/**
 * Standalone bridge HTTP smoke test.
 *
 * Verifies the stateless multi-client behavior that does not require a live Chrome extension.
 *
 * Runs against an explicitly selected Rust native host or the release build,
 * on an alternate port, so it does not disturb the user's running bridge on 12306.
 *
 * Usage: node smoke-test.mjs   (from app/native-server/)
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 12399;
const TEST_NATIVE_BIN = process.env.HC_TEST_NATIVE_BIN;
const DEFAULT_NATIVE_BIN = resolve('../../target/release', `humanchrome-nativehost${process.platform === 'win32' ? '.exe' : ''}`);

// Shared MCP response parser (handles SSE multi-frame correctly — picks the
// last `data:` rather than the first, which the inline parser used to drop).
const { parseMcpResponseBody } = await import('./test-helpers/parse-mcp-response.mjs');

function framed(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function commandForBridge() {
  const candidate = resolve(TEST_NATIVE_BIN ?? DEFAULT_NATIVE_BIN);
  if (!existsSync(candidate)) {
    throw new Error(`native host executable does not exist: ${candidate}; run pnpm build:native or set HC_TEST_NATIVE_BIN`);
  }
  return { command: candidate, args: [] };
}

function collectFramed(stream, onFrame) {
  let buffer = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onFrame(JSON.parse(body.toString('utf8')));
      } catch (error) {
        console.error('smoke test received malformed native frame:', error.message);
      }
    }
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function waitForFrame(child, frames, type, timeoutMs = 5_000) {
  return new Promise((resolveFrame, rejectFrame) => {
    const deadline = Date.now() + timeoutMs;
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.removeListener('error', onSpawnError);
      callback(value);
    };
    const onSpawnError = (error) => {
      finish(rejectFrame, new Error(`failed to spawn bridge: ${error.message}`));
    };
    const poll = () => {
      const frame = frames.find((candidate) => candidate.type === type);
      if (frame) {
        finish(resolveFrame, frame);
      } else if (child.exitCode !== null) {
        finish(rejectFrame, new Error(`bridge exited before ${type} (code=${child.exitCode})`));
      } else if (Date.now() >= deadline) {
        finish(
          rejectFrame,
          new Error(`bridge did not emit ${type} within ${timeoutMs}ms: ${JSON.stringify(frames)}`),
        );
      } else {
        timer = setTimeout(poll, 25);
      }
    };
    child.once('error', onSpawnError);
    poll();
  });
}

async function stopBridge(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    sleep(2_000),
  ]);
  if (child.exitCode !== null) return;

  child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    sleep(1_000),
  ]);
}


const listBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {},
};

const acceptHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

let passed = 0;
let failed = 0;
const log = (label, ok, extra) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ' — ' + extra : ''}`);
  if (ok) passed += 1;
  else failed += 1;
};

async function rpc(url, init = {}) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  return { status: resp.status, body: parseMcpResponseBody(text) ?? text };
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'hc-smoke-'));
  const home = join(tmp, 'home');
  const runtime = join(tmp, 'runtime');
  const registryDir = join(runtime, 'instances');
  const socketPath = join(runtime, 'bridge-daemon.sock');
  const agentDataDir = join(runtime, 'agent-data');
  const fleetRoot = join(runtime, 'fleet');
  mkdirSync(home, { recursive: true });
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(agentDataDir, { recursive: true });
  mkdirSync(fleetRoot, { recursive: true });

  let child;
  const cleanupSync = () => {
    try {
      if (child?.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* no child process was created */
    }
    rmSync(tmp, { recursive: true, force: true });
  };
  process.once('exit', cleanupSync);

  try {
    const { command, args } = commandForBridge();
    child = spawn(command, args, {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local/share'),
        HC_DISABLE_DAEMON: '0',
        HC_BRIDGE_PORT: String(PORT),
        HUMANCHROME_PORT: String(PORT),
        HUMANCHROME_URL: '',
        HUMANCHROME_TOKEN: '',
        MCP_HTTP_PORT: String(PORT),
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
        HC_DAEMON_IDLE_TIMEOUT_MS: '600000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[bridge stderr] ${chunk}`));
    const frames = [];
    collectFramed(child.stdout, (frame) => frames.push(frame));
    child.stdin.write(
      framed({
        type: 'start',
        payload: { port: PORT, extensionId: 'smoke-ext', instanceId: 'smoke-instance' },
      }),
    );
    await waitForFrame(child, frames, 'server_started');

    const baseUrl = `http://127.0.0.1:${PORT}`;
    console.log(`Bridge listening on ${baseUrl}\n`);

    // /ping baseline
    {
      const { status, body } = await rpc(`${baseUrl}/ping`);
      log('ping → 200 ok', status === 200 && body?.status === 'ok', JSON.stringify(body));
    }

    // T7 multi-client
    {
      const [a, b] = await Promise.all([
        rpc(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: acceptHeaders,
          body: JSON.stringify(listBody),
        }),
        rpc(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: acceptHeaders,
          body: JSON.stringify(listBody),
        }),
      ]);
      const ok = a.status === 200 && b.status === 200;
      log('T7 multi-client: two simultaneous stateless requests accepted', ok);
    }

    // REST surface — catalog + OpenAPI must be reachable even with no extension
    // (dynamic flows fail fast and fall back to TOOL_SCHEMAS).
    {
      const r = await fetch(`${baseUrl}/api/tools`);
      const j = await r.json();
      const ok = r.status === 200 && Array.isArray(j.tools) && j.tools.length > 0;
      log('REST /api/tools: returns tool catalog', ok, `count=${j.tools?.length}`);
    }
    {
      const r = await fetch(`${baseUrl}/api/openapi.json`);
      const j = await r.json();
      const ok = r.status === 200 && j.openapi === '3.1.0' && Object.keys(j.paths).length > 0;
      log(
        'REST /api/openapi.json: spec generated',
        ok,
        `openapi=${j.openapi} paths=${Object.keys(j.paths).length}`,
      );
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    return failed === 0 ? 0 : 1;
  } finally {
    await stopBridge(child);
    rmSync(tmp, { recursive: true, force: true });
    process.removeListener('exit', cleanupSync);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('smoke test crashed:', err);
    process.exit(1);
  });
