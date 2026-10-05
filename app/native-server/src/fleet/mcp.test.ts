import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.HC_FLEET_ROOT = mkdtempSync(path.join(tmpdir(), 'hc-fleet-mcp-test-'));

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import Fastify from 'fastify';
import { createFleetMcpServer } from './mcp';
import { createDefaultConfig, loadConfig, saveConfig } from './config';
import { FleetLeases } from './leases';
import type { ProfileSnapshot, ProfileSupervisor } from './supervisor';
import { runHijacked } from '../server/hijack';

const profiles: ProfileSnapshot[] = [
  {
    name: 'p01',
    port: 12500,
    labels: ['google'],
    enabled: true,
    purpose: 'linkedin',
    state: 'healthy',
    pid: 4242,
    leasedBy: null,
    lastError: null,
  },
];

const verbs: string[] = [];
const reloaded: unknown[] = [];
const released: Array<[string, string]> = [];

const supervisor = {
  snapshot: (leasedBy?: (profile: string) => string | null) =>
    profiles.map((profile) => ({
      ...profile,
      leasedBy: leasedBy ? leasedBy(profile.name) : null,
    })),
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
  reload: async (config: unknown) => {
    reloaded.push(config);
  },
} as unknown as ProfileSupervisor;

const clients: Client[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  verbs.length = 0;
  reloaded.length = 0;
  released.length = 0;
});

beforeEach(async () => {
  await saveConfig({
    ...createDefaultConfig(12300, 12500),
    profiles: [
      { name: 'p01', port: 12500, labels: ['google'], enabled: true, purpose: 'linkedin' },
    ],
  });
});

/** A real MCP client over the real HTTP transport, exactly as an agent connects. */
async function connect(): Promise<Client> {
  const leases = new FleetLeases(900, () => 0);
  const handler = createMcpHandler(() =>
    createFleetMcpServer({
      supervisor,
      leases,
      releaseBridge: async (agent, profile) => {
        released.push([agent, profile]);
      },
    }),
  );
  const node = toNodeHandler(handler);
  const app = Fastify({ logger: false });
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/v1/fleet/mcp',
    handler: (request, reply) =>
      runHijacked(reply, () => node(request.raw, reply.raw, request.body)),
  });
  apps.push(app);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'fleet-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL('/v1/fleet/mcp', address)));
  return client;
}

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';

describe('fleet MCP tools', () => {
  test('lists exactly the five fleet_ tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'fleet_leases',
      'fleet_park',
      'fleet_profile',
      'fleet_profiles',
      'fleet_purposes',
    ]);
    // The description is the catalog a model reads first.
    expect(tools.find((tool) => tool.name === 'fleet_profiles')?.description).toContain(
      'Start here.',
    );
  });

  test('fleet_profiles returns the supervisor snapshot', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'fleet_profiles', arguments: {} });
    expect(JSON.parse(textOf(result))).toEqual([
      expect.objectContaining({ name: 'p01', state: 'healthy', pid: 4242, lastError: null }),
    ]);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });

  test('fleet_profile runs each verb and refuses an unknown name', async () => {
    const client = await connect();
    for (const action of ['start', 'stop', 'restart'] as const) {
      await client.callTool({ name: 'fleet_profile', arguments: { action, name: 'p01' } });
    }
    expect(verbs).toEqual(['start:p01', 'stop:p01', 'restart:p01']);

    const unknown = await client.callTool({
      name: 'fleet_profile',
      arguments: { action: 'start', name: 'nope' },
    });
    expect((unknown as { isError?: boolean }).isError).toBe(true);
    expect(textOf(unknown)).toBe('unknown profile: nope');
  });

  test('fleet_leases lists by default and needs an agent to release', async () => {
    const client = await connect();
    const missing = await client.callTool({
      name: 'fleet_leases',
      arguments: { action: 'release' },
    });
    expect((missing as { isError?: boolean }).isError).toBe(true);
    expect(textOf(missing)).toContain('`agent` is required');

    expect(
      JSON.parse(textOf(await client.callTool({ name: 'fleet_leases', arguments: {} }))),
    ).toEqual({ leases: [] });
    expect(
      JSON.parse(
        textOf(
          await client.callTool({
            name: 'fleet_leases',
            arguments: { action: 'release', agent: 'nobody' },
          }),
        ),
      ),
    ).toEqual({ agent: 'nobody', released: [] });
  });

  test('fleet_leases release frees the browser-side client lane too', async () => {
    const client = await connect();
    const leases = new FleetLeases(900, () => 0);
    leases.acquire('agent-a', 'p01');
    const handler = createMcpHandler(() =>
      createFleetMcpServer({
        supervisor,
        leases,
        releaseBridge: async (agent, profile) => {
          released.push([agent, profile]);
        },
      }),
    );
    const node = toNodeHandler(handler);
    const app = Fastify({ logger: false });
    app.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/v1/fleet/mcp',
      handler: (request, reply) =>
        runHijacked(reply, () => node(request.raw, reply.raw, request.body)),
    });
    apps.push(app);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const leased = new Client({ name: 'fleet-test', version: '1.0.0' });
    clients.push(leased);
    await leased.connect(new StreamableHTTPClientTransport(new URL('/v1/fleet/mcp', address)));

    const result = await leased.callTool({
      name: 'fleet_leases',
      arguments: { action: 'release', agent: 'agent-a' },
    });

    expect(JSON.parse(textOf(result))).toEqual({ agent: 'agent-a', released: ['p01'] });
    expect(released).toEqual([['agent-a', 'p01']]);
  });

  test('fleet_purposes reports the live state, never a fabricated one', async () => {
    const client = await connect();
    const rows = JSON.parse(
      textOf(await client.callTool({ name: 'fleet_purposes', arguments: {} })),
    );
    expect(rows.purposes).toEqual([
      {
        purpose: 'linkedin',
        profile: 'p01',
        node: expect.any(String),
        state: 'healthy',
        labels: ['google'],
      },
    ]);
  });

  test('fleet_park writes the config and reloads the supervisor', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'fleet_park',
      arguments: { parked: true },
    });

    expect(JSON.parse(textOf(result))).toEqual({ parked: true, changed: true });
    expect((await loadConfig()).parked).toBe(true);
    expect(reloaded).toHaveLength(1);
    expect((reloaded[0] as { parked: boolean }).parked).toBe(true);
  });

  test('fleet_park is a no-op when the fleet is already parked', async () => {
    const client = await connect();
    expect((await loadConfig()).parked).toBe(false);
    await client.callTool({ name: 'fleet_park', arguments: { parked: true } });
    expect((await loadConfig()).parked).toBe(true);
    const second = await client.callTool({ name: 'fleet_park', arguments: { parked: true } });
    expect(JSON.parse(textOf(second))).toEqual({ parked: true, changed: false });
    expect(reloaded).toHaveLength(1);
  });

  test('a handler failure is a tool error, never a protocol error', async () => {
    const boom = jest
      .spyOn(supervisor, 'restartProfile')
      .mockRejectedValue(new Error('chrome is wedged'));
    const client = await connect();
    const result = await client.callTool({
      name: 'fleet_profile',
      arguments: { action: 'restart', name: 'p01' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toBe('chrome is wedged');
    boom.mockRestore();
  });
});
