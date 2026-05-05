/**
 * Regression tests for the bridge HTTP preHandler shipped in round 3.
 *
 * The preHandler enforces three layers on state-changing methods (POST / PUT
 * / DELETE / PATCH) — see `createSecurityPreHandler` in ./index.ts:
 *   1. Host header must be loopback (DNS-rebinding defence).
 *   2. Origin header (if present) must match the CORS allowlist.
 *   3. If `HUMANCHROME_TOKEN` is set, the request must carry a matching
 *      `Authorization: Bearer <token>` header.
 *
 * We test the hook in isolation against a bare Fastify instance using
 * `inject()` rather than booting the full Server (which pulls in
 * better-sqlite3, drizzle, the agent engines, MCP transport, etc.). The
 * production code path uses the same factory, so behavioural drift is
 * impossible without a code change.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import Fastify, { FastifyInstance } from 'fastify';

// Build a fresh Fastify instance per test so token captured at hook-creation
// time reflects the current `process.env.HUMANCHROME_TOKEN`.
async function buildServer(): Promise<FastifyInstance> {
  // Re-require so the env-snapshot inside `createSecurityPreHandler` reflects
  // any test-time mutations to `process.env.HUMANCHROME_TOKEN`. Jest module
  // cache makes this cheap.
  jest.resetModules();
  const { createSecurityPreHandler } = require('./index');

  const app = Fastify({ logger: false });
  app.addHook('preHandler', createSecurityPreHandler());

  // Catch-all route so we can assert "preHandler allowed the request through"
  // by checking for a 200, distinct from the preHandler's 401/403.
  app.all('/api/tools/:name', async (req, reply) => {
    reply.status(200).send({ ok: true, name: (req.params as { name: string }).name });
  });
  app.get('/ping', async (_req, reply) => {
    reply.status(200).send({ status: 'ok' });
  });
  await app.ready();
  return app;
}

let app: FastifyInstance;
const ORIGINAL_TOKEN = process.env.HUMANCHROME_TOKEN;

beforeEach(() => {
  delete process.env.HUMANCHROME_TOKEN;
});

afterEach(async () => {
  if (app) await app.close();
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.HUMANCHROME_TOKEN;
  } else {
    process.env.HUMANCHROME_TOKEN = ORIGINAL_TOKEN;
  }
});

// ===========================================================================
// Host header gating
// ===========================================================================

describe('preHandler — Host header (DNS-rebinding defence)', () => {
  test('POST with non-loopback Host is rejected with 403', async () => {
    app = await buildServer();
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
    app = await buildServer();
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
    app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { host: 'evil.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});

// ===========================================================================
// Origin header gating
// ===========================================================================

describe('preHandler — Origin allowlist', () => {
  test('POST with disallowed Origin is rejected with 403', async () => {
    app = await buildServer();
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
    app = await buildServer();
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

// ===========================================================================
// Bearer token gating
// ===========================================================================

describe('preHandler — HUMANCHROME_TOKEN bearer auth', () => {
  test('POST without Authorization header is rejected with 401 when token is set', async () => {
    process.env.HUMANCHROME_TOKEN = 'secret';
    app = await buildServer();
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
    process.env.HUMANCHROME_TOKEN = 'secret';
    app = await buildServer();
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
    process.env.HUMANCHROME_TOKEN = 'secret';
    app = await buildServer();
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

  test('whitespace around the configured token is trimmed before comparison', async () => {
    // Documented in `createSecurityPreHandler`: env value is `.trim()`ed at
    // hook-creation time. A bearer header with leading whitespace inside the
    // token value should still mismatch (the comparison is exact).
    process.env.HUMANCHROME_TOKEN = '  secret  ';
    app = await buildServer();
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
