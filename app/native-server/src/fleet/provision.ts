import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManifestContent } from '../scripts/utils';
import { HOST_NAME } from '../scripts/constant';
import { FLEET_ROOT, FleetConfig, loadConfig, saveConfig, validateProfileName } from './config';
import { applyWindowLabel } from './window-label';
import { launchProfileWithExtension } from './launch';
import { ChromeChild, readExtensionManifest, terminateChrome } from './cdp';

const TIMERS = {
  killDeadlineMs: 5_000,
  rmRetryDelayMs: 200,
  rmRetries: 10,
  bridgePollMs: 500,
  bridgeTimeoutMs: 60_000,
} as const;

const USER_MANIFEST = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.humanchrome.nativehost.json',
);

export async function initTemplate(config: FleetConfig): Promise<void> {
  const dir = path.join(FLEET_ROOT, 'profiles', '_template');
  await writeNativeHostManifest(dir);
  const port = config.basePort - 1;
  const launched = await launchProfileWithExtension(config, '_template', dir, port);
  const ready = await waitForBridge(port, TIMERS.bridgeTimeoutMs);
  launched.cdp.dispose();
  if (!ready) {
    await fs.rm(path.join(FLEET_ROOT, 'run', '_template.pid'), { force: true });
    await discardProfile(dir, launched.child);
    throw new Error('template extension did not connect; see docs/FLEET.md#troubleshooting');
  }
  console.log(`template ready: ${launched.extensionId} verified on 127.0.0.1:${port}`);
}

/**
 * Writes the per-profile native-messaging manifest and refuses to write one that
 * points at a host script that does not exist. Chrome accepts such a manifest
 * and then fails every connectNative() with "Native host has exited.", which
 * looks like a dead extension rather than a bad path.
 */
async function writeNativeHostManifest(profileDir: string): Promise<void> {
  const manifest = (await createManifestContent()) as { path?: string };
  if (!manifest.path) throw new Error('native host manifest has no path');
  try {
    await fs.access(manifest.path);
  } catch {
    throw new Error(
      `native host script missing: ${manifest.path} — provision from the built bridge ` +
        '(cd app/native-server && npm run build), not from a source checkout',
    );
  }
  await fs.mkdir(path.join(profileDir, 'NativeMessagingHosts'), { recursive: true });
  await fs.writeFile(
    path.join(profileDir, 'NativeMessagingHosts', `${HOST_NAME}.json`),
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * A dying Chrome keeps writing into its profile directory, so the directory is
 * removed only after the process is gone, with retries for the transient
 * ENOTEMPTY/EBUSY its shutdown leaves behind.
 */
async function discardProfile(dir: string, child: ChromeChild): Promise<void> {
  await terminateChrome(child.pid ?? 0, TIMERS.killDeadlineMs);
  await fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: TIMERS.rmRetries,
    retryDelay: TIMERS.rmRetryDelayMs,
  });
}

/**
 * Profile state that is either volatile (a dying browser keeps writing into it),
 * machine-specific, or a second copy of secrets this fleet never needs: the
 * cookie store and the profile-local state that decrypts it are deliberately
 * kept, because inheriting a live login is the entire point of seeding.
 */
const SEED_EXCLUDES =
  /^Singleton|^RunningChromeVersion$|^Last Version$|^Crashpad$|^component_crx_cache$|^extensions_crx_cache$|^BrowserMetrics|^Cache$|^Code Cache$|^GPUCache$|^DawnCache$|^GrShaderCache$|^ShaderCache$|^CacheStorage$|^Login Data$|^Account Web Data$|^NativeMessagingHosts$/;

export async function copyProfileDir(source: string, dest: string): Promise<void> {
  await fs.cp(source, dest, {
    recursive: true,
    filter: (entry) => !SEED_EXCLUDES.test(path.basename(entry)),
  });
}

/**
 * A template or seed source is a whole Chrome user-data-dir. It is copied before
 * the native-host manifest is written, so a source carrying its own
 * `NativeMessagingHosts/` cannot overwrite the manifest this profile needs.
 */
