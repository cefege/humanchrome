import { timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isIP, type Socket } from 'node:net';
import path from 'node:path';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import replyFrom from '@fastify/reply-from';
import { addProfile, type AddedProfile } from './provision';
import {
  FLEET_ROOT,
  type FleetConfig,
  loadConfig,
  saveConfig,
  validateProfileName,
} from './config';
import { type ProfileSnapshot, ProfileSupervisor } from './supervisor';
import {
  WorkerState,
  WorkerStateError,
  type WorkerExecution,
  type WorkerLeaseIdentity,
} from './worker-state';

const WORKER_CONFIG_FILE = 'worker.json';
const WORKER_FENCES_FILE = 'worker-fences.sqlite';
const REAP_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['start', 'stop', 'restart']);

export interface WorkerConfig {
  id: string;
  host: string;
  port: number;
  token: string;
  /** Names the operator has explicitly permitted this worker to expose/create. */
  profiles: string[];
  /** Operator-owned symbolic seed aliases. Values are absolute paths or null. */
  seedSources: Record<string, string | null>;
}

export interface WorkerServerOptions {
  config: WorkerConfig;
  supervisor: ProfileSupervisor;
  /** Defaults to `<HC_FLEET_ROOT>/worker-fences.sqlite`. */
  state?: WorkerState;
  bridgeToken?: string;
  addProfile?: (name: string, labels: string[], seedDir: string | null) => Promise<AddedProfile>;
  loadFleetConfig?: () => Promise<FleetConfig>;
  saveFleetConfig?: (config: FleetConfig) => Promise<void>;
  /** Injectable so release is deterministic without a real extension in tests. */
  releaseLane?: (profile: string, lane: string) => Promise<void>;
}

export class WorkerServer {
  private readonly app: FastifyInstance;
  private readonly config: WorkerConfig;
  private readonly supervisor: ProfileSupervisor;
  private readonly state: WorkerState;
  private readonly add: NonNullable<WorkerServerOptions['addProfile']>;
  private readonly loadFleetConfig: NonNullable<WorkerServerOptions['loadFleetConfig']>;
  private readonly saveFleetConfig: NonNullable<WorkerServerOptions['saveFleetConfig']>;
  private readonly releaseLane: NonNullable<WorkerServerOptions['releaseLane']>;
  private readonly bridgeToken: string;
  private readonly ownsState: boolean;
  private readonly serial = new Map<string, Promise<unknown>>();
  private reapTimer: NodeJS.Timeout | null = null;
  private configurationSerial: Promise<void> = Promise.resolve();
  private parking = false;

  constructor(options: WorkerServerOptions) {
    validateWorkerConfig(options.config);
    this.config = options.config;
    this.supervisor = options.supervisor;
    this.ownsState = !options.state;
    this.state = options.state ?? new WorkerState(path.join(FLEET_ROOT, WORKER_FENCES_FILE));
    this.add = options.addProfile ?? addProfile;
    this.loadFleetConfig = options.loadFleetConfig ?? loadConfig;
    this.saveFleetConfig = options.saveFleetConfig ?? saveConfig;
    this.bridgeToken = options.bridgeToken ?? '';
    this.releaseLane =
      options.releaseLane ?? ((profile, lane) => this.releaseBridgeLane(profile, lane));
    this.app = Fastify({ logger: false });
    // Browser actions are non-idempotent. reply-from's otherwise helpful retry
    // defaults must never make a click/navigation happen twice after a socket error.
    this.app.register(replyFrom, {
      retryMethods: [],
      maxRetriesOn503: 0,
    });
    this.app.server.on('connection', (socket: Socket) => socket.on('error', () => undefined));
    this.app.addHook('onRequest', async (request, reply) => {
      if (request.headers.origin) return this.error(reply, 403, 'origin_not_allowed');
      if (request.url.split('?')[0] === '/healthz') return;
      if (!validBearer(request.headers.authorization, this.config.token)) {
        return this.error(reply, 401, 'unauthorized');
      }
    });
    this.app.setNotFoundHandler((_request, reply) => this.error(reply, 404, 'not_found'));
    this.app.setErrorHandler((error, _request, reply) => {
      const candidate =
        error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
      const status =
        typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
      this.error(
        reply,
        status,
        status === 500 ? 'internal_error' : 'invalid_request',
        message(error),
      );
    });
    this.registerRoutes();
  }

