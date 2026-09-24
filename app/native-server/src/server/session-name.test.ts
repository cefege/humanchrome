import { describe, expect, test, afterAll, beforeAll, jest } from '@jest/globals';
import supertest from 'supertest';

import nativeMessagingHostInstance from '../native-messaging-host';
import Server from './index';

const dispatchSpy = jest.spyOn(nativeMessagingHostInstance, 'sendRequestToExtensionAndWait');

const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'humanchrome-test', version: '0.0.0' },
  },
};

const callBody = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'chrome_get_windows_and_tabs',
    arguments: {},
  },
};

const mcpHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

describe('stateless MCP client routing', () => {
  beforeAll(async () => {
    dispatchSpy.mockResolvedValue({ status: 'success', data: {} });
    await Server.getInstance().ready();
  }, 30_000);

  afterAll(async () => {
    dispatchSpy.mockRestore();
    await Server.stop();
  }, 30_000);

  test('serves a 2025 initialize without minting a session id', async () => {
    const response = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set({ ...mcpHeaders, 'x-humanchrome-session': 'Acme-Project ' })
      .send(initBody);

    expect(response.status).toBe(200);
    expect(response.text).toContain('"result"');
    expect(response.text).toContain('2025-06-18');
    expect(response.headers['mcp-session-id']).toBeUndefined();
  });

  test('routes calls with the normalized session header', async () => {
    dispatchSpy.mockClear();
    const response = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set({ ...mcpHeaders, 'x-humanchrome-session': 'Acme-Project ' })
      .send(callBody);

    expect(response.status).toBe(200);
    expect(dispatchSpy.mock.calls[0]?.[4]).toBe('acme-project');
  });

  test('routes calls without a session header through the default lane', async () => {
    dispatchSpy.mockClear();
    const response = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set(mcpHeaders)
      .send(callBody);

    expect(response.status).toBe(200);
    expect(dispatchSpy.mock.calls[0]?.[4]).toBe('default');
  });
});
