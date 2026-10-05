import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { FleetConfig, FLEET_ROOT } from './config';
import { LaunchedProfile, launchProfileWithExtension } from './launch';
import { captureSession, SESSION_FILE } from './session';
import { applyWindowLabel, closeOnboardingTabs, findLabelTarget, labelFor } from './window-label';

import { findChromeForProfile, terminateChrome } from './cdp';

const execFileAsync = promisify(execFile);

/** Every fleet timer and backoff bound, in one place. */
const TIMERS = {
  monitorMs: 5_000,
  healthMs: 10_000,
  sessionMs: 60_000,
  focusRetryMs: 4_000,
  pingTimeoutMs: 2_000,
  /** Grace period before SIGKILL; also the default in `terminateChrome`. */
  killGraceMs: 5_000,
  backoffMaxMs: 60_000,
  /** Uptime after which a browser is treated as stable and backoff resets. */
  stableUptimeMs: 10 * 60_000,
  /**
   * Health ticks without a bridge before the browser is replaced. Six is a
   * minute: a healthy browser answers within two seconds of its extension
   * connecting, and a replacement costs a cold Chrome start plus the login
   * replay, so a transient hiccup must never pay for one.
   */
  pingFailuresBeforeReplace: 6,
} as const;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Same `/ping` endpoint the health timer uses: an orphan whose bridge answers is
 * a healthy browser that only lost its supervisor, not one to be replaced.
 */
