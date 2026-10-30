import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, constants, copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, frame, isolatedRun, NativePeer } from './process-host.mjs';

const suffix = process.platform === 'win32' ? '.exe' : '';
const NATIVE_HOST = join(ROOT, 'target/release', `humanchrome-nativehost${suffix}`);
const RUST_STDIO = join(ROOT, 'target/release', `humanchrome-stdio${suffix}`);
const DEADLINE_MS = 15_000;

/**
 * Proves the Rust stdio launcher against a live Rust native host. The extension
 * peer, HTTP/MCP transport, registry discovery, and proxy are all real.
 */
export async function verify() {
  await requireExecutable(NATIVE_HOST, 'cargo build -p humanchrome-native --release --bin humanchrome-nativehost --bin humanchrome-stdio');
  await requireExecutable(RUST_STDIO, 'cargo build -p humanchrome-native --release --bin humanchrome-nativehost --bin humanchrome-stdio');
  const { stdio } = JSON.parse(await readFile(join(import.meta.dirname, 'typescript-baseline.json'), 'utf8'));

  for (const resolution of ['url', 'port', 'registry']) {
    assert.deepStrictEqual(
      await observe(resolution),
      stdio[resolution],
      `stdio ${resolution} resolution contract drift`,
    );
  }
  for (const [key, protocolVersion] of [['legacyProtocol', '2024-10-07'], ['unsupportedProtocol', '1900-01-01']]) {
    assert.deepStrictEqual(
      await observe('url', protocolVersion, false),
      stdio[key],
      `stdio ${protocolVersion} initialization/error contract drift`,
    );
  }

  console.log('PASS stdio proxy: isolated live native host handshake, legacy/fallback negotiation, JSON-RPC errors, list, lossless call, URL/port/registry resolution');
}

async function observe(resolution, protocolVersion = '2025-06-18', exerciseCalls = true) {
  return isolatedRun(async (scope) => {
    const peer = new NativePeer(scope.spawn(NATIVE_HOST, []), extensionResponse);
    const started = await peer.exchange(frame({
      type: 'start',
      payload: {
        port: scope.port,
        extensionId: 'stdio-proxy-fixture',
        instanceId: 'stdio-proxy-fixture',
      },
    }));
    assert.equal(started.type, 'server_started', JSON.stringify(started));

    const bridgeUrl = `http://127.0.0.1:${scope.port}/mcp`;
    const overrides = {
      HUMANCHROME_SESSION: 'stdio-proxy-fixture',
      HUMANCHROME_URL: resolution === 'url' ? bridgeUrl : '',
      HUMANCHROME_PORT: resolution === 'port' ? String(scope.port) : '',
    };
    if (resolution === 'url') overrides.HUMANCHROME_PORT = '1';

    const session = await StdioSession.start(scope, overrides);
    try {
      const initialize = await session.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'stdio-proxy-suite', version: '1.0.0' },
        },
      });
      if (!exerciseCalls) {
        const unknownMethod = await session.request({
          jsonrpc: '2.0',
          id: 2,
          method: 'humanchrome/does-not-exist',
        });
        return { initialize, unknownMethod };
      }
      await session.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const listed = await session.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.ok(initialize.result, `stdio initialize failed: ${JSON.stringify(initialize)}`);
      assert.ok(
        Array.isArray(listed.result?.tools),
        `stdio tools/list failed after ${JSON.stringify(initialize)}: ${JSON.stringify(listed)}\n${session.stderr}`,
      );
      const dispatcher = listed.result.tools.some((tool) => tool.name === 'humanchrome');

      // These two requests share the real upstream HTTP bridge and must be safe to complete in
      // either order. The escaped surrogate values prove the proxy never routes valid JSON via a
      // lossy Rust serde_json::Value projection.
      session.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      const losslessArgs = JSON.parse('{"\\ud800":"\\udfff","nested":{"value":"\\ud800"}}');
      session.send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: dispatcher
          ? { name: 'humanchrome', arguments: { name: 'chrome_get_windows_and_tabs', args: losslessArgs } }
          : { name: 'chrome_get_windows_and_tabs', arguments: losslessArgs },
      });
      const [concurrentList, call] = await Promise.all([session.response(3), session.response(4)]);
      const echoed = JSON.parse(call.result.content[0].text);
      assert.equal(echoed.args['\ud800'], '\udfff');
      assert.equal(echoed.args.nested.value, '\ud800');

      return { initialize, listed, concurrentList, call };
    } finally {
      await session.close();
    }
  });
}

