/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { writeInstance, removeInstance } from '../util/instance-registry';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { createMcpServer } from '../mcp/mcp-server';
import { normalizeSessionName } from '../mcp/session-name';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { runHijacked } from './hijack';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { closeDb } from '../agent/db';
import { registerAgentRoutes, registerApiRoutes } from './routes';

export function clientIdFromHeaders(headers: Headers | undefined, url: string | undefined): string {
  const header = headers?.get('x-humanchrome-session');
  if (header) {
    const normalized = normalizeSessionName(header);
    if (normalized) return normalized;
  }
  if (url) {
    const session = new URL(url, 'http://localhost').searchParams.get('session');
    if (session) {
      const normalized = normalizeSessionName(session);
      if (normalized) return normalized;
    }
  }
  return 'default';
}

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

// ============================================================
// Security preHandler factory
// ============================================================

/**
 * DNS-rebinding + cross-origin defence on state-changing methods.
 *
 * Applied via `fastify.addHook('preHandler', ...)`. Rules (in order):
 *   1. Skip non-state-changing methods (GET / HEAD / OPTIONS).
 *   2. Reject requests whose Host header isn't a loopback name (defends
 *      against DNS rebinding attacks where a public DNS name resolves to
 *      127.0.0.1).
 *   3. Reject Origin headers that aren't in the CORS allowlist.
 *   4. If `HUMANCHROME_TOKEN` is set in the environment, require an exact
 *      `Authorization: Bearer <token>` match.
 *
 * Exported as a factory so the regression suite can mount it on a bare
 * Fastify instance via `fastify.inject()` without booting the whole Server
 * (which pulls in better-sqlite3, drizzle, the agent engines, etc).
 */
