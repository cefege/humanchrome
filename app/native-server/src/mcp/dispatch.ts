/**
 * Transport-agnostic tool dispatch.
 *
 * Both the MCP request handler (register-tools.ts) and the plain HTTP REST
 * route (server/routes/api.ts) call into this helper. It is the single source
 * of truth for: forwarding `{name, args}` to the extension over native
 * messaging, resolving dynamic `flow.*` tools, and shaping errors into the
 * `CallToolResult` envelope MCP clients expect.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import nativeMessagingHostInstance from '../native-messaging-host';
import { NativeMessageType, ToolErrorCode, serializeToolError } from 'humanchrome-shared';
import { withContext } from '../util/logger';

const FLOW_PREFIX = 'flow.';
const TOOL_CALL_TIMEOUT_MS = 120_000;
const FLOW_LIST_TIMEOUT_MS = 20_000;
// Cache the rr_list_published_flows payload across both `tools/list` and the
// `flow.<slug>` dispatch path. Without this, every MCP client reconnect
// re-issues a tools/list (one round-trip), and every flow.<slug> call does a
// second round-trip just to look up the slug → flowId mapping. With it, both
// paths share one fetch within the TTL. Invalidate via the exported helper
// when flows publish/unpublish; the TTL is the safety net if an event is
// missed.
const FLOW_TOOLS_CACHE_TTL_MS = 60_000;

// Top-level keys `buildFlowArgs` strips into runner options. Mirror of the
// destructure on line ~80 — keep in sync. A user var with one of these names
// is dropped at schema-build time so the call-time strip doesn't silently
// reroute the value into the runner option.
export const FLOW_RUNNER_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'tabTarget',
  'refresh',
  'captureNetwork',
  'returnLogs',
  'timeoutMs',
  'startUrl',
]);

const flowToolsLog = withContext({ component: 'flow-tools' });

interface FlowToolsCacheEntry {
  tools: Tool[];
  items: any[];
  fetchedAt: number;
}

/**
 * Module-scope cache shared by `listDynamicFlowTools` and the flow-call
 * path inside `dispatchTool`. Module scope is correct here: the bridge is
 * a single Node process and rr_list_published_flows answers the same data
 * regardless of caller. A `pendingFetch` field collapses concurrent
 * requests during a cold cache so a burst of tools/list + flow.<slug>
 * calls only triggers one underlying round-trip.
 */
let flowToolsCache: FlowToolsCacheEntry | null = null;
let pendingFlowToolsFetch: Promise<FlowToolsCacheEntry> | null = null;

/**
 * Manually wipe the flow-tools cache. Exported so callers that observe a
 * publish/unpublish event (or tests) can force the next call to refetch.
 * The TTL is the always-on safety net, but explicit invalidation gives
 * recently-published flows zero-latency visibility.
 */
export function invalidateFlowToolsCache(): void {
  flowToolsCache = null;
  pendingFlowToolsFetch = null;
}

function isCacheFresh(now: number): boolean {
  return flowToolsCache !== null && now - flowToolsCache.fetchedAt < FLOW_TOOLS_CACHE_TTL_MS;
}

/**
 * Build the `Tool[]` schemas array from a raw rr_list_published_flows items
 * array. Lifted out of `listDynamicFlowTools` so the cache can hold both
 * the `items` (used by the flow-call path) and the `tools` (used by
 * tools/list) without re-doing the schema build on every call.
 */
