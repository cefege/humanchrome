import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createManifestContent } from '../scripts/utils';
import { EXTENSION_ID, HOST_NAME } from '../scripts/constant';
import { FLEET_ROOT, FleetConfig, loadConfig, saveConfig, validateProfileName } from './config';

const USER_MANIFEST = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.humanchrome.nativehost.json',
);

function profileEnvironment(config: FleetConfig, name: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HC_BRIDGE_PORT: String(port),
    HC_INSTANCE_REGISTRY_DIR: path.join(FLEET_ROOT, 'registry', 'instances'),
    HC_BRIDGE_DAEMON_SOCKET: path.join(FLEET_ROOT, 'run', `${name}.sock`),
    HUMANCHROME_TOKEN: config.bridgeToken,
    HC_FLEET_PROFILE: name,
  };
}

export async function initTemplate(config: FleetConfig): Promise<void> {
  const dir = path.join(FLEET_ROOT, 'profiles', '_template');
  await fs.mkdir(path.join(dir, 'NativeMessagingHosts'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`),
    JSON.stringify(await createManifestContent(), null, 2),
  );
  const child = spawn(
    config.chromePath,
    [
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'chrome://extensions',
    ],
    { stdio: 'ignore', env: profileEnvironment(config, '_template', config.basePort - 1) },
  );
  console.log(
    'Enable Developer mode → Load unpacked → Cmd+Shift+G → paste the extension directory → Select → quit Chrome.',
  );
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

export async function addProfile(name: string, labels: string[]): Promise<FleetConfig> {
  validateProfileName(name);
  const config = await loadConfig();
  if (config.profiles.some((profile) => profile.name === name)) {
    throw new Error(`profile already exists: ${name}`);
  }
  const manifest = JSON.parse(
    await fs.readFile(path.join(config.extensionDir, 'manifest.json'), 'utf8'),
  ) as { key?: string };
  if (!manifest.key)
    throw new Error('extension build is keyless; rebuild with CHROME_EXTENSION_KEY set');
  try {
    await fs.access(USER_MANIFEST);
  } catch {
    throw new Error('run humanchrome-bridge register first');
  }

  const dir = path.join(FLEET_ROOT, 'profiles', name);
  await fs.mkdir(path.join(dir, 'NativeMessagingHosts'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`),
    JSON.stringify(await createManifestContent(), null, 2),
  );

  const port = Math.max(config.basePort - 1, ...config.profiles.map((profile) => profile.port)) + 1;
  const template = path.join(FLEET_ROOT, 'profiles', '_template');
  try {
    await fs.access(template);
    await fs.cp(template, dir, {
      recursive: true,
      filter: (source) =>
        !/^Singleton|^Cache$|^Crashpad$|^GrShaderCache$|^ShaderCache$/.test(path.basename(source)),
    });
  } catch {
    console.log(
      `Enable Developer mode → Load unpacked → Cmd+Shift+G → paste ${config.extensionDir} → Select`,
    );
  }

  const child = spawn(
    config.chromePath,
    [
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    { detached: true, stdio: 'ignore', env: profileEnvironment(config, name, port) },
  );
  child.unref();
  if (child.pid) await fs.writeFile(path.join(FLEET_ROOT, 'run', `${name}.pid`), String(child.pid));

  const ready = await waitForBridge(port, 60_000);
  if (!ready) {
    if (child.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
    throw new Error('extension did not connect; see docs/FLEET.md#troubleshooting');
  }

  config.profiles.push({ name, port, labels: [...new Set(labels)], enabled: true });
  await saveConfig(config);
  await signalServe();
  return config;
}

export async function removeProfile(name: string, deleteData: boolean): Promise<void> {
  const config = await loadConfig();
  const profile = config.profiles.find((entry) => entry.name === name);
  if (!profile) throw new Error(`unknown profile: ${name}`);
  const pidPath = path.join(FLEET_ROOT, 'run', `${name}.pid`);
  try {
    const pid = Number(await fs.readFile(pidPath, 'utf8'));
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise<void>((done) => setTimeout(done, 100));
    }
  } catch {
    /* not running */
  }
  await fs.rm(pidPath, { force: true });
  config.profiles = config.profiles.filter((entry) => entry.name !== name);
  await saveConfig(config);
  if (deleteData)
    await fs.rm(path.join(FLEET_ROOT, 'profiles', name), { recursive: true, force: true });
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
    await new Promise<void>((done) => setTimeout(done, 500));
  }
  return false;
}

async function signalServe(): Promise<void> {
  try {
    const pid = Number(await fs.readFile(path.join(FLEET_ROOT, 'run', 'serve.pid'), 'utf8'));
    process.kill(pid, 'SIGHUP');
  } catch {
    /* serve is not running */
  }
}

export function extensionId(): string {
  return EXTENSION_ID;
}
