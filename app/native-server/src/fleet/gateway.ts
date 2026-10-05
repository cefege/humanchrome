import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import replyFrom from '@fastify/reply-from';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { FleetLeases } from './leases';
import { FleetConfig, FleetNodeConfig } from './config';
import { ProfileState, ProfileSnapshot, ProfileSupervisor } from './supervisor';
import { fetchNodeProfiles, NODE_SEPARATOR } from './remote';
import { createFleetMcpServer, type FleetMcpDeps } from './mcp';
import { FLEET_UI_HTML } from './ui';
import { normalizeSessionName } from '../mcp/session-name';
import { runHijacked } from '../server/hijack';

const TIMERS = {
  nodeCacheMs: 5_000,
  sweepMs: 30_000,
} as const;

/**
 * The only path prefixes a gateway client may reach on a leased browser's
 * bridge: its REST API, its MCP endpoint and its health probe. Everything else
 * on the bridge — the agent chat surface, the extension raw bridge — stays
 * unreachable through the fleet gateway. An allowlist, never a blocklist: a new
 * bridge route is private to the LAN by default instead of open on arrival.
 */
const PROXY_ALLOWED_PREFIXES = ['api/', 'mcp', 'ping'] as const;

interface ProfileRoute {
  /** Fully qualified `nodeId:profile` for remote profiles, bare name for local ones. */
  key: string;
  name: string;
  port: number;
  labels: string[];
  purpose: string | null;
  state: ProfileState;
  node: FleetNodeConfig | null;
}

export interface FleetGatewayOptions {
  config: FleetConfig;
  supervisor: ProfileSupervisor;
  leases: FleetLeases;
}

export class FleetGateway {
  private readonly app: FastifyInstance;
  private readonly options: FleetGatewayOptions;
  private config: FleetConfig;
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Per node id: one node going dark must not expire a healthy peer's routes. */
  private readonly nodeCache = new Map<string, { at: number; profiles: ProfileRoute[] }>();
  private readonly fleetMcpHandler: McpHttpHandler;
  private readonly fleetMcpNode: NodeMcpRequestHandler;

  constructor(options: FleetGatewayOptions) {
    this.options = options;
    this.config = options.config;
    this.app = Fastify({ logger: false });
    this.app.register(replyFrom);
    this.app.addHook('onRequest', async (request, reply) => {
      if (request.headers.origin) {
        reply.code(403).send({ error: 'origin_not_allowed' });
        return;
      }
      if (!validBearer(request.headers.authorization, this.config.token)) {
        reply.code(401).send({ error: 'unauthorized' });
      }
    });
    // A client that hangs up mid-response raises EPIPE on the raw socket. That
    // is routine on a network server, and an unhandled one takes the whole
    // fleet down with it — supervisor, leases and every browser with it.
    this.app.server.on('connection', (socket: Socket) => socket.on('error', () => undefined));

    // `releaseBridge` needs this gateway's route table, which does not exist
    // until the constructor finishes; the MCP session is created lazily per
    // request, so the closure sees the assigned value by then.
    const mcpDeps: FleetMcpDeps = {
      supervisor: options.supervisor,
      leases: options.leases,
      releaseBridge: async () => undefined,
    };
    this.fleetMcpHandler = createMcpHandler(() => createFleetMcpServer(mcpDeps));
    this.fleetMcpNode = toNodeHandler(this.fleetMcpHandler);
    mcpDeps.releaseBridge = (agent, profile) => this.releaseBridge(agent, profile);

    this.registerRoutes();
  }

  async listen(): Promise<string> {
    return this.app.listen({
      port: this.config.gateway.port,
      host: this.config.gateway.host,
    });
  }
  /**
   * Swaps in a reloaded fleet config (node registry, tokens) without dropping
   * the HTTP server or its in-flight leases.
   */
  reload(config: FleetConfig): void {
    this.config = config;
    this.nodeCache.clear();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.app.close();
  }

