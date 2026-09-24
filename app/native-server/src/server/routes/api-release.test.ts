import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import supertest from 'supertest';

const sendMessageMock = jest.fn();
jest.mock('../../native-messaging-host', () => ({
  __esModule: true,
  default: {
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  },
}));

import { createSecurityPreHandler } from '../index';
import { registerApiRoutes } from './api';

describe('POST /api/clients/:clientId/release', () => {
  const app = Fastify({ logger: false });
  const originalToken = process.env.HUMANCHROME_TOKEN;

  beforeAll(async () => {
    process.env.HUMANCHROME_TOKEN = 'bridge-secret';
    app.addHook('preHandler', createSecurityPreHandler());
    registerApiRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalToken === undefined) delete process.env.HUMANCHROME_TOKEN;
    else process.env.HUMANCHROME_TOKEN = originalToken;
  });

  test('releases a normalized client lane', async () => {
    sendMessageMock.mockClear();
    const response = await supertest(app.server)
      .post('/api/clients/Alice/release')
      .set('authorization', 'Bearer bridge-secret')
      .expect(200);

    expect(response.body).toEqual({ released: 'alice' });
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'client_disconnected',
      clientId: 'alice',
    });
  });

  test('rejects an invalid client id', async () => {
    const response = await supertest(app.server)
      .post('/api/clients/%20/release')
      .set('authorization', 'Bearer bridge-secret')
      .expect(400);
    expect(response.body).toEqual({ error: 'invalid_client_id' });
  });
});
