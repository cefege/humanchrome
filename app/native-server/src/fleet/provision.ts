import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createManifestContent } from '../scripts/utils';
import { HOST_NAME } from '../scripts/constant';
import { FLEET_ROOT, FleetConfig, loadConfig, saveConfig, validateProfileName } from './config';
import { applyWindowLabel } from './window-label';
import { LaunchedProfile, launchProfileWithExtension } from './launch';
import {
  assertKeychainReadable,
  CdpPipe,
  ChromeChild,
  readExtensionManifest,
  terminateChrome,
} from './cdp';
import {
  CHROME_EPOCH_OFFSET_US,
  GoogleSession,
  googleSessionLoss,
  probeProfileGoogleSession,
  signinPendingSince,
} from './google-session';

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
async function discardProfile(dir: string, child: ChromeChild | null): Promise<void> {
  if (child) await terminateChrome(child.pid ?? 0, TIMERS.killDeadlineMs);
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

/**
 * Persistent, unexpired, unpartitioned cookies, split out for google.com: the
 * logins a seeded profile exists to carry. Partitioned (CHIPS) cookies are left
 * out on both sides because `Storage.getCookies` does not report them reliably,
 * and a third of a jar can be partitioned (33 of 287 on the m1-us daily Chrome).
 */
export interface CookieCount {
  persistent: number;
  google: number;
}

/**
 * 90% of the copied cookies must survive the first launch. Losing them to an
 * undecryptable store is all-or-nothing (420 copied, 0 kept, observed), while
 * the legitimate churn between the copy and the check (a cookie that expires
 * in that minute, Chrome's own load-time cleanup) is a handful. google.com is
 * checked on its own, because a ratio can hide losing exactly the session that
 * seeding is for.
 */
export const COOKIE_KEEP_RATIO = 0.9;

const isGoogle = (host: string): boolean => {
  const bare = host.replace(/^\./, '');
  return bare === 'google.com' || bare.endsWith('.google.com');
};

/**
 * What a profile was given: read straight from its copied cookie store, before
 * any Chrome has opened it. A profile without a store was given nothing.
 */
export function countCopiedCookies(userDataDir: string, now = Date.now()): CookieCount {
  const file = path.join(userDataDir, 'Default', 'Cookies');
  if (!existsSync(file)) return { persistent: 0, google: 0 };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const hosts = db
      .prepare(
        `SELECT host_key FROM cookies
          WHERE is_persistent = 1 AND top_frame_site_key = '' AND expires_utc > ?`,
      )
      .pluck()
      .all(BigInt(now) * 1000n + CHROME_EPOCH_OFFSET_US);
    let google = 0;
    for (const host of hosts) if (typeof host === 'string' && isGoogle(host)) google += 1;
    return { persistent: hosts.length, google };
  } finally {
    db.close();
  }
}

/**
 * Whether a copy carries a Google login at all: the `SID` / `__Secure-1PSID`
 * pair Google sets at sign-in, unexpired. Only such a copy is expected to come
 * up with a live session; NID-style google.com cookies exist signed out too.
 */
export function copiedGoogleLogin(userDataDir: string, now = Date.now()): boolean {
  const file = path.join(userDataDir, 'Default', 'Cookies');
  if (!existsSync(file)) return false;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row: unknown = db
      .prepare(
        `SELECT 1 FROM cookies
          WHERE host_key = '.google.com' AND name IN ('SID', '__Secure-1PSID') AND expires_utc > ?
          LIMIT 1`,
      )
      .pluck()
      .get(BigInt(now) * 1000n + CHROME_EPOCH_OFFSET_US);
    return row !== undefined;
  } finally {
    db.close();
  }
}

/** What the running browser kept: the cookies it could load and decrypt. */
export async function countLiveCookies(cdp: CdpPipe, now = Date.now()): Promise<CookieCount> {
  const response = await cdp.send('Storage.getCookies', {});
  if (response.error) {
    throw new Error(`Storage.getCookies failed: ${response.error.message ?? 'unknown'}`);
  }
  const result = response.result;
  const cookies =
    result && typeof result === 'object' && 'cookies' in result && Array.isArray(result.cookies)
      ? (result.cookies as unknown[])
      : [];
  const count: CookieCount = { persistent: 0, google: 0 };
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') continue;
    if (!('session' in cookie) || cookie.session !== false) continue;
    if (!('expires' in cookie) || typeof cookie.expires !== 'number') continue;
    if (cookie.expires * 1000 <= now || 'partitionKey' in cookie) continue;
    count.persistent += 1;
    if ('domain' in cookie && typeof cookie.domain === 'string' && isGoogle(cookie.domain)) {
      count.google += 1;
    }
  }
  return count;
}

