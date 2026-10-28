import { describe, expect, test } from '@jest/globals';
import { validateCoordinatorConfig, workerInventorySchema } from './coordinator-config';

function configuration() {
  return {
    id: 'cloud',
    host: '127.0.0.1',
    port: 12300,
    databaseUrl: 'postgresql://localhost/humanchrome',
    leaseTtlSec: 900,
    clients: [
      { id: 'operator', token: 'a'.repeat(64), admin: true },
      { id: 'agent', token: 'b'.repeat(64), admin: false },
    ],
    workers: [{ id: 'mac', url: 'http://mac.example.ts.net:12310/', token: 'c'.repeat(64) }],
  };
}

describe('coordinator trust boundaries', () => {
  test('requires a distinct credential for each client and worker', () => {
    const config = configuration();
    config.clients[1].token = config.clients[0].token;
    expect(() => validateCoordinatorConfig(config)).toThrow('invalid coordinator configuration');
    config.clients[1].token = 'b'.repeat(64);
    config.workers[0].token = config.clients[0].token;
    expect(() => validateCoordinatorConfig(config)).toThrow('invalid coordinator configuration');
  });

  test('rejects conflicting worker identities instead of merging browser pools', () => {
    const config = configuration();
    config.workers.push({ ...config.workers[0], token: 'd'.repeat(64) });
    expect(() => validateCoordinatorConfig(config)).toThrow();
  });

  test.each([
    'https://user:secret@mac.example.ts.net',
    'file:///tmp/worker',
    'http://mac.example.ts.net/private',
    'http://mac.example.ts.net?token=secret',
  ])('rejects non-origin worker endpoint %s', (url) => {
    const config = configuration();
    config.workers[0].url = url;
    expect(() => validateCoordinatorConfig(config)).toThrow();
  });

  test('requires explicit administrator access without silently granting it', () => {
    const config = configuration();
    config.clients[0].admin = false;
    expect(() => validateCoordinatorConfig(config)).toThrow();
  });

  test.each([0, 14, 901, 15.5, Number.NaN])(
    'rejects lease duration %s outside worker fencing limits',
    (leaseTtlSec) => {
      expect(() => validateCoordinatorConfig({ ...configuration(), leaseTtlSec })).toThrow();
    },
  );

  test('configuration validation errors do not contain credentials', () => {
    const config = configuration();
    config.clients[0].token = 'secret';
    let reported: unknown;
    try {
      validateCoordinatorConfig(config);
    } catch (error) {
      reported = error;
    }
    expect(reported).toBeInstanceOf(Error);
    expect(String(reported)).not.toContain('secret');
  });

  test('rejects duplicate profile names in a worker inventory', () => {
    const profile = {
      name: 'browser',
      port: 12500,
      labels: [],
      enabled: true,
      purpose: null,
      state: 'healthy',
      pid: 1,
      leasedBy: null,
      lastError: null,
      startedBy: null,
    };
    expect(
      workerInventorySchema.safeParse({ id: 'mac', profiles: [profile, profile] }).success,
    ).toBe(false);
  });
});