  async listen(): Promise<string> {
    await assertTailscaleBind(this.config.host);
    this.reapTimer ??= setInterval(() => {
      void this.reapIdle().catch((error: unknown) =>
        console.error(`fleet worker: idle reap failed: ${message(error)}`),
      );
    }, REAP_MS);
    this.reapTimer.unref?.();
    return this.app.listen({ host: this.config.host, port: this.config.port });
  }

  async inject(options: InjectOptions): Promise<LightMyRequestResponse> {
    return this.app.inject(options);
  }

  async close(): Promise<void> {
    clearInterval(this.reapTimer ?? undefined);
    this.reapTimer = null;
    const closing = this.app.close();
    let closed = await settlesWithin(closing, SHUTDOWN_GRACE_MS);
    if (!closed) {
      this.app.server.closeAllConnections?.();
      closed = await settlesWithin(closing, 1_000);
    }
    if (closed && this.ownsState) this.state.close();
  }

  private registerRoutes(): void {
    this.app.get('/healthz', async () => ({ status: 'ok' }));
    this.app.get('/v1/worker', async (_request, reply) => {
      const profiles = this.supervisor
        .snapshot((name) => this.state.leasedBy(name))
        .filter((profile) => this.config.profiles.includes(profile.name));
      return reply.send({ id: this.config.id, profiles });
    });

    this.app.put('/v1/worker/profiles/:name/lease', async (request, reply) => {
      const name = (request.params as { name: string }).name;
      if (!this.knownProfile(name)) return this.error(reply, 404, 'unknown_profile');
      const body = request.body;
      const parsed = parseLeaseBody(body);
      if (!parsed) return this.error(reply, 400, 'invalid_lease');
      try {
        const lease = await this.exclusive(name, async () => {
          if (this.parking) throw new WorkerStateError('profile_busy', 'worker is parking');
          const handoff = this.state.reserveHandoff(name, parsed.identity);
          if (handoff) {
            try {
              await this.releaseLane(name, laneFor(handoff.prior.leaseId));
            } finally {
              handoff.release();
            }
          }
          return this.state.claim(name, parsed.identity, parsed.ttlSec);
        });
        return reply.send({ ...lease, expiresAt: new Date(lease.expiresAt).toISOString() });
      } catch (error) {
        return this.stateError(reply, error);
      }
    });

    this.app.delete('/v1/worker/profiles/:name/lease', async (request, reply) => {
      const name = (request.params as { name: string }).name;
      if (!this.knownProfile(name)) return this.error(reply, 404, 'unknown_profile');
      const identity = leaseHeaders(request);
      if (!identity) return this.error(reply, 400, 'invalid_lease');
      try {
        await this.exclusive(name, async () => {
          this.state.release(name, identity);
          await this.releaseLane(name, laneFor(identity.leaseId));
        });
        return reply.code(204).send();
      } catch (error) {
        return this.stateError(reply, error);
      }
    });

    const lifecycle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const { name, action } = request.params as { name: string; action: string };
      if (!this.knownProfile(name)) return this.error(reply, 404, 'unknown_profile');
      if (!ACTIONS.has(action) && action !== 'recover') return this.error(reply, 404, 'not_found');
      if (action === 'recover') {
        if (
          request.headers['x-humanchrome-lease'] !== undefined ||
          request.headers['x-humanchrome-generation'] !== undefined ||
          request.headers['x-humanchrome-agent'] !== undefined
        ) {
          return this.error(reply, 400, 'invalid_recovery');
        }
        try {
          await this.exclusive(name, async () => {
            const prior = this.state.recordedLeaseFor(name);
            const done = this.state.beginRecovery(name);
            try {
              await this.supervisor.stopProfile(name);
              await this.supervisor.startProfile(name);
              if (prior) await this.releaseLane(name, laneFor(prior.leaseId));
              this.state.clearUncertainAfterRecovery(name);
            } finally {
              done();
            }
          });
          reply.send(this.snapshot(name));
        } catch (error) {
          this.stateError(reply, error);
        }
        return;
      }
      const identity = leaseHeaders(request);
      if (!identity) return this.error(reply, 400, 'invalid_lease');
      try {
        await this.exclusive(name, async () => {
          const recovering = action === 'restart';
          const done = this.state.beginTransition(name, identity, recovering);
          try {
            if (action === 'start') await this.supervisor.startProfile(name);
            if (action === 'stop') await this.supervisor.stopProfile(name);
            if (action === 'restart') {
              await this.supervisor.restartProfile(name);
              this.state.clearUncertainAfterRestart(name, identity);
            }
          } finally {
            done();
          }
        });
        reply.send(this.snapshot(name));
      } catch (error) {
        this.stateError(reply, error);
      }
    };
    this.app.post('/v1/worker/profiles/:name/:action', lifecycle);

