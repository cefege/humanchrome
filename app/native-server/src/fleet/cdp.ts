import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Writable, Readable } from 'node:stream';

const execFileAsync = promisify(execFile);

const EXTENSION_DIR_FLAG = '--remote-debugging-pipe';

interface CdpMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Chrome's DevTools pipe transport speaks null-delimited JSON over fd 3 (browser
 * reads) and fd 4 (browser writes). Keeping the channel on stdio means no
 * debugging port is bound, so nothing on the LAN can drive the profile.
 *
 * The reader stays attached for the browser's whole lifetime: Chrome keeps
 * writing protocol events to fd 4 and blocks once that pipe fills. The instance
 * is disposed when the profile is stopped or its browser is replaced — never
 * only at shutdown.
 */
export class CdpPipe {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    number,
    { resolve: (message: CdpMessage) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
  ) {
    this.output.on('data', (chunk: Buffer) => this.consume(chunk));
    this.output.on('error', () => this.dispose());
    // The writer has no read side, so an EPIPE can surface here instead of in a
    // `write` callback — and an unhandled 'error' event takes the process down.
    this.input.on('error', () => this.dispose());
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const boundary = this.buffer.indexOf(0);
      if (boundary < 0) return;
      const raw = this.buffer.subarray(0, boundary).toString();
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!raw) continue;
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      entry.resolve(message);
    }
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<CdpMessage> {
    if (this.closed) return Promise.reject(new Error('cdp pipe closed'));
    const id = ++this.nextId;
    return new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.input.write(`${JSON.stringify({ id, method, params })}\0`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** Loads an unpacked extension directory and returns its Chrome extension id. */
  async loadUnpacked(extensionDir: string, timeoutMs = 15_000): Promise<string> {
    const response = await this.send('Extensions.loadUnpacked', { path: extensionDir }, timeoutMs);
    if (response.error) {
      throw new Error(`Extensions.loadUnpacked failed: ${response.error.message ?? 'unknown'}`);
    }
    const id = (response.result as { id?: string } | undefined)?.id;
    if (!id) throw new Error('Extensions.loadUnpacked returned no extension id');
    return id;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    // Settle the in-flight calls first: clearing the map alone left every
    // `send` hanging until its 15s timeout and reporting `cdp timeout` for what
    // is really a closed pipe.
    const error = new Error('cdp pipe closed');
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.input.destroy();
    this.output.destroy();
  }
}

export type ChromeChild = Omit<ChildProcess, 'stdio'> & {
  stdio: [null, null, null, Writable, Readable];
};

export function chromeArgs(userDataDir: string): string[] {
  return [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    EXTENSION_DIR_FLAG,
  ];
}

export function spawnWithCdpPipe(
  chromePath: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
): ChromeChild {
  return spawn(chromePath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: options.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }) as unknown as ChromeChild;
}

/**
 * Chrome is spawned as a process-group leader, so signalling the pid alone
 * leaves the browser and its helpers alive holding the profile's SingletonLock.
 * Signal the group, falling back to the single pid when the group is already
 * gone.
 */
export function killChromeGroup(pid: number, signal: NodeJS.Signals): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* group already gone; try the bare pid below */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already exited */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM the whole Chrome group, poll until it is gone, then SIGKILL what
 * refused. Cookies, logins and history live in the profile directory and
 * survive this; what a kill *can* lose is whatever Chrome has not flushed to
 * disk yet, which is why the grace period comes first.
 */
export async function terminateChrome(pid: number, graceMs = 5_000): Promise<void> {
  if (!pid || pid <= 0) return;
  killChromeGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (pidAlive(pid)) killChromeGroup(pid, 'SIGKILL');
}

const psCommand = async (args: string[]): Promise<string> =>
  (await execFileAsync('ps', args)).stdout;

/**
 * Finds the browsers actually running on a profile directory, by command line.
 *
 * The `startsWith(chromePath)` filter is load-bearing: Chrome's helper processes
 * inherit both `--user-data-dir` and `--remote-debugging-pipe`, but their
 * command begins with the `Contents/Frameworks/.../Helpers/...` path, so only
 * the browser process itself is a group leader worth adopting or killing.
 */
export async function findChromeForProfile(
  chromePath: string,
  userDataDir: string,
  run: (args: string[]) => Promise<string> = psCommand,
): Promise<number[]> {
  const stdout = await run(['-Ao', 'pid=,command=']).catch(() => '');
  const marker = `--user-data-dir=${userDataDir}`;
  const pids: number[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[2];
    if (command.startsWith(chromePath) && command.includes(marker)) pids.push(Number(match[1]));
  }
  return pids.sort((a, b) => a - b);
}

/**
 * `Extensions.loadUnpacked` is not persisted to the profile's Secure
 * Preferences, so the supervisor re-applies it on every launch. Chrome >= 137
 * ignores `--load-extension`, which is why provisioning goes through CDP.
 */
export async function readExtensionManifest(extensionDir: string): Promise<{ key?: string }> {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `extension build missing at ${extensionDir} — run: pnpm build:extension (or update extensionDir in fleet.json)`,
    );
  }
  return JSON.parse(raw) as { key?: string };
}
