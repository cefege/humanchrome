import { afterEach, describe, expect, test } from '@jest/globals';
import Fastify from 'fastify';
import { WorkerServer, type WorkerConfig } from './worker';
import { WorkerState } from './worker-state';
import type { ProfileSnapshot, ProfileSupervisor } from './supervisor';
import type { FleetConfig } from './config';

const token = 't'.repeat(32);
const identity = {
  agent: 'tenant-a:agent-a',
  leaseId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
};
const workerConfig: WorkerConfig = {
  id: 'mac-one',
  host: '100.100.100.100',
  port: 12320,
  token,
  profiles: ['browser', 'extra'],
  seedSources: { daily: '/Users/test/Chrome', empty: null },
};

const servers: WorkerServer[] = [];
const upstreams: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(upstreams.splice(0).map((server) => server.close()));
});

function fakeSupervisor(port = 12500): { supervisor: ProfileSupervisor; actions: string[] } {
  const actions: string[] = [];
  const profiles: ProfileSnapshot[] = [
    {
      name: 'browser',
      port,
      labels: [],
      enabled: true,
      purpose: null,
      state: 'healthy',
      pid: 1,
      leasedBy: null,
      lastError: null,
      startedBy: null,
    },
  ];
  return {
    actions,
    supervisor: {
      snapshot: () => profiles,
      state: (name: string) => profiles.find((profile) => profile.name === name)?.state,
      startProfile: async (name: string) => {
        actions.push(`start:${name}`);
      },
      stopProfile: async (name: string) => {
        actions.push(`stop:${name}`);
      },
      restartProfile: async (name: string) => {
        actions.push(`restart:${name}`);
      },
      reapIdle: async () => undefined,
      reload: async () => undefined,
    } as unknown as ProfileSupervisor,
  };
}

interface FixtureOptions {
  state?: WorkerState;
  releaseLane?: (profile: string, lane: string) => Promise<void>;
  port?: number;
}

function fixture(options: FixtureOptions = {}): WorkerServer {
  const { supervisor } = fakeSupervisor(options.port);
  const state = options.state ?? new WorkerState(':memory:');
  const config: FleetConfig = {
    version: 1,
    gateway: { host: '127.0.0.1', port: 12300 },
    token: null,
    bridgeToken: 'b'.repeat(32),
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    extensionDir: '/tmp/extension',
    basePort: 12500,
    leaseIdleTtlSec: 900,
    parked: false,
    demandStartTimeoutSec: 90,
    profiles: [],
    nodeId: 'mac-one',
    nodes: [],
  };
  const server = new WorkerServer({
    config: workerConfig,
    supervisor,
    state,
    bridgeToken: config.bridgeToken,
    loadFleetConfig: async () => config,
    saveFleetConfig: async () => undefined,
    releaseLane: options.releaseLane ?? (async () => undefined),
  });
  servers.push(server);
  return server;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

describe('WorkerServer permissions and ownership', () => {
  test('exposes only health without credentials and rejects web origins', async () => {
    const worker = fixture();
    expect((await worker.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await worker.inject({ method: 'GET', url: '/v1/worker' })).statusCode).toBe(401);
    expect(
      (
        await worker.inject({
          method: 'GET',
          url: '/v1/worker',
          headers: headers({ origin: 'https://attacker.example' }),
        })
      ).statusCode,
    ).toBe(403);
    const inventory = await worker.inject({
      method: 'GET',
      url: '/v1/worker',
      headers: headers(),
    });
    expect(JSON.parse(inventory.body)).toMatchObject({
      id: 'mac-one',
      profiles: [{ name: 'browser' }],
    });
  });

  test('requires exact coordinator ownership for control and keeps a profile fence', async () => {
    const worker = fixture();
    const granted = await worker.inject({
      method: 'PUT',
      url: '/v1/worker/profiles/browser/lease',
      headers: headers({ 'content-type': 'application/json' }),
      payload: { ...identity, ttlSec: 15 },
    });
    expect(granted.statusCode).toBe(200);
    const controlHeaders = headers({
      'x-humanchrome-agent': identity.agent,
      'x-humanchrome-lease': identity.leaseId,
      'x-humanchrome-generation': String(identity.generation),
    });
    expect(
      (
        await worker.inject({
          method: 'POST',
          url: '/v1/worker/profiles/browser/restart',
          headers: controlHeaders,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await worker.inject({
          method: 'POST',
          url: '/v1/worker/profiles/browser/stop',
          headers: headers({
            'x-humanchrome-agent': 'tenant-b:agent-b',
            'x-humanchrome-lease': identity.leaseId,
            'x-humanchrome-generation': '1',
          }),
        })
      ).statusCode,
    ).toBe(409);
  });

  test('streams proxied response bytes and clears completed execution fencing', async () => {
    const upstream = Fastify({ logger: false });
    upstream.get('/api/tools', async () => ({ tools: ['catalog'] }));
    const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
    upstreams.push(upstream);
    const port = Number(new URL(address).port);
    const state = new WorkerState(':memory:');
    state.claim('browser', identity, 15);
    const worker = fixture({ state, port });
    const response = await worker.inject({
      method: 'GET',
      url: '/v1/worker/profiles/browser/browser/api/tools',
      headers: headers({
        'x-humanchrome-agent': identity.agent,
        'x-humanchrome-lease': identity.leaseId,
        'x-humanchrome-generation': String(identity.generation),
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tools: ['catalog'] });
    state.release('browser', identity);
    state.close();
  });

  test('does not release an expired lane when active work rejects handoff', async () => {
    let now = 1_000;
    const state = new WorkerState(':memory:', () => now);
    state.claim('browser', identity, 15);
    state.beginExecution('browser', identity).clientClosed();
    now += 15_001;
    const releases: string[] = [];
    const worker = fixture({
      state,
      releaseLane: async (_profile, lane) => {
        releases.push(lane);
      },
    });
    const response = await worker.inject({
      method: 'PUT',
      url: '/v1/worker/profiles/browser/lease',
      headers: headers({ 'content-type': 'application/json' }),
      payload: {
        agent: 'tenant-b:agent-b',
        leaseId: '22222222-2222-4222-8222-222222222222',
        generation: 2,
        ttlSec: 15,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(releases).toEqual([]);
    state.close();
  });

  test('permits provisioning only from a symbolic operator allowlist', async () => {
    const worker = fixture();
    expect(
      (
        await worker.inject({
          method: 'POST',
          url: '/v1/worker/profiles',
          headers: headers({ 'content-type': 'application/json' }),
          payload: { name: 'extra', labels: [], seedSource: '/Users/raw/Chrome' },
        })
      ).statusCode,
    ).toBe(400);
  });

  test('parks without lease headers when worker credential is valid', async () => {
    const worker = fixture();
    const response = await worker.inject({
      method: 'POST',
      url: '/v1/worker/park',
      headers: headers({ 'content-type': 'application/json' }),
      payload: { parked: true },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ parked: true });
  });
});