function buildFlowToolsFromItems(items: any[]): Tool[] {
  const tools: Tool[] = [];
  for (const item of items) {
    const name = `${FLOW_PREFIX}${item.slug}`;
    const description =
      (item.meta && item.meta.tool && item.meta.tool.description) ||
      item.description ||
      'Recorded flow';
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const v of item.variables || []) {
      if (FLOW_RUNNER_RESERVED_KEYS.has(v.key)) {
        flowToolsLog.warn(
          { flowSlug: item.slug, varKey: v.key },
          'flow variable shadows a runner-option key; the runner option wins, var is hidden from the schema',
        );
        continue;
      }
      const desc = v.label || v.key;
      const typ = (v.type || 'string').toLowerCase();
      const prop: any = { description: desc };
      if (typ === 'boolean') prop.type = 'boolean';
      else if (typ === 'number') prop.type = 'number';
      else if (typ === 'enum') {
        prop.type = 'string';
        if (v.rules && Array.isArray(v.rules.enum)) prop.enum = v.rules.enum;
      } else if (typ === 'array') {
        prop.type = 'array';
        prop.items = { type: 'string' };
      } else {
        prop.type = 'string';
      }
      if (v.default !== undefined) prop.default = v.default;
      if (v.rules && v.rules.required) required.push(v.key);
      properties[v.key] = prop;
    }
    properties['tabTarget'] = { type: 'string', enum: ['current', 'new'], default: 'current' };
    properties['refresh'] = { type: 'boolean', default: false };
    properties['captureNetwork'] = { type: 'boolean', default: false };
    properties['returnLogs'] = { type: 'boolean', default: false };
    properties['timeoutMs'] = { type: 'number', minimum: 0 };
    tools.push({
      name,
      description,
      inputSchema: { type: 'object', properties, required },
    });
  }
  return tools;
}

/**
 * Fetch the published flows from the extension and populate the cache.
 * Concurrent callers share a single in-flight promise; sequential callers
 * within the TTL hit the cache. Returns the cached entry. On fetch error
 * the cache is left as-is and an entry with empty tools/items is returned
 * (the caller treats empty as "no flows" — same semantics the original
 * pre-cache code had on error).
 */
async function getFlowToolsCache(): Promise<FlowToolsCacheEntry> {
  const now = Date.now();
  if (isCacheFresh(now)) {
    return flowToolsCache!;
  }
  if (pendingFlowToolsFetch) {
    return pendingFlowToolsFetch;
  }
  pendingFlowToolsFetch = (async () => {
    try {
      const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
        {},
        'rr_list_published_flows',
        FLOW_LIST_TIMEOUT_MS,
      );
      const items =
        response && response.status === 'success' && Array.isArray(response.items)
          ? response.items
          : [];
      const tools = buildFlowToolsFromItems(items);
      const entry: FlowToolsCacheEntry = { tools, items, fetchedAt: Date.now() };
      flowToolsCache = entry;
      return entry;
    } catch {
      // Match pre-cache behavior: errors return empty without poisoning
      // the cache. The next call retries.
      return { tools: [], items: [], fetchedAt: 0 };
    } finally {
      pendingFlowToolsFetch = null;
    }
  })();
  return pendingFlowToolsFetch;
}

/**
 * Make sure every error reaching the LLM is the same parseable JSON envelope:
 *   {"error":{"code":"...","message":"...","details":{...}}}
 *
 * Tool handlers in the extension already produce this shape via
 * `createErrorResponse`. This helper handles the two paths where the
 * native-side bridge could otherwise drop structure:
 *
 *   1. The extension threw out of `handleCallTool` instead of returning a
 *      structured CallToolResult (rare — wrapper bugs).
 *   2. `sendRequestToExtensionAndWait` itself rejected (timeout, native
 *      messaging hiccup) — there's no extension-shaped error to forward.
 *
 * Pre-serialized envelopes are passed through unchanged so codes survive.
 */
export function toErrorEnvelopeText(message: string | undefined): string {
  const text = message ?? 'Unknown error';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.error && parsed.error.code) {
        return text;
      }
    } catch {
      // not JSON — fall through to wrap
    }
  }
  return serializeToolError(ToolErrorCode.UNKNOWN, text);
}

/**
 * Split MCP args for a `flow.<slug>` call into the shape FlowRunTool expects:
 *   { flowId, args: <user vars only>, tabTarget, refresh, captureNetwork,
 *     returnLogs, timeoutMs, startUrl }
 *
 * The extension's FlowRunTool destructures runner options at the TOP LEVEL and
 * treats `args` as the user-supplied flow variable bag. Without this split, the
 * options arrive as undefined (defaults kick in) and `vars` ends up containing
 * the runner options too. See IMP-0024.
 */
