/**
 * IMP-0115: on-disk registry of running humanchrome-bridge instances.
 *
 * Each bridge process writes one JSON file under
 * `~/Library/Application Support/humanchrome-bridge/instances/<pid>.json`
 * once its HTTP server has bound a port. The matrix runner (and other
 * HTTP clients) read the registry to discover which bridge is serving
 * which Chrome instance — solves the "is this port mine or the user's
 * regular Chrome?" routing problem.
 *
 * Stale entries (dead pid OR mtime > MAX_STALE_MS) are filtered out at
 * read time. Each bridge unlinks its own entry on SIGTERM/SIGINT/exit.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { resolve } from 'node:path';

export interface InstanceRecord {
  pid: number;
  port: number;
  extensionId: string;
  instanceId?: string;
  chromeBinary?: string;
  startedAt: string;
}

const MAX_STALE_MS = 5 * 60 * 1000;

export function registryDir(): string {
  if (process.env.HC_INSTANCE_REGISTRY_DIR) {
    return process.env.HC_INSTANCE_REGISTRY_DIR;
  }
  // Use the same protected dir the bridge itself lives under so anything
  // Chrome touches stays out of TCC-restricted roots (see project memory).
  if (platform() === 'darwin') {
    return resolve(homedir(), 'Library/Application Support/humanchrome-bridge/instances');
  }
  if (platform() === 'win32') {
    return resolve(homedir(), 'AppData/Local/humanchrome-bridge/instances');
  }
  return resolve(homedir(), '.config/humanchrome-bridge/instances');
}

function entryPath(pid: number): string {
  return resolve(registryDir(), `${pid}.json`);
}

/** Atomic write via tmp+rename. */
export function writeInstance(record: InstanceRecord): void {
  const dir = registryDir();
  mkdirSync(dir, { recursive: true });
  const final = entryPath(record.pid);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(tmp, final);
}

/** Remove this process's registry entry. Safe to call multiple times. */
export function removeInstance(pid: number): void {
  try {
    rmSync(entryPath(pid), { force: true });
  } catch {
    /* already gone */
  }
}

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === 'EPERM') return true; // owned by another user — still alive
    return false;
  }
}

/**
 * Read the registry and return every live instance. Drops entries whose
 * pid is dead OR whose file is older than MAX_STALE_MS (orphans). Garbage
 * collection of stale entries is opportunistic: filtered at read, deleted
 * on a best-effort basis so a clean shutdown isn't required for the
 * registry to stay healthy.
 */
export function listInstances(): InstanceRecord[] {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const live: InstanceRecord[] = [];
  const now = Date.now();
  for (const file of files) {
    const path = resolve(dir, file);
    let record: InstanceRecord;
    let mtimeMs: number;
    try {
      record = JSON.parse(readFileSync(path, 'utf8')) as InstanceRecord;
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // Corrupt entry — clean up.
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    const stale = now - mtimeMs > MAX_STALE_MS;
    if (stale || !isPidAlive(record.pid)) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    live.push(record);
  }
  return live;
}
