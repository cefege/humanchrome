/**
 * IMP-0115 — instance registry round-trip + stale GC.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'hc-instance-registry-'));
  process.env.HC_INSTANCE_REGISTRY_DIR = tmp;
});

afterAll(() => {
  delete process.env.HC_INSTANCE_REGISTRY_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Clean slate per test.
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});

async function load() {
  // registryDir() reads HC_INSTANCE_REGISTRY_DIR on every call, so no need
  // for jest.isolateModules — a direct import always sees the current env.
  return await import('./instance-registry');
}

describe('instance registry (IMP-0115)', () => {
  test('writeInstance + listInstances round-trip', async () => {
    const mod = await load();
    mod.writeInstance({
      pid: process.pid,
      port: 12306,
      extensionId: 'hbdg-test',
      instanceId: 'instance-A',
      startedAt: new Date().toISOString(),
    });
    const live = mod.listInstances();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      port: 12306,
      extensionId: 'hbdg-test',
      instanceId: 'instance-A',
    });
  });

  test('listInstances filters dead pids', async () => {
    const mod = await load();
    // Pick a pid that's almost certainly dead — INT32_MAX - 1.
    const deadPid = 2_147_483_646;
    mod.writeInstance({
      pid: deadPid,
      port: 12307,
      extensionId: 'hbdg-test',
      startedAt: new Date().toISOString(),
    });
    // Also write a live entry for this process.
    mod.writeInstance({
      pid: process.pid,
      port: 12308,
      extensionId: 'hbdg-test',
      startedAt: new Date().toISOString(),
    });
    const live = mod.listInstances();
    expect(live.map((r: { port: number }) => r.port).sort()).toEqual([12308]);
    // Dead entry should have been GC'd from disk.
    expect(existsSync(resolve(tmp, `${deadPid}.json`))).toBe(false);
  });

  test('listInstances drops corrupt JSON entries', async () => {
    const mod = await load();
    writeFileSync(resolve(tmp, '99999.json'), '{ not json');
    const live = mod.listInstances();
    expect(live).toHaveLength(0);
    expect(existsSync(resolve(tmp, '99999.json'))).toBe(false);
  });

  test('removeInstance unlinks the entry', async () => {
    const mod = await load();
    mod.writeInstance({
      pid: process.pid,
      port: 12309,
      extensionId: 'hbdg-test',
      startedAt: new Date().toISOString(),
    });
    mod.removeInstance(process.pid);
    expect(mod.listInstances()).toHaveLength(0);
  });
});
