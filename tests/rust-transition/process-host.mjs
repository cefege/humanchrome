import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
const DEADLINE_MS = 15_000;

export function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export async function allocatePort(host = '127.0.0.1') {
  const listener = createServer();
  listener.listen(0, host);
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function isolatedRun(run) {
  // macOS UDS paths have a small limit; os.tmpdir() may already occupy most of it.
  const directory = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'hc-rt-'));
  const children = new Set();
  const home = join(directory, 'home');
  const temporary = join(directory, 'tmp');
  await Promise.all([mkdir(home), mkdir(temporary)]);
  const port = await allocatePort();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    APPDATA: join(home, 'AppData/Roaming'),
    LOCALAPPDATA: join(home, 'AppData/Local'),
    HUMANCHROME_TOKEN: '',
    HUMANCHROME_URL: '',
    HUMANCHROME_PORT: String(port),
    MCP_HTTP_PORT: String(port),
    HC_BRIDGE_PORT: String(port),
    HC_DISABLE_DAEMON: '1',
    HC_BRIDGE_DAEMON_SOCKET: join(directory, 'daemon.sock'),
    HC_DAEMON_IDLE_TIMEOUT_MS: '1000',
    HC_INSTANCE_REGISTRY_DIR: join(directory, 'instances'),
    HC_FLEET_ROOT: join(directory, 'fleet'),
    CHROME_MCP_AGENT_DB_FILE: join(directory, 'agent.db'),
  };
  let closing;
  const cleanup = () => closing ??= (async () => {
    try {
      await Promise.all([...children].map(async (child) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        try { await exited; } finally { clearTimeout(timer); }
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  const interrupted = () => { void cleanup().finally(() => process.exit(130)); };
  const terminated = () => { void cleanup().finally(() => process.exit(143)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);
  try {
    return await run({ directory, port, env, spawn: (command, args = [], overrides = {}) => {
      const child = spawn(command, args, { cwd: ROOT, env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      return child;
    } });
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    await cleanup();
  }
}

export class NativePeer {
  #buffer = Buffer.alloc(0);
  #queue = [];
  #waiter;
  #failure;
  stderr = '';

  constructor(child, onRequest) {
    this.child = child;
    child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    child.on('error', (error) => this.#fail(error));
    child.stdin.on('error', (error) => this.#fail(error));
    child.on('exit', (code, signal) => this.#fail(new Error(`native process exited (${code ?? signal})\n${this.stderr}`)));
    child.stdout.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      try {
        while (this.#buffer.length >= 4) {
          const size = this.#buffer.readUInt32LE();
          assert(size > 0 && size <= 16 * 1024 * 1024, `invalid protocol stdout length: ${size}`);
          if (this.#buffer.length < size + 4) break;
          const message = JSON.parse(this.#buffer.subarray(4, size + 4).toString());
          this.#buffer = this.#buffer.subarray(size + 4);
          if (message.requestId && onRequest) {
            const response = onRequest(message);
            if (response !== undefined) {
              child.stdin.write(frame({ responseToRequestId: message.requestId, payload: response }));
              continue;
            }
          }
          this.#queue.push(message);
          this.#wake();
        }
      } catch (error) { this.#fail(error); }
    });
  }

  #wake() {
    if (this.#waiter && this.#queue.length) {
      const { resolve, timer } = this.#waiter;
      this.#waiter = undefined;
      clearTimeout(timer);
      resolve(this.#queue.shift());
    }
  }

  #fail(error) {
    this.#failure = error;
    if (this.#waiter) {
      clearTimeout(this.#waiter.timer);
      this.#waiter.reject(error);
      this.#waiter = undefined;
    }
  }

  next() {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#failure) return Promise.reject(this.#failure);
    assert(!this.#waiter, 'only one reader may consume native frames');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error(`native frame timeout\n${this.stderr}`)), DEADLINE_MS);
      this.#waiter = { resolve, reject, timer };
    });
  }

  async exchange(bytes) {
    this.child.stdin.write(bytes);
    return this.next();
  }
}

export function executable() {
  return [process.env.HC_TEST_NATIVE_BIN ?? join(ROOT, 'target/release', `humanchrome-nativehost${process.platform === 'win32' ? '.exe' : ''}`), []];
}

export async function captureProcess(
  command, args, scope, { timeoutMs = DEADLINE_MS, gracefulTimeout = false } = {},
) {
  const child = scope.spawn(command, args);
  const chunks = [];
  const errors = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  let timedOut = false;
  let forcedKill;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill(gracefulTimeout ? 'SIGTERM' : 'SIGKILL');
    if (gracefulTimeout) forcedKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
  }, timeoutMs);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(timedOut, false, `${command} exceeded ${timeoutMs}ms:\n${Buffer.concat(errors)}\n${Buffer.concat(chunks)}`);
    assert.equal(code, 0, `${command} exited ${code}: ${Buffer.concat(errors)}\n${Buffer.concat(chunks)}`);
    return Buffer.concat(chunks).toString();
  } finally { clearTimeout(timer); clearTimeout(forcedKill); }
}

// Object key order is wire data. Equal containers do not constitute a difference.
export function firstDifference(left, right, path = '$') {
  if (Object.is(left, right)) return undefined;
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object' &&
      !Array.isArray(left) && !Array.isArray(right)) {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    for (let index = 0; index < Math.max(leftEntries.length, rightEntries.length); index += 1) {
      const [leftKey, leftValue] = leftEntries[index] ?? [];
      const [rightKey, rightValue] = rightEntries[index] ?? [];
      if (leftKey !== rightKey) return { path: `${path}.{key:${index}}`, left: leftKey, right: rightKey };
      const difference = firstDifference(leftValue, rightValue, `${path}.${leftKey}`);
      if (difference) return difference;
    }
    return undefined;
  }
  return { path, left, right };
}
