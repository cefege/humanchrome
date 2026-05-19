/**
 * Regression tests for the bridge HTTP preHandler — Host header gating slice.
 *
 * Sibling files (`preHandler-{host,origin,bearer}.test.ts`) split by describe
 * so each runs in its own jest worker — combined-file boot contention used
 * to flake under parallel jest load. Boot helper is in
 * `./preHandler-test-utils.ts`; each describe hoists `bootPreHandlerApp` to
 * `beforeAll` so we get one Fastify per worker, not one per test.
 *
 * Host header gate: enforces the loopback-Host DNS-rebinding defence on
 * state-changing methods. See `createSecurityPreHandler` in ./index.ts step 1.
 *
 * We test the hook in isolation against a bare Fastify instance using
 * `inject()` rather than booting the full Server (which pulls in
 * better-sqlite3, drizzle, the agent engines, MCP transport, etc.). The
 * production code path uses the same factory, so behavioural drift is
 * impossible without a code change.
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

describe('preHandler — Host header (DNS-rebinding defence)', () => {
  test('POST with non-loopback Host is rejected with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/foo',
      headers: { host: 'evil.example.com', 'content-type': 'application/json' },
      payload: { args: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'Host not allowed' });
  });

  test('POST with loopback Host (127.0.0.1:12306) and no Origin passes the preHandler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/foo',
      headers: { host: '127.0.0.1:12306', 'content-type': 'application/json' },
      payload: { args: {} },
    });
    // The route is a stub that returns 200; the gate is "not 401/403".
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  test('GET /ping with a non-loopback Host is still allowed (only state-changing methods are gated)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { host: 'evil.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});
