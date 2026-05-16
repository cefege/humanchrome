#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'humanchrome-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import { withContext } from '../util/logger';
import { normalizeSessionName } from './session-name';

const log = withContext({ component: 'mcp-stdio' });

let stdioMcpServer: Server | null = null;
let mcpClient: Client | null = null;

// Read configuration from stdio-config.json
const loadConfig = () => {
  try {
    const configPath = path.join(__dirname, 'stdio-config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    log.fatal(
      { err: error instanceof Error ? error.message : String(error) },
      'failed to load stdio-config.json',
    );
    throw new Error('Configuration file stdio-config.json not found or invalid', {
      cause: error,
    });
  }
};

export const getStdioMcpServer = () => {
  if (stdioMcpServer) {
    return stdioMcpServer;
  }
  stdioMcpServer = new Server(
    {
      name: 'StdioHumanChromeServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  setupTools(stdioMcpServer);
  return stdioMcpServer;
};

/**
 * Resolve a stable sessionName for this stdio process. The stdio server runs
 * as a subprocess of the calling CLI (Claude Code, Codex, etc.), so the
 * CLI's working directory is a good default — `~/projects/acme-api` →
 * "acme-api". Override via `HUMANCHROME_SESSION` env when the default isn't
 * appropriate (e.g. two CLIs sharing a CWD).
 *
 * Returns the normalized name, or `null` if neither source yields a usable
 * value (caller falls back to UUID at the server end).
 */
const resolveSessionName = (): string | null => {
  const envName = process.env.HUMANCHROME_SESSION;
  if (envName) {
    const norm = normalizeSessionName(envName);
    if (norm) return norm;
  }
  try {
    return normalizeSessionName(path.basename(process.cwd()));
  } catch {
    return null;
  }
};

export const ensureMcpClient = async () => {
  try {
    if (mcpClient) {
      const pingResult = await mcpClient.ping();
      if (pingResult) {
        return mcpClient;
      }
    }

    const config = loadConfig();
    mcpClient = new Client({ name: 'Mcp Chrome Proxy', version: '1.0.0' }, { capabilities: {} });
    const sessionName = resolveSessionName();
    // Send the canonical name on the initial connect handshake so the bridge
    // can persist ownership across this stdio process's restarts.
    const requestInit: RequestInit | undefined = sessionName
      ? { headers: { 'X-Humanchrome-Session': sessionName } }
      : undefined;
    const transportOpts = requestInit ? { requestInit } : {};
    const transport = new StreamableHTTPClientTransport(new URL(config.url), transportOpts);
    await mcpClient.connect(transport);
    if (sessionName) {
      log.info({ sessionName }, 'stdio proxy connected with sessionName');
    }
    return mcpClient;
  } catch (error) {
    mcpClient?.close();
    mcpClient = null;
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'failed to connect to MCP server',
    );
  }
};

export const setupTools = (server: Server) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params.name, request.params.arguments || {}),
  );

  // List resources handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  // List prompts handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
};

const handleToolCall = async (name: string, args: any): Promise<CallToolResult> => {
  try {
    const client = await ensureMcpClient();
    if (!client) {
      throw new Error('Failed to connect to MCP server');
    }
    // Use a sane default of 2 minutes; the previous value mistakenly used 2*6*1000 (12s)
    const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: DEFAULT_CALL_TIMEOUT_MS,
    });
    return result as CallToolResult;
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

async function main() {
  const transport = new StdioServerTransport();
  await getStdioMcpServer().connect(transport);
}

main().catch((error) => {
  log.fatal(
    { err: error instanceof Error ? error.message : String(error), stack: error?.stack },
    'fatal error in HumanChrome stdio main()',
  );
  process.exit(1);
});
