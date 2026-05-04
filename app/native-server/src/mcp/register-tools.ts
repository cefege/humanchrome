import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'humanchrome-shared';
import { dispatchTool, listDynamicFlowTools } from './dispatch';

export const setupTools = (server: Server, clientId?: string) => {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const dynamicTools = await listDynamicFlowTools();
    return { tools: [...TOOL_SCHEMAS, ...dynamicTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatchTool(request.params.name, request.params.arguments || {}, clientId),
  );
};
