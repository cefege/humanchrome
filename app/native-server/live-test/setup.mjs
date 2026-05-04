/**
 * Live-test setup: boot a tiny static fixture server and connect two MCP
 * clients to the running bridge. Tests own their tabs (open and close them
 * within `run`) so they don't leak state across the suite.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures');

const DEFAULT_BRIDGE_PORT = 12306;
const DEFAULT_FIXTURE_PORT = 12397;

function mimeFor(filename) {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filename.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Start the fixture server. Returns `{port, baseUrl, close}`.
 */
export async function startFixtureServer(port = DEFAULT_FIXTURE_PORT) {
  const server = http.createServer(async (req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    const safe = reqPath === '/' ? '/index.html' : reqPath;
    // Reject any path that escapes the fixture dir.
    const candidate = path.normalize(path.join(FIXTURE_DIR, safe));
    if (!candidate.startsWith(FIXTURE_DIR)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    try {
      const buf = await fs.readFile(candidate);
      res.statusCode = 200;
      res.setHeader('Content-Type', mimeFor(candidate));
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export async function connectClients(bridgePort = DEFAULT_BRIDGE_PORT) {
  const baseUrl = `http://127.0.0.1:${bridgePort}`;
  // Sanity-check bridge is up before initializing.
  try {
    const ping = await fetch(`${baseUrl}/ping`);
    if (!ping.ok) throw new Error(`bridge /ping returned ${ping.status}`);
  } catch (err) {
    throw new Error(
      `Bridge not reachable at ${baseUrl}: ${err.message}. Make sure Chrome is running with the extension loaded — that's what spawns the native host.`,
    );
  }
  const A = new McpClient(baseUrl, 'A');
  const B = new McpClient(baseUrl, 'B');
  await A.initialize();
  await B.initialize();
  return { A, B, baseUrl };
}

/**
 * Navigate `client` to a fixture page and return the resulting tabId.
 * Returns null when navigate didn't yield a tabId — callers fail their
 * precondition check in that case. The default warmup gives the page a
 * beat to commit its document so accessibility-tree / ref-based tools
 * have a real DOM to walk on the first message.
 */
export async function openFixture(client, fixtureBase, page = 'index.html', { warmupMs = 200 } = {}) {
  const result = await client.callTool('chrome_navigate', {
    url: `${fixtureBase}/${page}`,
  });
  const payload = client.parseTextPayload(result);
  const tabId = payload?.tabId ?? payload?.tab?.id ?? null;
  if (typeof tabId === 'number' && warmupMs > 0) {
    await new Promise((r) => setTimeout(r, warmupMs));
  }
  return tabId;
}

/**
 * Best-effort tab cleanup: close any tabs whose URL points at the fixture
 * server. Used in test teardown so a flaky run doesn't leave the user's
 * Chrome cluttered.
 */
export async function closeFixtureTabs(client, fixtureBase) {
  try {
    const result = await client.callTool('get_windows_and_tabs', {});
    const parsed = client.parseTextPayload(result);
    const ids = [];
    const windows = Array.isArray(parsed?.windows) ? parsed.windows : [];
    for (const w of windows) {
      for (const t of w.tabs ?? []) {
        if (typeof t.url === 'string' && t.url.startsWith(fixtureBase)) {
          ids.push(t.id);
        }
      }
    }
    if (ids.length) {
      await client.callTool('chrome_close_tabs', { tabIds: ids });
    }
  } catch {
    // best-effort; teardown failures shouldn't fail the run
  }
}
