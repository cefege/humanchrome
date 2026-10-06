import path from 'node:path';
import { FleetConfig, FLEET_ROOT } from './config';
import {
  assertKeychainReadable,
  chromeArgs,
  killChromeGroup,
  readExtensionManifest,
  spawnWithCdpPipe,
  CdpPipe,
  ChromeChild,
} from './cdp';
import { restoreSession, SESSION_FILE } from './session';

export interface LaunchedProfile {
  child: ChromeChild;
  cdp: CdpPipe;
  extensionId: string;
}

export function profileEnvironment(
  config: FleetConfig,
  name: string,
  port: number,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HC_BRIDGE_PORT: String(port),
    HC_INSTANCE_REGISTRY_DIR: path.join(FLEET_ROOT, 'registry', 'instances'),
    HC_BRIDGE_DAEMON_SOCKET: path.join(FLEET_ROOT, 'run', `${name}.sock`),
    HUMANCHROME_TOKEN: config.bridgeToken,
    HC_FLEET_PROFILE: name,
  };
}

/**
 * Launches a profile with the DevTools protocol on stdio and loads the humanchrome
 * extension over it. Loading is deliberately re-applied on every launch: Chrome
 * does not persist a CDP-loaded unpacked extension, and Chrome >= 137 ignores
 * `--load-extension`, so a persisted clone is the only other source of truth and
 * it silently dies whenever the repo build directory moves.
 */
export async function launchProfileWithExtension(
  config: FleetConfig,
  name: string,
  userDataDir: string,
  port: number,
): Promise<LaunchedProfile> {
  const manifest = await readExtensionManifest(config.extensionDir);
  if (!manifest.key) {
    throw new Error('extension build is keyless; rebuild with CHROME_EXTENSION_KEY set');
  }
  // Every launch, not only a seeding one: a profile started where the Keychain
  // is locked deletes its own cookies, and nothing downstream can undo that.
  await assertKeychainReadable();
  const child = spawnWithCdpPipe(config.chromePath, chromeArgs(userDataDir), {
    env: profileEnvironment(config, name, port),
  });
  child.unref();
  const cdp = new CdpPipe(child.stdio[3], child.stdio[4]);
  // A bad `chromePath` makes spawn emit 'error' asynchronously, and with
  // `child.unref()` nothing else observes it. Disposing the pipe is what turns
  // that into the `cdp pipe closed` failure the launch reports.
  child.once('error', () => cdp.dispose());
  try {
    // Before the extension can navigate: cookies must be in place before any
    // site page loads, or the first request goes out unauthenticated.
    await restoreSession(cdp, path.join(userDataDir, SESSION_FILE), name);
    const extensionId = await cdp.loadUnpacked(config.extensionDir);
    return { child, cdp, extensionId };
  } catch (error) {
    cdp.dispose();
    killChromeGroup(child.pid ?? 0, 'SIGKILL');
    throw error;
  }
}
