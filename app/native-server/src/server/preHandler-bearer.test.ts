/**
 * Regression tests for the bridge HTTP preHandler — Bearer token slice.
 * See `preHandler-host.test.ts` for the split rationale.
 *
 * Bearer is env-sensitive (`createSecurityPreHandler` snapshots
 * `HUMANCHROME_TOKEN` at hook-creation time), so we boot two long-lived
 * Fastify instances per worker: one with `secret`, one with the padded
 * `  secret  ` variant. Each describe binds to its own instance.
 *
 * Bearer gate: when `HUMANCHROME_TOKEN` is set, every state-changing request
 * must carry a matching `Authorization: Bearer <token>` header. See
 * `createSecurityPreHandler` in ./index.ts step 3.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import type { FastifyInstance } from 'fastify';
import { bootPreHandlerApp, captureTokenEnv } from './preHandler-test-utils';

const restoreTokenEnv = captureTokenEnv();
afterAll(restoreTokenEnv);

describe('preHandler — HUMANCHROME_TOKEN bearer auth (token=secret)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await bootPreHandlerApp('secret');
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  test('POST without Authorization header is rejected with 401 when token is set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/foo',
      headers: { host: '127.0.0.1:12306', 'content-type': 'application/json' },
      payload: { args: {} },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'Invalid or missing bearer token' });
  });

  test('POST with wrong bearer token is rejected with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/foo',
      headers: {
        host: '127.0.0.1:12306',
        authorization: 'Bearer wrong',
        'content-type': 'application/json',
      },
      payload: { args: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  test('POST with correct bearer token passes the preHandler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/foo',
      headers: {
        host: '127.0.0.1:12306',
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      payload: { args: {} },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

describe('preHandler — HUMANCHROME_TOKEN bearer auth (token="  secret  ", trim behaviour)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await bootPreHandlerApp('  secret  ');
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  test('whitespace around the configured token is trimmed before comparison', async () => {
    // Documented in `createSecurityPreHandler`: env value is `.trim()`ed at
    // hook-creation time. A bearer header carrying the un-padded token must
    // still match (the configured "  secret  " is trimmed to "secret" at
    // factory time, so the exact compare against the presented "secret"
    // succeeds).
    const ok = await app.inject({
      method: 'POST',
      url: '/api/tools/foo',
      headers: {
        host: '127.0.0.1:12306',
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      payload: { args: {} },
    });
    expect(ok.statusCode).not.toBe(401);
  });
});