export async function seedProfileFrom(
  name: string,
  seedDir: string | null,
  dir: string,
  template: string,
): Promise<{ seededFrom: string; seededAt: string } | null> {
  const source = seedDir ?? template;
  try {
    await fs.access(source);
  } catch {
    if (seedDir) throw new Error(`seed profile not found: ${source}`);
    console.log(`template profile missing — starting ${name} with an empty profile`);
    return null;
  }
  if (seedDir) {
    try {
      await fs.access(path.join(source, 'Local State'));
    } catch {
      throw new Error(`seed profile has no Local State: ${source}`);
    }
  }
  try {
    await copyProfileDir(source, dir);
  } catch (error) {
    // An explicit seed never degrades to the empty-profile path: half a login
    // is worse than no profile at all.
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  if (!seedDir) return null;
  return { seededFrom: source, seededAt: new Date().toISOString() };
}

export async function addProfile(
  name: string,
  labels: string[],
  seedDir: string | null = null,
): Promise<FleetConfig> {
  validateProfileName(name);
  const config = await loadConfig();
  if (config.profiles.some((profile) => profile.name === name)) {
    throw new Error(`profile already exists: ${name}`);
  }
  const manifest = await readExtensionManifest(config.extensionDir);
  if (!manifest.key)
    throw new Error('extension build is keyless; rebuild with CHROME_EXTENSION_KEY set');
  try {
    await fs.access(USER_MANIFEST);
  } catch {
    throw new Error('run humanchrome-bridge register first');
  }

  const dir = path.join(FLEET_ROOT, 'profiles', name);
  const port = Math.max(config.basePort - 1, ...config.profiles.map((profile) => profile.port)) + 1;
  const provenance = await seedProfileFrom(
    name,
    seedDir,
    dir,
    path.join(FLEET_ROOT, 'profiles', '_template'),
  );
  await writeNativeHostManifest(dir);

  const launched = await launchProfileWithExtension(config, name, dir, port);
  if (launched.child.pid)
    await fs.writeFile(path.join(FLEET_ROOT, 'run', `${name}.pid`), String(launched.child.pid));

  const ready = await waitForBridge(port, TIMERS.bridgeTimeoutMs);
  if (!ready) {
    launched.cdp.dispose();
    // The pid file outlived the browser it named, so a later `profile rm` would
    // signal whatever process inherited that recycled pid.
    await fs.rm(path.join(FLEET_ROOT, 'run', `${name}.pid`), { force: true });
    await discardProfile(dir, launched.child);
    throw new Error('extension did not connect; see docs/FLEET.md#troubleshooting');
  }

  // Labelled here because this process owns the only DevTools pipe this
  // browser will ever have: `serve` adopts it by pid and cannot re-label it.
  await applyWindowLabel(launched.cdp, dir, name).catch(() => undefined);

  config.profiles.push({
    name,
    port,
    labels: [...new Set(labels)],
    enabled: true,
    ...(provenance ?? {}),
  });
  await saveConfig(config);
  await signalServe();
  // Hand the browser over. It outlives this DevTools pipe, and `serve` adopts
  // it from the pid file above; leaving the pipe attached is what kept this
  // process alive after provisioning, so the operator had to Ctrl-C it.
  launched.cdp.dispose();
  return config;
}

export async function removeProfile(name: string, deleteData: boolean): Promise<void> {
  const config = await loadConfig();
  const profile = config.profiles.find((entry) => entry.name === name);
  if (!profile) throw new Error(`unknown profile: ${name}`);
  const pidPath = path.join(FLEET_ROOT, 'run', `${name}.pid`);
  try {
    const pid = Number(await fs.readFile(pidPath, 'utf8'));
    await terminateChrome(pid, TIMERS.killDeadlineMs);
  } catch (error) {
    // A missing pid file means "not running", and that is the only benign case:
    // swallowing EPERM or a corrupt pid file too meant deleting a profile
    // directory out from under a live Chrome.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.rm(pidPath, { force: true });
  config.profiles = config.profiles.filter((entry) => entry.name !== name);
  await saveConfig(config);
  if (deleteData) {
    // Signalled before the data goes: the running serve must let go of the
    // profile before its directory disappears under it.
    await signalServe();
    await fs.rm(path.join(FLEET_ROOT, 'profiles', name), {
      recursive: true,
      force: true,
      maxRetries: TIMERS.rmRetries,
      retryDelay: TIMERS.rmRetryDelayMs,
    });
  }
  await signalServe();
}

async function waitForBridge(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (((await response.json()) as { status?: string }).status === 'ok') return true;
    } catch {
      /* retry */
    }
    await new Promise<void>((done) => setTimeout(done, TIMERS.bridgePollMs));
  }
  return false;
}

export async function signalServe(): Promise<void> {
  try {
    const pid = Number(await fs.readFile(path.join(FLEET_ROOT, 'run', 'serve.pid'), 'utf8'));
    process.kill(pid, 'SIGHUP');
  } catch {
    /* serve is not running */
  }
}
