#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const COORDINATOR_PORT = 12301;
const POSTGRES_IMAGE = 'postgres:17-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5';
const DEFAULT_TIMEOUT_SECONDS = 90;
const MCP_REQUIRE = createRequire(new URL('../app/native-server/package.json', import.meta.url));

function fail(message) {
  throw new Error(message);
}

function usage() {
  return [
    'usage: node scripts/verify-coordinator-container.mjs',
    '  --context <isolated-x86-docker-context>',
    '  --image <candidate-image>',
    '  --machine-label <physical-x86_64|emulated-x86_64>',
    '  [--timeout-seconds <15-300>]',
  ].join(' ');
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!['--context', '--image', '--machine-label', '--timeout-seconds'].includes(option) || !value) {
      fail(usage());
    }
    if (values.has(option)) fail(`duplicate option: ${option}`);
    values.set(option, value);
  }
  if (!values.has('--context') || !values.has('--image') || !values.has('--machine-label')) {
    fail(usage());
  }
  const context = values.get('--context');
  if (context.toLowerCase() === 'default' || /(^|[-_/])(?:prod|production)(?:$|[-_/])/i.test(context)) {
    fail('--context must name an isolated non-production Docker context');
  }
  const machineLabel = values.get('--machine-label');
  if (!['physical-x86_64', 'emulated-x86_64'].includes(machineLabel)) {
    fail('--machine-label must be physical-x86_64 or emulated-x86_64');
  }
  const timeoutSeconds = values.has('--timeout-seconds')
    ? Number.parseInt(values.get('--timeout-seconds'), 10)
    : DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 15 || timeoutSeconds > 300) {
    fail('--timeout-seconds must be an integer from 15 through 300');
  }
  return { context, image: values.get('--image'), machineLabel, timeoutSeconds };
}

const options = parseArguments(process.argv.slice(2));
const state = {
  network: undefined,
  containers: [],
  volumes: [],
  temporaryRoot: undefined,
  secrets: new Set(),
};

function redact(value) {
  let safe = String(value);
  for (const secret of state.secrets) {
    safe = safe.replaceAll(secret, '<redacted>');
  }
  return safe;
}

function report(message) {
  console.log(redact(message));
}

async function docker(arguments_, options_ = {}) {
  try {
    return await execFileAsync('docker', ['--context', options.context, ...arguments_], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      ...options_,
    });
  } catch (error) {
    const stderr = error?.stderr ? `: ${String(error.stderr).trim()}` : '';
    fail(`docker ${arguments_[0]} failed${stderr}`);
  }
}

async function dockerJson(arguments_, description) {
  const { stdout } = await docker(arguments_);
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`${description} did not return JSON`);
  }
}

async function dockerInspect(name) {
  const inspected = await dockerJson(['container', 'inspect', name], `container inspect for ${name}`);
  if (!Array.isArray(inspected) || inspected.length !== 1) fail(`unable to inspect owned container ${name}`);
  return inspected[0];
}

function randomToken() {
  return randomBytes(32).toString('hex');
}

function assertLinuxAmd64(value, description) {
  const os = String(value.Os ?? value.os ?? '').toLowerCase();
  const architecture = String(value.Architecture ?? value.architecture ?? value.Arch ?? value.arch ?? '').toLowerCase();
  if (os !== 'linux' || !['amd64', 'x86_64'].includes(architecture)) {
    fail(`${description} must be Linux amd64/x86_64, received ${os || '<missing>'}/${architecture || '<missing>'}`);
  }
  return { os, architecture };
}

async function assertMachineAndImage() {
  const { stdout } = await docker(['version', '--format', '{{json .Server}}']);
  let server;
  try {
    server = JSON.parse(stdout);
  } catch {
    fail('Docker daemon did not report server platform JSON');
  }
  const daemon = assertLinuxAmd64(server, 'Docker daemon');
  const image = await dockerJson(['image', 'inspect', options.image], 'candidate image inspection');
  if (!Array.isArray(image) || image.length !== 1) fail('candidate image inspection was ambiguous');
  const imagePlatform = assertLinuxAmd64(image[0], 'candidate image');
  const user = String(image[0]?.Config?.User ?? '');
  if (user === '' || user === '0' || user === 'root' || user.startsWith('0:') || user.startsWith('root:')) {
    fail('candidate image must declare a non-root runtime user');
  }
  report(`machine-proof: ${options.machineLabel}; daemon=${daemon.os}/${daemon.architecture}; image=${imagePlatform.os}/${imagePlatform.architecture}; image-user=${user}`);
}

