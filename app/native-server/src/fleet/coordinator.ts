import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import replyFrom from '@fastify/reply-from';
import { timingSafeEqual } from 'node:crypto';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { runHijacked } from '../server/hijack';
import { normalizeSessionName } from '../mcp/session-name';
import { z } from 'zod';
import { TOOLS } from './mcp';
import type { ProfileSnapshot } from './supervisor';
import {
  CoordinatorClient,
  CoordinatorConfig,
  CoordinatorWorker,
  validateCoordinatorConfig,
  workerInventorySchema,
} from './coordinator-config';
import {
  CoordinatorError,
  CoordinatorLease,
  CoordinatorProfile,
  CoordinatorStore,
} from './coordinator-store';

const objectSchema = z.record(z.string(), z.unknown());
const asObject = (value: unknown): Record<string, unknown> => {
  const result = objectSchema.safeParse(value);
  if (!result.success) throw new CoordinatorError(400, 'invalid_body');
  return result.data;
};
const leaseHeaders = (lease: CoordinatorLease): Record<string, string> => ({
  'X-Humanchrome-Lease': lease.leaseId,
  'X-Humanchrome-Generation': String(lease.generation),
  'X-Humanchrome-Agent': `${lease.client}:${lease.agent}`,
});
const visibleLease = (lease: CoordinatorLease) => ({
  profile: lease.profile,
  client: lease.client,
  agent: lease.agent,
  expiresAt: lease.expiresAt,
});

export class FleetCoordinator {
  private readonly app: FastifyInstance;
  private readonly store: CoordinatorStore;
  private readonly identities = new WeakMap<FastifyRequest, CoordinatorClient>();
  private readonly workerHealth = new Map<string, { available: boolean; error: string | null }>();
  private refreshPromise: Promise<void> | null = null;
  private lastRefresh = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly active = new Map<string, number>();
  private readonly heartbeats = new Set<NodeJS.Timeout>();

  constructor(private readonly config: CoordinatorConfig) {
    this.config = validateCoordinatorConfig(config);
    this.store = new CoordinatorStore(config.id, config.databaseUrl);
    this.app = Fastify({ logger: false, forceCloseConnections: true, bodyLimit: 1024 * 1024 });
    this.app.register(replyFrom, {
      retryMethods: [],
      maxRetriesOn503: 0,
      undici: { headersTimeout: 180_000, bodyTimeout: 0 },
    });
    this.app.server.on('connection', (socket) => socket.on('error', () => undefined));
    this.app.setErrorHandler((error, _request, reply) => {
      if (error instanceof CoordinatorError)
        return reply.code(error.status).send({ error: error.code, message: error.message });
      // Never serialize PG connection strings, worker URLs or credentials from exceptions.
      return reply.code(503).send({ error: 'coordinator_unavailable' });
    });
    this.app.addHook('onRequest', async (request, reply) => {
      if (request.headers.origin) return reply.code(403).send({ error: 'origin_not_allowed' });
      if (['/healthz', '/readyz'].includes(request.url.split('?')[0])) return;
      const header = request.headers.authorization;
      const identity = config.clients.find((client) => tokenMatches(header, client.token));
      if (!identity) return reply.code(401).send({ error: 'unauthorized' });
      this.identities.set(request, identity);
      if (!(await this.store.ready()))
        return reply.code(503).send({ error: 'coordinator_unavailable' });
    });
    this.registerRoutes();
  }

