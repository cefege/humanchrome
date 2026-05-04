/**
 * Plain HTTP REST surface — same Chrome-control capabilities as the MCP
 * transport, without the MCP session lifecycle. Designed so a script using
 * the Anthropic SDK (or any other client) can call tools directly.
 *
 * Endpoints:
 *   GET  /api/tools           catalog of tool schemas (TOOL_SCHEMAS + dynamic flows)
 *   POST /api/tools/:name     dispatch one tool; body `{ args: {...} }`
 *   GET  /api/openapi.json    OpenAPI 3.1 spec generated from the catalog
 *
 * Optional `X-Client-Id` header is forwarded to the extension so callers can
 * keep preferred-tab continuity across requests, mirroring per-MCP-session
 * behaviour.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'humanchrome-shared';
import { HTTP_STATUS } from '../../constant';
import { dispatchTool, listDynamicFlowTools } from '../../mcp/dispatch';

interface ToolCallBody {
  args?: Record<string, unknown>;
}

function buildOpenApi(tools: Tool[]) {
  const paths: Record<string, unknown> = {};
  for (const tool of tools) {
    paths[`/api/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description || tool.name,
        tags: ['tools'],
        parameters: [
          {
            name: 'X-Client-Id',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Optional stable identifier to keep preferred-tab state across calls.',
          },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  args: tool.inputSchema || { type: 'object' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Tool result (MCP CallToolResult shape).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    content: {
                      type: 'array',
                      items: { type: 'object' },
                    },
                    isError: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'humanchrome REST API',
      version: '1.0.0',
      description:
        'Plain HTTP surface over the same Chrome browser tools the MCP transport exposes. ' +
        'Each operation forwards to the extension over native messaging and returns an MCP ' +
        'CallToolResult — `content` is an array of items (text, image, etc.) and `isError` ' +
        'is `true` when the call failed.',
    },
    paths,
  };
}

export function registerApiRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/tools', async (_req: FastifyRequest, reply: FastifyReply) => {
    const dynamicTools = await listDynamicFlowTools();
    reply.status(HTTP_STATUS.OK).send({ tools: [...TOOL_SCHEMAS, ...dynamicTools] });
  });

  fastify.get('/api/openapi.json', async (_req: FastifyRequest, reply: FastifyReply) => {
    const dynamicTools = await listDynamicFlowTools();
    const spec = buildOpenApi([...TOOL_SCHEMAS, ...dynamicTools]);
    reply.status(HTTP_STATUS.OK).send(spec);
  });

  fastify.post(
    '/api/tools/:name',
    async (
      request: FastifyRequest<{ Params: { name: string }; Body?: ToolCallBody }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params;
      const body = request.body || {};
      const args = body.args ?? {};
      const clientIdHeader = request.headers['x-client-id'];
      const clientId = Array.isArray(clientIdHeader) ? clientIdHeader[0] : clientIdHeader;

      const result = await dispatchTool(name, args, clientId);
      // Always 200 — `isError` in the body indicates tool-level failure, same
      // as MCP. Reserve HTTP error codes for transport/dispatch problems.
      reply.status(HTTP_STATUS.OK).send(result);
    },
  );
}
