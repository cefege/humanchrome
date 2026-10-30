import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { executable, frame, isolatedRun, NativePeer } from './process-host.mjs';
import { normalize } from './native-fixtures.mjs';
import { verifyAgentApplicationRoutes } from './agent-application-fixtures.mjs';
import { agentFleetReference } from './agent-fleet-reference.mjs';
import { verifyMacOsRoutes } from './agent-os-fixtures.mjs';

const REQUEST_TIMEOUT_MS = 15_000;

async function request(scope, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${scope.port}${path}`, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function eventReader(reader) {
  const decoder = new TextDecoder();
  let buffer = '';
  return async function next() {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        let eventType = 'message';
        const data = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventType = line.slice(6).replace(/^ /, '') || 'message';
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) return { eventType, value: JSON.parse(data.join('\n')) };
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Agent stream ended before its next event');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

function seedLegacyDatabase(scope, workspace) {
  const database = new DatabaseSync(join(scope.directory, 'agent.db'));
  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      root_path TEXT NOT NULL,
      preferred_cli TEXT,
      selected_model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_active_at TEXT
    );
  `);
  database.prepare(`
    INSERT INTO projects (id, name, root_path, preferred_cli, created_at, updated_at, last_active_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-project', 'Legacy project', workspace, 'codex', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  database.close();
}

async function start(scope, overrides = {}) {
  const [command, args] = executable();
  const peer = new NativePeer(scope.spawn(command, args, overrides));
  const started = await peer.exchange(frame({ type: 'start', payload: { port: scope.port, extensionId: 'agent-transition' } }));
  assert.equal(started.type, 'server_started');
  return peer;
}

function publicProject(project) {
  return {
    name: project.name,
    rootPath: project.rootPath,
    preferredCli: project.preferredCli,
    enableHumanChrome: project.enableHumanChrome,
  };
}

async function exercise() {
  return isolatedRun(async (scope) => {
    const workspace = join(scope.directory, 'home', 'workspace');
    await mkdir(workspace);
    seedLegacyDatabase(scope, workspace);
    await start(scope);
    const legacy = await request(scope, '/agent/projects');
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.projects.find((entry) => entry.id === 'legacy-project').name, 'Legacy project');
    const project = await request(scope, '/agent/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Compatibility project', rootPath: workspace, preferredCli: 'codex' }),
    });
    assert.equal(project.status, 200);
    assert.equal(publicProject(project.body.project).name, 'Compatibility project');

    const projectId = project.body.project.id;
    const session = await request(scope, `/agent/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ engineName: 'codex', name: 'Durable session', model: 'gpt-5' }),
    });
    assert.equal(session.status, 201);
    const sessionId = session.body.session.id;

    const message = await request(scope, `/agent/chat/${projectId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        role: 'user',
        content: 'legacy transcript entry',
        messageType: 'chat',
        metadata: { retained: true },
        cliSource: 'codex',
        requestId: 'transition-request',
      }),
    });
    assert.equal(message.status, 201);

    const history = await request(scope, `/agent/sessions/${sessionId}/history?limit=50&offset=0`);
    assert.equal(history.status, 200);
    assert.equal(history.body.totalCount, 1);
    assert.equal(history.body.messages[0].content, 'legacy transcript entry');
    assert.deepEqual(history.body.messages[0].metadata, { retained: true });

    const openStream = async (id) => {
      const response = await fetch(`http://127.0.0.1:${scope.port}/agent/chat/${id}/stream`, {
        signal: AbortSignal.timeout(45_000),
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      return { reader, next: eventReader(reader) };
    };
    const firstStream = await openStream(sessionId);
    const connected = await firstStream.next();
    assert.equal(connected.eventType, 'message');
    assert.equal(connected.value.type, 'connected');
    assert.equal(connected.value.data.sessionId, sessionId);
    const reconnect = await openStream(sessionId);
    assert.equal((await reconnect.next()).value.data.sessionId, sessionId);
    assert.equal((await firstStream.next()).value.type, 'connected');
    const anotherSession = await openStream(`${sessionId}-isolated`);
    assert.equal((await anotherSession.next()).value.data.sessionId, `${sessionId}-isolated`);
    const [heartbeat, otherHeartbeat] = await Promise.all([firstStream.next(), anotherSession.next()]);
    assert.equal(heartbeat.eventType, 'message');
    assert.equal(heartbeat.value.type, 'heartbeat');
    assert.equal(otherHeartbeat.value.type, 'heartbeat');
    assert.equal(otherHeartbeat.value.data.timestamp, heartbeat.value.data.timestamp);
    assert(Number.isFinite(Date.parse(heartbeat.value.data.timestamp)));
    await Promise.all([firstStream.reader.cancel(), reconnect.reader.cancel(), anotherSession.reader.cancel()]);

    const unknownCancel = await request(scope, `/agent/chat/${sessionId}/cancel/no-such-request`, { method: 'DELETE' });
    assert.equal(unknownCancel.status, 200);
    assert.deepEqual(unknownCancel.body, {
      success: false,
      message: 'No running execution found with this requestId',
      requestId: 'no-such-request',
      sessionId,
    });

    const reset = await request(scope, `/agent/sessions/${sessionId}/reset`, { method: 'POST', body: '{}' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.deletedMessages, 1);
    assert.equal(reset.body.session.id, sessionId);

    const reopened = await request(scope, '/agent/projects');
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.projects.length, 2);
    const compatibility = reopened.body.projects.find((entry) => entry.id === projectId);
    return normalize({ project: publicProject(compatibility), reset: reset.body.deletedMessages, cancel: unknownCancel.body }, scope);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, read, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let observed;
  while (Date.now() < deadline) {
    observed = await read();
    if (predicate(observed)) return observed;
    await delay(100);
  }
  throw new Error(`${description}: ${JSON.stringify(observed)}`);
}

