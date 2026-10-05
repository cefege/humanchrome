import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.HC_FLEET_ROOT = mkdtempSync(path.join(tmpdir(), 'hc-config-test-'));

import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  createDefaultConfig,
  FleetNotInitializedError,
  gatewayUrl,
  loadConfig,
  NAME_RE,
  PROFILE_NAME_RE,
  PURPOSE_NAME_RE,
  saveConfig,
  validateProfileName,
  validatePurposeName,
} from './config';

const CONFIG_PATH = path.join(process.env.HC_FLEET_ROOT!, 'fleet.json');

function write(raw: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
}

beforeEach(() => {
  write(createDefaultConfig(12300, 12500));
});

describe('name validation', () => {
  test('profile, purpose and node ids share one shape', () => {
    expect(NAME_RE).toBe(PROFILE_NAME_RE);
    expect(NAME_RE).toBe(PURPOSE_NAME_RE);
  });

  test('the node-qualified separator is excluded everywhere', () => {
    // A purpose or profile containing `:` would collide with `nodeId:profile`.
    expect(NAME_RE.test('a:b')).toBe(false);
    expect(() => validatePurposeName('work:linkedin')).toThrow(/invalid purpose name/);
    expect(() => validateProfileName('work:linkedin')).toThrow(/invalid fleet profile name/);
  });

  test('the `_` prefix is reserved for the fleet template', () => {
    expect(() => validateProfileName('_template')).toThrow(/invalid fleet profile name/);
    expect(validateProfileName('p01')).toBeUndefined();
  });

  test('uppercase, leading dashes and over-long names are rejected', () => {
    expect(() => validateProfileName('P01')).toThrow();
    expect(() => validateProfileName('-p01')).toThrow();
    expect(() => validateProfileName('a'.repeat(33))).toThrow();
    expect(validateProfileName('a'.repeat(32))).toBeUndefined();
  });
});

describe('loadConfig', () => {
  test('raises a typed error when the fleet was never initialised', async () => {
    rmSync(CONFIG_PATH, { force: true });
    const error = await loadConfig().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FleetNotInitializedError);
  });

  test('a fresh fleet is open and mints a bridge credential', async () => {
    const config = await loadConfig();
    expect(config.token).toBeNull();
    expect(config.bridgeToken).toMatch(/^[0-9a-f]{64}$/);
  });

  test('backfills token and leaseIdleTtlSec written before they existed', async () => {
    const config = await loadConfig();
    delete (config as Partial<typeof config>).leaseIdleTtlSec;
    delete (config as Partial<typeof config>).token;
    write(config);

    const loaded = await loadConfig();
    expect(loaded.token).toBeNull();
    // Without this, every lease's liveness check compared against NaN and died
    // instantly, handing live profiles out from under their agents.
    expect(loaded.leaseIdleTtlSec).toBe(900);
  });

  test('names the field a trimmed file is missing', async () => {
    const cases: Array<[string, (config: Record<string, unknown>) => void]> = [
      ['gateway.host', (config) => delete config.gateway],
      [
        'gateway.port',
        (config) => ((config.gateway as Record<string, unknown>).port = undefined as never),
      ],
      ['bridgeToken', (config) => delete config.bridgeToken],
      ['chromePath', (config) => delete config.chromePath],
      ['extensionDir', (config) => delete config.extensionDir],
      ['basePort', (config) => delete config.basePort],
    ];
    for (const [field, mutate] of cases) {
      const config = JSON.parse(JSON.stringify(createDefaultConfig())) as Record<string, unknown>;
      mutate(config);
      write(config);
      await expect(loadConfig()).rejects.toThrow(`invalid fleet.json: ${field} is missing`);
    }
  });

  test('refuses a node id that collides with this machine', async () => {
    const config = createDefaultConfig();
    config.nodes = [{ id: config.nodeId, host: '127.0.0.1', port: 12300, token: 't' }];
    write(config);
    await expect(loadConfig()).rejects.toThrow(/collides with this machine's nodeId/);
  });

  test('refuses two profiles bound to the same purpose', async () => {
    const config = createDefaultConfig();
    config.profiles = [
      { name: 'p01', port: 12500, labels: [], enabled: true, purpose: 'linkedin' },
      { name: 'p02', port: 12501, labels: [], enabled: true, purpose: 'linkedin' },
    ];
    write(config);
    await expect(loadConfig()).rejects.toThrow(/is bound to both p01 and p02/);
  });
});

describe('saveConfig', () => {
  test('writes a 0600 file through a tmp+rename', async () => {
    const config = createDefaultConfig();
    config.profiles = [{ name: 'p01', port: 12500, labels: [], enabled: true }];
    await saveConfig(config);

    expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).profiles).toHaveLength(1);
    // No tmp file survives the rename.
    expect(readFileSync(CONFIG_PATH, 'utf8').endsWith('\n')).toBe(true);
  });

  test('fixes the mode of a file that already existed', async () => {
    writeFileSync(CONFIG_PATH, '{}', { mode: 0o644 });
    const config = createDefaultConfig();
    await saveConfig(config);
    expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
  });
});

describe('gatewayUrl', () => {
  test('resolves a wildcard bind to loopback, which is connectable', () => {
    const config = createDefaultConfig(12300, 12500);
    expect(gatewayUrl(config)).toBe('http://127.0.0.1:12300');
  });

  test('uses a concrete bind as-is, so a Tailscale-pinned fleet stays reachable', () => {
    const config = createDefaultConfig(12300, 12500);
    // The CLI talks to the gateway for status and control verbs; against a
    // wildcard bind only loopback answers, against a pinned one loopback is
    // ECONNREFUSED.
    config.gateway.host = '100.88.99.122';
    expect(gatewayUrl(config)).toBe('http://100.88.99.122:12300');
  });

  test('an empty host is treated as a wildcard', () => {
    const config = createDefaultConfig(12300, 12500);
    config.gateway.host = '';
    expect(gatewayUrl(config)).toBe('http://127.0.0.1:12300');
  });
});
