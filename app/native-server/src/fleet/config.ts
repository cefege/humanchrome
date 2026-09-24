import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FleetProfileConfig {
  name: string;
  port: number;
  labels: string[];
  enabled: boolean;
}

export interface FleetConfig {
  version: 1;
  gateway: { host: string; port: number };
  token: string;
  bridgeToken: string;
  chromePath: string;
  extensionDir: string;
  basePort: number;
  leaseIdleTtlSec: number;
  profiles: FleetProfileConfig[];
}

export const FLEET_ROOT =
  process.env.HC_FLEET_ROOT ??
  path.join(os.homedir(), 'Library/Application Support/humanchrome-fleet');
export const FLEET_CONFIG_PATH = path.join(FLEET_ROOT, 'fleet.json');
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name) || name.startsWith('_')) {
    throw new Error(`invalid fleet profile name: ${name}`);
  }
}

export function createDefaultConfig(gatewayPort = 12300, basePort = 12500): FleetConfig {
  return {
    version: 1,
    gateway: { host: '0.0.0.0', port: gatewayPort },
    token: randomBytes(32).toString('hex'),
    bridgeToken: randomBytes(32).toString('hex'),
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    extensionDir: path.join(
      os.homedir(),
      'Library/Application Support/humanchrome-extension/chrome-mv3',
    ),
    basePort,
    leaseIdleTtlSec: 900,
    profiles: [],
  };
}

export async function ensureFleetDirectories(): Promise<void> {
  await Promise.all(
    ['profiles', 'run', path.join('registry', 'instances'), 'logs'].map((entry) =>
      fs.mkdir(path.join(FLEET_ROOT, entry), { recursive: true }),
    ),
  );
}

export async function loadConfig(): Promise<FleetConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(FLEET_CONFIG_PATH, 'utf8');
  } catch {
    throw new Error('fleet not initialized — run: humanchrome-bridge fleet init');
  }
  const config = JSON.parse(raw) as FleetConfig;
  if (config.version !== 1 || !Array.isArray(config.profiles)) {
    throw new Error('invalid fleet.json');
  }
  for (const profile of config.profiles) validateProfileName(profile.name);
  return config;
}

export async function saveConfig(config: FleetConfig): Promise<void> {
  await ensureFleetDirectories();
  const temporaryPath = `${FLEET_CONFIG_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, FLEET_CONFIG_PATH);
  await fs.chmod(FLEET_CONFIG_PATH, 0o600);
}
