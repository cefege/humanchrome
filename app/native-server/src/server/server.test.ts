import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import supertest from 'supertest';

jest.mock('../mcp/dispatch', () => ({
  dispatchTool: jest.fn(),
  listDynamicFlowTools: jest.fn(async () => []),
}));

import Server from './index';

const listBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {},
};

const mcpHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

describe('Bridge HTTP smoke', () => {
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

  test('T7 multi-client: two simultaneous stateless lists both succeed', async () => {
    const app = Server.getInstance();
    const responses = (await Promise.all([
      app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders, payload: listBody }),
      app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders, payload: listBody }),
    ])) as unknown as Array<{ statusCode: number; headers: Record<string, string> }>;
    const [a, b] = responses;
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.headers['mcp-session-id']).toBeUndefined();
    expect(b.headers['mcp-session-id']).toBeUndefined();
  });

  test('serves a pinned 2026-07-28 client', async () => {
    const address = await Server.getInstance().listen({ port: 0, host: '127.0.0.1' });
    const client = new Client(
      { name: 'modern-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', address));
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).toContain('humanchrome');
    } finally {
      client.close();
      await Server.getInstance().close();
    }
  });
});
