import Fastify from 'fastify';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { FleetGateway } from './gateway';
import { FleetLeases } from './leases';
import type { FleetConfig } from './config';
import type { AddedProfile } from './provision';
import type { ProfileSnapshot, ProfileSupervisor } from './supervisor';

const config: FleetConfig = {
  version: 1,
  gateway: { host: '127.0.0.1', port: 0 },
  token: 'a'.repeat(64),
  bridgeToken: 'b'.repeat(64),
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  extensionDir: '/tmp/extension',
  basePort: 12500,
  leaseIdleTtlSec: 900,
  parked: false,
  nodeId: 'central',
  nodes: [],
  profiles: [
    { name: 'p01', port: 12500, labels: ['google'], enabled: true },
    { name: 'p02', port: 12501, labels: ['google'], enabled: true },
  ],
};

const upstreams: Array<ReturnType<typeof Fastify>> = [];
const gateways: FleetGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

async function upstream(): Promise<{ port: number; app: ReturnType<typeof Fastify> }> {
  const app = Fastify({ logger: false });
  app.all('/api/echo', async (request) => ({ path: request.url, headers: request.headers }));
  // The bridge's own MCP endpoint, so the gateway allowlist can be told apart
  // from "the upstream happened not to have this route".
  app.all('/mcp', async (request) => ({ path: request.url, headers: request.headers }));
  app.post('/api/clients/:agent/release', async (request) => ({
    released: (request.params as { agent: string }).agent,
  }));
  app.get('/api/stream', async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('data: one\n\n');
    setTimeout(() => reply.raw.end('data: two\n\n'), 100);
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  upstreams.push(app);
  return { port: Number(new URL(address).port), app };
}

function fakeSupervisor(profiles: ProfileSnapshot[], verbs: string[] = []): ProfileSupervisor {
  return {
    snapshot: () => profiles,
    state: (name: string) => profiles.find((profile) => profile.name === name)?.state,
    startProfile: async (name: string) => {
      verbs.push(`start:${name}`);
    },
    stopProfile: async (name: string) => {
      verbs.push(`stop:${name}`);
    },
    restartProfile: async (name: string) => {
      verbs.push(`restart:${name}`);
    },
  } as unknown as ProfileSupervisor;
}

async function gatewayFixture(): Promise<{
  url: string;
  leases: FleetLeases;
  profiles: ProfileSnapshot[];
  verbs: string[];
}> {
  const first = await upstream();
  const second = await upstream();
  const profiles: ProfileSnapshot[] = [
    {
      name: 'p01',
      port: first.port,
      labels: ['google'],
      enabled: true,
      purpose: null,
      state: 'healthy',
      pid: 1,
      leasedBy: null,
      lastError: null,
    },
    {
      name: 'p02',
      port: second.port,
      labels: ['google'],
      enabled: true,
      purpose: null,
      state: 'healthy',
      pid: 2,
      leasedBy: null,
      lastError: null,
    },
  ];
  const verbs: string[] = [];
  const supervisor = fakeSupervisor(profiles, verbs);
  const leases = new FleetLeases(900, () => 0);
  const gateway = new FleetGateway({ config, supervisor, leases });
  gateways.push(gateway);
  return { url: await gateway.listen(), leases, profiles, verbs };
}

describe('FleetGateway', () => {
  test('rejects missing credentials and browser origins', async () => {
    const { url } = await gatewayFixture();
    expect((await fetch(`${url}/v1/profiles`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/v1/profiles`, {
          headers: { authorization: `Bearer ${config.token}`, origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
  });

  test('a client that hangs up mid-response does not take the fleet down', async () => {
    const { url } = await gatewayFixture();
    const headers = { authorization: `Bearer ${config.token}` };
    // Abort the request mid-flight, which is what produces the EPIPE.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const request = fetch(`${url}/v1/pool/google/api/echo`, {
        method: 'POST',
        headers: { ...headers, 'x-humanchrome-agent': `hangup-${attempt}` },
        body: '{}',
        signal: controller.signal,
      });
      controller.abort();
      await expect(request).rejects.toBeDefined();
    }
    // The gateway must still be serving afterwards.
    expect(
      (await fetch(`${url}/v1/profiles`, { headers: { authorization: `Bearer ${config.token}` } }))
        .status,
    ).toBe(200);
  });

  test('requires an agent name and routes pooled requests with bridge credentials', async () => {
    const { url } = await gatewayFixture();
    const headers = { authorization: `Bearer ${config.token}` };
    expect(
      (await fetch(`${url}/v1/pool/google/api/echo`, { method: 'POST', headers, body: '{}' }))
        .status,
    ).toBe(400);
    const response = await fetch(`${url}/v1/pool/google/api/echo?x=1`, {
      method: 'POST',
      headers: { ...headers, 'x-humanchrome-agent': 'agent-a' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-humanchrome-profile')).toBe('p01');
    const body = (await response.json()) as { path: string; headers: Record<string, string> };
    expect(body.path).toContain('/api/echo?x=1');
    expect(body.headers.authorization).toBe(`Bearer ${config.bridgeToken}`);
    expect(body.headers['x-humanchrome-session']).toBe('agent-a');
  });

  test('returns busy and exhausted responses', async () => {
    const { url } = await gatewayFixture();
    const headers = { authorization: `Bearer ${config.token}`, 'x-humanchrome-agent': 'agent-a' };
    expect(
      (await fetch(`${url}/v1/profiles/p01/api/echo`, { method: 'POST', headers, body: '{}' }))
        .status,
    ).toBe(200);
    expect(
      (
        await fetch(`${url}/v1/profiles/p01/api/echo`, {
          method: 'POST',
          headers: { ...headers, 'x-humanchrome-agent': 'agent-b' },
          body: '{}',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(`${url}/v1/pool/google/api/echo`, {
          method: 'POST',
          headers: { ...headers, 'x-humanchrome-agent': 'agent-b' },
          body: '{}',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${url}/v1/pool/google/api/echo`, {
          method: 'POST',
          headers: { ...headers, 'x-humanchrome-agent': 'agent-c' },
          body: '{}',
        })
      ).status,
    ).toBe(503);
  });

  test('streams SSE chunks through the proxy', async () => {
    const { url } = await gatewayFixture();
    const response = await fetch(`${url}/v1/pool/google/api/stream`, {
      headers: { authorization: `Bearer ${config.token}`, 'x-humanchrome-agent': 'agent-stream' },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: one');
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain('data: two');
  });

  test('releases bridge ownership when an agent lease is deleted', async () => {
    const { url } = await gatewayFixture();
    const headers = { authorization: `Bearer ${config.token}`, 'x-humanchrome-agent': 'agent-a' };
    await fetch(`${url}/v1/pool/google/api/echo`, { method: 'POST', headers, body: '{}' });
    const response = await fetch(`${url}/v1/leases/agent-a`, {
      method: 'DELETE',
      headers: { ...headers },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ released: ['p01'] });
  });
});

describe('FleetGateway federation', () => {
  const peerToken = 'c'.repeat(64);
  const peerBridgeToken = 'd'.repeat(64);

  function profileOn(port: number, name = 'p01', purpose: string | null = null): ProfileSnapshot {
    return {
      name,
      port,
      labels: ['google'],
      purpose,
      enabled: true,
      state: 'healthy',
      pid: 1,
      leasedBy: null,
      lastError: null,
    };
  }

  async function gatewayFor(
    gatewayConfig: FleetConfig,
    profiles: ProfileSnapshot[],
  ): Promise<string> {
    const gateway = new FleetGateway({
      config: gatewayConfig,
      supervisor: fakeSupervisor(profiles),
      leases: new FleetLeases(900, () => 0),
    });
    gateways.push(gateway);
    return gateway.listen();
  }

  async function peerGateway(): Promise<{ url: string; bridge: number }> {
    const bridge = await upstream();
    const peerConfig: FleetConfig = {
      ...config,
      token: peerToken,
      bridgeToken: peerBridgeToken,
      nodeId: 'worker',
      nodes: [],
      gateway: { host: '127.0.0.1', port: 0 },
    };
    const url = await gatewayFor(peerConfig, [profileOn(bridge.port)]);
    return { url, bridge: bridge.port };
  }

  async function peerGatewayWithPurpose(purpose: string): Promise<{ url: string; bridge: number }> {
    const bridge = await upstream();
    const peerConfig: FleetConfig = {
      ...config,
      token: peerToken,
      bridgeToken: peerBridgeToken,
      nodeId: 'worker',
      nodes: [],
      gateway: { host: '127.0.0.1', port: 0 },
    };
    const url = await gatewayFor(peerConfig, [profileOn(bridge.port, 'p01', purpose)]);
    return { url, bridge: bridge.port };
  }

  test('merges peer profiles into the listing as node-qualified names', async () => {
    const peer = await peerGateway();
    const central: FleetConfig = {
      ...config,
      nodeId: 'central',
      nodes: [
        { id: 'worker', host: '127.0.0.1', port: Number(new URL(peer.url).port), token: peerToken },
      ],
    };
    const local = await upstream();
    const url = await gatewayFor(central, [profileOn(local.port)]);
    const response = await fetch(`${url}/v1/profiles`, {
      headers: { authorization: `Bearer ${config.token}` },
    });
    const names = ((await response.json()) as Array<{ name: string }>).map((p) => p.name);
    expect(names).toContain('p01');
    expect(names).toContain('worker:p01');
  });

  test('forwards a remote profile request to the peer gateway with the node token', async () => {
    const peer = await peerGateway();
    const central: FleetConfig = {
      ...config,
      nodeId: 'central',
      nodes: [
        { id: 'worker', host: '127.0.0.1', port: Number(new URL(peer.url).port), token: peerToken },
      ],
    };
    const url = await gatewayFor(central, []);
    const response = await fetch(`${url}/v1/profiles/worker:p01/api/echo?x=1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'x-humanchrome-agent': 'agent-a',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-humanchrome-profile')).toBe('worker:p01');
    const body = (await response.json()) as { path: string; headers: Record<string, string> };
    // The peer strips its own hop and injects the bridge credential it holds.
    expect(body.path).toBe('/api/echo?x=1');
    expect(body.headers.authorization).toBe(`Bearer ${peerBridgeToken}`);
  });

  test('offers a healthy peer profile to the pool', async () => {
    const peer = await peerGateway();
    const central: FleetConfig = {
      ...config,
      nodeId: 'central',
      nodes: [
        { id: 'worker', host: '127.0.0.1', port: Number(new URL(peer.url).port), token: peerToken },
      ],
    };
    const url = await gatewayFor(central, []);
    const response = await fetch(`${url}/v1/pool/google/api/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'x-humanchrome-agent': 'agent-pool' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-humanchrome-profile')).toBe('worker:p01');
  });

  test('routes to a peer profile by purpose and reports that purpose', async () => {
    const peer = await peerGatewayWithPurpose('linkedin');
    const central: FleetConfig = {
      ...config,
      nodeId: 'central',
      nodes: [
        { id: 'worker', host: '127.0.0.1', port: Number(new URL(peer.url).port), token: peerToken },
      ],
    };
    const url = await gatewayFor(central, []);
    const response = await fetch(`${url}/v1/pool/linkedin/api/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'x-humanchrome-agent': 'agent-purpose' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-humanchrome-profile')).toBe('worker:p01');
    const profiles = (await (
      await fetch(`${url}/v1/profiles`, { headers: { authorization: `Bearer ${config.token}` } })
    ).json()) as Array<{ name: string; purpose: string | null }>;
    expect(profiles.find((profile) => profile.name === 'worker:p01')?.purpose).toBe('linkedin');
  });

  test('a purpose-bound local profile stays in its label pool', async () => {
    const local = await upstream();
    const url = await gatewayFor(config, [profileOn(local.port, 'p01', 'linkedin')]);
    const headers = {
      authorization: `Bearer ${config.token}`,
      'x-humanchrome-agent': 'agent-label',
    };
    const byLabel = await fetch(`${url}/v1/pool/google/api/echo`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(byLabel.headers.get('x-humanchrome-profile')).toBe('p01');
    // A second gateway: the first request's lease is still held, and a 409 here
    // would say nothing about purpose routing.
    const purposeUrl = await gatewayFor(config, [profileOn(local.port, 'p01', 'linkedin')]);
    const byPurpose = await fetch(`${purposeUrl}/v1/pool/linkedin/api/echo`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'x-humanchrome-agent': 'agent-purpose-local',
      },
      body: '{}',
    });
    expect(byPurpose.headers.get('x-humanchrome-profile')).toBe('p01');
  });

  test('an unbound purpose pool has no candidate', async () => {
    const local = await upstream();
    const url = await gatewayFor(config, [profileOn(local.port)]);
    const response = await fetch(`${url}/v1/pool/linkedin/api/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'x-humanchrome-agent': 'agent-none' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'no_free_profile',
    });
  });

  test('reports an unreachable node instead of failing the whole listing', async () => {
    const central: FleetConfig = {
      ...config,
      nodeId: 'central',
      nodes: [{ id: 'gone', host: '127.0.0.1', port: 1, token: 'e'.repeat(64) }],
    };
    const local = await upstream();
    const url = await gatewayFor(central, [profileOn(local.port)]);
    const profiles = (await (
      await fetch(`${url}/v1/profiles`, { headers: { authorization: `Bearer ${config.token}` } })
    ).json()) as Array<{ name: string; state: string }>;
    expect(profiles.find((profile) => profile.name === 'gone')?.state).toBe('unreachable');
    expect(profiles.find((profile) => profile.name === 'p01')?.state).toBe('healthy');
  });

  test('an unreachable peer is cached per node for the cache window only', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const central: FleetConfig = {
      ...config,
      nodeId: 'central',
      nodes: [
        { id: 'gone', host: '127.0.0.1', port: 1, token: 'e'.repeat(64) },
        { id: 'gone-too', host: '127.0.0.1', port: 2, token: 'e'.repeat(64) },
      ],
    };
    const url = await gatewayFor(central, []);
    const notAnswering = () =>
      errors.mock.calls.filter((call) => String(call[0]).includes('did not answer')).length;

    await fetch(`${url}/v1/profiles`, { headers: { authorization: `Bearer ${config.token}` } });
    expect(notAnswering()).toBe(2);
    await fetch(`${url}/v1/profiles`, { headers: { authorization: `Bearer ${config.token}` } });
    // One cache entry per node: the second listing re-probes neither.
    expect(notAnswering()).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 5_100));
    await fetch(`${url}/v1/profiles`, { headers: { authorization: `Bearer ${config.token}` } });
    expect(notAnswering()).toBe(4);
    errors.mockRestore();
  }, 20_000);

  test('refuses to forward a node-qualified name back out of a peer', async () => {
    const peer = await peerGateway();
    const response = await fetch(`${peer.url}/v1/node/worker:p01/api/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${peerToken}` },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });

  test('rejects a wrong node token on the peer gateway', async () => {
    const peer = await peerGateway();
    const response = await fetch(`${peer.url}/v1/node/p01/api/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'f'.repeat(64)}` },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });
});

