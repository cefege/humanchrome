import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';
import { copyProfileDir, seedProfileFrom } from './provision';

async function seedDir(entries: string[]): Promise<string> {
  const dir = path.join(await fs.mkdtemp(path.join(tmpdir(), 'hc-seed-')), 'source');
  await fs.mkdir(dir, { recursive: true });
  for (const entry of entries) {
    const target = path.join(dir, entry);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'x');
  }
  return dir;
}

describe('copyProfileDir', () => {
  test('keeps the cookie store and the state that decrypts it', async () => {
    const source = await seedDir(['Local State', 'Default/Cookies', 'Default/Preferences']);
    const dest = `${source}-copy`;
    await copyProfileDir(source, dest);
    for (const kept of ['Local State', 'Default/Cookies', 'Default/Preferences']) {
      await expect(fs.access(path.join(dest, kept))).resolves.toBeUndefined();
    }
  });

  test('drops volatile caches and the source native-host manifest', async () => {
    const source = await seedDir([
      'Local State',
      'SingletonCookie',
      'SingletonLock',
      'Default/Cache',
      'Default/Code Cache',
      'Service Worker/CacheStorage',
      'Default/Login Data',
      'Default/Account Web Data',
      'NativeMessagingHosts/com.humanchrome.nativehost.json',
      'Crashpad',
    ]);
    const dest = `${source}-copy`;
    await copyProfileDir(source, dest);
    for (const dropped of [
      'SingletonCookie',
      'SingletonLock',
      'Default/Cache',
      'Default/Code Cache',
      'Service Worker/CacheStorage',
      'Default/Login Data',
      'Default/Account Web Data',
      'NativeMessagingHosts',
      'Crashpad',
    ]) {
      await expect(fs.access(path.join(dest, dropped))).rejects.toThrow();
    }
    await expect(fs.access(path.join(dest, 'Local State'))).resolves.toBeUndefined();
  });

  test('copies nested session state that a login depends on', async () => {
    const source = await seedDir([
      'Local State',
      'Default/Local Storage/leveldb/000003.log',
      'Default/IndexedDB/https_127.0.0.1_4174.indexeddb.leveldb/000001.log',
    ]);
    const dest = `${source}-copy`;
    await copyProfileDir(source, dest);
    await expect(
      fs.access(path.join(dest, 'Default/Local Storage/leveldb/000003.log')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(dest, 'Default/IndexedDB/https_127.0.0.1_4174.indexeddb.leveldb/000001.log'),
      ),
    ).resolves.toBeUndefined();
  });

  test('a source that does not exist fails the copy', async () => {
    await expect(
      copyProfileDir(path.join(mkdtempSync(path.join(tmpdir(), 'hc-none-')), 'absent'), '/tmp/x'),
    ).rejects.toThrow();
  });
});

describe('seedProfileFrom', () => {
  const template = path.join(mkdtempSync(path.join(tmpdir(), 'hc-tpl-')), '_template');

  test('a missing template starts an empty profile instead of failing', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = path.join(template, '..', 'fresh');
    expect(await seedProfileFrom('p03', null, dir, template)).toBeNull();
    expect(log).toHaveBeenCalledWith(
      'template profile missing — starting p03 with an empty profile',
    );
    await expect(fs.access(dir)).rejects.toThrow();
    log.mockRestore();
  });

  test('a seed directory that does not exist is refused by name', async () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'hc-miss-')), 'absent');
    await expect(seedProfileFrom('p03', missing, `${missing}-copy`, template)).rejects.toThrow(
      `seed profile not found: ${missing}`,
    );
  });

  test('a directory that is not a Chrome profile is refused by name', async () => {
    const source = await seedDir(['Default/Cookies']);
    await expect(seedProfileFrom('p03', source, `${source}-copy`, template)).rejects.toThrow(
      `seed profile has no Local State: ${source}`,
    );
    await expect(fs.access(`${source}-copy`)).rejects.toThrow();
  });

  test('a valid seed is copied and its provenance recorded', async () => {
    const source = await seedDir(['Local State', 'Default/Cookies']);
    const dest = `${source}-copy`;
    const provenance = await seedProfileFrom('p03', source, dest, template);
    expect(provenance?.seededFrom).toBe(source);
    expect(provenance?.seededAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(fs.access(path.join(dest, 'Default/Cookies'))).resolves.toBeUndefined();
  });
});

describe('copyProfileDir with a stale Chrome user-data-dir', () => {
  test('skips RunningChromeVersion, a dangling symlink into a removed build', async () => {
    // Chrome leaves this pointing at the version it last ran. After an update
    // the target is gone, and `fs.cp` stats it and aborts the whole copy.
    const source = await seedDir(['Local State', 'Default/Cookies']);
    const dangling = path.join(source, 'RunningChromeVersion');
    await fs.symlink('153.0.8010.53:1', dangling);

    const dest = `${source}-copy`;
    await copyProfileDir(source, dest);

    // The rest of the profile still copied.
    await expect(fs.access(path.join(dest, 'Default/Cookies'))).resolves.toBeUndefined();
    // And the broken link is not carried into the new profile.
    await expect(fs.lstat(path.join(dest, 'RunningChromeVersion'))).rejects.toThrow();
  });

  test('also skips Last Version and the singleton locks', async () => {
    const source = await seedDir(['Local State', 'Default/Cookies']);
    await fs.writeFile(path.join(source, 'Last Version'), '154.0.0.0');
    await fs.writeFile(path.join(source, 'SingletonLock'), 'lock');
    const dest = `${source}-copy2`;
    await copyProfileDir(source, dest);
    await expect(fs.access(path.join(dest, 'Default/Cookies'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dest, 'Last Version'))).rejects.toThrow();
    await expect(fs.access(path.join(dest, 'SingletonLock'))).rejects.toThrow();
  });
});