export function buildFlowArgs(flowId: string, mcpArgs: any) {
  const { tabTarget, refresh, captureNetwork, returnLogs, timeoutMs, startUrl, ...vars } =
    mcpArgs ?? {};
  return {
    flowId,
    args: vars,
    tabTarget,
    refresh,
    captureNetwork,
    returnLogs,
    timeoutMs,
    startUrl,
  };
}

/**
 * Fetch dynamic flow tool schemas from the extension. Used by both the MCP
 * `tools/list` handler and the REST `/api/tools` catalog endpoint. Cached
 * for {@link FLOW_TOOLS_CACHE_TTL_MS}; call {@link invalidateFlowToolsCache}
 * after a publish/unpublish to drop the cache eagerly.
 */
export async function listDynamicFlowTools(): Promise<Tool[]> {
  const entry = await getFlowToolsCache();
  return entry.tools;
}

/**
 * Dispatch a tool call to the extension. Returns the same `CallToolResult`
 * shape MCP clients consume — REST callers can either pass it through or
 * unwrap `content[]` themselves.
 */
export async function dispatchTool(
  name: string,
  args: any,
  clientId?: string,
): Promise<CallToolResult> {
  const requestId = nativeMessagingHostInstance.newRequestId();
  const log = withContext({ requestId, tool: name, clientId });
  const startedAt = Date.now();
  log.info('tool call start');

  try {
    if (name && name.startsWith(FLOW_PREFIX)) {
      // Reuse the cached items the tools/list path populated. On a cold
      // cache `getFlowToolsCache` does the round-trip; on a warm cache
      // (within TTL) this is a Map lookup, saving a 20s-timeout native
      // round-trip per flow call. If the slug isn't in the cached items
      // we invalidate and refetch once before failing — covers the case
      // where a flow was published since the last fetch and the TTL
      // hasn't expired yet.
      const slug = name.slice(FLOW_PREFIX.length);
      let cached = await getFlowToolsCache();
      let match = cached.items.find((it: any) => it.slug === slug);
      if (!match) {
        invalidateFlowToolsCache();
        cached = await getFlowToolsCache();
        match = cached.items.find((it: any) => it.slug === slug);
      }
      if (!match) throw new Error(`Flow not found for tool ${name}`);
      const flowArgs = buildFlowArgs(match.id, args);
      const proxyRes = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
        { name: 'record_replay_flow_run', args: flowArgs },
        NativeMessageType.CALL_TOOL,
        TOOL_CALL_TIMEOUT_MS,
        requestId,
        clientId,
      );
      if (proxyRes.status === 'success') {
        log.info({ durationMs: Date.now() - startedAt, kind: 'flow' }, 'tool call ok');
        return proxyRes.data;
      }
      log.warn(
        { durationMs: Date.now() - startedAt, error: proxyRes.error, kind: 'flow' },
        'tool call error',
      );
      return {
        content: [{ type: 'text', text: toErrorEnvelopeText(proxyRes.error) }],
        isError: true,
      };
    }

    const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
      { name, args },
      NativeMessageType.CALL_TOOL,
      TOOL_CALL_TIMEOUT_MS,
      requestId,
      clientId,
    );
    if (response.status === 'success') {
      log.info({ durationMs: Date.now() - startedAt }, 'tool call ok');
      return response.data;
    }
    log.warn({ durationMs: Date.now() - startedAt, error: response.error }, 'tool call error');
    return {
      content: [{ type: 'text', text: toErrorEnvelopeText(response.error) }],
      isError: true,
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    log.error({ durationMs: Date.now() - startedAt, error: message }, 'tool call threw');
    return {
      content: [{ type: 'text', text: toErrorEnvelopeText(message) }],
      isError: true,
    };
  }
}