function archiveEntries(container) {
  return new Promise((resolveArchive, rejectArchive) => {
    const child = spawn('docker', ['--context', options.context, 'export', container], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const paths = [];
    let carry = Buffer.alloc(0);
    let remaining = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      carry = Buffer.concat([carry, chunk]);
      while (carry.length >= 512) {
        if (remaining > 0) {
          const skip = Math.min(remaining, carry.length);
          carry = carry.subarray(skip);
          remaining -= skip;
          if (remaining > 0 || carry.length < 512) continue;
        }
        const header = carry.subarray(0, 512);
        carry = carry.subarray(512);
        if (header.every((byte) => byte === 0)) continue;
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
        if (name) paths.push(prefix ? `${prefix}/${name}` : name);
        const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
        const size = Number.parseInt(sizeText || '0', 8);
        if (!Number.isFinite(size) || size < 0) {
          child.kill();
          rejectArchive(new Error('candidate image export has an invalid tar entry'));
          return;
        }
        remaining = Math.ceil(size / 512) * 512;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => rejectArchive(error));
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) resolveArchive(paths);
      else rejectArchive(new Error(`docker export failed${signal ? ` (${signal})` : ` (${code})`}: ${stderr.trim()}`));
    });
  });
}

async function assertBrowserlessLayout(container) {
  const entries = await archiveEntries(container);
  const forbidden = entries.filter((entry) => /(^|\/)(?:node|nodejs|npm|npx|chrome|chromium|google-chrome)(?:$|[./-])/i.test(entry));
  if (forbidden.length > 0) {
    fail(`candidate image contains browser or Node runtime entries: ${forbidden.slice(0, 5).join(', ')}`);
  }
  report(`browserless-layout: exported ${entries.length} filesystem entries; no Node or Chrome runtime entry found`);
}

async function createContainer(name, arguments_) {
  await docker(['create', '--name', name, ...arguments_]);
  state.containers.push(name);
}

async function copyConfig(container, configPath) {
  await docker(['cp', configPath, `${container}:/app/coordinator.json`]);
}

async function startContainer(container) {
  await docker(['start', container]);
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitUntil(description, predicate, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  const detail = lastError ? `: ${lastError.message}` : '';
  fail(`timed out waiting for ${description}${detail}`);
}

async function waitForPostgres(container) {
  await waitUntil('PostgreSQL readiness', async () => {
    try {
      await docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'coordinator', '-d', state.databaseName]);
      return true;
    } catch {
      return false;
    }
  }, options.timeoutSeconds * 1000);
}

async function localPort(container) {
  const inspected = await dockerInspect(container);
  const bindings = inspected?.NetworkSettings?.Ports?.[`${COORDINATOR_PORT}/tcp`];
  const binding = Array.isArray(bindings) ? bindings.find((item) => item.HostIp === '127.0.0.1' || item.HostIp === '0.0.0.0') : undefined;
  if (!binding?.HostPort) fail('candidate container did not publish coordinator port locally');
  return Number.parseInt(binding.HostPort, 10);
}

async function request(baseUrl, path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(new URL(path, baseUrl), { ...init, signal: controller.signal });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Endpoint status and structured error checks below remain authoritative.
    }
    return { response, json };
  } finally {
    clearTimeout(timer);
  }
}

function assertStatus(result, status, description) {
  if (result.response.status !== status) {
    fail(`${description} returned HTTP ${result.response.status}, expected ${status}`);
  }
}

function assertError(result, status, code, description) {
  assertStatus(result, status, description);
  if (result.json?.error !== code) {
    fail(`${description} did not return domain error ${code}`);
  }
}

async function waitForStatus(baseUrl, path, status, description) {
  return waitUntil(description, async () => {
    const result = await request(baseUrl, path);
    return result.response.status === status ? result : false;
  }, options.timeoutSeconds * 1000);
}

function authenticatedHeaders() {
  return { authorization: `Bearer ${state.clientToken}` };
}