async function probeBridge(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ping`, {
      signal: AbortSignal.timeout(TIMERS.pingTimeoutMs),
    });
    return ((await response.json()) as { status?: string }).status === 'ok';
  } catch {
    return false;
  }
}

export type ProfileState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'healthy'
  | 'backoff'
  /** Only produced for profiles on a configured peer node that did not answer. */
  | 'unreachable';

export interface ProfileSnapshot {
  name: string;
  port: number;
  labels: string[];
  enabled: boolean;
  purpose: string | null;
  state: ProfileState;
  pid: number | null;
  leasedBy: string | null;
  /** Last launch failure, cleared when the profile is up again. */
  lastError: string | null;
}

export type ProfileLauncher = (
  config: FleetConfig,
  name: string,
  userDataDir: string,
  port: number,
) => Promise<LaunchedProfile>;

/**
 * Legal combinations (enforced by the transitions below, asserted by the tests):
 *   * `launched !== null` implies `pid !== null` — a pipe without a browser is
 *     not addressable, and `pid === null` implies `healthySince === null`.
 *   * `label !== null` implies `launched !== null` — labelling needs a pipe.
 *   * `pid === null` implies `healthySince === null`: uptime is measured from a
 *     browser that exists, and leaving the old stamp behind made every later
 *     tick look "stable" and reset the crash backoff.
 */
interface ProfileRuntime {
  config: FleetConfig['profiles'][number];
  state: ProfileState;
  pid: number | null;
  backoffMs: number;
  healthySince: number | null;
  launched: LaunchedProfile | null;
  /** Last label written to the browser's label tab, or null while unlabelled. */
  label: string | null;
  /** Whether the label tab has been put in front for this browser run. */
  labelFocused: boolean;
  /** Consecutive health ticks on which this profile's bridge did not answer. */
  pingFailures: number;
  /** Last launch failure message, so a persistent fault is reported once. */
  lastError: string | null;
}

export class ProfileSupervisor {
  private readonly profiles = new Map<string, ProfileRuntime>();
  private monitorTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private readonly focusTimers = new Map<string, NodeJS.Timeout>();
  /** Names with a launch in flight, so one profile never races two Chromes. */
  private readonly launching = new Set<string>();
  private stopping = false;

  constructor(
    private config: FleetConfig,
    private readonly launcher: ProfileLauncher = launchProfileWithExtension,
    private readonly bridgeProbe: (port: number) => Promise<boolean> = probeBridge,
  ) {
    this.replaceProfiles(config);
  }

  async start(): Promise<void> {
    this.stopping = false;
    // A supervisor that was stopped on purpose leaves a marker and terminates
    // its browsers. launchd restarts us within a second, while those browsers
    // are still dying — and adopting one would leave this supervisor without a
    // DevTools pipe, which silently costs it labelling and session capture.
    await this.clearOwnShutdown();
    if (this.config.parked) {
      for (const runtime of this.profiles.values()) runtime.state = 'stopped';
      this.startTimers();
      return;
    }
    for (const profile of this.config.profiles) {
      if (!profile.enabled) continue;
      await this.adoptOrLaunch(profile);
    }
    this.startTimers();
  }

  /**
   * Idempotent, because a `serve` that booted while parked has no timers and an
   * unpark arrives later as a reload — a fleet that came up parked must still
   * capture sessions once its browsers are running.
   */
  private startTimers(): void {
    this.monitorTimer ??= setInterval(() => void this.monitor(), TIMERS.monitorMs);
    this.healthTimer ??= setInterval(() => void this.checkHealth(), TIMERS.healthMs);
    this.sessionTimer ??= setInterval(() => void this.captureSessions(), TIMERS.sessionMs);
    this.monitorTimer.unref?.();
    this.healthTimer.unref?.();
    this.sessionTimer.unref?.();
  }

  async reload(next: FleetConfig): Promise<void> {
    this.config = next;
    if (!next.parked) this.startTimers();
    if (next.parked) {
      for (const name of [...this.profiles.keys()]) await this.stopProfile(name);
      return;
    }
    const nextNames = new Set(next.profiles.map((profile) => profile.name));
    for (const runtime of [...this.profiles.values()]) {
      const updated = next.profiles.find((profile) => profile.name === runtime.config.name);
      // One failing stop must not leave the remaining profiles unsupervised.
      if (!updated || !updated.enabled) {
        try {
          await this.stopProfile(runtime.config.name);
        } catch (error) {
          console.error(
            `fleet: could not stop ${runtime.config.name}: ${(error as Error).message}`,
          );
        }
      }
    }
    for (const profile of next.profiles) {
      const runtime = this.profiles.get(profile.name);
      if (!runtime) {
        this.profiles.set(profile.name, {
          label: null,
          labelFocused: false,
          config: profile,
          state: 'stopped',
          pid: null,
          backoffMs: TIMERS.monitorMs,
          healthySince: null,
          launched: null,
          pingFailures: 0,
          lastError: null,
        });
        // A profile added while disabled must stay stopped.
        if (!profile.enabled) continue;
        await this.adoptOrLaunch(profile);
        continue;
      }
      // Assigned before the `enabled` check below: a disabled profile's runtime
      // must still report its current config, or `snapshot()` serves the port and
      // enabled flag of a browser that is no longer meant to run.
      runtime.config = profile;
      runtime.backoffMs = TIMERS.monitorMs;
      if (!profile.enabled) continue;
      if (!runtime.pid) await this.adoptOrLaunch(profile);
      await this.refreshLabel(profile.name);
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
        purpose: runtime.config.purpose ?? null,
        enabled: runtime.config.enabled,
        state: runtime.state,
        pid: runtime.pid,
        leasedBy: leasedBy(runtime.config.name),
        lastError: runtime.lastError,
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
    const pidPath = path.join(FLEET_ROOT, 'run', `${name}.pid`);
    if (!runtime.pid) {
      let recorded = 0;
      try {
        recorded = Number(await fs.readFile(pidPath, 'utf8'));
      } catch {
        recorded = 0;
      }
      // `Number('abc')` is NaN, which is falsy and used to read as "stopped"
      // while leaving the bad file for `adoptOrLaunch` to re-read every 5s.
      if (!Number.isInteger(recorded) || recorded <= 0) {
        await fs.rm(pidPath, { force: true });
        runtime.state = 'stopped';
        return;
      }
      runtime.pid = recorded;
    }
    const pid = runtime.pid;
    await this.captureOne(name, runtime);
    await terminateChrome(pid, TIMERS.killGraceMs);
    // A pid file that refuses to go must not abort the teardown: the pipe, the
    // focus timer and the state all still need clearing.
    try {
      await fs.rm(pidPath, { force: true });
    } catch (error) {
      console.error(`fleet: could not remove ${pidPath}: ${(error as Error).message}`);
    }
    runtime.labelFocused = false;
    runtime.label = null;
    this.clearFocusRetry(name);
    this.launching.delete(name);
    runtime.launched?.cdp.dispose();
    runtime.launched = null;
    runtime.pid = null;
    runtime.healthySince = null;
    runtime.state = 'stopped';
  }

  async restartProfile(name: string): Promise<void> {
    await this.stopProfile(name);
    await this.startProfile(name);
  }

  /**
   * Freezing first, then a final session snapshot, then a graceful browser
   * exit. A browser this supervisor launched holds its DevTools pipe, so it
   * dies the moment this process exits — abruptly, without flushing. The
   * snapshot is the only thing standing between a restart and a fleet that
   * has to be logged into again.
   *
   * An adopted browser has no pipe here and is left running: it belongs to
   * whoever launched it, and stopping it would kill a healthy browser nothing
   * asked us to touch.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    // Written before any browser is signalled: it is what tells the next
    // supervisor these browsers are ours and already on their way out.
    await fs
      .writeFile(path.join(FLEET_ROOT, 'run', 'supervisor-restart.marker'), '')
      .catch(() => undefined);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.monitorTimer = null;
    this.healthTimer = null;
    for (const name of [...this.focusTimers.keys()]) this.clearFocusRetry(name);
    if (this.config.parked) return;
    await Promise.all(
      [...this.profiles].map(async ([name, runtime]) => {
        if (!runtime.launched) return;
        // The 60s capture timer may not have fired since the last cookie was
        // written, and this file is the only copy of the session-cookie logins.
        await this.captureOne(name, runtime, true);
        await terminateChrome(runtime.pid ?? 0, TIMERS.killGraceMs);
        runtime.launched.cdp.dispose();
        runtime.launched = null;
        runtime.pid = null;
        runtime.healthySince = null;
      }),
    );
  }

  /**
   * Finishes a deliberate shutdown: waits out any browser the previous
   * supervisor was already killing and forgets its pid file, so the normal
   * start path launches a clean browser instead of adopting a corpse.
   *
   * A supervisor that crashed leaves no marker, and its browsers are adopted as
   * before — which is the case this whole mechanism must not break.
   */
  private async clearOwnShutdown(): Promise<boolean> {
    const marker = path.join(FLEET_ROOT, 'run', 'supervisor-restart.marker');
    try {
      await fs.access(marker);
    } catch {
      return false;
    }
    await fs.rm(marker, { force: true });
    for (const profile of this.config.profiles) {
      if (!profile.enabled) continue;
      const pids = await findChromeForProfile(
        this.config.chromePath,
        this.profileDir(profile.name),
      );
      for (const pid of pids) {
        await terminateChrome(pid, TIMERS.killGraceMs);
        console.log(
          `fleet: replaced browser for ${profile.name} (pid ${pid}) from a prior shutdown`,
        );
      }
      await fs.rm(path.join(FLEET_ROOT, 'run', `${profile.name}.pid`), { force: true });
    }
    return true;
  }

  private replaceProfiles(config: FleetConfig): void {
    this.profiles.clear();
    for (const profile of config.profiles) {
      this.profiles.set(profile.name, {
        config: profile,
        state: 'stopped',
        pid: null,
        backoffMs: TIMERS.monitorMs,
        healthySince: null,
        launched: null,
        label: null,
        labelFocused: false,
        lastError: null,
        pingFailures: 0,
      });
    }
  }

  /**
   * A crash or a `kill -9` gives stopProfile no chance to run, so the session is
   * also snapshotted on a timer. Each profile is captured concurrently, so one
   * dead pipe cannot delay the others.
   */
  private async captureSessions(): Promise<void> {
    if (this.config.parked) return;
    await Promise.all([...this.profiles].map(([name, runtime]) => this.captureOne(name, runtime)));
  }

  private async captureOne(name: string, runtime: ProfileRuntime, force = false): Promise<void> {
    if (!runtime.launched || (this.stopping && !force)) return;
    try {
      await captureSession(
        runtime.launched.cdp,
        path.join(this.profileDir(name), SESSION_FILE),
        name,
      );
    } catch (error) {
      // A dying browser closes the pipe first; the next tick retries. The forced
      // shutdown capture has no next tick, so its failures are always reported.
      if (!this.stopping || force) {
        console.error(`fleet: session capture failed for ${name}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Keeps the browser's label tab in step with its purpose. Only a browser this
   * supervisor launched has a DevTools pipe to write through; an adopted one
   * was labelled by whoever created it.
   */
  private async refreshLabel(name: string): Promise<void> {
    const runtime = this.profiles.get(name);
    if (!runtime) return;
    const label = labelFor(runtime.config);
    if (runtime.label === label) return;
    if (!runtime.launched) {
      // An adopted browser has no DevTools pipe to write a label through, so
      // there is nothing to mark as done; whoever created it owns its tab.
      runtime.label = null;
      return;
    }
    try {
      await applyWindowLabel(runtime.launched.cdp, this.profileDir(name), label);
      runtime.label = label;
    } catch (error) {
      // A browser that cannot show its label is still perfectly usable.
      console.error(`fleet: could not label ${name}: ${(error as Error).message}`);
    }
  }

  private scheduleFocusRetry(name: string): void {
    this.clearFocusRetry(name);
    const timer = setTimeout(() => {
      this.focusTimers.delete(name);
      void this.focusLabel(name);
    }, TIMERS.focusRetryMs);
    timer.unref?.();
    this.focusTimers.set(name, timer);
  }

  private clearFocusRetry(name: string): void {
    const timer = this.focusTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.focusTimers.delete(name);
    }
  }

  /** Puts the label tab back in front so the window title reads the tag. */
  private async focusLabel(name: string): Promise<void> {
    const runtime = this.profiles.get(name);
    if (!runtime?.launched) return;
    try {
      const label = await findLabelTarget(runtime.launched.cdp);
      if (label) {
        await runtime.launched.cdp.send('Target.activateTarget', { targetId: label.targetId });
      }
      // The extension opens its welcome page and focuses it, which outranks the
      // label; a driven profile has no use for that onboarding tab.
      await closeOnboardingTabs(runtime.launched.cdp);
    } catch (error) {
      if (!this.stopping) {
        console.error(`fleet: could not focus label for ${name}: ${(error as Error).message}`);
      }
    }
  }

  private async adoptOrLaunch(profile: FleetConfig['profiles'][number]): Promise<void> {
    // A concurrent `reload` can delete the runtime between the caller's lookup
    // and this call.
    const runtime = this.profiles.get(profile.name);
    if (!runtime) return;
    // Already supervising a live browser: `startProfile` on a healthy profile
    // used to rewrite its state to `running`, which the gateway reads as
    // unavailable for the next health tick.
    if (runtime.pid && pidAlive(runtime.pid)) return;
    const dir = this.profileDir(profile.name);
    const pidPath = path.join(FLEET_ROOT, 'run', `${profile.name}.pid`);
    try {
      const pid = Number(await fs.readFile(pidPath, 'utf8'));
      // A browser the pid file names is not thereby serving: the extension can
      // fail to connect while Chrome itself stays up, and adopting that corpse
      // strands the profile until someone kills it by hand. Only an answering
      // `/ping` counts as an adoptable browser.
      if (
        Number.isInteger(pid) &&
        pid > 0 &&
        pidAlive(pid) &&
        (await this.commandLine(pid)).includes(`--user-data-dir=${dir}`) &&
        (await this.bridgeProbe(profile.port))
      ) {
        runtime.pid = pid;
        runtime.state = 'running';
        return;
      }
    } catch {
      /* no adoptable pid */
    }
    if (await this.adoptExisting(profile.name)) return;
    await this.launch(profile);
  }

  /**
   * Re-associates a browser with its profile when the pid file is gone or stale.
   * A healthy orphan is adopted, because launching a second Chrome on the same
   * directory is what starts the relaunch loop; an alive-but-unserving browser
   * holds the profile's SingletonLock, so it is killed and the caller launches
   * a clean one.
   */
  private async adoptExisting(name: string): Promise<boolean> {
    const runtime = this.profiles.get(name);
    if (!runtime) return false;
    const pids = await findChromeForProfile(this.config.chromePath, this.profileDir(name));
    if (pids.length === 0) return false;
    const [keep, ...duplicates] = pids;
    for (const pid of duplicates) {
      await terminateChrome(pid);
      console.log(`fleet: stopped duplicate browser for ${name} (pid ${pid})`);
    }
    if (await this.bridgeProbe(runtime.config.port)) {
      runtime.pid = keep;
      runtime.state = 'running';
      runtime.lastError = null;
      await fs.mkdir(path.join(FLEET_ROOT, 'run'), { recursive: true });
      await fs.writeFile(path.join(FLEET_ROOT, 'run', `${name}.pid`), String(keep));
      console.log(`fleet: adopted running browser for ${name} (pid ${keep})`);
      return true;
    }
    await terminateChrome(keep);
    return false;
  }

  private async launch(profile: FleetConfig['profiles'][number]): Promise<void> {
    const runtime = this.profiles.get(profile.name);
    if (!runtime) return;
    // One launch per profile at a time: two Chromes on one --user-data-dir
    // fight over the SingletonLock and kill each other.
    if (this.launching.has(profile.name)) return;
    this.launching.add(profile.name);
    try {
      await this.launchOnce(profile, runtime);
    } finally {
      this.launching.delete(profile.name);
    }
  }

  private async launchOnce(
    profile: FleetConfig['profiles'][number],
    runtime: ProfileRuntime,
  ): Promise<void> {
    runtime.state = 'starting';
    const dir = this.profileDir(profile.name);
    await fs.mkdir(dir, { recursive: true });
    let launched: LaunchedProfile | null = null;
    try {
      launched = await this.launcher(this.config, profile.name, dir, profile.port);
      runtime.launched = launched;
      runtime.pid = launched.child.pid ?? null;
      runtime.state = 'running';
      // The label belongs to the browser run, not the profile: a crash-relaunched
      // Chrome has no label tab and nothing has put it in front yet.
      runtime.label = null;
      runtime.labelFocused = false;
      await this.refreshLabel(profile.name);
      if (runtime.lastError) {
        console.log(`fleet: profile ${profile.name} is up again`);
        runtime.lastError = null;
      }
    } catch (error) {
      if (launched) {
        launched.cdp.dispose();
        await terminateChrome(launched.child.pid ?? 0, 0);
      }
      runtime.launched = null;
      runtime.pid = null;
      runtime.state = 'backoff';
      const message = (error as Error).message;
      if (runtime.lastError !== message) {
        runtime.lastError = message;
        console.error(`fleet: profile ${profile.name} failed to launch: ${message}`);
      }
    }
    // Outside the try: a pid-file write that throws must not take the browser
    // down with it. The file is a convenience for adoption, not a lock.
    if (runtime.pid) {
      try {
        await fs.writeFile(
          path.join(FLEET_ROOT, 'run', `${profile.name}.pid`),
          String(runtime.pid),
        );
      } catch (error) {
        console.error(
          `fleet: could not record pid for ${profile.name}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * One pass over every profile. The decision per profile is synchronous and
   * the slow parts run concurrently: serialising them made one tick take
   * backoff × profiles — six dead profiles at max backoff is six minutes.
   */
  private async monitor(): Promise<void> {
    if (this.stopping || this.config.parked) return;
    const work: Promise<void>[] = [];
    for (const runtime of this.profiles.values()) {
      if (!runtime.config.enabled) continue;
      // A launch in flight has no pid yet; acting on it would race a second
      // Chrome onto the same profile directory and kill the first one.
      if (runtime.state === 'starting') continue;
      if (this.launching.has(runtime.config.name)) continue;
      if (runtime.pid && pidAlive(runtime.pid)) continue;
      work.push(this.revive(runtime));
    }
    await Promise.all(work);
  }

  private async revive(runtime: ProfileRuntime): Promise<void> {
    const name = runtime.config.name;
    runtime.state = 'backoff';
    runtime.pid = null;
    runtime.healthySince = null;
    // The browser is gone; its pipe is a dead file descriptor. Leaving it set
    // made every later capture and label call write into a closed pipe.
    runtime.launched?.cdp.dispose();
    runtime.launched = null;
    runtime.lastError ??= 'browser exited; relaunching';
    try {
      await fs.rm(path.join(FLEET_ROOT, 'run', `${name}.pid`), { force: true });
    } catch (error) {
      console.error(`fleet: could not remove stale pid for ${name}: ${(error as Error).message}`);
    }
    if (await this.adoptExisting(name)) {
      runtime.backoffMs = TIMERS.monitorMs;
      return;
    }
    if (runtime.backoffMs > 0) {
      await new Promise<void>((done) => setTimeout(done, runtime.backoffMs));
    }
    if (!this.stopping && runtime.config.enabled && !this.config.parked) {
      await this.launch(runtime.config);
    }
    runtime.backoffMs = Math.min(runtime.backoffMs * 2, TIMERS.backoffMaxMs);
  }

  private async checkHealth(): Promise<void> {
    for (const runtime of this.profiles.values()) {
      // `stopped` guards the teardown race: a `/ping` that lands during
      // stopProfile's kill loop would otherwise re-arm the focus retry after
      // stopProfile cleared it, and the timer would write to a disposed pipe.
      if (!runtime.pid || runtime.state === 'stopped') continue;
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.config.port}/ping`, {
          signal: AbortSignal.timeout(TIMERS.pingTimeoutMs),
        });
        const body = (await response.json()) as { status?: string };
        if (body.status === 'ok') {
          const wasHealthy = runtime.state === 'healthy';
          runtime.state = 'healthy';
          runtime.pingFailures = 0;
          // Only on the not-healthy → healthy edge: with `??=` the stamp from
          // before a crash survived, so the very first tick after a relaunch
          // looked "stable" and reset the crash backoff.
          if (!wasHealthy) runtime.healthySince = Date.now();
          if (Date.now() - (runtime.healthySince ?? 0) > TIMERS.stableUptimeMs) {
            runtime.backoffMs = TIMERS.monitorMs;
          }
          // The label tab is claimed here rather than at launch: the extension
          // opens its welcome page once the bridge is already answering and
          // takes focus, so an earlier claim is simply handed back.
          if (!wasHealthy && !runtime.labelFocused) {
            runtime.labelFocused = true;
            await this.focusLabel(runtime.config.name);
            this.scheduleFocusRetry(runtime.config.name);
          }
        } else {
          runtime.state = 'running';
          runtime.pingFailures += 1;
          await this.replaceIfUnreachable(runtime);
        }
      } catch {
        runtime.state = 'running';
        runtime.pingFailures += 1;
        await this.replaceIfUnreachable(runtime);
      }
    }
  }

  /**
   * The health loop's only repair action. A browser whose bridge has been silent
   * for a full minute is not slow, it is unreachable — the extension's service
   * worker died, or `Extensions.loadUnpacked` left it disabled pending a reload
   * — and nothing else in the supervisor would ever replace it: `monitor` only
   * revives a profile whose pid is gone.
   */
  private async replaceIfUnreachable(runtime: ProfileRuntime): Promise<void> {
    if (runtime.pingFailures < TIMERS.pingFailuresBeforeReplace) return;
    // A launch in flight owns this profile: its browser is still coming up.
    if (runtime.state === 'stopped' || runtime.state === 'starting') return;
    if (this.launching.has(runtime.config.name)) return;
    await this.replaceBrowser(runtime);
  }

  /**
   * Snapshot the session, kill the browser and launch a clean one. Holds the
   * launch guard itself so a concurrent `monitor` pass cannot revive the same
   * profile into a second Chrome on one `--user-data-dir`.
   */
  private async replaceBrowser(runtime: ProfileRuntime): Promise<void> {
    const name = runtime.config.name;
    const pid = runtime.pid;
    this.launching.add(name);
    runtime.pingFailures = 0;
    runtime.pid = null;
    runtime.healthySince = null;
    runtime.state = 'backoff';
    runtime.label = null;
    runtime.labelFocused = false;
    this.clearFocusRetry(name);
    try {
      console.error(
        `fleet: no bridge on port ${runtime.config.port} for ${name}; replacing the browser`,
      );
      // The snapshot is the only copy of this browser's session-cookie logins,
      // and the replacement replays it before the first navigation.
      await this.captureOne(name, runtime);
      runtime.launched?.cdp.dispose();
      runtime.launched = null;
      if (pid) await terminateChrome(pid, TIMERS.killGraceMs);
      try {
        await fs.rm(path.join(FLEET_ROOT, 'run', `${name}.pid`), { force: true });
      } catch (error) {
        console.error(`fleet: could not remove pid for ${name}: ${(error as Error).message}`);
      }
      runtime.backoffMs = TIMERS.monitorMs;
      runtime.lastError = 'bridge unreachable; browser replaced';
      await this.launchOnce(runtime.config, runtime);
    } finally {
      this.launching.delete(name);
    }
  }

  private profileDir(name: string): string {
    return path.join(FLEET_ROOT, 'profiles', name);
  }

  private async commandLine(pid: number): Promise<string> {
    try {
      return (await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)])).stdout;
    } catch {
      return '';
    }
  }
}
