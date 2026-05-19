/**
 * Shared test-only helper for the preHandler regression suites
 * (`preHandler-host.test.ts` / `preHandler-origin.test.ts` /
 * `preHandler-bearer.test.ts`).
 *
 * Each slice file boots a Fastify instance once in `beforeAll` (per IMP-0123:
 * amortising the ~50ms cost across tests in the worker keeps every test under
 * jest's per-test timeout under parallel load). The boot recipe is identical
 * across slices apart from the `HUMANCHROME_TOKEN` env value the hook factory
 * snapshots — so it lives here as `bootPreHandlerApp(tokenEnvValue)`.
 *
 * Filename intentionally avoids the `.test.ts` suffix so jest's `testMatch`
 * skips it; it's importable but not executed as a test file.
 */
import { jest } from '@jest/globals';
import Fastify, { FastifyInstance } from 'fastify';

/**
 * Boot a fresh Fastify mounted with `createSecurityPreHandler`.
 *
 * `tokenEnvValue` is written to `process.env.HUMANCHROME_TOKEN` BEFORE the
 * hook factory is required — so the trim/snapshot semantics in
 * `createSecurityPreHandler` are exercised exactly as in production. Pass
 * `null` to clear the env (no bearer required).
 */
export async function bootPreHandlerApp(tokenEnvValue: string | null): Promise<FastifyInstance> {
  if (tokenEnvValue === null) {
    delete process.env.HUMANCHROME_TOKEN;
  } else {
    process.env.HUMANCHROME_TOKEN = tokenEnvValue;
  }

  // Re-require so the env-snapshot inside `createSecurityPreHandler` reflects
  // the current value. Jest module cache makes this cheap.
  jest.resetModules();

  const { createSecurityPreHandler } = require('./index');

  const app = Fastify({ logger: false });
  app.addHook('preHandler', createSecurityPreHandler());

  // Catch-all route so callers can assert "preHandler allowed the request
  // through" by checking for a 200, distinct from the preHandler's 401/403.
  app.all('/api/tools/:name', async (req, reply) => {
    reply.status(200).send({ ok: true, name: (req.params as { name: string }).name });
  });
  app.get('/ping', async (_req, reply) => {
    reply.status(200).send({ status: 'ok' });
  });

  await app.ready();
  return app;
}

/**
 * Snapshot the test-run's original `HUMANCHROME_TOKEN` and return a restorer.
 * Call in module scope; invoke the returned function from `afterAll` to put
 * the env back the way we found it.
 */
export function captureTokenEnv(): () => void {
  const original = process.env.HUMANCHROME_TOKEN;
  return () => {
    if (original === undefined) {
      delete process.env.HUMANCHROME_TOKEN;
    } else {
      process.env.HUMANCHROME_TOKEN = original;
    }
  };
}