describe('FleetGateway profile control', () => {
  const auth = { authorization: `Bearer ${config.token}` };

  test('the three verbs answer 202 and reach the supervisor', async () => {
    const { url, verbs } = await gatewayFixture();
    for (const [verb, key] of [
      ['start', 'starting'],
      ['stop', 'stopping'],
      ['restart', 'restarting'],
    ] as const) {
      const response = await fetch(`${url}/v1/profiles/p01/${verb}`, {
        method: 'POST',
        headers: auth,
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ [key]: 'p01' });
    }
    expect(verbs).toEqual(['start:p01', 'stop:p01', 'restart:p01']);
  });

  test('an unknown name is 404 on every verb', async () => {
    const { url } = await gatewayFixture();
    for (const verb of ['start', 'stop', 'restart']) {
      const response = await fetch(`${url}/v1/profiles/nope/${verb}`, {
        method: 'POST',
        headers: auth,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'unknown_profile' });
    }
  });

  test('a restart refused while another agent drives the browser is 409', async () => {
    const { url, leases } = await gatewayFixture();
    leases.acquire('agent-b', 'p01');
    const response = await fetch(`${url}/v1/profiles/p01/restart`, {
      method: 'POST',
      headers: auth,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'profile_busy', heldBy: 'agent-b' });
  });

  test('a rejected verb is logged instead of killing serve', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const profiles: ProfileSnapshot[] = [
      {
        name: 'p01',
        port: 1,
        labels: [],
        enabled: true,
        purpose: null,
        state: 'stopped',
        pid: null,
        leasedBy: null,
        lastError: null,
      },
    ];
    const gateway = new FleetGateway({
      config,
      supervisor: {
        ...(fakeSupervisor(profiles) as object),
        restartProfile: async () => {
          throw new Error('chrome is wedged');
        },
      } as unknown as ProfileSupervisor,
      leases: new FleetLeases(900, () => 0),
    });
    gateways.push(gateway);
    const url = await gateway.listen();
    const response = await fetch(`${url}/v1/profiles/p01/restart`, {
      method: 'POST',
      headers: auth,
    });
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toHaveBeenCalledWith('fleet: gateway: restart of p01 failed: chrome is wedged');
    errors.mockRestore();
  });
});