async function verifyMcp(baseUrl) {
  const { Client, StreamableHTTPClientTransport } = MCP_REQUIRE('@modelcontextprotocol/client');
  const transport = new StreamableHTTPClientTransport(new URL('/v1/fleet/mcp', baseUrl), {
    requestInit: { headers: authenticatedHeaders() },
  });
  const client = new Client({ name: 'coordinator-container-verifier', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === 'fleet_profiles')) {
      fail('official MCP SDK tools/list did not expose fleet_profiles');
    }
    const result = await client.callTool({ name: 'fleet_profiles', arguments: {} });
    if (result.isError === true) fail('fleet_profiles returned an MCP tool error while coordinator was ready');
    const text = result.content?.find((item) => item.type === 'text')?.text;
    let profiles;
    try {
      profiles = JSON.parse(text);
    } catch {
      fail('fleet_profiles did not return its domain payload as JSON text');
    }
    if (!Array.isArray(profiles) || profiles.length !== 0) {
      fail('fleet_profiles did not report the empty unavailable-worker inventory');
    }
  } finally {
    await client.close().catch(() => {});
  }
}

async function verifyUnavailableWorker(baseUrl) {
  const workers = await request(baseUrl, '/v1/workers', { headers: authenticatedHeaders() });
  assertStatus(workers, 200, 'unavailable worker inventory');
  const worker = Array.isArray(workers.json)
    ? workers.json.find((entry) => entry?.id === 'unavailable')
    : undefined;
  if (worker?.available !== false || worker?.error !== 'worker_unavailable') {
    fail('configured unavailable worker was not reported as unavailable');
  }
  const profiles = await request(baseUrl, '/v1/profiles', { headers: authenticatedHeaders() });
  assertStatus(profiles, 200, 'unavailable worker profiles');
  if (!Array.isArray(profiles.json) || profiles.json.length !== 0) {
    fail('unavailable worker inventory unexpectedly exposed an available profile');
  }
  assertError(
    await request(baseUrl, '/v1/pool/any/api/tools/chrome_click', {
      method: 'POST',
      headers: {
        ...authenticatedHeaders(),
        'content-type': 'application/json',
        'x-humanchrome-agent': 'container-verifier',
      },
      body: JSON.stringify({ args: {} }),
    }),
    503,
    'no_free_profile',
    'browser work with no free profile',
  );
}

async function waitForExit(container, description) {
  return waitUntil(description, async () => {
    const inspected = await dockerInspect(container);
    return inspected.State?.Running === false ? inspected : false;
  }, options.timeoutSeconds * 1000);
}

async function safeDiagnostics() {
  for (const container of state.containers) {
    try {
      const inspected = await dockerInspect(container);
      const stateSummary = inspected.State ?? {};
      report(`diagnostic: ${container} running=${Boolean(stateSummary.Running)} exit=${stateSummary.ExitCode ?? '<unknown>'} oom=${Boolean(stateSummary.OOMKilled)}`);
      const { stdout, stderr } = await docker(['logs', '--tail', '80', container]);
      const logs = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (logs) report(`diagnostic logs for ${container}:\n${logs}`);
    } catch {
      // A container can already be gone while reporting the primary failure.
    }
  }
}

async function cleanup() {
  for (const container of [...state.containers].reverse()) {
    try {
      await docker(['rm', '--force', '--volumes', container]);
    } catch {
      // Cleanup continues so every owned object gets an attempt.
    }
  }
  for (const volume of state.volumes) {
    try {
      await docker(['volume', 'rm', volume]);
    } catch {
      // Continue cleaning the other owned resources.
    }
  }
  if (state.network) {
    try {
      await docker(['network', 'rm', state.network]);
    } catch {
      // A failed verification must not mask a later cleanup attempt.
    }
  }
  if (state.temporaryRoot) await rm(state.temporaryRoot, { recursive: true, force: true });
}

