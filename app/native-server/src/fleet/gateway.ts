import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import replyFrom from '@fastify/reply-from';
import { timingSafeEqual } from 'node:crypto';
import { FleetConfig } from './config';
import { FleetLeases } from './leases';
import { ProfileSupervisor, ProfileSnapshot } from './supervisor';
import { normalizeSessionName } from '../mcp/session-name';

export interface FleetGatewayOptions {
  config: FleetConfig;
  supervisor: ProfileSupervisor;
  leases: FleetLeases;
}

export class FleetGateway {
  private readonly app: FastifyInstance;
  private readonly options: FleetGatewayOptions;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: FleetGatewayOptions) {
    this.options = options;
    this.app = Fastify({ logger: false });
    this.app.register(replyFrom);
    this.app.addHook('onRequest', async (request, reply) => {
      if (request.headers.origin) {
        reply.code(403).send({ error: 'origin_not_allowed' });
        return;
      }
      if (!validBearer(request.headers.authorization, options.config.token)) {
        reply.code(401).send({ error: 'unauthorized' });
      }
    });
    this.registerRoutes();
  }

  async listen(): Promise<string> {
    return this.app.listen({
      port: this.options.config.gateway.port,
      host: this.options.config.gateway.host,
    });
  }
  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.app.close();
  }
  getInstance(): FastifyInstance {
    return this.app;
  }

  private registerRoutes(): void {
    this.app.get('/v1/profiles', async (_request, reply) => {
      reply.send(
        this.options.supervisor.snapshot(
          (profile) =>
            this.options.leases.list().find((lease) => lease.profile === profile)?.agent ?? null,
        ),
      );
    });
    this.app.post('/v1/profiles/:name/restart', async (request, reply) => {
      const { name } = request.params as { name: string };
      if (!this.options.supervisor.state(name))
        return reply.code(404).send({ error: 'unknown_profile' });
      void this.options.supervisor.restartProfile(name);
      reply.code(202).send({ restarting: name });
    });
    this.app.get('/v1/leases', async (_request, reply) => reply.send(this.options.leases.list()));
    this.app.delete('/v1/leases/:agent', async (request, reply) => {
      const agent = normalizeSessionName((request.params as { agent: string }).agent);
      if (!agent) return reply.code(400).send({ error: 'invalid_agent' });
      const released = this.options.leases.release(agent);
      await Promise.all(released.map((profile) => this.releaseBridge(agent, profile)));
      return reply.send({ released });
    });

    const proxy = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const agent = normalizeSessionName(request.headers['x-humanchrome-agent']);
      if (!agent) return reply.code(400).send({ error: 'missing_agent' });
      const params = request.params as { name?: string; label?: string; '*': string };
      if (params['*']?.startsWith('admin')) return reply.code(404).send({ error: 'not_found' });
      if (params.name && !this.options.supervisor.state(params.name)) {
        return reply.code(404).send({ error: 'unknown_profile' });
      }
      if (params.name && this.options.supervisor.state(params.name) !== 'healthy') {
        return reply
          .code(503)
          .send({
            error: 'profile_unavailable',
            state: this.options.supervisor.state(params.name),
          });
      }
      const profile =
        params.name ??
        this.options.leases.acquireFromPool(
          agent,
          params.label ?? 'any',
          this.healthyCandidates(params.label ?? 'any'),
        );
      if (!profile) {
        return reply.code(503).send({ error: 'no_free_profile', label: params.label });
      }
      if (params.name) {
        const acquisition = this.options.leases.acquire(agent, profile);
        if (!acquisition.ok) {
          return reply.code(409).send({ error: 'profile_busy', heldBy: acquisition.heldBy });
        }
      }
      const runtime = this.options.supervisor.snapshot().find((entry) => entry.name === profile);
      if (!runtime || runtime.state !== 'healthy') {
        return reply.code(503).send({ error: 'profile_unavailable', state: runtime?.state });
      }
      this.options.leases.touch(agent, profile);
      const targetPath = params['*'] ?? '';
      const query = request.url.includes('?')
        ? `?${request.url.slice(request.url.indexOf('?') + 1)}`
        : '';
      const target = `http://127.0.0.1:${runtime.port}/${targetPath}${query}`;
      reply.header('X-Humanchrome-Profile', profile);
      await reply.from(target, {
        rewriteRequestHeaders: (_request, headers) => ({
          ...headers,
          host: `127.0.0.1:${runtime.port}`,
          authorization: `Bearer ${this.options.config.bridgeToken}`,
          'x-humanchrome-session': headers['x-humanchrome-session'] ?? agent,
          'x-client-id': headers['x-client-id'] ?? agent,
        }),
      });
    };

    this.app.register(async (instance) => {
      instance.removeAllContentTypeParsers();
      instance.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
      instance.all('/v1/profiles/:name/*', proxy);
      instance.all('/v1/pool/:label/*', proxy);
    });
    this.sweepTimer = setInterval(() => void this.sweep(), 30_000);
  }

  private healthyCandidates(label: string): string[] {
    return this.options.supervisor
      .snapshot()
      .filter(
        (profile) =>
          profile.enabled &&
          profile.state === 'healthy' &&
          (label === 'any' || profile.labels.includes(label)),
      )
      .map((profile) => profile.name);
  }

  private async sweep(): Promise<void> {
    for (const lease of this.options.leases.sweep())
      await this.releaseBridge(lease.agent, lease.profile);
  }

  private async releaseBridge(agent: string, profile: string): Promise<void> {
    const runtime = this.options.supervisor.snapshot().find((entry) => entry.name === profile);
    if (!runtime) return;
    try {
      await fetch(
        `http://127.0.0.1:${runtime.port}/api/clients/${encodeURIComponent(agent)}/release`,
        { method: 'POST', headers: { authorization: `Bearer ${this.options.config.bridgeToken}` } },
      );
    } catch {
      /* best effort */
    }
  }
}

function validBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(header.slice(7));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
