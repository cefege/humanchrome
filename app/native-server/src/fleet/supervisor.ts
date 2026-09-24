import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { FleetConfig, FLEET_ROOT } from './config';

const execFileAsync = promisify(execFile);
export type ProfileState = 'stopped' | 'starting' | 'running' | 'healthy' | 'backoff';

export interface ProfileSnapshot {
  name: string;
  port: number;
  labels: string[];
  enabled: boolean;
  state: ProfileState;
  pid: number | null;
  leasedBy: string | null;
}

interface ProfileRuntime {
  config: FleetConfig['profiles'][number];
  state: ProfileState;
  pid: number | null;
  backoffMs: number;
  healthySince: number | null;
}

export class ProfileSupervisor {
  private readonly profiles = new Map<string, ProfileRuntime>();
  private monitorTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private config: FleetConfig) {
    this.replaceProfiles(config);
  }

  async start(): Promise<void> {
    this.stopping = false;
    for (const profile of this.config.profiles) {
      if (!profile.enabled) continue;
      await this.adoptOrLaunch(profile);
    }
    this.monitorTimer = setInterval(() => void this.monitor(), 5_000);
    this.healthTimer = setInterval(() => void this.checkHealth(), 10_000);
  }

  async reload(next: FleetConfig): Promise<void> {
    this.config = next;
    const nextNames = new Set(next.profiles.map((profile) => profile.name));
    for (const runtime of [...this.profiles.values()]) {
      const updated = next.profiles.find((profile) => profile.name === runtime.config.name);
      if (!updated || !updated.enabled) await this.stopProfile(runtime.config.name);
    }
    for (const profile of next.profiles) {
      if (profile.enabled && !this.profiles.has(profile.name)) {
        this.profiles.set(profile.name, {
          config: profile,
          state: 'stopped',
          pid: null,
          backoffMs: 5_000,
          healthySince: null,
        });
        await this.adoptOrLaunch(profile);
      } else if (profile.enabled) this.profiles.get(profile.name)!.config = profile;
    }
    for (const name of [...this.profiles.keys()])
      if (!nextNames.has(name)) this.profiles.delete(name);
  }

  snapshot(leasedBy: (profile: string) => string | null = () => null): ProfileSnapshot[] {
    return [...this.profiles.values()]
      .map((runtime) => ({
        name: runtime.config.name,
        port: runtime.config.port,
        labels: runtime.config.labels,
        enabled: runtime.config.enabled,
        state: runtime.state,
        pid: runtime.pid,
        leasedBy: leasedBy(runtime.config.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  state(name: string): ProfileState | undefined {
    return this.profiles.get(name)?.state;
  }

  async startProfile(name: string): Promise<void> {
    const runtime = this.profiles.get(name);
    if (!runtime) throw new Error(`unknown profile: ${name}`);
    await this.adoptOrLaunch(runtime.config);
  }
  async stopProfile(name: string): Promise<void> {
    const runtime = this.profiles.get(name);
    if (!runtime) throw new Error(`unknown profile: ${name}`);
    if (!runtime.pid) {
      try {
        runtime.pid = Number(
          await fs.readFile(path.join(FLEET_ROOT, 'run', `${name}.pid`), 'utf8'),
        );
      } catch {
        runtime.state = 'stopped';
        return;
      }
    }
    if (!runtime.pid) {
      runtime.state = 'stopped';
      return;
    }
    const pid = runtime.pid;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && this.pidAlive(pid)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (this.pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    await fs.rm(path.join(FLEET_ROOT, 'run', `${name}.pid`), { force: true });
    runtime.pid = null;
    runtime.state = 'stopped';
  }

  async restartProfile(name: string): Promise<void> {
    await this.stopProfile(name);
    await this.startProfile(name);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.monitorTimer = null;
    this.healthTimer = null;
  }

  private replaceProfiles(config: FleetConfig): void {
    this.profiles.clear();
    for (const profile of config.profiles) {
      this.profiles.set(profile.name, {
        config: profile,
        state: 'stopped',
        pid: null,
        backoffMs: 5_000,
        healthySince: null,
      });
    }
  }

  private async adoptOrLaunch(profile: FleetConfig['profiles'][number]): Promise<void> {
    const runtime = this.profiles.get(profile.name)!;
    const dir = this.profileDir(profile.name);
    const pidPath = path.join(FLEET_ROOT, 'run', `${profile.name}.pid`);
    try {
      const pid = Number(await fs.readFile(pidPath, 'utf8'));
      if (this.pidAlive(pid) && (await this.commandLine(pid)).includes(`--user-data-dir=${dir}`)) {
        runtime.pid = pid;
        runtime.state = 'running';
        return;
      }
    } catch {
      /* no adoptable pid */
    }
    await this.launch(profile);
  }

  private async launch(profile: FleetConfig['profiles'][number]): Promise<void> {
    const runtime = this.profiles.get(profile.name)!;
    runtime.state = 'starting';
    const dir = this.profileDir(profile.name);
    await fs.mkdir(dir, { recursive: true });
    const child = spawn(
      this.config.chromePath,
      [
        `--user-data-dir=${dir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          HC_BRIDGE_PORT: String(profile.port),
          HC_INSTANCE_REGISTRY_DIR: path.join(FLEET_ROOT, 'registry', 'instances'),
          HC_BRIDGE_DAEMON_SOCKET: path.join(FLEET_ROOT, 'run', `${profile.name}.sock`),
          HUMANCHROME_TOKEN: this.config.bridgeToken,
          HC_FLEET_PROFILE: profile.name,
        },
      },
    );
    child.unref();
    runtime.pid = child.pid ?? null;
    runtime.state = 'running';
    if (runtime.pid)
      await fs.writeFile(path.join(FLEET_ROOT, 'run', `${profile.name}.pid`), String(runtime.pid));
  }

  private async monitor(): Promise<void> {
    if (this.stopping) return;
    for (const runtime of this.profiles.values()) {
      if (!runtime.config.enabled || !runtime.pid) continue;
      if (this.pidAlive(runtime.pid)) continue;
      runtime.state = 'backoff';
      runtime.pid = null;
      await fs.rm(path.join(FLEET_ROOT, 'run', `${runtime.config.name}.pid`), { force: true });
      if (runtime.backoffMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, runtime.backoffMs));
      }
      if (!this.stopping && runtime.config.enabled) await this.launch(runtime.config);
      runtime.backoffMs = Math.min(runtime.backoffMs * 2, 60_000);
    }
  }

  private async checkHealth(): Promise<void> {
    for (const runtime of this.profiles.values()) {
      if (!runtime.pid) continue;
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.config.port}/ping`, {
          signal: AbortSignal.timeout(2_000),
        });
        const body = (await response.json()) as { status?: string };
        if (body.status === 'ok') {
          runtime.state = 'healthy';
          runtime.healthySince ??= Date.now();
          if (Date.now() - runtime.healthySince > 10 * 60_000) runtime.backoffMs = 5_000;
        } else runtime.state = 'running';
      } catch {
        runtime.state = 'running';
      }
    }
  }

  private profileDir(name: string): string {
    return path.join(FLEET_ROOT, 'profiles', name);
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async commandLine(pid: number): Promise<string> {
    try {
      return (await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)])).stdout;
    } catch {
      return '';
    }
  }
}
