import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executable, frame, isolatedRun, NativePeer } from './process-host.mjs';
import { normalize } from './native-fixtures.mjs';
import { agentFleetReference } from './agent-fleet-reference.mjs';

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN = 'agent-route-fixture-token';

async function request(scope, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${scope.port}${path}`, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.authorized === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

async function requestBytes(scope, path) {
  const response = await fetch(`http://127.0.0.1:${scope.port}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
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
  `).run('legacy-route-project', 'Legacy route project', workspace, 'codex', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  database.close();
}

async function start(scope) {
  const [command, args] = executable();
  const peer = new NativePeer(scope.spawn(command, args, {
    HUMANCHROME_TOKEN: TOKEN,
    MCP_ALLOWED_WORKSPACE_BASE: '',
  }));
  const started = await peer.exchange(frame({ type: 'start', payload: { port: scope.port, extensionId: 'agent-route-fixture' } }));
  assert.equal(started.type, 'server_started');
}

async function exercise() {
  return isolatedRun(async (scope) => {
    const home = join(scope.directory, 'home');
    const workspace = join(home, 'workspace');
    const requestedDirectory = join(home, 'workspaces', 'created-from-route');
    await mkdir(workspace, { recursive: true });
    seedLegacyDatabase(scope, workspace);
    await start(scope);

    const unauthorized = await request(scope, '/agent/projects/default-root', {
      method: 'POST',
      body: JSON.stringify({ projectName: 'Blocked' }),
      authorized: false,
    });
    assert.deepEqual(unauthorized, {
      status: 401,
      body: { error: 'Invalid or missing bearer token' },
      headers: unauthorized.headers,
    });

    const defaultWorkspace = await request(scope, '/agent/projects/default-workspace');
    assert.equal(defaultWorkspace.status, 200);
    assert.deepEqual(defaultWorkspace.body, { success: true, path: join(home, '.humanchrome-agent', 'workspaces') });

    const defaultRoot = await request(scope, '/agent/projects/default-root', {
      method: 'POST',
      body: JSON.stringify({ projectName: '  Route Fixture -- Project!  ' }),
    });
    assert.deepEqual(defaultRoot.body, { success: true, path: join(home, '.humanchrome-agent', 'workspaces', 'route-fixture-project') });

    const missingProjectName = await request(scope, '/agent/projects/default-root', { method: 'POST', body: '{}' });
    assert.deepEqual(missingProjectName.body, { error: 'projectName is required' });
    assert.equal(missingProjectName.status, 400);

    const missingRoot = await request(scope, '/agent/projects/validate-path', { method: 'POST', body: '{}' });
    assert.deepEqual(missingRoot.body, { error: 'rootPath is required' });
    assert.equal(missingRoot.status, 400);

    const validationBefore = await request(scope, '/agent/projects/validate-path', {
      method: 'POST',
      body: JSON.stringify({ rootPath: requestedDirectory }),
    });
    assert.deepEqual(validationBefore.body, {
      valid: true,
      absolute: requestedDirectory,
      exists: false,
      needsCreation: true,
    });

    const createdDirectory = await request(scope, '/agent/projects/create-directory', {
      method: 'POST',
      body: JSON.stringify({ absolutePath: requestedDirectory }),
    });

    const escapedRoot = `${home}/../outside-agent-workspace`;
    const escapedValidation = await request(scope, '/agent/projects/validate-path', {
      method: 'POST',
      body: JSON.stringify({ rootPath: escapedRoot }),
    });
    assert.equal(escapedValidation.status, 200);
    assert.deepEqual(escapedValidation.body, {
      valid: false,
      absolute: join(scope.directory, 'outside-agent-workspace'),
      exists: false,
      needsCreation: false,
      error: `Project rootPath must be under allowed directories: ${home}, ${home}`,
    });

    const prefixCompatibleRoot = `${home}-prefix-compatible`;
    const prefixValidation = await request(scope, '/agent/projects/validate-path', {
      method: 'POST',
      body: JSON.stringify({ rootPath: prefixCompatibleRoot }),
    });
    assert.deepEqual(prefixValidation.body, {
      valid: true,
      absolute: prefixCompatibleRoot,
      exists: false,
      needsCreation: true,
    });
    assert.deepEqual(createdDirectory.body, { success: true, path: requestedDirectory });

    const duplicateDirectory = await request(scope, '/agent/projects/create-directory', {
      method: 'POST',
      body: JSON.stringify({ absolutePath: requestedDirectory }),
    });
    assert.equal(duplicateDirectory.status, 400);
    assert.deepEqual(duplicateDirectory.body, { error: 'Directory already exists' });

    const missingProjectRoot = await request(scope, '/agent/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Incomplete project' }),
    });
    assert.equal(missingProjectRoot.status, 400);
    assert.deepEqual(missingProjectRoot.body, { error: 'name and rootPath are required to create a project' });

    const project = await request(scope, '/agent/projects', {
      method: 'POST',
      body: JSON.stringify({
        id: 'route-fixture-project',
        name: 'Route fixture project',
        rootPath: requestedDirectory,
        preferredCli: 'codex',
        description: 'created through the public route',
      }),
    });
    assert.equal(project.status, 200);
    const projectId = project.body.project.id;
    assert.equal(projectId, 'route-fixture-project');

    const legacyProjects = await request(scope, '/agent/projects');
    assert.equal(legacyProjects.status, 200);
    assert.equal(legacyProjects.body.projects.some((entry) => entry.id === 'legacy-route-project'), true);

    const missingOpenTarget = await request(scope, `/agent/projects/${projectId}/open`, { method: 'POST', body: '{}' });
    assert.equal(missingOpenTarget.status, 400);
    assert.deepEqual(missingOpenTarget.body, { success: false, error: 'target is required' });

    const invalidOpenTarget = await request(scope, `/agent/projects/${projectId}/open`, {
      method: 'POST',
      body: JSON.stringify({ target: 'finder' }),
    });
    assert.equal(invalidOpenTarget.status, 400);
    assert.deepEqual(invalidOpenTarget.body, {
      success: false,
      error: 'Invalid target. Must be one of: vscode, terminal',
    });

    const missingOpenFilePath = await request(scope, `/agent/projects/${projectId}/open-file`, { method: 'POST', body: '{}' });
    assert.equal(missingOpenFilePath.status, 400);
    assert.deepEqual(missingOpenFilePath.body, { success: false, error: 'filePath is required' });

    const missingEngine = await request(scope, `/agent/projects/${projectId}/sessions`, { method: 'POST', body: '{}' });
    assert.equal(missingEngine.status, 400);
    assert.deepEqual(missingEngine.body, { error: 'engineName is required' });

    const invalidEngine = await request(scope, `/agent/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ engineName: 'invalid' }),
    });
    assert.equal(invalidEngine.status, 400);
    assert.deepEqual(invalidEngine.body, { error: 'Invalid engineName. Must be one of: claude, codex, cursor, qwen, glm' });

    const createdSession = await request(scope, `/agent/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        engineName: 'codex',
        name: ' Route session ',
        model: 'gpt-5',
        permissionMode: 'plan',
        allowDangerouslySkipPermissions: false,
        systemPromptConfig: { type: 'custom', text: 'route fixture' },
        optionsConfig: { maxTurns: 3 },
      }),
    });
    assert.equal(createdSession.status, 201);
    const sessionId = createdSession.body.session.id;

    const updatedSession = await request(scope, `/agent/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: ' Updated route session ',
        model: null,
        managementInfo: { lastUpdated: '2026-02-03T04:05:06.000Z', model: 'gpt-5' },
      }),
    });
    assert.equal(updatedSession.status, 200);
    assert.equal(updatedSession.body.session.name, 'Updated route session');
    assert.equal('model' in updatedSession.body.session, false);

    const sessionClaudeInfo = await request(scope, `/agent/sessions/${sessionId}/claude-info`);
    assert.deepEqual(sessionClaudeInfo.body, {
      managementInfo: { lastUpdated: '2026-02-03T04:05:06.000Z', model: 'gpt-5' },
      sessionId,
      engineName: 'codex',
    });

    const projectClaudeInfo = await request(scope, `/agent/projects/${projectId}/claude-info`);
    assert.deepEqual(projectClaudeInfo.body, {
      managementInfo: null,
      projectId,
      sessionsWithInfo: 0,
    });

    const sessions = await request(scope, `/agent/projects/${projectId}/sessions`);
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.sessions.length, 1);
    assert.equal(sessions.body.sessions[0].id, sessionId);

    const firstMessage = await request(scope, `/agent/chat/${projectId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'route-message-one',
        sessionId,
        conversationId: 'conversation-one',
        role: 'ASSISTANT',
        messageType: 'unknown-type',
        content: '  normalized content  ',
        metadata: { retained: true },
        cliSource: 'codex',
        requestId: 'route-request',
        createdAt: '2026-02-03T04:05:06.000Z',
      }),
    });
    assert.equal(firstMessage.status, 201);
    assert.deepEqual(firstMessage.body.data, {
      id: 'route-message-one',
      projectId,
      sessionId,
      conversationId: 'conversation-one',
      role: 'assistant',
      content: 'normalized content',
      messageType: 'chat',
      metadata: { retained: true },
      cliSource: 'codex',
      requestId: 'route-request',
      createdAt: '2026-02-03T04:05:06.000Z',
    });

    const secondMessage = await request(scope, `/agent/chat/${projectId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ id: 'route-message-two', conversationId: 'conversation-two', role: 'system', content: 'status message' }),
    });
    assert.equal(secondMessage.status, 201);
    assert.equal(secondMessage.body.data.sessionId, '');
    assert.equal(secondMessage.body.data.messageType, 'status');

    const updatedMessage = await request(scope, `/agent/chat/${projectId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ id: 'route-message-one', sessionId, conversationId: 'conversation-one', content: 'replacement content' }),
    });
    assert.equal(updatedMessage.status, 201);

    const page = await request(scope, `/agent/chat/${projectId}/messages?limit=1&offset=0`);
    assert.deepEqual(page.body.pagination, { limit: 1, offset: 0, count: 1, hasMore: true });
    assert.equal(page.body.totalCount, 2);
    assert.equal(page.body.data[0].content, 'replacement content');

    const history = await request(scope, `/agent/sessions/${sessionId}/history?limit=1&offset=0`);
    assert.deepEqual(history.body.pagination, { limit: 1, offset: 0, count: 1, hasMore: false });
    assert.equal(history.body.messages[0].id, 'route-message-one');

    const missingContent = await request(scope, `/agent/chat/${projectId}/messages`, { method: 'POST', body: '{}' });
    assert.equal(missingContent.status, 400);
    assert.deepEqual(missingContent.body, { success: false, error: 'content is required' });

    const deletedConversation = await request(scope, `/agent/chat/${projectId}/messages?conversationId=conversation-one`, { method: 'DELETE' });
    assert.deepEqual(deletedConversation.body, { success: true, deleted: 1 });

    const dataDir = join(home, '.humanchrome-agent');
    const attachmentDirectory = join(dataDir, 'attachments', projectId);
    const attachmentBytes = Buffer.from('\x89PNG\r\n\x1a\nroute fixture image');
    await mkdir(attachmentDirectory, { recursive: true });
    await writeFile(join(attachmentDirectory, 'route-image.png'), attachmentBytes);

    const stats = await request(scope, '/agent/attachments/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.success, true);
    assert.equal(stats.body.totalFiles, 1);
    assert.equal(stats.body.totalBytes, attachmentBytes.length);
    assert.equal(stats.body.projects[0].projectId, projectId);
    assert.equal(stats.body.projects[0].projectName, 'Route fixture project');
    assert.equal(stats.body.projects[0].existsInDb, true);

    const attachment = await requestBytes(scope, `/agent/attachments/${projectId}/route-image.png`);
    assert.equal(attachment.status, 200);
    assert.equal(attachment.headers.get('content-type'), 'image/png');
    assert.equal(attachment.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(attachment.body, attachmentBytes);

    const invalidAttachment = await request(scope, `/agent/attachments/${projectId}/.hidden.png`);
    assert.equal(invalidAttachment.status, 400);
    assert.match(invalidAttachment.body.error, /Invalid filename/);

    const cleanedProject = await request(scope, `/agent/attachments/${projectId}`, { method: 'DELETE' });
    assert.equal(cleanedProject.status, 200);
    assert.deepEqual(cleanedProject.body.scope, 'project');
    assert.equal(cleanedProject.body.removedFiles, 1);
    assert.equal(cleanedProject.body.removedBytes, attachmentBytes.length);

    await mkdir(attachmentDirectory, { recursive: true });
    await writeFile(join(attachmentDirectory, 'route-image-selected.png'), attachmentBytes);
    const selectedCleanup = await request(scope, '/agent/attachments', {
      method: 'DELETE',
      body: JSON.stringify({ projectIds: [projectId] }),
    });
    assert.equal(selectedCleanup.status, 200);
    assert.equal(selectedCleanup.body.scope, 'selected');
    assert.equal(selectedCleanup.body.removedFiles, 1);
    assert.equal(selectedCleanup.body.removedBytes, attachmentBytes.length);

    const allCleanup = await request(scope, '/agent/attachments', { method: 'DELETE', body: '{}' });
    assert.deepEqual(allCleanup.body, {
      success: true,
      scope: 'all',
      removedFiles: 0,
      removedBytes: 0,
      results: [],
    });

    const deletedSession = await request(scope, `/agent/sessions/${sessionId}`, { method: 'DELETE' });
    assert.equal(deletedSession.status, 204);
    const missingSession = await request(scope, `/agent/sessions/${sessionId}`);
    assert.deepEqual(missingSession, { status: 404, body: { error: 'Session not found' }, headers: missingSession.headers });

    return normalize({
      defaultRoot: defaultRoot.body,
      validationBefore: validationBefore.body,
      session: {
        name: updatedSession.body.session.name,
        managementInfo: updatedSession.body.session.managementInfo,
        projectSessions: sessions.body.sessions.length,
      },
      messages: {
        page: page.body.pagination,
        history: history.body.pagination,
        deleted: deletedConversation.body.deleted,
        missingContent: missingContent.body,
      },
      attachment: {
        contentType: attachment.headers.get('content-type'),
        bytes: attachment.body.toString('base64'),
        cleanup: {
          scope: cleanedProject.body.scope,
          removedFiles: cleanedProject.body.removedFiles,
          removedBytes: cleanedProject.body.removedBytes,
        },
      },
    }, scope);
  });
}

export async function verifyAgentApplicationRoutes() {
  const reference = await agentFleetReference();
  assert.deepEqual(await exercise(), reference.agentApplication, 'agent route-family diverged from the captured Node contract');
}
