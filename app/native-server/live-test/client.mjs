/**
 * Minimal MCP-over-HTTP client used by the live-test harness.
 *
 * The bridge is already running (the extension launched it via native
 * messaging on port 12306). We don't start a server here — we just speak
 * StreamableHTTP MCP to it.
 */
import { parseMcpResponseBody as parseBody } from '../test-helpers/parse-mcp-response.mjs';

const ACCEPT_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

let nextRpcId = 1;

export class McpClient {
  constructor(baseUrl, label = 'A') {
    this.baseUrl = baseUrl;
    this.label = label;
    this.sessionId = null;
  }

  async initialize() {
    const body = {
      jsonrpc: '2.0',
      id: nextRpcId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: `live-test-${this.label}`, version: '0.0.0' },
      },
    };
    const resp = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: ACCEPT_HEADERS,
      body: JSON.stringify(body),
    });
    this.sessionId = resp.headers.get('mcp-session-id');
    const text = await resp.text();
    const parsed = parseBody(text);
    if (resp.status !== 200 || !this.sessionId) {
      throw new Error(
        `initialize failed: status=${resp.status} sessionId=${this.sessionId} body=${text}`,
      );
    }
    return parsed;
  }

  async listTools() {
    const body = {
      jsonrpc: '2.0',
      id: nextRpcId++,
      method: 'tools/list',
    };
    const resp = await this._post(body);
    return resp?.result?.tools ?? [];
  }

  /**
   * Call a tool. Returns the raw MCP `result` (with `content`, `isError`).
   */
  async callTool(name, args = {}) {
    const body = {
      jsonrpc: '2.0',
      id: nextRpcId++,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    const resp = await this._post(body);
    return resp?.result ?? null;
  }

  /**
   * Convenience: parse the first text content block of a tool response as JSON.
   * Tools serialize structured payloads as JSON inside a single text block;
   * the structured-error envelope also uses this shape.
   */
  parseTextPayload(toolResult) {
    const block = toolResult?.content?.find?.((c) => c.type === 'text');
    if (!block?.text) return null;
    try {
      return JSON.parse(block.text);
    } catch {
      return block.text;
    }
  }

  /**
   * Pull the structured-error envelope from a failed tool response.
   * Returns `{code, message, details?}` or null when the response wasn't an error.
   */
  parseErrorEnvelope(toolResult) {
    if (!toolResult?.isError) return null;
    const parsed = this.parseTextPayload(toolResult);
    return parsed?.error ?? null;
  }

  async _post(body) {
    if (!this.sessionId) throw new Error('client not initialized');
    const resp = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...ACCEPT_HEADERS, 'mcp-session-id': this.sessionId },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    const parsed = parseBody(text);
    if (resp.status !== 200) {
      throw new Error(
        `RPC ${body.method} failed: status=${resp.status} body=${text.slice(0, 500)}`,
      );
    }
    if (parsed?.error) {
      throw new Error(
        `RPC ${body.method} returned JSON-RPC error: ${JSON.stringify(parsed.error)}`,
      );
    }
    return parsed;
  }
}

/**
 * Pull extension-side debug-log entries that match a filter. Used by the
 * failure-triage flow to attach root-cause context to every failed assertion.
 *
 * Tools don't surface their server-side `requestId` to the caller, so tests
 * correlate by `(tool, sinceMs)` instead — the newest matching entry is "this
 * call." From there the test can lift its `requestId` and call dumpForRequest
 * to gather the full ordered trail.
 */
export async function dumpRecent(client, filter) {
  try {
    const result = await client.callTool('chrome_debug_dump', {
      limit: 50,
      ...filter,
    });
    const parsed = client.parseTextPayload(result);
    return parsed?.entries ?? [];
  } catch (err) {
    return [{ error: `debug-dump failed: ${err.message}` }];
  }
}

/**
 * Pull all entries for a known requestId.
 */
export async function dumpForRequest(client, requestId, limit = 50) {
  return dumpRecent(client, { requestId, limit });
}

/**
 * Walk recent entries to find the requestId of "this call": the latest
 * entry whose `tool` matches and whose `ts` >= sinceMs. Returns null when
 * no entry matches (e.g. tool failed before logging).
 */
export async function correlateRequestId(client, tool, sinceMs) {
  const entries = await dumpRecent(client, { tool, sinceMs, limit: 50 });
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.requestId) return entries[i].requestId;
  }
  return null;
}
