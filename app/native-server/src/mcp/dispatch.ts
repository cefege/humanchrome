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
 * Fetch dynamic flow tool schemas from the extension. Used by both the MCP
 * `tools/list` handler and the REST `/api/tools` catalog endpoint.
 */
export async function listDynamicFlowTools(): Promise<Tool[]> {
  try {
    const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
      {},
      'rr_list_published_flows',
      FLOW_LIST_TIMEOUT_MS,
    );
    if (!response || response.status !== 'success' || !Array.isArray(response.items)) {
      return [];
    }
    const tools: Tool[] = [];
    for (const item of response.items) {
      const name = `${FLOW_PREFIX}${item.slug}`;
      const description =
        (item.meta && item.meta.tool && item.meta.tool.description) ||
        item.description ||
        'Recorded flow';
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const v of item.variables || []) {
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
  } catch {
    return [];
  }
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
      const resp = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
        {},
        'rr_list_published_flows',
        FLOW_LIST_TIMEOUT_MS,
      );
      const items = (resp && resp.items) || [];
      const slug = name.slice(FLOW_PREFIX.length);
      const match = items.find((it: any) => it.slug === slug);
      if (!match) throw new Error(`Flow not found for tool ${name}`);
      const flowArgs = { flowId: match.id, args };
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
