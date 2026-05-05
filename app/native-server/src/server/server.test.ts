import { describe, expect, test, afterAll, beforeAll } from '@jest/globals';
import supertest from 'supertest';
import Server from './index';

const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'humanchrome-test', version: '0.0.0' },
  },
};

const sseAcceptHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

describe('Bridge HTTP smoke', () => {
  // ts-jest's first compile of the Server module pulls in the agent engines,
  // drizzle/sqlite, the MCP transport, etc — that can take a few seconds on a
  // cold jest cache. Bump the hook timeouts so CI / local first runs don't
  // flake on the default 5 s budget.
  beforeAll(async () => {
    await Server.getInstance().ready();
  }, 30_000);

  afterAll(async () => {
    await Server.stop();
  }, 30_000);

  test('GET /ping returns pong', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/ping')
      .expect(200)
      .expect('Content-Type', /json/);
    expect(response.body).toEqual({ status: 'ok', message: 'pong' });
  });

  // T7 — multi-client. Two concurrent /mcp initialize calls must both succeed,
  // each with its own session ID. The pre-fork singleton McpServer rejected
  // the second with "Already connected to a transport".
  test('T7 multi-client: two simultaneous initializes both succeed', async () => {
    const agent = supertest(Server.getInstance().server);
    const [a, b] = await Promise.all([
      agent.post('/mcp').set(sseAcceptHeaders).send(initBody),
      agent.post('/mcp').set(sseAcceptHeaders).send(initBody),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const sa = a.headers['mcp-session-id'];
    const sb = b.headers['mcp-session-id'];
    expect(sa).toBeTruthy();
    expect(sb).toBeTruthy();
    expect(sa).not.toBe(sb);
  });

  // T11 — admin/reset clears all live transports. After reset, fresh init still works.
  test('T11 POST /admin/reset clears transports and a follow-up init succeeds', async () => {
    const agent = supertest(Server.getInstance().server);
    // Open two sessions.
    const a = await agent.post('/mcp').set(sseAcceptHeaders).send(initBody);
    const b = await agent.post('/mcp').set(sseAcceptHeaders).send(initBody);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Reset.
    const reset = await agent.post('/admin/reset').expect(200);
    expect(reset.body.ok).toBe(true);
    expect(typeof reset.body.cleared).toBe('number');
    expect(reset.body.cleared).toBeGreaterThanOrEqual(2);

    // Fresh init still works.
    const c = await agent.post('/mcp').set(sseAcceptHeaders).send(initBody);
    expect(c.status).toBe(200);
    const sc = c.headers['mcp-session-id'];
    expect(sc).toBeTruthy();
    expect(sc).not.toBe(a.headers['mcp-session-id']);
  });
});