  async listen(): Promise<string> {
    try {
      await this.store.open();
      await this.refresh(true);
      this.refreshTimer = setInterval(() => {
        void this.refresh(true).catch(() => {
          /* readiness fails closed when DB is lost */
        });
      }, 10_000);
      this.refreshTimer.unref();
      return await this.app.listen({ host: this.config.host, port: this.config.port });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    clearInterval(this.refreshTimer ?? undefined);
    for (const timer of this.heartbeats) clearInterval(timer);
    this.heartbeats.clear();
    await this.app.close();
    if (this.refreshPromise) await this.refreshPromise.catch(() => undefined);
    await this.store.close();
  }

  private identity(request: FastifyRequest): CoordinatorClient {
    const identity = this.identities.get(request);
    if (!identity) throw new CoordinatorError(401, 'unauthorized');
    return identity;
  }

  private agent(request: FastifyRequest, fallback?: string): string {
    const agent = normalizeSessionName(request.headers['x-humanchrome-agent'] ?? fallback);
    if (!agent) throw new CoordinatorError(400, 'missing_agent');
    return agent;
  }

  private admin(client: CoordinatorClient): void {
    if (!client.admin) throw new CoordinatorError(403, 'admin_required');
  }

  private worker(id: string): CoordinatorWorker {
    const worker = this.config.workers.find((worker) => worker.id === id);
    if (!worker) throw new CoordinatorError(404, 'unknown_worker');
    return worker;
  }

  private async workerJson(
    worker: CoordinatorWorker,
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
    timeout = 10_000,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${worker.url}/v1/worker${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${worker.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
    } catch {
      throw new CoordinatorError(503, 'worker_unavailable');
    }
    if (response.status === 204) return null;
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new CoordinatorError(502, 'invalid_worker_response');
    }
    if (!response.ok) {
      const code =
        result &&
        typeof result === 'object' &&
        'error' in result &&
        typeof result.error === 'string'
          ? result.error
          : 'worker_error';
      throw new CoordinatorError(response.status, code);
    }
    return result;
  }

  private async refresh(force = false): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && Date.now() - this.lastRefresh < 3_000) return;
    this.refreshPromise = (async () => {
      await Promise.all(
        this.config.workers.map(async (worker) => {
          let profiles: ProfileSnapshot[] | null = null;
          let error: string | null = null;
          try {
            const result = workerInventorySchema.parse(
              await this.workerJson(worker, '', 'GET', undefined, {}, 3_000),
            );
            if (result.id !== worker.id) throw new Error('worker identity mismatch');
            profiles = result.profiles;
          } catch {
            error = 'worker_unavailable';
          }
          this.workerHealth.set(worker.id, { available: profiles !== null, error });
          await this.store.observe(worker.id, profiles);
        }),
      );
      this.lastRefresh = Date.now();
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async profiles(client: CoordinatorClient): Promise<CoordinatorProfile[]> {
    await this.refresh();
    const profiles = await this.store.profiles(this.config.workers.map((worker) => worker.id));
    const leases = await this.store.leases();
    return profiles.map((profile) => {
      const holder = leases.find((lease) => lease.profile === profile.name);
      return {
        ...profile,
        leasedBy: holder
          ? holder.client === client.id || client.admin
            ? holder.agent
            : 'busy'
          : null,
      };
    });
  }

  private async reserve(
    client: CoordinatorClient,
    agent: string,
    named?: string,
    label?: string,
  ): Promise<{ lease: CoordinatorLease; profile: CoordinatorProfile; worker: CoordinatorWorker }> {
    const profiles = await this.profiles(client);
    if (named && !profiles.some((profile) => profile.name === named))
      throw new CoordinatorError(404, 'unknown_profile');
    const lease = await this.store.acquire(
      client.id,
      agent,
      profiles,
      this.config.leaseTtlSec,
      named,
      label,
    );
    const profile = profiles.find((profile) => profile.name === lease.profile)!;
    const worker = this.worker(profile.worker);
    await this.assertWorkerLease(worker, profile.profile, lease);
    return { lease, profile, worker };
  }

  private async assertWorkerLease(
    worker: CoordinatorWorker,
    name: string,
    lease: CoordinatorLease,
  ): Promise<void> {
    const deadline = await this.store.renewalDeadline(this.config.leaseTtlSec);
    await this.workerJson(worker, `/profiles/${encodeURIComponent(name)}/lease`, 'PUT', {
      agent: `${lease.client}:${lease.agent}`,
      leaseId: lease.leaseId,
      generation: lease.generation,
      ttlSec: this.config.leaseTtlSec,
    });
    await this.store.renew(lease, deadline);
  }

  private async releaseLease(lease: CoordinatorLease): Promise<void> {
    if (this.active.has(lease.leaseId)) throw new CoordinatorError(409, 'profile_busy');
    const [workerId, name] = lease.profile.split(':');
    // Keep DB ownership on transport failure: do not report release while the worker may be executing.
    try {
      await this.workerJson(
        this.worker(workerId),
        `/profiles/${encodeURIComponent(name)}/lease`,
        'DELETE',
        undefined,
        leaseHeaders(lease),
      );
    } catch (error) {
      if (!(error instanceof CoordinatorError) || error.code !== 'stale_lease') throw error;
    }
    await this.store.release(lease);
  }

  private async releaseAgent(client: CoordinatorClient, agent: string): Promise<string[]> {
    const leases = await this.store.leases(client.id, agent, true);
    const released: string[] = [];
    for (const lease of leases) {
      await this.releaseLease(lease);
      released.push(lease.profile);
    }
    await this.store.clearBindings(client.id, agent);
    return released;
  }

  private async control(
    client: CoordinatorClient,
    agent: string,
    name: string,
    action: string,
  ): Promise<unknown> {
    this.admin(client);
    if (!['start', 'stop', 'restart'].includes(action))
      throw new CoordinatorError(400, 'invalid_action');
    const existing = (await this.store.leases(client.id, agent)).some(
      (lease) => lease.profile === name,
    );
    const { lease, profile, worker } = await this.reserve(client, agent, name);
    try {
      return await this.workerJson(
        worker,
        `/profiles/${encodeURIComponent(profile.profile)}/${action}`,
        'POST',
        {},
        leaseHeaders(lease),
        180_000,
      );
    } finally {
      if (!existing) await this.releaseLease(lease);
    }
  }

  private async park(client: CoordinatorClient, parked: boolean): Promise<unknown> {
    this.admin(client);
    if ((await this.store.leases()).length) throw new CoordinatorError(409, 'profile_busy');
    const results = await Promise.allSettled(
      this.config.workers.map((worker) =>
        this.workerJson(worker, '/park', 'POST', { parked }, {}, 180_000),
      ),
    );
    const failed = results.flatMap((result, index) =>
      result.status === 'rejected' ? [this.config.workers[index].id] : [],
    );
    if (failed.length)
      throw new CoordinatorError(
        503,
        'park_incomplete',
        `workers not confirmed: ${failed.join(', ')}`,
      );
    await this.refresh(true);
    return { parked };
  }

  private registerRoutes(): void {
    this.app.get('/healthz', async (_request, reply) => {
      // Losing the leader connection is fatal: restart rather than serve without its lock.
      const healthy = await this.store.ready();
      return reply.code(healthy ? 200 : 503).send({ healthy });
    });
    this.app.get('/readyz', async (_request, reply) => {
      const ready = await this.store.ready();
      return reply.code(ready ? 200 : 503).send({ ready });
    });
    this.app.get('/v1/profiles', (request) => this.profiles(this.identity(request)));
    this.app.get('/v1/workers', async (request) => {
      this.admin(this.identity(request));
      await this.refresh();
      return this.config.workers.map((worker) => ({
        id: worker.id,
        ...this.workerHealth.get(worker.id),
      }));
    });
    this.app.get('/v1/leases', async (request) => {
      const client = this.identity(request);
      return (await this.store.leases(client.admin ? undefined : client.id)).map(visibleLease);
    });
    this.app.delete<{ Params: { agent: string } }>('/v1/leases/:agent', async (request) => {
      const agent = request.params.agent;
      if (agent !== this.agent(request)) throw new CoordinatorError(403, 'agent_mismatch');
      return { released: await this.releaseAgent(this.identity(request), agent) };
    });
    this.app.post('/v1/profiles', async (request) => {
      this.admin(this.identity(request));
      const body = asObject(request.body);
      if (
        typeof body.worker !== 'string' ||
        typeof body.name !== 'string' ||
        typeof body.seedSource !== 'string'
      )
        throw new CoordinatorError(400, 'invalid_args');
      const result = await this.workerJson(
        this.worker(body.worker),
        '/profiles',
        'POST',
        { name: body.name, labels: body.labels ?? [], seedSource: body.seedSource },
        {},
        180_000,
      );
      await this.refresh(true);
      return result;
    });
    for (const action of ['start', 'stop', 'restart']) {
      this.app.post<{ Params: { name: string } }>(`/v1/profiles/:name/${action}`, (request) =>
        this.control(
          this.identity(request),
          this.agent(request, 'control'),
          request.params.name,
          action,
        ),
      );
    }
    this.app.post<{ Params: { name: string } }>('/v1/profiles/:name/recover', async (request) => {
      const client = this.identity(request);
      this.admin(client);
      const name = request.params.name;
      const profile = (await this.profiles(client)).find((profile) => profile.name === name);
      if (!profile) throw new CoordinatorError(404, 'unknown_profile');
      if ((await this.store.leases()).some((lease) => lease.profile === name))
        throw new CoordinatorError(409, 'profile_busy');
      const result = await this.workerJson(
        this.worker(profile.worker),
        `/profiles/${encodeURIComponent(profile.profile)}/recover`,
        'POST',
        {},
        {},
        180_000,
      );
      await this.refresh(true);
      return result;
    });
    this.app.post('/v1/park', async (request) => {
      const body = asObject(request.body);
      if (typeof body.parked !== 'boolean') throw new CoordinatorError(400, 'invalid_args');
      return this.park(this.identity(request), body.parked);
    });
    this.app.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/v1/fleet/mcp',
      handler: async (request, reply) => {
        const client = this.identity(request);
        const handler = createMcpHandler(() => this.mcpServer(client, request));
        return runHijacked(reply, () =>
          toNodeHandler(handler)(request.raw, reply.raw, request.body),
        );
      },
    });
    this.app.register(async (instance) => {
      instance.removeAllContentTypeParsers();
      instance.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
      const proxy = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const params = request.params as { name?: string; label?: string; '*': string };
        const remainder = params['*'] ?? '';
        if (
          !(
            remainder === 'mcp' ||
            remainder === 'ping' ||
            remainder === 'api/tools' ||
            remainder === 'api/openapi.json' ||
            /^api\/tools\/[a-zA-Z0-9_]+$/.test(remainder)
          )
        )
          return reply.code(404).send({ error: 'not_found' });
        const client = this.identity(request);
        const agent = this.agent(request);
        const { lease, profile, worker } = await this.reserve(
          client,
          agent,
          params.name,
          params.label,
        );
        this.active.set(lease.leaseId, (this.active.get(lease.leaseId) ?? 0) + 1);
        let done = false;
        let renewing = false;
        const heartbeat = setInterval(
          () => {
            if (renewing || done) return;
            renewing = true;
            void (async () => {
              await this.assertWorkerLease(worker, profile.profile, lease);
            })()
              .catch(() => reply.raw.destroy())
              .finally(() => {
                renewing = false;
              });
          },
          Math.max(1_000, Math.floor((this.config.leaseTtlSec * 1000) / 3)),
        );
        heartbeat.unref();
        this.heartbeats.add(heartbeat);
        const finish = () => {
          if (done) return;
          done = true;
          clearInterval(heartbeat);
          this.heartbeats.delete(heartbeat);
          const count = (this.active.get(lease.leaseId) ?? 1) - 1;
          if (count) this.active.set(lease.leaseId, count);
          else this.active.delete(lease.leaseId);
        };
        reply.raw.once('finish', finish);
        reply.raw.once('close', finish);
        const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
        reply.header('X-Humanchrome-Profile', profile.name);
        await reply.from(
          `${worker.url}/v1/worker/profiles/${encodeURIComponent(profile.profile)}/browser/${remainder}${query}`,
          {
            retryDelay: () => null,
            retriesCount: 0,
            rewriteHeaders: (headers) => ({ ...headers, 'x-humanchrome-profile': profile.name }),
            rewriteRequestHeaders: (_request, headers) => {
              const outgoing: Record<string, string | string[] | undefined> = {};
              for (const name of [
                'accept',
                'content-type',
                'content-length',
                'mcp-session-id',
                'mcp-protocol-version',
                'last-event-id',
              ])
                outgoing[name] = headers[name];
              return {
                ...outgoing,
                host: new URL(worker.url).host,
                authorization: `Bearer ${worker.token}`,
                ...Object.fromEntries(
                  Object.entries(leaseHeaders(lease)).map(([key, value]) => [
                    key.toLowerCase(),
                    value,
                  ]),
                ),
              };
            },
            onError: (response) => {
              finish();
              if (!response.raw.headersSent)
                response.code(502).send({
                  error: 'outcome_unknown',
                  message:
                    'The worker connection failed; the browser action may have executed. It was not retried.',
                });
              else response.raw.destroy();
            },
          },
        );
      };
      instance.all('/v1/profiles/:name/*', proxy);
      instance.all('/v1/pool/:label/*', proxy);
    });
  }

  private mcpServer(client: CoordinatorClient, request: FastifyRequest): Server {
    const server = new Server(
      { name: 'HumanChromeFleet', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', () => ({ tools: TOOLS }));
    server.setRequestHandler('tools/call', async (call) => {
      try {
        const args = asObject(call.params.arguments ?? {});
        let result: unknown;
        switch (call.params.name) {
          case 'fleet_profiles':
            result = await this.profiles(client);
            break;
          case 'fleet_profile':
            if (typeof args.name !== 'string' || typeof args.action !== 'string')
              throw new CoordinatorError(400, 'invalid_args');
            result = await this.control(
              client,
              this.agent(request, 'control'),
              args.name,
              args.action,
            );
            break;
          case 'fleet_leases':
            if ((args.action ?? 'list') === 'list')
              result = {
                leases: (await this.store.leases(client.admin ? undefined : client.id)).map(
                  visibleLease,
                ),
              };
            else if (
              args.action === 'release' &&
              typeof args.agent === 'string' &&
              args.agent === this.agent(request)
            )
              result = { released: await this.releaseAgent(client, args.agent) };
            else throw new CoordinatorError(403, 'agent_mismatch');
            break;
          case 'fleet_purposes':
            result = {
              purposes: (await this.profiles(client))
                .filter((p) => p.purpose)
                .map((p) => ({
                  purpose: p.purpose,
                  profile: p.name,
                  node: p.worker,
                  state: p.state,
                  labels: p.labels,
                })),
            };
            break;
          case 'fleet_park':
            if (typeof args.parked !== 'boolean') throw new CoordinatorError(400, 'invalid_args');
            result = await this.park(client, args.parked);
            break;
          default:
            throw new CoordinatorError(404, 'unknown_tool');
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] } as CallToolResult;
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof CoordinatorError ? error.code : 'coordinator_unavailable',
            },
          ],
        };
      }
    });
    return server;
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