  private registerRoutes(): void {
    // Read-only status page, at the root so `http://<tailscale-host>:12300/`
    // just works. Same-origin GET only: a browser sends no Origin header for
    // one, which is what keeps the fleet's origin guard intact.
    const ui = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.type('text/html; charset=utf-8').send(FLEET_UI_HTML);
    this.app.get('/', ui);
    this.app.get('/ui', ui);

    this.app.get('/v1/profiles', async (_request, reply) => {
      const leasedBy = (key: string) =>
        this.options.leases.list().find((lease) => lease.profile === key)?.agent ?? null;
      const local = this.options.supervisor.snapshot(leasedBy);
      const remote = (await this.routes())
        .filter((route) => route.node)
        .map((route) => ({
          name: route.key,
          port: route.port,
          labels: route.labels,
          purpose: route.purpose,
          enabled: true,
          state: route.state,
          pid: null,
          lastError: null,
          leasedBy: leasedBy(route.key),
        }));
      reply.send([...local, ...remote]);
    });
    /**
     * The three profile verbs share one shape: refuse an unknown name, refuse to
     * tear down a browser another agent is driving, then answer `202` and let the
     * supervisor do the slow work in the background.
     */

    const profileVerb = (
      verb: 'start' | 'stop' | 'restart',
      pending: 'starting' | 'stopping' | 'restarting',
      action: (name: string) => Promise<void>,
    ) => {
      this.app.post(`/v1/profiles/:name/${verb}`, async (request, reply) => {
        const { name } = request.params as { name: string };
        if (!this.options.supervisor.state(name)) {
          return reply.code(404).send({ error: 'unknown_profile' });
        }
        const heldBy = this.options.leases.list().find((lease) => lease.profile === name)?.agent;
        if (heldBy) return reply.code(409).send({ error: 'profile_busy', heldBy });
        // Fire and forget with a rejection handler: an unhandled rejection here
        // would take `serve` — and with it every browser — down.
        void action(name).catch((error: Error) => {
          console.error(`fleet: gateway: ${verb} of ${name} failed: ${error.message}`);
        });
        return reply.code(202).send({ [pending]: name });
      });
    };
    profileVerb('start', 'starting', (name) => this.options.supervisor.startProfile(name));
    profileVerb('stop', 'stopping', (name) => this.options.supervisor.stopProfile(name));
    profileVerb('restart', 'restarting', (name) => this.options.supervisor.restartProfile(name));

    this.app.get('/v1/leases', async (_request, reply) => reply.send(this.options.leases.list()));
    this.app.delete('/v1/leases/:agent', async (request, reply) => {
      const agent = normalizeSessionName((request.params as { agent: string }).agent);
      if (!agent) return reply.code(400).send({ error: 'invalid_agent' });
      // With auth off, any caller on the LAN could otherwise evict any agent and
      // post a `client_disconnected` into the victim's browser. The path segment
      // must agree with who the caller claims to be.
      const claiming = normalizeSessionName(request.headers['x-humanchrome-agent']);
      if (claiming !== agent) return reply.code(403).send({ error: 'agent_mismatch' });
      const released = this.options.leases.release(agent);
      await Promise.all(released.map((profile) => this.releaseBridge(agent, profile)));
      return reply.send({ released });
    });

    // Registered on the root instance so it inherits the onRequest auth hook.
    this.app.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/v1/fleet/mcp',
      handler: (request, reply) =>
        runHijacked(reply, () => this.fleetMcpNode(request.raw, reply.raw, request.body)),
    });

    const proxy = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const config = this.config;
      const agent = normalizeSessionName(request.headers['x-humanchrome-agent']);
      if (!agent) return reply.code(400).send({ error: 'missing_agent' });
      const params = request.params as { name?: string; label?: string; '*': string };
      const remainder = params['*'] ?? '';
      if (!PROXY_ALLOWED_PREFIXES.some((prefix) => remainder.startsWith(prefix))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const routes = await this.routes();
      const requested = params.name ? routes.find((route) => route.key === params.name) : undefined;
      if (params.name && !requested) return reply.code(404).send({ error: 'unknown_profile' });
      if (requested && requested.state !== 'healthy') {
        return reply.code(503).send({ error: 'profile_unavailable', state: requested.state });
      }
      const key =
        params.name ??
        this.options.leases.acquireFromPool(
          agent,
          this.healthyCandidates(routes, params.label ?? 'any'),
        );
      if (!key) {
        return reply.code(503).send({ error: 'no_free_profile', label: params.label });
      }
      if (params.name) {
        const acquisition = this.options.leases.acquire(agent, key);
        if (!acquisition.ok) {
          return reply.code(409).send({ error: 'profile_busy', heldBy: acquisition.heldBy });
        }
        // Stealing an expired lease leaves the evicted agent's client lane open
        // in the browser, so free it here rather than waiting for its TTL.
        if (acquisition.displaced) {
          void this.releaseBridge(acquisition.displaced, key);
        }
      }
      const route = routes.find((entry) => entry.key === key);
      if (!route || route.state !== 'healthy') {
        return reply.code(503).send({ error: 'profile_unavailable', state: route?.state });
      }
      this.options.leases.touch(agent, key);
      const query = request.url.includes('?')
        ? `?${request.url.slice(request.url.indexOf('?') + 1)}`
        : '';
      const target = this.targetFor(config, route, remainder, query);
      reply.header('X-Humanchrome-Profile', key);
      await reply.from(target.url, {
        rewriteRequestHeaders: (_request, headers) => ({
          ...headers,
          host: target.host,
          authorization: `Bearer ${target.token}`,
          'x-humanchrome-session': headers['x-humanchrome-session'] ?? agent,
          'x-client-id': headers['x-client-id'] ?? agent,
        }),
      });
    };

    /**
     * Peer-node entry point. A peer gateway forwards here with its own bearer
     * token and this machine injects the local bridge credential. It resolves
     * local profiles only, so a forwarded request can never hop back out.
     */
    const forward = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const config = this.config;
      const params = request.params as { name: string; '*': string };
      // With this fleet's own client auth off, federation is the only credential
      // left: if any configured peer carries a token, a forwarded request must
      // present one of them.
      if (!this.peerAuthorized(request.headers.authorization, config)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!this.options.supervisor.state(params.name)) {
        return reply.code(404).send({ error: 'unknown_profile' });
      }
      const runtime = this.options.supervisor
        .snapshot()
        .find((entry) => entry.name === params.name);
      if (!runtime || runtime.state !== 'healthy') {
        return reply.code(503).send({ error: 'profile_unavailable', state: runtime?.state });
      }
      const targetPath = params['*'] ?? '';
      const query = request.url.includes('?')
        ? `?${request.url.slice(request.url.indexOf('?') + 1)}`
        : '';
      await reply.from(`http://127.0.0.1:${runtime.port}/${targetPath}${query}`, {
        rewriteRequestHeaders: (_request, headers) => ({
          ...headers,
          host: `127.0.0.1:${runtime.port}`,
          authorization: `Bearer ${config.bridgeToken}`,
        }),
      });
    };

    this.app.register(async (instance) => {
      instance.removeAllContentTypeParsers();
      instance.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
      instance.all('/v1/profiles/:name/*', proxy);
      instance.all('/v1/pool/:label/*', proxy);
      instance.all('/v1/node/:name/*', forward);
    });
    this.sweepTimer = setInterval(() => void this.sweep(), TIMERS.sweepMs);
  }

  /**
   * A peer gateway reaches `/v1/node/:name/*` with its own bearer token. When no
   * peer carries a token the fleet is trusted end to end and the route behaves
   * like any other open route.
   */
  private peerAuthorized(header: string | undefined, config: FleetConfig): boolean {
    const tokens = config.nodes.map((node) => node.token).filter(Boolean);
    if (!tokens.length) return true;
    return tokens.some((token) => validBearer(header, token));
  }

  /**
   * A purpose tag is a routing key like a pool label, and never a replacement
   * for one: a purpose-bound profile stays reachable through its labels, so
   * existing pool traffic is unaffected.
   */
  private healthyCandidates(routes: ProfileRoute[], label: string): string[] {
    return routes
      .filter(
        (route) =>
          route.state === 'healthy' &&
          (label === 'any' || route.labels.includes(label) || route.purpose === label),
      )
      .map((route) => route.key);
  }

  private async sweep(): Promise<void> {
    for (const lease of this.options.leases.sweep())
      await this.releaseBridge(lease.agent, lease.profile);
  }

  private async releaseBridge(agent: string, key: string): Promise<void> {
    const route = (await this.routes()).find((entry) => entry.key === key);
    if (!route) return;
    const target = this.targetFor(
      this.config,
      route,
      `api/clients/${encodeURIComponent(agent)}/release`,
      '',
    );
    try {
      await fetch(target.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${target.token}` },
      });
    } catch {
      /* best effort */
    }
  }

  /**
   * Every profile reachable from this gateway: local ones plus one entry per
   * profile on each configured node, keyed `nodeId:profile`. Local names are
   * validated to exclude `:`, so a qualified key can never shadow a local one.
   */
  private async routes(): Promise<ProfileRoute[]> {
    const config = this.config;
    const local: ProfileRoute[] = this.options.supervisor.snapshot().map((profile) => ({
      key: profile.name,
      name: profile.name,
      port: profile.port,
      labels: profile.labels,
      state: profile.state,
      node: null,
      purpose: profile.purpose,
    }));
    if (config.nodes.length === 0) return local;
    const fresh = (node: FleetNodeConfig): ProfileRoute[] | null => {
      const entry = this.nodeCache.get(node.id);
      return entry && Date.now() - entry.at < TIMERS.nodeCacheMs ? entry.profiles : null;
    };
    const cached = config.nodes.map(fresh);
    if (cached.every((entry) => entry !== null)) {
      return [...local, ...(cached as ProfileRoute[][]).flat()];
    }
    const remote = (
      await Promise.all(config.nodes.map((node) => this.fetchNodeProfiles(node)))
    ).flat();
    return [...local, ...remote];
  }

  private async fetchNodeProfiles(node: FleetNodeConfig): Promise<ProfileRoute[]> {
    try {
      const profiles = (await fetchNodeProfiles(node)).map((profile) => ({
        key: `${node.id}${NODE_SEPARATOR}${profile.name}`,
        name: profile.name,
        port: profile.port,
        labels: profile.labels,
        purpose: profile.purpose,
        state: profile.state,
        node,
      }));
      this.nodeCache.set(node.id, { at: Date.now(), profiles });
      return profiles;
    } catch (error) {
      const message = (error as Error).message;
      console.error(`fleet: gateway: node ${node.id} did not answer: ${message}`);
      const unreachable: ProfileRoute[] = [
        {
          key: node.id,
          name: node.id,
          port: node.port,
          labels: [],
          purpose: null,
          state: 'unreachable',
          node,
        },
      ];
      this.nodeCache.set(node.id, { at: Date.now(), profiles: unreachable });
      return unreachable;
    }
  }

  /** Where a request for this route must be sent, and with which credential. */
  private targetFor(
    config: FleetConfig,
    route: ProfileRoute,
    targetPath: string,
    query: string,
  ): { url: string; host: string; token: string } {
    if (!route.node) {
      return {
        url: `http://127.0.0.1:${route.port}/${targetPath}${query}`,
        host: `127.0.0.1:${route.port}`,
        token: config.bridgeToken,
      };
    }
    return {
      url: `http://${route.node.host}:${route.node.port}/v1/node/${encodeURIComponent(route.name)}/${targetPath}${query}`,
      host: `${route.node.host}:${route.node.port}`,
      token: route.node.token,
    };
  }
}

function validBearer(header: string | undefined, token: string | null): boolean {
  if (token === null) return true;
  if (!header?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(header.slice(7));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type { ProfileSnapshot };