async function main() {
  await assertMachineAndImage();
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  state.network = `hc-coordinator-verify-${runId}`;
  const database = `hc_container_test_${runId}`;
  const coordinatorId = `verify-${runId.slice(0, 20)}`;
  state.databaseName = database;
  state.clientToken = randomToken();
  state.workerToken = randomToken();
  const badToken = randomToken();
  const postgresPassword = randomToken();
  state.secrets.add(state.clientToken);
  state.secrets.add(badToken);
  state.secrets.add(state.workerToken);
  state.secrets.add(postgresPassword);

  state.temporaryRoot = await mkdtemp(join(tmpdir(), 'humanchrome-coordinator-verify-'));
  const databaseUrl = `postgresql://coordinator:${encodeURIComponent(postgresPassword)}@${state.network}-postgres:5432/${database}?sslmode=disable`;
  state.secrets.add(databaseUrl);
  const configPath = join(state.temporaryRoot, 'coordinator.json');
  await writeFile(configPath, `${JSON.stringify({
    id: coordinatorId,
    host: '0.0.0.0',
    port: COORDINATOR_PORT,
    databaseUrl,
    leaseTtlSec: 15,
    clients: [{ id: 'control', token: state.clientToken, admin: true }],
    workers: [{
      id: 'unavailable',
      url: 'http://127.0.0.1:1',
      token: state.workerToken,
    }],
  })}\n`, { mode: 0o644 });

  const postgres = `${state.network}-postgres`;
  const primary = `${state.network}-primary`;
  const contender = `${state.network}-contender`;
  await docker(['network', 'create', state.network]);
  const configVolume = `${state.network}-config`;
  await docker(['volume', 'create', configVolume]);
  state.volumes.push(configVolume);
  const configHolder = `${state.network}-config-holder`;
  await createContainer(configHolder, [
    '--network', 'none',
    '--mount', `type=volume,source=${configVolume},target=/app`,
    options.image,
  ]);
  await copyConfig(configHolder, configPath);
  await createContainer(postgres, [
    '--network', state.network,
    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec',
    '-e', `POSTGRES_USER=coordinator`,
    '-e', `POSTGRES_PASSWORD=${postgresPassword}`,
    '-e', `POSTGRES_DB=${database}`,
    POSTGRES_IMAGE,
  ]);
  await startContainer(postgres);
  await waitForPostgres(postgres);

  const hardenedCoordinator = [
    '--network', state.network,
    '--read-only',
    '--mount', `type=volume,source=${configVolume},target=/app,readonly`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec',
    '--tmpfs', '/home/humanchrome:rw,nosuid,nodev,noexec',
  ];
  await createContainer(primary, [
    ...hardenedCoordinator,
    '--publish', `127.0.0.1::${COORDINATOR_PORT}`,
    options.image,
    'fleet', 'coordinator', '--config', '/app/coordinator.json',
  ]);
  await assertBrowserlessLayout(primary);
  await startContainer(primary);
  const port = await localPort(primary);
  const baseUrl = new URL(`http://127.0.0.1:${port}/`);
  await waitForStatus(baseUrl, '/healthz', 200, 'coordinator health endpoint');
  await waitForStatus(baseUrl, '/readyz', 200, 'coordinator readiness endpoint');

  assertError(await request(baseUrl, '/v1/profiles'), 401, 'unauthorized', 'missing authentication');
  assertError(await request(baseUrl, '/v1/profiles', { headers: { authorization: `Bearer ${badToken}` } }), 401, 'unauthorized', 'bad authentication');
  await verifyMcp(baseUrl);
  await verifyUnavailableWorker(baseUrl);

  await createContainer(contender, [
    ...hardenedCoordinator,
    options.image,
    'fleet', 'coordinator', '--config', '/app/coordinator.json',
  ]);
  await startContainer(contender);
  const contenderState = await waitForExit(contender, 'singleton contender rejection');
  if (contenderState.State?.ExitCode === 0 || contenderState.State?.OOMKilled) {
    fail('second coordinator did not fail closed on the existing coordinator singleton lock');
  }
  await waitForStatus(baseUrl, '/readyz', 200, 'primary readiness after singleton rejection');

  await docker(['stop', '--time', '5', postgres]);
  await waitForStatus(baseUrl, '/readyz', 503, 'readiness after PostgreSQL leader loss');
  const primaryState = await dockerInspect(primary);
  if (primaryState.State?.Running !== true) fail('coordinator process died after PostgreSQL leader loss');
  assertError(
    await request(baseUrl, '/v1/pool/any/api/tools/chrome_click', {
      method: 'POST',
      headers: {
        ...authenticatedHeaders(),
        'content-type': 'application/json',
        'x-humanchrome-agent': 'container-verifier',
      },
      body: JSON.stringify({ args: {} }),
    }),
    503,
    'coordinator_unavailable',
    'new browser work after PostgreSQL leader loss',
  );

  await docker(['kill', '--signal', 'SIGTERM', primary]);
  const stoppedPrimary = await waitForExit(primary, 'graceful SIGTERM coordinator exit');
  if (stoppedPrimary.State?.ExitCode !== 0 || stoppedPrimary.State?.OOMKilled) {
    fail('coordinator did not exit cleanly after SIGTERM; timeout or SIGKILL is not accepted');
  }
  report('coordinator container verification passed: PostgreSQL, HTTP authentication, MCP control, singleton exclusion, leader loss, and SIGTERM shutdown');
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  console.error(`coordinator container verification failed: ${redact(error?.message ?? error)}`);
  await safeDiagnostics();
} finally {
  await cleanup();
}
if (failure) process.exitCode = 1;
