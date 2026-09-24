import Fastify from 'fastify';
import { afterEach, describe, expect, test } from '@jest/globals';
import { FleetGateway } from './gateway';
import { FleetLeases } from './leases';
import type { FleetConfig } from './config';
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

async function gatewayFixture(): Promise<{
  url: string;
  leases: FleetLeases;
  profiles: ProfileSnapshot[];
}> {
  const first = await upstream();
  const second = await upstream();
  const profiles: ProfileSnapshot[] = [
    {
      name: 'p01',
      port: first.port,
      labels: ['google'],
      enabled: true,
      state: 'healthy',
      pid: 1,
      leasedBy: null,
    },
    {
      name: 'p02',
      port: second.port,
      labels: ['google'],
      enabled: true,
      state: 'healthy',
      pid: 2,
      leasedBy: null,
    },
  ];
  const supervisor = {
    snapshot: () => profiles,
    state: (name: string) => profiles.find((profile) => profile.name === name)?.state,
  } as unknown as ProfileSupervisor;
  const leases = new FleetLeases(900, () => 0);
  const gateway = new FleetGateway({ config, supervisor, leases });
  gateways.push(gateway);
  return { url: await gateway.listen(), leases, profiles };
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
      headers: { authorization: `Bearer ${config.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ released: ['p01'] });
  });
});
