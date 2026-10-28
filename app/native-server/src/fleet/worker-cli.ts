import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Command } from 'commander';
import Database from 'better-sqlite3';
import {
  createDefaultConfig,
  DEFAULT_DAILY_PROFILE_DIR,
  ensureFleetDirectories,
  FLEET_ROOT,
  loadConfig,
  saveConfig,
  validateProfileName,
} from './config';
import { addProfile, initTemplate } from './provision';
import { ProfileSupervisor } from './supervisor';
import {
  assertTailscaleBind,
  loadWorkerConfig,
  saveWorkerConfig,
  type WorkerConfig,
  WorkerServer,
  workerConfigPath,
} from './worker';

const WORKER_LABEL = 'com.humanchrome.fleet-worker';
const rootLockConnections = new WeakMap<FleetRootLock, Database.Database>();

/** Registers under the existing `fleet` command; parent owns that integration. */
export function registerWorkerCommands(fleet: Command): void {
  const worker = fleet.command('worker').description('Run the private coordinator worker');
  worker
    .command('init <id>')
    .description('Initialize a dedicated GUI-session worker root and its first browser')
    .requiredOption('--host <host>', 'Tailscale IP or MagicDNS .ts.net hostname to bind')
    .option('--port <port>', 'Worker HTTP port', '12320')
    .option('--base-port <port>', 'First dedicated browser bridge port', '12900')
    .option('--token <token>', 'Worker bearer token (generated when omitted)')
    .option('--allow-profile <name>', 'Additional coordinator-allowlisted profile', collect, [])
    .option('--seed-source <name=path>', 'Operator-approved seed alias (repeatable)', collect, [])
    .action(async (id: string, options) => {
      requireDedicatedWorkerRoot();
      const port = Number(options.port);
      const basePort = Number(options.basePort);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error('invalid worker port');
      if (
        !Number.isInteger(basePort) ||
        basePort < 1025 ||
        basePort > 65_535 ||
        basePort === port
      ) {
        throw new Error('invalid worker base port');
      }
      try {
        await fs.access(workerConfigPath());
        throw new Error(`worker already initialized at ${FLEET_ROOT}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await fs.access(path.join(FLEET_ROOT, 'fleet.json'));
        throw new Error(`refusing to replace existing fleet root ${FLEET_ROOT}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const profiles = ['browser', ...((options.allowProfile as string[]) ?? [])];
      for (const name of profiles) validateProfileName(name);
      if (new Set(profiles).size !== profiles.length) throw new Error('duplicate allowed profile');
      const seedSources = parseSeedSources((options.seedSource as string[]) ?? []);
      const config: WorkerConfig = {
        id,
        host: String(options.host),
        port,
        token:
          options.token === undefined ? randomBytes(32).toString('hex') : String(options.token),
        profiles,
        seedSources,
      };
      await ensureFleetDirectories();
      // Validates all operator-supplied worker fields before this root acquires
      // a fleet.json or launches Chrome.
      await saveWorkerConfig(config);
      const fleetConfig = createDefaultConfig(12300, basePort);
      await saveConfig(fleetConfig);
      try {
        await initTemplate(fleetConfig);
        await addProfile('browser', [], seedSources.daily ?? null);
      } catch (error) {
        // Keep credentials/config for diagnosis but never pretend browser is
        // provisioned; addProfile itself removes its partial profile on failure.
        throw new Error(`worker initialization did not provision browser: ${reason(error)}`);
      }
      console.log(
        JSON.stringify({
          id: config.id,
          host: config.host,
          port: config.port,
          token: config.token,
        }),
      );
    });

  worker
    .command('serve')
    .description('Run the supervisor and authenticated worker HTTP server')
    .action(async () => {
      requireDedicatedWorkerRoot();
      const [workerConfig, fleetConfig] = await Promise.all([loadWorkerConfig(), loadConfig()]);
      const unexpected = fleetConfig.profiles.find(
        (profile) => !workerConfig.profiles.includes(profile.name),
      );
      if (unexpected) {
        throw new Error(`worker root contains non-allowlisted profile ${unexpected.name}`);
      }
      await assertNoLegacyFleetServe();
      const lock = await acquireFleetRootLock();
      const supervisor = new ProfileSupervisor(fleetConfig);
      const server = new WorkerServer({
        config: workerConfig,
        supervisor,
        bridgeToken: fleetConfig.bridgeToken,
      });
      const pidFile = path.join(FLEET_ROOT, 'run', 'worker.pid');
      try {
        await fs.writeFile(pidFile, String(process.pid));
        await supervisor.start();
        console.log(await server.listen());
      } catch (error) {
        await server.close().catch(() => undefined);
        await supervisor.shutdown().catch(() => undefined);
        await fs.rm(pidFile, { force: true });
        await releaseFleetRootLock(lock);
        throw error;
      }
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
          await server.close();
          await supervisor.shutdown();
        } finally {
          await fs.rm(pidFile, { force: true });
          await releaseFleetRootLock(lock);
          process.exitCode = 0;
        }
      };
      process.once('SIGTERM', () => void shutdown());
      process.once('SIGINT', () => void shutdown());
    });

  worker
    .command('install-agent')
    .description('Install the worker launchd agent in this Mac GUI session')
    .action(async () => {
      requireDedicatedWorkerRoot();
      await loadWorkerConfig();
      await ensureFleetDirectories();
      const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${WORKER_LABEL}.plist`);
      await fs.writeFile(
        plist,
        workerPlist(
          WORKER_LABEL,
          path.resolve(__dirname, '../cli.js'),
          path.join(FLEET_ROOT, 'logs', 'worker.log'),
        ),
        { mode: 0o644 },
      );
      const domain = `gui/${process.getuid?.() ?? 0}`;
      await unloadLaunchAgent(`${domain}/${WORKER_LABEL}`);
      await runLaunchctl(['bootstrap', domain, plist]);
    });

  worker
    .command('uninstall-agent')
    .description('Remove the worker launchd agent')
    .action(async () => {
      requireDedicatedWorkerRoot();
      const domain = `gui/${process.getuid?.() ?? 0}`;
      await unloadLaunchAgent(`${domain}/${WORKER_LABEL}`);
      await fs.rm(path.join(os.homedir(), 'Library/LaunchAgents', `${WORKER_LABEL}.plist`), {
        force: true,
      });
    });
}

function collect(value: string, values: string[]): string[] {
  return [...values, value];
}

function requireDedicatedWorkerRoot(): void {
  const defaultFleetRoot = path.join(os.homedir(), 'Library/Application Support/humanchrome-fleet');
  if (!process.env.HC_FLEET_ROOT || path.resolve(FLEET_ROOT) === defaultFleetRoot) {
    throw new Error('worker requires a dedicated non-default HC_FLEET_ROOT');
  }
}

export interface FleetRootLock {
  readonly path: string;
}

/**
 * Shared process/root exclusion for worker and legacy `fleet serve`. Callers
 * hold the returned lock until their supervisor has stopped.
 */
export async function acquireFleetRootLock(): Promise<FleetRootLock> {
  await ensureFleetDirectories();
  const lock = { path: path.join(FLEET_ROOT, 'run', 'fleet-root-lock.sqlite') };
  const database = new Database(lock.path);
  database.pragma('busy_timeout = 0');
  try {
    database.exec('BEGIN EXCLUSIVE');
  } catch {
    database.close();
    throw new Error(`a fleet process is already running in this root (${FLEET_ROOT})`);
  }
  rootLockConnections.set(lock, database);
  return lock;
}

export async function releaseFleetRootLock(lock: FleetRootLock): Promise<void> {
  const database = rootLockConnections.get(lock);
  if (!database) return;
  rootLockConnections.delete(lock);
  try {
    database.exec('COMMIT');
  } finally {
    database.close();
  }
}

async function assertNoLegacyFleetServe(): Promise<void> {
  const servePid = await livePid(path.join(FLEET_ROOT, 'run', 'serve.pid'));
  if (servePid !== null) {
    throw new Error(`fleet serve is already running in this worker root (pid ${servePid})`);
  }
}

async function livePid(file: string): Promise<number | null> {
  let pid: number;
  try {
    pid = Number(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

function parseSeedSources(entries: string[]): Record<string, string | null> {
  const sources: Record<string, string | null> = {
    daily: DEFAULT_DAILY_PROFILE_DIR,
    empty: null,
  };
  for (const entry of entries) {
    const equals = entry.indexOf('=');
    if (equals <= 0) throw new Error('--seed-source must be name=/absolute/path or name=null');
    const name = entry.slice(0, equals);
    const source = entry.slice(equals + 1);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error(`invalid seed source ${name}`);

    if (source === 'null') {
      sources[name] = null;
      continue;
    }
    if (!path.isAbsolute(source)) throw new Error(`seed source ${name} must be an absolute path`);
    sources[name] = source;
  }
  return sources;
}

function workerPlist(label: string, cliPath: string, logPath: string): string {
  const e = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${e(label)}</string><key>ProgramArguments</key><array><string>${e(process.execPath)}</string><string>${e(cliPath)}</string><string>fleet</string><string>worker</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${e(logPath)}</string><key>StandardErrorPath</key><string>${e(logPath)}</string><key>EnvironmentVariables</key><dict><key>HC_FLEET_ROOT</key><string>${e(FLEET_ROOT)}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict></dict></plist>`;
}

async function unloadLaunchAgent(service: string): Promise<void> {
  let requested = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await runLaunchctl(['print', service]);
    } catch (error) {
      if (error instanceof Error && /Could not find service|No such process/i.test(error.message))
        return;
      throw error;
    }
    if (!requested) {
      await runLaunchctl(['bootout', service]);
      requested = true;
    }
    // bootout acknowledges removal before launchd has finished unloading.
    await delay(200);
  }
  throw new Error(`launchd did not finish unloading ${service}`);
}

async function runLaunchctl(args: string[]): Promise<void> {
  const child = spawn('launchctl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`launchctl ${args[0]} exited ${code}: ${stderr.trim()}`);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