describe('FleetGateway profile add', () => {
  const auth = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  const added = (name: string): AddedProfile => ({
    name,
    port: 12509,
    copied: { persistent: 254, google: 53 },
    kept: { persistent: 254, google: 53 },
    google: { state: 'session', accounts: 1, signedIn: 1 },
  });

  async function addGateway(
    add: (name: string, labels: string[], seed: string | null) => Promise<AddedProfile>,
  ): Promise<string> {
    const gateway = new FleetGateway({
      config,
      supervisor: fakeSupervisor([]),
      leases: new FleetLeases(900, () => 0),
      addProfile: add,
    });
    gateways.push(gateway);
    return gateway.listen();
  }

  test('provisions in serve and answers once the add has finished', async () => {
    const calls: unknown[] = [];
    const url = await addGateway(async (name, labels, seed) => {
      calls.push([name, labels, seed]);
      return added(name);
    });
    const response = await fetch(`${url}/v1/profiles`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'linkedin', labels: ['social'], seed: '/seed/Chrome' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(added('linkedin'));
    expect(calls).toEqual([['linkedin', ['social'], '/seed/Chrome']]);
  });

  test('a refused add is 422 with its reason, and serve stays up', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const url = await addGateway(async () => {
      throw new Error('wiped lost its seeded cookies: Chrome kept 0 of 254 copied cookies');
    });
    const response = await fetch(`${url}/v1/profiles`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'wiped', labels: [], seed: '/seed/Chrome' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'add_failed',
      message: 'wiped lost its seeded cookies: Chrome kept 0 of 254 copied cookies',
    });
    errors.mockRestore();
  });

  test('a malformed request never reaches provisioning', async () => {
    const calls: string[] = [];
    const url = await addGateway(async (name) => {
      calls.push(name);
      return added(name);
    });
    for (const [body, error] of [
      [{ labels: [] }, 'invalid_name'],
      [{ name: 'x', labels: 'a,b' }, 'invalid_labels'],
      [{ name: 'x', seed: 'relative/dir' }, 'invalid_seed'],
    ] as const) {
      const response = await fetch(`${url}/v1/profiles`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
    expect(calls).toEqual([]);
  });

  test('the add endpoint inherits the gateway bearer check', async () => {
    const url = await addGateway(async (name) => added(name));
    const response = await fetch(`${url}/v1/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', labels: [], seed: null }),
    });
    expect(response.status).toBe(401);
  });
});

describe('FleetGateway proxy surface', () => {
  const auth = { authorization: `Bearer ${config.token}` };

  test('only the bridge API, MCP and ping are reachable through a profile', async () => {
    const { url } = await gatewayFixture();
    const agent = { ...auth, 'x-humanchrome-agent': 'agent-a' };
    expect(
      (
        await fetch(`${url}/v1/profiles/p01/api/echo`, {
          method: 'POST',
          headers: agent,
          body: '{}',
        })
      ).status,
    ).toBe(200);
    const mcp = await fetch(`${url}/v1/profiles/p01/mcp`, {
      method: 'POST',
      headers: agent,
      body: '{}',
    });
    expect(mcp.status).toBe(200);
    expect((await mcp.json()) as { path: string }).toMatchObject({ path: '/mcp' });
  });

  test('refuses a path outside the allowlist instead of proxying it', async () => {
    const { url } = await gatewayFixture();
    const response = await fetch(`${url}/v1/profiles/p01/agent/projects/x/open-file`, {
      method: 'POST',
      headers: { ...auth, 'x-humanchrome-agent': 'agent-a' },
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  test('a browser origin is still refused', async () => {
    const { url } = await gatewayFixture();
    expect(
      (
        await fetch(`${url}/v1/profiles/p01/api/echo`, {
          method: 'POST',
          headers: { ...auth, origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });

  test('an agent may only release its own leases', async () => {
    const { url, leases } = await gatewayFixture();
    leases.acquire('victim', 'p01');
    const mismatched = await fetch(`${url}/v1/leases/victim`, {
      method: 'DELETE',
      headers: { ...auth, 'x-humanchrome-agent': 'someone-else' },
    });
    expect(mismatched.status).toBe(403);
    expect(await mismatched.json()).toEqual({ error: 'agent_mismatch' });
    expect(leases.list()).toHaveLength(1);

    const matched = await fetch(`${url}/v1/leases/victim`, {
      method: 'DELETE',
      headers: { ...auth, 'x-humanchrome-agent': 'victim' },
    });
    expect(matched.status).toBe(200);
    expect(leases.list()).toEqual([]);
  });

  test('an open fleet needs no credential, a closed one does', async () => {
    const open: FleetConfig = { ...config, token: null };
    const gateway = new FleetGateway({
      config: open,
      supervisor: fakeSupervisor([]),
      leases: new FleetLeases(900, () => 0),
    });
    gateways.push(gateway);
    const openUrl = await gateway.listen();
    expect((await fetch(`${openUrl}/v1/profiles`)).status).toBe(200);

    const { url } = await gatewayFixture();
    expect((await fetch(`${url}/v1/profiles`)).status).toBe(401);
    expect((await fetch(`${url}/v1/profiles`, { headers: auth })).status).toBe(200);
  });
});

describe('FleetGateway fleet MCP', () => {
  test('serves the five fleet_ tools over a real MCP client', async () => {
    const gateway = new FleetGateway({
      config,
      supervisor: fakeSupervisor([]),
      leases: new FleetLeases(900, () => 0),
    });
    gateways.push(gateway);
    const url = await gateway.listen();

    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    // The MCP endpoint sits behind the same bearer check as every other route.
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/v1/fleet/mcp', url), {
        requestInit: { headers: { authorization: `Bearer ${config.token}` } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'fleet_leases',
        'fleet_park',
        'fleet_profile',
        'fleet_profiles',
        'fleet_purposes',
      ]);
    } finally {
      await client.close();
    }
  });

  test('the MCP endpoint inherits the gateway bearer check', async () => {
    const { url } = await gatewayFixture();
    const response = await fetch(`${url}/v1/fleet/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('FleetGateway status page', () => {
  test('serves the UI at the root and at /ui', async () => {
    const { url } = await gatewayFixture();
    for (const path of ['/', '/ui']) {
      // Behind the same bearer check as every other route when a fleet has auth.
      const response = await fetch(`${url}${path}`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('Chrome fleet');
    }
  });

  test('reads only the two JSON endpoints it polls, and never innerHTML', async () => {
    const { url } = await gatewayFixture();
    const html = await (
      await fetch(`${url}/`, { headers: { authorization: `Bearer ${config.token}` } })
    ).text();
    // Same-origin GET only: a browser sends no Origin header for those, which
    // is what lets the page work under the fleet's origin guard.
    expect(html).toContain("fetch('/v1/profiles')");
    expect(html).toContain("fetch('/v1/leases')");
    expect(html).not.toMatch(/fetch\([^)]*method\s*:\s*['"](POST|DELETE)/);
    // Profile labels and error text come from outside the page.
    expect(html).toContain('textContent');
    // The word may appear in a comment; what must not exist is an assignment.
    expect(html).not.toMatch(/innerHTML\s*=/);
  });

  test('serves the UI without a credential on an open fleet', async () => {
    const gateway = new FleetGateway({
      config: { ...config, token: null },
      supervisor: fakeSupervisor([]),
      leases: new FleetLeases(900, () => 0),
    });
    gateways.push(gateway);
    expect((await fetch(await gateway.listen())).status).toBe(200);
  });
});