async function actualProviderExecution(engine) {
  if (process.env[engine === 'claude' ? 'HC_TEST_CLAUDE' : 'HC_TEST_CODEX'] !== '1') return;
  assert.equal(process.platform, 'darwin', 'local-only provider proof requires the macOS network sandbox');
  const bundledEngines = process.env.HC_TEST_BUNDLED_ENGINES === '1';
  const sdkRoot = process.env.HC_TEST_CLAUDE_SDK_ROOT && resolve(process.env.HC_TEST_CLAUDE_SDK_ROOT);
  const adapter = process.env.HC_TEST_THIRD_PARTY_ADAPTER && resolve(process.env.HC_TEST_THIRD_PARTY_ADAPTER);
  if (engine === 'claude') {
    assert(sdkRoot, 'HC_TEST_CLAUDE_SDK_ROOT is required for the real Claude provider smoke');
    assert(adapter, 'HC_TEST_THIRD_PARTY_ADAPTER is required for the real Claude provider smoke');
    await Promise.all([access(join(sdkRoot, 'package.json')), access(adapter)]);
  }

  await isolatedRun(async (scope) => {
    const sockets = new Set();
    let apiRequests = 0;
    let unexpectedCredential = false;
    const token = 'fixture-only-no-cloud-credential';
    const api = createServer((request, response) => {
      if ((request.headers.authorization && request.headers.authorization !== `Bearer ${token}`)
        || (request.headers['x-api-key'] && request.headers['x-api-key'] !== token)) {
        unexpectedCredential = true;
        response.writeHead(401).end();
        return;
      }
      request.resume();
      if (request.url?.startsWith('/v1/messages') || request.url?.startsWith('/v1/responses')) {
        apiRequests += 1;
        // Hold the real engine request until cancellation; never synthesize a model response.
      } else {
        response.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"local-only fixture"}}');
      }
    });
    api.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    try {
      const workspace = join(scope.directory, 'home', `${engine}-workspace`);
      await mkdir(workspace);
      const codexHome = join(scope.env.HOME, '.codex');
      if (engine === 'codex') {
        await mkdir(codexHome);
        await writeFile(join(codexHome, 'config.toml'), [
          'model = "gpt-5"',
          'model_provider = "local_fault"',
          '[model_providers.local_fault]',
          'name = "Local fault fixture"',
          `base_url = "http://127.0.0.1:${api.address().port}/v1"`,
          'env_key = "HC_CODEX_FIXTURE_KEY"',
          'wire_api = "responses"',
          'requires_openai_auth = false',
          'supports_websockets = false',
          '',
        ].join('\n'), { mode: 0o600 });
      }
      const scrubbed = Object.fromEntries(Object.keys(process.env)
        .filter((key) => /TOKEN|SECRET|API_KEY|ACCESS_KEY|PASSWORD|AUTHORIZATION|CREDENTIAL/i.test(key))
        .map((key) => [key, '']));
      const localEnv = {
        ...scrubbed,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_FOUNDRY: '0',
        CLAUDE_CONFIG_DIR: join(scope.env.HOME, '.claude'),
        CODEX_HOME: codexHome,
        HC_CODEX_FIXTURE_KEY: token,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      };
      const sandbox = '(version 1) (allow default) (deny network*) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*")) (allow network-bind (local ip "localhost:*")) (allow network-inbound (local unix-socket)) (allow network-outbound (remote unix-socket)) (allow network-bind (local unix-socket))';
      const [command, args] = executable();
      const peer = new NativePeer(scope.spawn('/usr/bin/sandbox-exec', ['-p', sandbox, command, ...args], {
        ...localEnv,
        ...(bundledEngines
          ? { PATH: '', HC_AGENT_SDK_ROOT: undefined, HC_THIRD_PARTY_ADAPTER: undefined, HC_TRACE_NODE: undefined }
          : { HC_AGENT_SDK_ROOT: sdkRoot, HC_THIRD_PARTY_ADAPTER: adapter }),
      }));
      const started = await peer.exchange(frame({ type: 'start', payload: { port: scope.port, extensionId: 'local-only-sdk' } }));
      assert.equal(started.type, 'server_started');
      const project = await request(scope, '/agent/projects', {
        method: 'POST',
        body: JSON.stringify({ name: `${engine} provider gate`, rootPath: workspace, preferredCli: engine, enableHumanChrome: false, useCcr: false }),
      });
      assert.equal(project.status, 200);
      const session = await request(scope, `/agent/projects/${project.body.project.id}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ engineName: engine, optionsConfig: { env: localEnv } }),
      });
      assert.equal(session.status, 201);
      const sessionId = session.body.session.id;
      const database = new DatabaseSync(join(scope.directory, 'agent.db'));
      database.prepare('UPDATE projects SET last_active_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', project.body.project.id);
      database.close();
      const streamResponse = await fetch(`http://127.0.0.1:${scope.port}/agent/chat/${sessionId}/stream`, { signal: AbortSignal.timeout(60_000) });
      assert.equal(streamResponse.status, 200);
      const reader = streamResponse.body.getReader();
      const next = eventReader(reader);
      assert.equal((await next()).value.type, 'connected');
      try {
        let engineSessionId;
        let managementVersion;
        for (let turn = 0; turn < (engine === 'claude' ? 2 : 1); turn += 1) {
          const previousRequests = apiRequests;
          const accepted = await request(scope, `/agent/chat/${sessionId}/act`, {
            method: 'POST',
            body: JSON.stringify({ projectId: project.body.project.id, dbSessionId: sessionId, cliPreference: engine, instruction: turn === 0 ? 'Initialize this local-only provider session and wait for cancellation.' : 'Resume this local-only provider session and wait for cancellation.' }),
          });
          assert.equal(accepted.status, 200);
          assert.equal(accepted.body.status, 'accepted');
          if (engine === 'claude') {
            const initialized = await waitFor(
              'Claude SDK did not initialize or resume through the Rust JSONL adapter',
              async () => request(scope, `/agent/sessions/${sessionId}`),
              (response) => response.status === 200
                && typeof response.body.session.engineSessionId === 'string'
                && (turn === 0 || response.body.session.managementInfo?.lastUpdated !== managementVersion),
            );
            if (turn > 0) assert.equal(initialized.body.session.engineSessionId, engineSessionId, 'resume must retain the real SDK session identity');
            engineSessionId = initialized.body.session.engineSessionId;
            managementVersion = initialized.body.session.managementInfo?.lastUpdated;
            assert.equal(typeof managementVersion, 'string');
          }
          await waitFor(`real ${engine} did not target the local fault API`, async () => apiRequests, (count) => count > previousRequests);
          assert.equal(unexpectedCredential, false, 'provider must use only the synthetic fixture credential');
          if (turn === 0) {
            const projects = await request(scope, '/agent/projects');
            const active = projects.body.projects.find((entry) => entry.id === project.body.project.id);
            assert(Date.parse(active.lastActiveAt) > Date.parse('2000-01-01T00:00:00.000Z'), 'accepted turn must refresh project activity');
          }
          const cancelled = await request(scope, `/agent/chat/${sessionId}/cancel/${accepted.body.requestId}`, { method: 'DELETE' });
          assert.equal(cancelled.status, 200);
          assert.equal(cancelled.body.success, true);
          const terminal = await waitFor(
            `${engine} provider cancellation did not reap its child`,
            async () => next(),
            (event) => event.value?.type === 'status'
              && event.value?.data?.requestId === accepted.body.requestId
              && event.value?.data?.status === 'cancelled',
          );
          assert.equal(terminal.value.data.requestId, accepted.body.requestId);
        }
        if (engine === 'claude') {
          const database = new DatabaseSync(join(scope.directory, 'agent.db'));
          database.prepare('UPDATE sessions SET engine_session_id = ? WHERE id = ?').run('11111111-2222-4333-8444-555555555555', sessionId);
          database.close();
          const previousRequests = apiRequests;
          const invalid = await request(scope, `/agent/chat/${sessionId}/act`, {
            method: 'POST',
            body: JSON.stringify({ projectId: project.body.project.id, dbSessionId: sessionId, cliPreference: engine, instruction: 'Resume the selected local-only session.' }),
          });
          assert.equal(invalid.status, 200);
          await waitFor(
            'invalid real SDK resume must clear its durable identity',
            async () => request(scope, `/agent/sessions/${sessionId}`),
            (response) => response.body.session.engineSessionId == null,
          );
          await waitFor(
            'invalid resume must terminate as an error',
            async () => next(),
            (event) => event.value?.type === 'status'
              && event.value?.data?.requestId === invalid.body.requestId
              && event.value?.data?.status === 'error',
          );
          assert.equal(apiRequests, previousRequests, 'invalid resume must not silently retry as a fresh model query');
        }
      } finally { await reader.cancel(); }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    }
  });
  console.log(`PASS actual ${engine}: local-only startup${engine === 'claude' ? ', resume and invalid-resume clear' : ''} → activity → cancel/reap; no real credentials or model response`);
}

export async function verify() {
  const reference = await agentFleetReference();
  assert.deepEqual(await exercise(), reference.agent, 'agent project/session/message/SSE/cancel diverged from the captured Node contract');

  await actualProviderExecution('claude');
  await actualProviderExecution('codex');
  await verifyAgentApplicationRoutes();
  if (process.platform === 'darwin') await verifyMacOsRoutes();
  console.log('PASS agent: Rust CRUD, persisted history, SSE acknowledgement, reset, and cancellation response contract');
  if (process.env.HC_TEST_CLAUDE !== '1') {
    console.log('UNEXERCISED Claude provider: set HC_TEST_CLAUDE=1, HC_TEST_CLAUDE_SDK_ROOT, and HC_TEST_THIRD_PARTY_ADAPTER for the Rust provider → JSONL adapter → SDK system:init/cancel/reap smoke');
  }
  if (process.env.HC_TEST_CODEX !== '1') {
    console.log('UNEXERCISED Codex CLI: set HC_TEST_CODEX=1 for the real CLI → local fault API → cancel/reap smoke');
  }
}
