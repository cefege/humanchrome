/**
 * Locks the wire contract for caller-supplied sessionName:
 *  - When a Streamable HTTP client sends `X-Humanchrome-Session: <name>` on
 *    the initialize POST, the server uses the normalized name as the
 *    mcp-session-id (so subsequent requests with that id route correctly
 *    and the extension sees the same clientId across reconnects).
 *  - When no header is sent, the server falls back to a UUID.
 *  - When two callers init with the same sessionName, the second wins
 *    (the first transport is closed).
 *
 * Mocks the native messaging host so the disconnect-notification path is
 * observable without a real native port.
 */
import { describe, expect, test, afterAll, beforeAll, jest } from '@jest/globals';
import supertest from 'supertest';

import nativeMessagingHostInstance from '../native-messaging-host';
import Server from './index';

// Replace the real implementation so test runs don't write the 4-byte
// length-prefixed native protocol bytes to stdout (which would corrupt
// jest's progress output and could surface intermittently as garbled
// characters in CI logs).
const sendMessageSpy = jest
  .spyOn(nativeMessagingHostInstance, 'sendMessage')
  .mockImplementation(() => undefined);

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

describe('Streamable HTTP sessionName header', () => {
  beforeAll(async () => {
    await Server.getInstance().ready();
  }, 30_000);

  afterAll(async () => {
    await Server.stop();
  }, 30_000);

  test('uses the normalized header as the mcp-session-id', async () => {
    const agent = supertest(Server.getInstance().server);
    const res = await agent
      .post('/mcp')
      .set({ ...sseAcceptHeaders, 'x-humanchrome-session': 'Acme-Project ' })
      .send(initBody);
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBe('acme-project');
  });

  test('falls back to UUID when no header is sent', async () => {
    const agent = supertest(Server.getInstance().server);
    const res = await agent.post('/mcp').set(sseAcceptHeaders).send(initBody);
    expect(res.status).toBe(200);
    const sid = res.headers['mcp-session-id'];
    expect(sid).toBeTruthy();
    // UUID v4 shape — not the literal we'd get from a header.
    expect(sid).toMatch(/^[0-9a-f-]{20,}$/i);
  });

  test('same name twice → second connection takes over; first is closed', async () => {
    const agent = supertest(Server.getInstance().server);
    sendMessageSpy.mockClear();
    const first = await agent
      .post('/mcp')
      .set({ ...sseAcceptHeaders, 'x-humanchrome-session': 'reclaim-me' })
      .send(initBody);
    expect(first.headers['mcp-session-id']).toBe('reclaim-me');

    const second = await agent
      .post('/mcp')
      .set({ ...sseAcceptHeaders, 'x-humanchrome-session': 'reclaim-me' })
      .send(initBody);
    expect(second.headers['mcp-session-id']).toBe('reclaim-me');

    // Closing the first transport surfaces a CLIENT_DISCONNECTED native msg
    // with clientId 'reclaim-me' — that's the signal the extension's
    // releaseClient picks up to free the lane for the new connection.
    const disconnectCalls = sendMessageSpy.mock.calls
      .map((c) => c[0] as { type?: string; clientId?: string })
      .filter((m) => m?.type === 'client_disconnected' && m?.clientId === 'reclaim-me');
    expect(disconnectCalls.length).toBeGreaterThanOrEqual(1);
  });
});