/** Why a launch lost the logins it was given, or null when it kept them. */
export function cookieLoss(copied: CookieCount, kept: CookieCount): string | null {
  if (kept.persistent < copied.persistent * COOKIE_KEEP_RATIO) {
    return (
      `Chrome kept ${kept.persistent} of ${copied.persistent} copied cookies ` +
      `(at least ${Math.ceil(copied.persistent * COOKIE_KEEP_RATIO)} required)`
    );
  }
  if (copied.google > 0 && kept.google === 0) {
    return `Chrome kept none of the ${copied.google} copied google.com cookies`;
  }
  return null;
}

export interface AddedProfile {
  name: string;
  port: number;
  copied: CookieCount;
  kept: CookieCount;
  /** Google's answer for the new browser; null when unreadable and no session was expected. */
  google: GoogleSession | null;
}

/**
 * Registers a profile only once its browser is up, its extension answers, it
 * kept the cookies it was seeded with, and, when the copy carried a Google
 * login, Google confirms that login is a live session. Any failure on the way
 * discards the directory and the browser, so a refused add leaves nothing behind.
 */
export async function addProfile(
  name: string,
  labels: string[],
  seedDir: string | null = null,
): Promise<AddedProfile> {
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
  // Checked before the copy too: a launch would refuse anyway, and this way no
  // multi-gigabyte second copy of the daily profile's secrets is made for it.
  await assertKeychainReadable();

  const dir = path.join(FLEET_ROOT, 'profiles', name);
  const pidFile = path.join(FLEET_ROOT, 'run', `${name}.pid`);
  const port = Math.max(config.basePort - 1, ...config.profiles.map((profile) => profile.port)) + 1;
  const provenance = await seedProfileFrom(
    name,
    seedDir,
    dir,
    path.join(FLEET_ROOT, 'profiles', '_template'),
  );

  let launched: LaunchedProfile | null = null;
  let copied: CookieCount;
  let kept: CookieCount;
  let google: GoogleSession | null = null;
  try {
    await writeNativeHostManifest(dir);
    copied = countCopiedCookies(dir);
    const expectsGoogle = provenance !== null && copiedGoogleLogin(dir);
    launched = await launchProfileWithExtension(config, name, dir, port);
    if (launched.child.pid) await fs.writeFile(pidFile, String(launched.child.pid));
    if (!(await waitForBridge(port, TIMERS.bridgeTimeoutMs))) {
      throw new Error('extension did not connect; see docs/FLEET.md#troubleshooting');
    }
    kept = await countLiveCookies(launched.cdp);
    const loss = cookieLoss(copied, kept);
    if (loss) throw new Error(`${name} lost its seeded cookies: ${loss}; profile discarded`);
    try {
      google = await probeProfileGoogleSession(port, config.bridgeToken);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Only a copy that carried a Google login is gated on it; any other add
      // reports the state when it can and goes on when it cannot.
      if (expectsGoogle) {
        throw new Error(
          `${name}: could not read its Google session (${reason}); profile discarded`,
        );
      }
      console.error(`fleet: Google session of ${name} unknown: ${reason}`);
    }
    const lostGoogle =
      google &&
      googleSessionLoss(expectsGoogle, google, seedDir ? signinPendingSince(seedDir) : null);
    if (lostGoogle) throw new Error(`${name}: ${lostGoogle}; profile discarded`);
  } catch (error) {
    launched?.cdp.dispose();
    // The pid file outlived the browser it named, so a later `profile rm` would
    // signal whatever process inherited that recycled pid.
    await fs.rm(pidFile, { force: true });
    await discardProfile(dir, launched?.child ?? null);
    throw error;
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
  return { name, port, copied, kept, google };
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