export function createSecurityPreHandler(): (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void> {
  // Read env at hook-creation time to mirror production behaviour: the token
  // is captured when the server starts, not on every request.
  const requiredToken = process.env.HUMANCHROME_TOKEN?.trim() || null;
  const STATE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
  const HOST_ALLOW = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

  return async (request, reply) => {
    const method = request.method.toUpperCase();
    if (!STATE_METHODS.has(method)) return;

    const hostHeader = String(request.headers.host || '');
    const hostName = hostHeader.split(':')[0].toLowerCase();
    if (!HOST_ALLOW.has(hostName) && !HOST_ALLOW.has(hostHeader.toLowerCase())) {
      reply.status(HTTP_STATUS.FORBIDDEN).send({ error: 'Host not allowed' });
      return;
    }

    const origin = request.headers.origin;
    if (origin) {
      const allowed = SERVER_CONFIG.CORS_ORIGIN.some((pattern) =>
        pattern instanceof RegExp ? pattern.test(origin) : origin.startsWith(pattern),
      );
      if (!allowed) {
        reply.status(HTTP_STATUS.FORBIDDEN).send({ error: 'Origin not allowed' });
        return;
      }
    }

    if (requiredToken) {
      const auth = String(request.headers.authorization || '');
      const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (presented !== requiredToken) {
        reply.status(HTTP_STATUS.UNAUTHORIZED).send({ error: 'Invalid or missing bearer token' });
        return;
      }
    }
  };
}

// ============================================================
// Server Class
// ============================================================

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  private nativeHost: NativeMessagingHost | null = null;
  private mcpHandler: McpHttpHandler;
  private mcpNode: NodeMcpRequestHandler;
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.mcpHandler = createMcpHandler(({ requestInfo }) =>
      createMcpServer(clientIdFromHeaders(requestInfo?.headers, requestInfo?.url)),
    );
    this.mcpNode = toNodeHandler(this.mcpHandler);
    this.agentStreamManager = new AgentStreamManager();
    this.agentChatService = new AgentChatService({
      engines: [new CodexEngine(), new ClaudeEngine()],
      streamManager: this.agentStreamManager,
    });
    // Order + sync registration matter:
    //   * Fastify's `register()` is a thenable — `await register(cors, ...)`
    //     would trigger fastify's boot sequence as a side effect of `await`
    //     and deadlock subsequent `addHook()` calls (the root plugin gets
    //     marked "booted" before the hook is queued).
    //   * Therefore call `register()` *without* awaiting and queue the hook
    //     synchronously after it. Fastify's plugin-load order is preserved
    //     because both calls land in the same internal queue.
    //   * Routes are registered first so they sit before the plugin/hook in
    //     the queue and inherit the cors + preHandler configuration when
    //     fastify drains the queue inside `ready()`.
    this.setupRoutes();
    this.setupPlugins();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private setupPlugins(): void {
    // NOTE: do NOT `await` the `register()` call. Fastify's register thenable
    // would trigger boot on await, racing with the addHook below. Both calls
    // land in the same plugin queue and run in order during `ready()`.
    this.fastify.register(cors, {
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g., curl, server-to-server)
        if (!origin) {
          return cb(null, true);
        }
        // Check if origin matches any pattern in whitelist
        const allowed = SERVER_CONFIG.CORS_ORIGIN.some((pattern) =>
          pattern instanceof RegExp ? pattern.test(origin) : origin.startsWith(pattern),
        );
        cb(null, allowed);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });

    this.fastify.addHook('preHandler', createSecurityPreHandler());
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    // Extension communication
    this.setupExtensionRoutes();

    // Agent routes (delegated to separate module)
    registerAgentRoutes(this.fastify, {
      streamManager: this.agentStreamManager,
      chatService: this.agentChatService,
    });

    // Plain HTTP REST API (transport-agnostic alternative to MCP)
    registerApiRoutes(this.fastify);

    // MCP routes
    this.setupMcpRoutes();
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
      });
    });
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            'process_data',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    this.fastify.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      handler: (request, reply) =>
        runHijacked(reply, () => this.mcpNode(request.raw, reply.raw, request.body)),
    });
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  /**
   * Bind the Fastify HTTP server. When `port` is already bound (another
   * humanchrome-bridge instance is serving a different Chrome), walks up to
   * `port + maxWalk` to find a free port and returns the one actually bound.
   * This is what lets two Chromes (user's regular + Chrome for Testing)
   * coexist — each bridge process gets its own HTTP port.
   */
  public async start(
    port = NATIVE_SERVER_PORT,
    nativeHost: NativeMessagingHost,
    maxWalk = 100,
  ): Promise<number> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return Number(process.env.HUMANCHROME_PORT) || port;
    }

    let lastErr: unknown = null;
    for (let candidate = port; candidate <= port + maxWalk; candidate++) {
      try {
        await this.fastify.listen({ port: candidate, host: SERVER_CONFIG.HOST });
        process.env.HUMANCHROME_PORT = String(candidate);
        process.env.MCP_HTTP_PORT = String(candidate);
        this.isRunning = true;
        // IMP-0115: announce this instance to disk so the matrix runner
        // (and any other HTTP client) can discover which port belongs to
        // which Chrome instance.
        try {
          writeInstance({
            pid: process.pid,
            port: candidate,
            extensionId: nativeHost.getRemoteExtensionId?.() ?? 'unknown',
            instanceId: nativeHost.getRemoteInstanceId?.() ?? undefined,
            chromeBinary: process.env.HC_CHROME_BINARY ?? undefined,
            startedAt: new Date().toISOString(),
          });
        } catch (err) {
          // Best-effort — registry write failure doesn't kill the bridge.
          // Logged and life goes on.

          console.error('[instance-registry] write failed:', err);
        }
        return candidate;
      } catch (err: any) {
        lastErr = err;
        if (err?.code !== 'EADDRINUSE') break;
      }
    }
    this.isRunning = false;
    throw lastErr ?? new Error(`No free port found in [${port}, ${port + maxWalk}]`);
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.mcpHandler.close();
      await this.fastify.close();
      closeDb();
      this.isRunning = false;
    } catch (err) {
      this.isRunning = false;
      closeDb();
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server();
export default serverInstance;
