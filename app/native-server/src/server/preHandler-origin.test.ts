/**
 * Regression tests for the bridge HTTP preHandler — Origin allowlist slice.
 *
 * Originally part of `preHandler.test.ts`; split into 3 sibling files
 * (`preHandler-{host,origin,bearer}.test.ts`) under IMP-0123 so each describe
 * block runs in its own jest worker process. See `preHandler-host.test.ts`
 * docblock for the full rationale. Boot helper lives in
 * `./preHandler-test-utils.ts`.
 *
 * Origin gate: enforces the CORS allowlist on state-changing methods when an
 * Origin header is present. See `createSecurityPreHandler` in ./index.ts step
 * 2.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import type { FastifyInstance } from 'fastify';
import { bootPreHandlerApp, captureTokenEnv } from './preHandler-test-utils';

let app: FastifyInstance;
const restoreTokenEnv = captureTokenEnv();

beforeAll(async () => {
  app = await bootPreHandlerApp(null);
});

afterAll(async () => {
  if (app) await app.close();
  restoreTokenEnv();
});

describe('preHandler — Origin allowlist', () => {
  test('POST with disallowed Origin is rejected with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/foo',
      headers: {
        host: '127.0.0.1:12306',
        origin: 'https://evil.com',
        'content-type': 'application/json',
      },
      payload: { args: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'Origin not allowed' });
  });

  test('POST with chrome-extension:// Origin passes the preHandler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/foo',
      headers: {
        host: '127.0.0.1:12306',
        origin: 'chrome-extension://abcdefghijklmnop/',
        'content-type': 'application/json',
      },
      payload: { args: {} },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});
