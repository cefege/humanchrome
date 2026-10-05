import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from '@jest/globals';

process.env.HC_FLEET_ROOT = mkdtempSync(path.join(tmpdir(), 'hc-purpose-test-'));

import { loadConfig, saveConfig, validatePurposeName, FleetConfig } from './config';
import type { AddressInfo } from 'node:net';

const execFileAsync = promisify(execFile);
const CLI = path.join(__dirname, '..', '..', 'src', 'cli.ts');
const servers: ReturnType<typeof createServer>[] = [];

afterAll(() => {
  for (const server of servers) server.close();
});

describe('validatePurposeName', () => {
  test('accepts a lowercase tag', () => {
    expect(() => validatePurposeName('linkedin')).not.toThrow();
    expect(() => validatePurposeName('linkedin-2')).not.toThrow();
  });

  test('rejects a tag that could impersonate a node-qualified profile key', () => {
    expect(() => validatePurposeName('a:b')).toThrow('invalid purpose name: a:b');
  });

  test('rejects mixed case, empty and over-long tags', () => {
    expect(() => validatePurposeName('LinkedIn')).toThrow('invalid purpose name: LinkedIn');
    expect(() => validatePurposeName('')).toThrow('invalid purpose name: ');
    expect(() => validatePurposeName('a'.repeat(40))).toThrow(/invalid purpose name/);
  });
});

async function writeConfig(config: FleetConfig): Promise<void> {
  await saveConfig(config);
}

