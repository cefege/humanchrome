#!/usr/bin/env node
/**
 * Standalone bridge HTTP smoke test.
 *
 * Verifies the two patches that don't require a live Chrome extension:
 *   T7  — multi-client: two simultaneous /mcp initializes both succeed.
 *   T11 — admin/reset: clears stuck transports and a follow-up init works.
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

const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mihai-fork-smoke', version: '0.0.0' },
  },
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
  const sessionId = resp.headers.get('mcp-session-id') || undefined;
  const text = await resp.text();
  return { status: resp.status, body: parseMcpResponseBody(text) ?? text, sessionId };
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
  let s1, s2;
  {
    const [a, b] = await Promise.all([
      rpc(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: acceptHeaders,
        body: JSON.stringify(initBody),
      }),
      rpc(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: acceptHeaders,
        body: JSON.stringify(initBody),
      }),
    ]);
    s1 = a.sessionId;
    s2 = b.sessionId;
    const ok = a.status === 200 && b.status === 200 && !!s1 && !!s2 && s1 !== s2;
    log('T7 multi-client init: two simultaneous sessions accepted', ok, `s1=${s1} s2=${s2}`);
  }

  // T11 admin/reset
  {
    const { status, body } = await rpc(`${baseUrl}/admin/reset`, { method: 'POST' });
    const cleared = body?.cleared ?? -1;
    log('T11 /admin/reset: ok=true, cleared >= 2', status === 200 && body?.ok === true && cleared >= 2, JSON.stringify(body));
  }

  // After reset, fresh init still works.
  {
    const { status, sessionId } = await rpc(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: acceptHeaders,
      body: JSON.stringify(initBody),
    });
    log(
      'T11 follow-up: fresh init succeeds with new session',
      status === 200 && !!sessionId && sessionId !== s1 && sessionId !== s2,
      sessionId,
    );
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
