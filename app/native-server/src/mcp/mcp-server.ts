import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

/**
 * Per-session McpServer factory.
 *
 * The original code held a singleton McpServer and called .connect(transport)
 * for every new MCP HTTP/SSE session. The MCP SDK's Server.connect() rejects a
 * second concurrent transport with "Already connected to a transport", which
 * meant only one MCP client (Claude Code or curl, never both) could talk to
 * the bridge at a time, and a stuck transport survived until the extension
 * was disconnect/reconnected.
 *
 * Tool handlers registered by setupTools() are stateless message dispatchers,
 * so handing each session its own Server instance is safe and eliminates the
 * "Already connected" failure mode entirely. Mirrors upstream PRs #295/#301/#338
 * which converged on this exact fix.
 *
 * @param clientId  Optional MCP-session identifier. When provided, every tool
 *   call routed through this server will carry the id into the native-messaging
 *   envelope so the extension can keep per-client state (preferred tab, etc.).
 *   Omit only for backward-compatible call sites.
 */
export const createMcpServer = (clientId?: string): Server => {
  const server = new Server(
    {
      name: 'HumanChromeServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  setupTools(server, clientId);
  return server;
};

// Back-compat re-export. Old callers that imported `getMcpServer` keep working
// but every call returns a fresh per-session server instead of a singleton.
export const getMcpServer = createMcpServer;
