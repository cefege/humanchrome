import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FleetProfileConfig {
  name: string;
  port: number;
  labels: string[];
  enabled: boolean;
  /** Single-valued purpose tag; at most one browser fleet-wide serves it. */
  purpose?: string;
  /** Absolute source user-data-dir this profile was seeded from, if any. */
  seededFrom?: string;
  seededAt?: string;
}

/** A peer machine running its own `fleet serve`, reachable over the LAN/Tailscale. */
export interface FleetNodeConfig {
  id: string;
  host: string;
  port: number;
  token: string;
}
export interface FleetConfig {
  version: 1;
  gateway: { host: string; port: number };
  /** Gateway bearer for LAN clients. `null` means the fleet is open (no auth). */
  token: string | null;
  bridgeToken: string;
  chromePath: string;
  extensionDir: string;
  basePort: number;
  leaseIdleTtlSec: number;
  /** When true, every profile stays stopped regardless of its `enabled` flag. */
  parked: boolean;
  profiles: FleetProfileConfig[];
  /**
   * Identifies this machine in lease keys; must not collide with a configured
   * node id. Leases themselves are keyed by profile alone — `nodeId` is not a
   * lease key.
   */
  nodeId: string;
  nodes: FleetNodeConfig[];
  /** This machine's main Chrome user-data-dir, the default `--seed daily` source. */
  dailyProfileDir?: string;
}

/**
 * One name shape for profiles, purposes and node ids. `:` is excluded so a
 * purpose can never impersonate the `nodeId:profile` route key, and `_` is
 * rejected for profiles because `_template` is fleet-reserved.
 */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PURPOSE_NAME_RE = NAME_RE;

export const FLEET_ROOT =
  process.env.HC_FLEET_ROOT ??
  path.join(os.homedir(), 'Library/Application Support/humanchrome-fleet');
export const FLEET_CONFIG_PATH = path.join(FLEET_ROOT, 'fleet.json');
export const PROFILE_NAME_RE = NAME_RE;

/** `loadConfig` raises this typed error instead of a message string callers sniff. */
export class FleetNotInitializedError extends Error {}

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name) || name.startsWith('_')) {
    throw new Error(`invalid fleet profile name: ${name}`);
  }
}

export function validatePurposeName(name: string): void {
  if (!PURPOSE_NAME_RE.test(name)) {
    throw new Error(`invalid purpose name: ${name}`);
  }
}

/**
 * Where the gateway can be reached *from this machine*. A wildcard bind
 * (`0.0.0.0`) is not connectable, so it resolves to loopback; a concrete bind —
 * a Tailscale address, say — is used as-is, otherwise every CLI command that
 * asks the gateway a question would get ECONNREFUSED.
 */
export function gatewayUrl(config: FleetConfig): string {
  const host =
    !config.gateway.host || config.gateway.host === '0.0.0.0' ? '127.0.0.1' : config.gateway.host;
  return `http://${host}:${config.gateway.port}`;
}

export const DEFAULT_DAILY_PROFILE_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
);

export function createDefaultConfig(gatewayPort = 12300, basePort = 12500): FleetConfig {
  return {
    version: 1,
    gateway: { host: '0.0.0.0', port: gatewayPort },
    // Client auth is off until the operator turns it on; see `fleet init --token`.
    token: null,
    bridgeToken: randomBytes(32).toString('hex'),
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    extensionDir: path.join(
      os.homedir(),
      'Library/Application Support/humanchrome-extension/chrome-mv3',
    ),
    basePort,
    leaseIdleTtlSec: 900,
    parked: false,
    profiles: [],
    nodeId: os.hostname(),
    nodes: [],
    dailyProfileDir: DEFAULT_DAILY_PROFILE_DIR,
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
    throw new FleetNotInitializedError(
      'fleet not initialized — run: humanchrome-bridge fleet init',
    );
  }
  const config = JSON.parse(raw) as FleetConfig;
  if (config.version !== 1 || !Array.isArray(config.profiles)) {
    throw new Error('invalid fleet.json');
  }
  for (const profile of config.profiles) validateProfileName(profile.name);
  const purposeOwners = new Map<string, string>();
  for (const profile of config.profiles) {
    if (!profile.purpose) continue;
    validatePurposeName(profile.purpose);
    const owner = purposeOwners.get(profile.purpose);
    if (owner) {
      throw new Error(`purpose "${profile.purpose}" is bound to both ${owner} and ${profile.name}`);
    }
    purposeOwners.set(profile.purpose, profile.name);
  }
  config.parked ??= false;
  config.nodeId ??= os.hostname();
  config.nodes ??= [];
  config.token ??= null;
  // Backfilled rather than required: a fleet.json written before this field
  // existed otherwise makes every liveness check compare against NaN, so
  // leases die instantly and live profiles are handed out from under agents.
  config.leaseIdleTtlSec ??= 900;
  config.dailyProfileDir ??= DEFAULT_DAILY_PROFILE_DIR;
  for (const node of config.nodes) {
    if (node.id === config.nodeId) {
      throw new Error(`node id ${node.id} collides with this machine's nodeId`);
    }
  }
  // The runtime dereferences these; a trimmed file would otherwise reach
  // `validBearer`, where Buffer.from(undefined) throws inside the gateway's
  // onRequest hook and every request 500s.
  const required: Array<[string, unknown]> = [
    ['gateway.host', config.gateway?.host],
    ['gateway.port', config.gateway?.port],
    ['bridgeToken', config.bridgeToken],
    ['chromePath', config.chromePath],
    ['extensionDir', config.extensionDir],
    ['basePort', config.basePort],
  ];
  for (const [field, value] of required) {
    if (value === undefined || value === null || value === '') {
      throw new Error(`invalid fleet.json: ${field} is missing`);
    }
  }
  return config;
}

/**
 * Each write is atomic (tmp file + rename + 0600), but the read-modify-write a
 * CLI command wraps around it is not: two CLI processes racing on the same file
 * silently lose one another's change. Fixing that needs an mtime handshake
 * across every mutating command and is deliberately out of scope here.
 */
export async function saveConfig(config: FleetConfig): Promise<void> {
  await ensureFleetDirectories();
  const temporaryPath = `${FLEET_CONFIG_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, FLEET_CONFIG_PATH);
  await fs.chmod(FLEET_CONFIG_PATH, 0o600);
}
