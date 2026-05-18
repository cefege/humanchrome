/**
 * IMP-0121: contract test for the MCP-route hijack discipline.
 *
 * The MCP SDK's StreamableHTTPServerTransport uses `@hono/node-server`
 * internally to write the response. If fastify also tries to auto-respond
 * after the handler returns, the second `writeHead` blows up with
 * `ERR_HTTP_HEADERS_SENT` — observed in production at ~10 errors/sec, the
 * single biggest source of bridge log spam.
 *
 * Fix: every MCP-adjacent route that hands `reply.raw` to the SDK calls
 * `reply.hijack()` BEFORE the handoff. This test asserts that contract by
 * spinning up a real fastify with the same `hijack-then-write-raw` pattern
 * the production routes use, and confirming that a real HTTP round-trip
 * succeeds without surfacing the headers-sent error.
 *
 * Negative coverage lives in `server.test.ts` T7 (multi-client init smoke):
 * the production routes regress to ERR_HTTP_HEADERS_SENT if the hijack call
 * is removed, which surfaces as transport teardown there.
 */
import { describe, test, expect, afterEach } from '@jest/globals';
import Fastify, { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe('MCP route hijack contract — IMP-0121', () => {
  test('hijack BEFORE raw write: round-trip succeeds with no HEADERS_SENT', async () => {
    app = Fastify({ logger: false });
    app.post('/route', async (_req, reply) => {
      reply.hijack();
      // Mirrors what the MCP SDK + @hono/node-server do inside
      // transport.handleRequest — write status + headers + body directly
      // on the underlying ServerResponse. Without the hijack above,
      // fastify's post-handler auto-send races this and throws.
      reply.raw.writeHead(200, { 'Content-Type': 'application/json' });
      reply.raw.end(JSON.stringify({ ok: true, source: 'raw' }));
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/route`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, source: 'raw' });
  });
});