    this.app.post('/v1/worker/profiles', async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return this.error(reply, 400, 'invalid_body');
      }
      const {
        name,
        labels = [],
        seedSource,
      } = body as {
        name?: unknown;
        labels?: unknown;
        seedSource?: unknown;
      };
      if (typeof name !== 'string' || !this.knownProfile(name)) {
        return this.error(reply, 400, 'invalid_name');
      }
      if (!Array.isArray(labels) || !labels.every((label) => typeof label === 'string')) {
        return this.error(reply, 400, 'invalid_labels');
      }
      if (typeof seedSource !== 'string' || !(seedSource in this.config.seedSources)) {
        return this.error(reply, 400, 'invalid_seed_source');
      }
      try {
        const result = await this.withConfigurationMutation(() =>
          this.exclusive(name, async () => {
            if (this.supervisor.state(name))
              throw new WorkerStateError('profile_exists', 'profile exists');
            const added = await this.add(name, labels, this.config.seedSources[seedSource]);
            // addProfile only registers after the browser proves it is usable. A
            // reload after that point lets this supervisor adopt precisely that browser.
            await this.supervisor.reload(await this.loadFleetConfig());
            return added;
          }),
        );
        return reply.code(201).send(result);
      } catch (error) {
        return this.stateError(reply, error, 'provision_failed');
      }
    });

    this.app.post('/v1/worker/park', async (request, reply) => {
      const body = request.body;
      if (
        !body ||
        typeof body !== 'object' ||
        typeof (body as { parked?: unknown }).parked !== 'boolean'
      ) {
        return this.error(reply, 400, 'invalid_body');
      }
      if (this.parking) return this.error(reply, 409, 'profile_busy');
      this.parking = true;
      try {
        const parked = await this.withConfigurationMutation(async () => {
          if (this.state.hasLiveLeases() || this.state.hasActiveWork()) {
            throw new WorkerStateError('profile_busy', 'profile has active work');
          }
          const config = await this.loadFleetConfig();
          config.parked = (body as { parked: boolean }).parked;
          await this.saveFleetConfig(config);
          await this.supervisor.reload(config);
          return config.parked;
        });
        return reply.send({ parked });
      } catch (error) {
        return this.stateError(reply, error, 'park_failed');
      } finally {
        this.parking = false;
      }
    });

    this.app.register(async (instance) => {
      instance.removeAllContentTypeParsers();
      instance.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
      instance.all('/v1/worker/profiles/:name/browser/*', (request, reply) =>
        this.proxyBrowser(request, reply),
      );
    });
  }

  private async proxyBrowser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { name, '*': targetPath = '' } = request.params as { name: string; '*': string };
    if (!this.knownProfile(name)) return this.error(reply, 404, 'unknown_profile');
    if (!allowedBrowserPath(targetPath)) return this.error(reply, 404, 'not_found');
    if (this.parking) return this.error(reply, 409, 'profile_busy');
    const identity = leaseHeaders(request);
    if (!identity) return this.error(reply, 400, 'invalid_lease');

    let execution: WorkerExecution | undefined;
    try {
      const runtime = this.snapshot(name);
      if (!runtime) return this.error(reply, 404, 'unknown_profile');
      if (runtime.state !== 'healthy') {
        const done = this.state.beginTransition(name, identity);
        try {
          await this.supervisor.demandStart(name, {
            agent: laneFor(identity.leaseId),
            request: `worker/${name}`,
          });
        } finally {
          done();
        }
      }
      execution =
        request.method === 'GET' || request.method === 'HEAD'
          ? this.state.beginRead(name, identity)
          : this.state.beginExecution(name, identity);
      const current = this.snapshot(name);
      if (!current || current.state !== 'healthy') {
        execution.complete();
        return this.error(reply, 503, 'profile_unavailable', current?.state);
      }
      // A client disconnect only says that the caller did not observe the
      // result. Mutating requests retain their durable marker until the bridge
      // response ends; GET/HEAD streams merely release their in-memory guard.
      reply.raw.once('close', execution.clientClosed);
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const target = `http://127.0.0.1:${current.port}/${targetPath}${query}`;
      await reply.from(target, {
        retriesCount: 0,
        retryDelay: () => null,
        rewriteRequestHeaders: (_original, headers) => {
          const forwarded = { ...headers };
          delete forwarded.authorization;
          delete forwarded.host;
          delete forwarded['x-client-id'];
          delete forwarded['x-humanchrome-session'];
          delete forwarded['x-humanchrome-agent'];
          delete forwarded['x-humanchrome-lease'];
          delete forwarded['x-humanchrome-generation'];
          return {
            ...forwarded,
            host: `127.0.0.1:${current.port}`,
            authorization: `Bearer ${this.bridgeToken}`,
            'x-client-id': laneFor(identity.leaseId),
            'x-humanchrome-session': laneFor(identity.leaseId),
          };
        },
        onResponse: (_request, upstreamReply, response) => {
          response.stream.once('end', () => execution?.complete());
          response.stream.once('error', () => execution?.clientClosed());
          response.stream.once('aborted', () => execution?.clientClosed());
          response.stream.once('close', () => {
            if (!response.stream.complete) execution?.clientClosed();
          });
          upstreamReply.send(response.stream);
        },
        onError: (upstreamReply, error) => {
          execution?.clientClosed();
          if (!upstreamReply.sent) {
            upstreamReply
              .code(502)
              .send({ error: 'outcome_unknown', message: message(error.error) });
          }
        },
      });
    } catch (error) {
      execution?.clientClosed();
      if (error instanceof WorkerStateError) return this.stateError(reply, error);
      if (!reply.sent) return this.error(reply, 502, 'outcome_unknown', message(error));
    }
  }

  private async releaseBridgeLane(profile: string, lane: string): Promise<void> {
    const runtime = this.snapshot(profile);
    if (!runtime) return;
    // Best effort only: the durable fence has already made the old identity
    // unusable. A stopped browser has no lane to release and demand-starting it
    // merely to release an old client would mutate profile state.
    if (runtime.state !== 'healthy') return;
    await fetch(
      `http://127.0.0.1:${runtime.port}/api/clients/${encodeURIComponent(lane)}/release`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.bridgeToken}` },
      },
    ).catch(() => undefined);
  }

  private snapshot(name: string): ProfileSnapshot | undefined {
    return this.supervisor
      .snapshot((profile) => this.state.leasedBy(profile))
      .find((p) => p.name === name);
  }

  private knownProfile(name: string): boolean {
    return this.config.profiles.includes(name);
  }

  private async reapIdle(): Promise<void> {
    await this.supervisor.reapIdle((name) => this.state.leaseFor(name) !== null);
  }

  private async exclusive<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.serial.get(name) ?? Promise.resolve();
    let resolveCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    this.serial.set(name, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      resolveCurrent();
      if (this.serial.get(name) === current) this.serial.delete(name);
    }
  }

  private async withConfigurationMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.configurationSerial;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.configurationSerial = current;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private stateError(
    reply: FastifyReply,
    error: unknown,
    fallback = 'operation_failed',
  ): FastifyReply {
    if (error instanceof WorkerStateError)
      return this.error(reply, error.status, error.error, error.message);
    return this.error(reply, 422, fallback, message(error));
  }

  private error(reply: FastifyReply, status: number, error: string, detail?: string): FastifyReply {
    return reply.code(status).send(detail ? { error, message: detail } : { error });
  }
}

export function workerConfigPath(root = FLEET_ROOT): string {
  return path.join(root, WORKER_CONFIG_FILE);
}

export async function loadWorkerConfig(root = FLEET_ROOT): Promise<WorkerConfig> {
  const parsed = JSON.parse(await fs.readFile(workerConfigPath(root), 'utf8')) as WorkerConfig;
  validateWorkerConfig(parsed);
  return parsed;
}

export async function saveWorkerConfig(config: WorkerConfig, root = FLEET_ROOT): Promise<void> {
  validateWorkerConfig(config);
  await fs.mkdir(root, { recursive: true });
  const file = workerConfigPath(root);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

export function validateWorkerConfig(config: WorkerConfig): void {
  if (!config || typeof config !== 'object') throw new Error('invalid worker config');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(config.id)) throw new Error('invalid worker id');
  if (typeof config.host !== 'string' || !config.host) throw new Error('invalid worker host');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error('invalid worker port');
  }
  if (typeof config.token !== 'string' || config.token.length < 32)
    throw new Error('worker token is too short');
  if (!Array.isArray(config.profiles) || !config.profiles.length)
    throw new Error('worker profiles are required');
  for (const name of config.profiles) validateProfileName(name);
  if (new Set(config.profiles).size !== config.profiles.length)
    throw new Error('worker profiles are duplicated');
  if (
    !config.seedSources ||
    typeof config.seedSources !== 'object' ||
    Array.isArray(config.seedSources)
  ) {
    throw new Error('invalid worker seed sources');
  }
  for (const [name, source] of Object.entries(config.seedSources)) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error(`invalid seed source ${name}`);
    if (source !== null && (typeof source !== 'string' || !path.isAbsolute(source))) {
      throw new Error(`seed source ${name} must be an absolute path or null`);
    }
  }
}

export async function assertTailscaleBind(host: string): Promise<void> {
  if (host === '0.0.0.0' || host === '::' || host === 'localhost' || host === '127.0.0.1') {
    throw new Error('worker host must be a Tailscale address or MagicDNS hostname');
  }
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    if (octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) {
      throw new Error('worker IPv4 host must be in Tailscale 100.64.0.0/10');
    }
  }
  if (family === 6 && !host.toLowerCase().startsWith('fd7a:115c:a1e0:')) {
    throw new Error('worker IPv6 host must be in Tailscale fd7a:115c:a1e0::/48');
  }
  if (!family && (!host.endsWith('.ts.net') || host.includes('/'))) {
    throw new Error('worker hostname must be a MagicDNS .ts.net name');
  }
}

function validBearer(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(header.slice(7));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseLeaseBody(body: unknown): { identity: WorkerLeaseIdentity; ttlSec: number } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { agent, leaseId, generation, ttlSec } = body as Record<string, unknown>;
  if (
    typeof agent !== 'string' ||
    !agent ||
    agent.length > 256 ||
    typeof leaseId !== 'string' ||
    !UUID_RE.test(leaseId) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) <= 0 ||
    !Number.isInteger(ttlSec) ||
    (ttlSec as number) < 15 ||
    (ttlSec as number) > 900
  ) {
    return null;
  }
  return {
    identity: { agent, leaseId, generation: generation as number },
    ttlSec: ttlSec as number,
  };
}

function leaseHeaders(request: FastifyRequest): WorkerLeaseIdentity | null {
  const leaseId = request.headers['x-humanchrome-lease'];
  const rawGeneration = request.headers['x-humanchrome-generation'];
  const current = request.headers['x-humanchrome-agent'];
  const generation = typeof rawGeneration === 'string' ? Number(rawGeneration) : NaN;
  if (
    typeof leaseId !== 'string' ||
    !UUID_RE.test(leaseId) ||
    typeof current !== 'string' ||
    !current ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    return null;
  }
  return { leaseId, generation, agent: current };
}

function allowedBrowserPath(target: string): boolean {
  return (
    target === 'mcp' ||
    target === 'ping' ||
    target === 'api/openapi.json' ||
    target === 'api/tools' ||
    /^api\/tools\/[a-zA-Z0-9_.-]+$/.test(target)
  );
}

function laneFor(leaseId: string): string {
  return `lease-${leaseId}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