function extensionResponse(message) {
  if (message.type === 'rr_list_published_flows') return { status: 'success', items: [] };
  if (message.type === 'call_tool') {
    return {
      status: 'success',
      data: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: message.payload.name,
            args: message.payload.args,
            clientId: message.clientId,
          }),
        }],
        _meta: { extensionFixture: true },
      },
    };
  }
  return undefined;
}

class StdioSession {
  #buffer = '';
  #responses = new Map();
  #waiters = new Map();
  #error;
  #stderr = '';

  constructor(child) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#accept(chunk));
    child.stderr.on('data', (chunk) => { this.#stderr += chunk; });
    child.on('error', (error) => this.#fail(error));
    child.stdin.on('error', (error) => this.#fail(error));
    child.once('exit', (code, signal) => {
      if (code !== 0 || this.#waiters.size) {
        this.#fail(new Error(`stdio proxy exited ${code ?? signal}\n${this.#stderr}`));
      }
    });
  }
  get stderr() {
    return this.#stderr;
  }

  static async start(scope, overrides) {
    const directory = join(scope.directory, 'stdio-bundle');
    await mkdir(join(directory, 'mcp'), { recursive: true });
    const executable = join(directory, `humanchrome-stdio${suffix}`);
    await copyFile(RUST_STDIO, executable, constants.COPYFILE_FICLONE);
    await copyFile(
      join(ROOT, 'app/native-server/contracts/stdio-config.json'),
      join(directory, 'mcp/stdio-config.json'),
    );
    return new StdioSession(scope.spawn(executable, [], overrides));
  }

  send(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async notify(value) {
    this.send(value);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async request(value) {
    this.send(value);
    return this.response(value.id);
  }

  response(id) {
    if (this.#responses.has(id)) {
      const value = this.#responses.get(id);
      this.#responses.delete(id);
      return Promise.resolve(value);
    }
    if (this.#error) return Promise.reject(this.#error);
    assert(!this.#waiters.has(id), `duplicate waiter for JSON-RPC id ${id}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        reject(new Error(`stdio response timeout for id ${id}\n${this.#stderr}`));
      }, DEADLINE_MS);
      this.#waiters.set(id, { resolve, reject, timer });
    });
  }

  async close() {
    const exited = this.child.exitCode !== null || this.child.signalCode !== null
      ? Promise.resolve([this.child.exitCode, this.child.signalCode])
      : once(this.child, 'exit');
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), DEADLINE_MS);
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0, `stdio proxy exited ${code ?? signal}\n${this.#stderr}`);
    } finally {
      clearTimeout(timer);
    }
  }

  #accept(chunk) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.#fail(error);
        return;
      }
      const id = message.id;
      const waiter = this.#waiters.get(id);
      if (waiter) {
        this.#waiters.delete(id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.#responses.set(id, message);
      }
    }
  }

  #fail(error) {
    if (this.#error) return;
    this.#error = error;
    for (const { reject, timer } of this.#waiters.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#waiters.clear();
  }
}


async function requireExecutable(path, command) {
  await requireFile(path, command, constants.X_OK);
}

async function requireFile(path, command, mode = constants.R_OK) {
  try {
    await access(path, mode);
  } catch {
    throw new Error(`missing prerequisite ${path}; run ${command}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
