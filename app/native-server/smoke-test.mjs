#!/usr/bin/env node
/**
 * Standalone bridge HTTP smoke test.
 *
 * Verifies the stateless multi-client behavior that does not require a live Chrome extension.
 *
 * Runs against the compiled dist, on an alternate port, so it does not
 * disturb the user's running daily-driver bridge on 12306.
 *
 * Usage: node smoke-test.mjs   (from app/native-server/)
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Pre-set port env vars so module-time port reads pick up the alt port.
const PORT = 12399;
process.env.HUMANCHROME_PORT = String(PORT);
process.env.MCP_HTTP_PORT = String(PORT);

// Pull the pre-built singleton Server instance.
const Server = require('./dist/server/index.js').default;

// Shared MCP response parser (handles SSE multi-frame correctly — picks the
// last `data:` rather than the first, which the inline parser used to drop).
const { parseMcpResponseBody } = await import('./test-helpers/parse-mcp-response.mjs');

const listBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {},
};

const acceptHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

let passed = 0;
let failed = 0;
const log = (label, ok, extra) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ' — ' + extra : ''}`);
  if (ok) passed += 1;
  else failed += 1;
};

async function rpc(url, init = {}) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  return { status: resp.status, body: parseMcpResponseBody(text) ?? text };
}

async function main() {
  await Server.getInstance().listen({ port: PORT, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${PORT}`;
  console.log(`Bridge listening on ${baseUrl}\n`);

  // /ping baseline
  {
    const { status, body } = await rpc(`${baseUrl}/ping`);
    log('ping → 200 ok', status === 200 && body?.status === 'ok', JSON.stringify(body));
  }

  // T7 multi-client
  {
    const [a, b] = await Promise.all([
      rpc(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: acceptHeaders,
        body: JSON.stringify(listBody),
      }),
      rpc(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: acceptHeaders,
        body: JSON.stringify(listBody),
      }),
    ]);
    const ok = a.status === 200 && b.status === 200;
    log('T7 multi-client: two simultaneous stateless requests accepted', ok);
  }

  // REST surface — catalog + OpenAPI must be reachable even with no extension
  // (dynamic flows fail fast and fall back to TOOL_SCHEMAS).
  {
    const r = await fetch(`${baseUrl}/api/tools`);
    const j = await r.json();
    const ok = r.status === 200 && Array.isArray(j.tools) && j.tools.length > 0;
    log('REST /api/tools: returns tool catalog', ok, `count=${j.tools?.length}`);
  }
  {
    const r = await fetch(`${baseUrl}/api/openapi.json`);
    const j = await r.json();
    const ok = r.status === 200 && j.openapi === '3.1.0' && Object.keys(j.paths).length > 0;
    log(
      'REST /api/openapi.json: spec generated',
      ok,
      `openapi=${j.openapi} paths=${Object.keys(j.paths).length}`,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  // The dist Server holds open keep-alive sockets; force exit.
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