async function baseConfig(): Promise<FleetConfig> {
  return {
    version: 1,
    gateway: { host: '127.0.0.1', port: 0 },
    token: 'a'.repeat(64),
    bridgeToken: 'b'.repeat(64),
    chromePath: '/nonexistent/chrome',
    extensionDir: '/nonexistent/extension',
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
}

describe('loadConfig purpose uniqueness', () => {
  test('rejects a purpose bound to two local profiles', async () => {
    const config = await baseConfig();
    config.profiles[0].purpose = 'linkedin';
    config.profiles[1].purpose = 'linkedin';
    await writeConfig(config);
    await expect(loadConfig()).rejects.toThrow('purpose "linkedin" is bound to both p01 and p02');
  });

  test('rejects an invalid purpose name in the file', async () => {
    const config = await baseConfig();
    config.profiles[0].purpose = 'LinkedIn';
    await writeConfig(config);
    await expect(loadConfig()).rejects.toThrow('invalid purpose name: LinkedIn');
  });

  test('backfills dailyProfileDir for a config written before it existed', async () => {
    const config = await baseConfig();
    await writeConfig(config);
    delete (config as { dailyProfileDir?: string }).dailyProfileDir;
    await fs.writeFile(
      path.join(process.env.HC_FLEET_ROOT!, 'fleet.json'),
      JSON.stringify(config, null, 2),
    );
    const loaded = await loadConfig();
    expect(loaded.dailyProfileDir).toMatch(/Google[\\/]Chrome$/);
  });
});

/** A peer gateway that answers `/v1/profiles` with the given payload. */
async function peer(payload: unknown, status = 200): Promise<number> {
  const server = createServer((request, response) => {
    if (request.url !== '/v1/profiles') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', CLI, ...args], {
      env: { ...process.env, HC_FLEET_ROOT: process.env.HC_FLEET_ROOT },
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: failure.stdout ?? '', err: failure.stderr ?? '' };
  }
}

describe('fleet purpose add', () => {
  test('binds a tag and prints the binding', async () => {
    const config = await baseConfig();
    await writeConfig(config);
    const result = await runCli(['fleet', 'purpose', 'add', 'linkedin', 'p01']);
    expect(result.out).toContain('purpose linkedin -> p01');
    const saved = await loadConfig();
    expect(saved.profiles.find((profile) => profile.name === 'p01')?.purpose).toBe('linkedin');
  }, 60_000);

  test('refuses a profile that already holds a tag', async () => {
    const config = await baseConfig();
    config.profiles[0].purpose = 'linkedin';
    await writeConfig(config);
    const result = await runCli(['fleet', 'purpose', 'add', 'whatsapp', 'p01']);
    expect(result.err).toContain('profile p01 is already bound to purpose "linkedin"');
  }, 60_000);

  test('refuses an unknown profile', async () => {
    await writeConfig(await baseConfig());
    const result = await runCli(['fleet', 'purpose', 'add', 'linkedin', 'nope']);
    expect(result.err).toContain('unknown profile: nope');
  }, 60_000);

  test('refuses an invalid tag name', async () => {
    await writeConfig(await baseConfig());
    const result = await runCli(['fleet', 'purpose', 'add', 'LinkedIn', 'p01']);
    expect(result.err).toContain('invalid purpose name: LinkedIn');
  }, 60_000);

  test('refuses a tag a peer already serves, naming the peer profile', async () => {
    const config = await baseConfig();
    const port = await peer([
      { name: 'remote01', port: 12600, labels: [], purpose: 'linkedin', state: 'healthy' },
    ]);
    config.nodes = [{ id: 'worker', host: '127.0.0.1', port, token: 'c'.repeat(64) }];
    await writeConfig(config);
    const result = await runCli(['fleet', 'purpose', 'add', 'linkedin', 'p01']);
    expect(result.err).toContain('purpose "linkedin" is already bound to worker:remote01');
    expect((await loadConfig()).profiles[0].purpose).toBeUndefined();
  }, 60_000);

  test('fails closed when a configured peer does not answer', async () => {
    const config = await baseConfig();
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((done) => server.close(() => done()));
    config.nodes = [{ id: 'gone', host: '127.0.0.1', port, token: 'd'.repeat(64) }];
    await writeConfig(config);
    const result = await runCli(['fleet', 'purpose', 'add', 'linkedin', 'p01']);
    expect(result.err).toContain('cannot verify purpose "linkedin" is unique');
    expect(result.err).toContain('gone at 127.0.0.1');
    expect((await loadConfig()).profiles[0].purpose).toBeUndefined();
  }, 60_000);

  test('a peer failure other than unreachable is also fatal', async () => {
    const config = await baseConfig();
    config.nodes = [
      { id: 'worker', host: '127.0.0.1', port: await peer({}, 500), token: 'e'.repeat(64) },
    ];
    await writeConfig(config);
    const result = await runCli(['fleet', 'purpose', 'add', 'linkedin', 'p01']);
    expect(result.err).toContain('cannot verify purpose "linkedin" is unique');
    expect((await loadConfig()).profiles[0].purpose).toBeUndefined();
  }, 60_000);
  test('refuses a tag another local profile already holds', async () => {
    const config = await baseConfig();
    config.profiles[0].purpose = 'linkedin';
    await writeConfig(config);
    const result = await runCli(['fleet', 'purpose', 'add', 'linkedin', 'p02']);
    expect(result.err).toContain('purpose "linkedin" is already bound to p01');
    const saved = await loadConfig();
    expect(saved.profiles.find((profile) => profile.name === 'p02')?.purpose).toBeUndefined();
    // The file must still load: a rejected binding leaves no duplicate behind.
    expect(saved.profiles.filter((profile) => profile.purpose === 'linkedin')).toHaveLength(1);
  }, 60_000);
});

describe('fleet purpose rm and ls', () => {
  test('rm releases the tag without touching the profile', async () => {
    const config = await baseConfig();
    config.profiles[0].purpose = 'linkedin';
    config.profiles[0].seededFrom = '/tmp/seed';
    await writeConfig(config);
    const result = await runCli(['fleet', 'purpose', 'rm', 'linkedin']);
    expect(result.out).toContain('purpose linkedin released');
    const saved = await loadConfig();
    const profile = saved.profiles.find((entry) => entry.name === 'p01');
    expect(profile?.purpose).toBeUndefined();
    expect(profile?.seededFrom).toBe('/tmp/seed');
  }, 60_000);

  test('rm on an unbound tag is an error', async () => {
    await writeConfig(await baseConfig());
    const result = await runCli(['fleet', 'purpose', 'rm', 'linkedin']);
    expect(result.err).toContain('unknown purpose: linkedin');
  }, 60_000);

  test('ls --json lists local and peer bindings', async () => {
    const config = await baseConfig();
    config.profiles[0].purpose = 'linkedin';
    const port = await peer([
      {
        name: 'remote01',
        port: 12600,
        labels: ['meta'],
        purpose: 'whatsapp',
        state: 'healthy',
      },
    ]);
    config.nodes = [{ id: 'worker', host: '127.0.0.1', port, token: 'f'.repeat(64) }];
    await writeConfig(config);
    const result = await runCli(['fleet', 'purpose', 'ls', '--json']);
    const rows = JSON.parse(result.out.slice(result.out.indexOf('['))) as Array<{
      purpose: string;
      profile: string;
      node: string;
      labels: string[];
    }>;
    expect(rows).toContainEqual({
      purpose: 'linkedin',
      profile: 'p01',
      node: 'central',
      state: 'unknown',
      labels: ['google'],
    });
    expect(rows).toContainEqual({
      purpose: 'whatsapp',
      profile: 'remote01',
      node: 'worker',
      state: 'healthy',
      labels: ['meta'],
    });
  }, 60_000);

  test('ls reports nothing when no purpose is bound', async () => {
    await writeConfig(await baseConfig());
    const result = await runCli(['fleet', 'purpose', 'ls', '--json']);
    expect(JSON.parse(result.out.slice(result.out.indexOf('[')))).toEqual([]);
  }, 60_000);
});

describe('fleet init credentials', () => {
  test('--token none opens an existing fleet that required auth', async () => {
    const config = await baseConfig();
    config.token = 'a'.repeat(64);
    await writeConfig(config);

    const result = await runCli(['fleet', 'init', '--token', 'none']);

    expect(result.code).toBe(0);
    // The way back to an open fleet: without this the "already initialized"
    // guard would make the fleet a one-way door.
    expect((await loadConfig()).token).toBeNull();
  }, 60_000);

  test('--token sets a bearer without re-initialising the fleet', async () => {
    const config = await baseConfig();
    await writeConfig(config);

    const result = await runCli(['fleet', 'init', '--token', 'b'.repeat(64)]);

    expect(result.code).toBe(0);
    const saved = await loadConfig();
    expect(saved.token).toBe('b'.repeat(64));
    // Profiles survive a credential change.
    expect(saved.profiles).toHaveLength(config.profiles.length);
  }, 60_000);

  test('--print-token reads the stored token back', async () => {
    const config = await baseConfig();
    config.token = 'c'.repeat(64);
    await writeConfig(config);

    const result = await runCli(['fleet', 'init', '--print-token']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('c'.repeat(64));
  }, 60_000);

  test('a plain re-init is still refused', async () => {
    const config = await baseConfig();
    await writeConfig(config);

    const result = await runCli(['fleet', 'init']);

    expect(result.code).not.toBe(0);
    expect(result.err).toContain('already initialized');
  }, 60_000);

  test('a malformed token is rejected before it is written', async () => {
    const config = await baseConfig();
    await writeConfig(config);

    const result = await runCli(['fleet', 'init', '--token', 'too-short']);

    expect(result.code).not.toBe(0);
    // The fleet keeps whatever credential it already had.
    expect((await loadConfig()).token).toBe(config.token);
  }, 60_000);
});
