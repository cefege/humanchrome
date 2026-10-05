import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.HC_FLEET_ROOT = mkdtempSync(path.join(tmpdir(), 'hc-guard-test-'));

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { TOOL_NAMES } from 'humanchrome-shared';
import {
  _resetProtectionCacheForTest,
  currentProfileProtection,
  evaluatePurposeGuard,
} from './purpose-guard';

const CLEAR = TOOL_NAMES.BROWSER.CLEAR_BROWSING_DATA;
const NAVIGATE = TOOL_NAMES.BROWSER.NAVIGATE;
const PURPOSE = 'bound to purpose "linkedin"';
const SEED = 'seeded from /Users/someone/Library/Application Support/Google/Chrome';

describe('evaluatePurposeGuard', () => {
  test('leaves every other tool alone on a protected profile', () => {
    const args = { url: 'https://example.test' };
    const verdict = evaluatePurposeGuard(NAVIGATE, args, PURPOSE);
    expect(verdict).toEqual({ allowed: true, args });
  });

  test('allows a clear that names its origins', () => {
    const args = { dataTypes: ['cookies'], origins: ['https://example.test'] };
    expect(evaluatePurposeGuard(CLEAR, args, PURPOSE)).toEqual({ allowed: true, args });
  });

  test('an empty origins array is not a scope, so it is refused', () => {
    const args = { dataTypes: ['cookies'], origins: [] };
    const verdict = evaluatePurposeGuard(CLEAR, args, PURPOSE);
    expect(verdict.allowed).toBe(false);
    expect(verdict.args).toEqual(args);
  });

  test('a bare clear on an unprotected profile passes through', () => {
    const args = { dataTypes: ['cookies'] };
    expect(evaluatePurposeGuard(CLEAR, args, null)).toEqual({ allowed: true, args });
  });

  test('refuses a bare clear on a purpose-bound profile with the exact message', () => {
    const args = { dataTypes: ['cookies'] };
    const verdict = evaluatePurposeGuard(CLEAR, args, PURPOSE);
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toBe(
      'profile is bound to purpose "linkedin"; chrome_clear_browsing_data without "origins" clears every login in this browser — pass origins to scope it, or confirmProfileWipe: true to wipe it anyway',
    );
  });

  test('refuses a bare clear on a seeded profile with the same clause shape', () => {
    const verdict = evaluatePurposeGuard(CLEAR, {}, SEED);
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toBe(
      `profile is ${SEED}; chrome_clear_browsing_data without "origins" clears every login in this browser — pass origins to scope it, or confirmProfileWipe: true to wipe it anyway`,
    );
  });

  test('confirmProfileWipe is honoured and then stripped from the envelope', () => {
    const verdict = evaluatePurposeGuard(
      CLEAR,
      { dataTypes: ['cookies'], confirmProfileWipe: true },
      PURPOSE,
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.args).toEqual({ dataTypes: ['cookies'] });
  });

  test('args the caller did not touch come back identical', () => {
    const args = { dataTypes: ['cookies'] };
    expect(evaluatePurposeGuard(CLEAR, args, PURPOSE).args).toBe(args);
  });
});

describe('currentProfileProtection', () => {
  const root = process.env.HC_FLEET_ROOT!;
  const fleetJson = path.join(root, 'fleet.json');

  function writeFleet(profiles: unknown[]): void {
    writeFileSync(
      fleetJson,
      JSON.stringify({
        version: 1,
        gateway: { host: '127.0.0.1', port: 12300 },
        token: null,
        bridgeToken: 'b'.repeat(64),
        chromePath: '/nonexistent/chrome',
        extensionDir: '/nonexistent/ext',
        basePort: 12500,
        leaseIdleTtlSec: 900,
        parked: false,
        nodeId: 'test',
        nodes: [],
        profiles,
      }),
    );
  }

  afterEach(() => {
    delete process.env.HC_FLEET_PROFILE;
    _resetProtectionCacheForTest();
  });

  test('is null outside a fleet profile, without reading any config', async () => {
    await expect(currentProfileProtection()).resolves.toBeNull();
  });

  test('names the purpose tag a profile serves', async () => {
    writeFleet([{ name: 'p01', port: 12500, labels: [], enabled: true, purpose: 'linkedin' }]);
    process.env.HC_FLEET_PROFILE = 'p01';
    await expect(currentProfileProtection()).resolves.toBe('bound to purpose "linkedin"');
  });

  test('names a seed source and stays null for an ordinary profile', async () => {
    writeFleet([
      { name: 'p01', port: 12500, labels: [], enabled: true, seededFrom: '/Users/someone/Chrome' },
      { name: 'p02', port: 12501, labels: [], enabled: true },
    ]);
    process.env.HC_FLEET_PROFILE = 'p01';
    await expect(currentProfileProtection()).resolves.toBe('seeded from /Users/someone/Chrome');
    _resetProtectionCacheForTest();
    process.env.HC_FLEET_PROFILE = 'p02';
    await expect(currentProfileProtection()).resolves.toBeNull();
  });

  test('a config read failure is logged and never cached', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    rmSync(fleetJson, { force: true });
    process.env.HC_FLEET_PROFILE = 'p01';
    await expect(currentProfileProtection()).resolves.toBeNull();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('purpose guard could not read fleet.json'),
    );
    // Not cached: a fixed config is picked up immediately rather than after 30s.
    writeFleet([{ name: 'p01', port: 12500, labels: [], enabled: true, purpose: 'linkedin' }]);
    await expect(currentProfileProtection()).resolves.toBe('bound to purpose "linkedin"');
    errors.mockRestore();
  });
});
