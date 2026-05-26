import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  TOOL_SCHEMAS,
  buildDispatcherTool,
  DISPATCHER_TOOL_NAME,
  isKnownToolName,
  suggestToolName,
  ToolErrorCode,
  serializeToolError,
  buildInvalidArgsDetails,
} from 'humanchrome-shared';
import { dispatchTool, listDynamicFlowTools } from './dispatch';
import { lookupIdempotentResult, recordIdempotentResult } from './idem-cache';

/**
 * Tool-surface mode. `legacy` (default) ships the full TOOL_SCHEMAS manifest;
 * `lazy` (IMP-0177) collapses it to a single `humanchrome(name, args)`
 * dispatcher whose `description` carries the catalog. Default is `legacy` so
 * the rollout is safe — flip via `HUMANCHROME_TOOL_MODE=lazy` once green.
 */
function resolveToolMode(): 'legacy' | 'lazy' {
  const v = (process.env.HUMANCHROME_TOOL_MODE || '').toLowerCase();
  return v === 'lazy' ? 'lazy' : 'legacy';
}

function invalidArgsResult(message: string, details: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text',
        text: serializeToolError(ToolErrorCode.INVALID_ARGS, message, details),
      },
    ],
    isError: true,
  };
}

export const setupTools = (server: Server, clientId?: string) => {
  const mode = resolveToolMode();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const dynamicTools = await listDynamicFlowTools();
    if (mode === 'lazy') {
      return { tools: [buildDispatcherTool(), ...dynamicTools] };
    }
    return { tools: [...TOOL_SCHEMAS, ...dynamicTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (mode === 'lazy' && name === DISPATCHER_TOOL_NAME) {
      const bag = (args as Record<string, unknown> | undefined) || {};
      const innerName = bag.name;
      const innerArgs = (bag.args as Record<string, unknown> | undefined) ?? {};
      const wantsRaw = bag.raw === true;
      const idemKey = typeof bag.idemKey === 'string' && bag.idemKey.length > 0 ? bag.idemKey : undefined;

      if (typeof innerName !== 'string' || innerName.length === 0) {
        return invalidArgsResult(
          '`name` is required (string) — pick a tool from the catalog in the dispatcher description.',
          buildInvalidArgsDetails({
            arg: 'name',
            received: innerName,
            expected: { type: 'string', description: 'Tool name from humanchrome catalog.' },
          }),
        );
      }

      if (!isKnownToolName(innerName)) {
        const dynamic = await listDynamicFlowTools();
        const dynamicNames = dynamic.map((t) => t.name);
        if (!dynamicNames.includes(innerName)) {
          const guess = suggestToolName(innerName, dynamicNames);
          return invalidArgsResult(
            `Unknown tool: "${innerName}". ${guess ? `Did you mean "${guess}"?` : 'See the humanchrome description for the catalog.'}`,
            buildInvalidArgsDetails({
              arg: 'name',
              received: innerName,
              expected: {
                kind: 'tool_name',
                catalogSize: TOOL_SCHEMAS.length + dynamicNames.length,
              },
              hint: guess ? `Did you mean "${guess}"?` : undefined,
            }),
          );
        }
      }

      // IMP-0183: short-circuit on a cached idempotent hit before paying for
      // dispatch. Per-tool tools don't see idemKey — it lives only on the
      // outer dispatcher surface.
      const cached = lookupIdempotentResult(clientId, innerName, idemKey);
      if (cached) return cached;

      // Don't inject `raw: false` — preserves the inner args shape when the
      // caller omitted `raw`. Tools that branch on `'raw' in args` would
      // misread the unconditional spread as an explicit opt-in.
      const forwardArgs = wantsRaw ? { ...innerArgs, raw: true } : innerArgs;
      const result = await dispatchTool(innerName, forwardArgs, clientId);
      recordIdempotentResult(clientId, innerName, idemKey, result);
      return result;
    }

    return dispatchTool(name, args || {}, clientId);
  });
};
