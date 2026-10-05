import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from '@jest/globals';
import { fetchLocalProfiles, fetchNodeProfiles } from './remote';
import type { FleetNodeConfig } from './config';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

interface Stub {
  node: FleetNodeConfig;
  received: Array<{ url: string; authorization: string | undefined }>;
}

/** A peer gateway that records what the caller actually sent. */
async function stub(
  handler: (res: Parameters<Parameters<Server['on']>[1]>[0]) => void,
): Promise<{ node: FleetNodeConfig; received: Stub['received'] }> {
  const received: Stub['received'] = [];
  const server = createServer((req, res) => {
    received.push({ url: req.url ?? '', authorization: req.headers.authorization });
    handler(res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { node: { id: 'worker', host: '127.0.0.1', port, token: '' }, received };
}

describe('fetchNodeProfiles', () => {
  test('throws on a non-200 so the caller can prove something about the fleet', async () => {
    const { node } = await stub((res) => {
      res.writeHead(503).end();
    });
    await expect(fetchNodeProfiles(node)).rejects.toThrow('status 503');
  });

  test('sends no authorization header when the peer carries no token', async () => {
    const { node, received } = await stub((res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    });
    await fetchNodeProfiles(node);
    expect(received[0]?.authorization).toBeUndefined();
  });

  test('sends the peer token when it has one', async () => {
    const { node, received } = await stub((res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    });
    await fetchNodeProfiles({ ...node, token: 'secret' });
    expect(received[0]?.authorization).toBe('Bearer secret');
  });

  test('normalises optional purpose and enabled fields', async () => {
    const { node } = await stub((res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          { name: 'p01', port: 12500, labels: [], state: 'healthy' },
          {
            name: 'p02',
            port: 12501,
            labels: [],
            state: 'stopped',
            purpose: 'linkedin',
            enabled: false,
          },
        ]),
      );
    });
    expect(await fetchNodeProfiles(node)).toEqual([
      { name: 'p01', port: 12500, labels: [], purpose: null, enabled: true, state: 'healthy' },
      {
        name: 'p02',
        port: 12501,
        labels: [],
        purpose: 'linkedin',
        enabled: false,
        state: 'stopped',
      },
    ]);
  });

  test('aborts rather than hanging on a peer that never answers', async () => {
    const { node } = await stub(() => {
      /* accept the request and answer nothing */
    });
    const started = Date.now();
    await expect(fetchNodeProfiles(node, 250)).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('fetchLocalProfiles', () => {
  test('reads this gateway with no credential when auth is off', async () => {
    const { node, received } = await stub((res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    });
    await expect(fetchLocalProfiles('127.0.0.1', node.port, null)).resolves.toEqual([]);
    expect(received[0]).toMatchObject({ url: '/v1/profiles', authorization: undefined });
  });

  test('sends the fleet token when one is configured', async () => {
    const { node, received } = await stub((res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    });
    await fetchLocalProfiles('127.0.0.1', node.port, 'tok');
    expect(received[0]?.authorization).toBe('Bearer tok');
  });

  test('normalises a missing purpose to null', async () => {
    const { node } = await stub((res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([{ name: 'p01', state: 'healthy' }]));
    });
    expect(await fetchLocalProfiles('127.0.0.1', node.port, null)).toEqual([
      { name: 'p01', state: 'healthy', purpose: null },
    ]);
  });
});
