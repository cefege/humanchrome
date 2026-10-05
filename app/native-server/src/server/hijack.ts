import type { FastifyReply } from 'fastify';
import { HTTP_STATUS } from '../constant';

/**
 * IMP-0121: every MCP HTTP route hands `reply.raw` to the SDK transport, which
 * writes the response itself via `@hono/node-server`. Without hijacking,
 * Fastify also auto-responds after the handler resolves and the second
 * `writeHead` blows up with `ERR_HTTP_HEADERS_SENT`. This helper hijacks before
 * the handoff and provides a uniform raw-mode error tail.
 */
export async function runHijacked(reply: FastifyReply, fn: () => Promise<void>): Promise<void> {
  reply.hijack();
  try {
    await fn();
  } catch {
    if (!reply.raw.headersSent) reply.raw.writeHead(HTTP_STATUS.INTERNAL_SERVER_ERROR);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
