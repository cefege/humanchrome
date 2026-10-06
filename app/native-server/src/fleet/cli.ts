import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { FleetGateway } from './gateway';
import {
  createDefaultConfig,
  DEFAULT_DAILY_PROFILE_DIR,
  ensureFleetDirectories,
  FLEET_ROOT,
  FleetNotInitializedError,
  gatewayUrl,
  loadConfig,
  NAME_RE,
  saveConfig,
  validatePurposeName,
} from './config';
import { addProfile, initTemplate, removeProfile, signalServe } from './provision';
import { fetchLocalProfiles, fetchNodeProfiles } from './remote';
import { ProfileSupervisor } from './supervisor';
import type { ProfileState } from './supervisor';
import { FleetLeases } from './leases';

export function registerFleetCommands(program: Command): void {
  const fleet = program.command('fleet').description('Manage a multi-profile Chrome fleet');
  fleet
    .command('init')
    .description('Initialize fleet storage and credentials')
    .option('--gateway-port <port>', 'Gateway port', '12300')
    .option('--base-port <port>', 'First profile port', '12500')
    .option('--token <hex>', 'Require this bearer token from LAN clients ("none" to stay open)')
    .option('--print-token', 'Echo the token already in fleet.json')
    .option('--force-new-token', 'Rotate both bearer tokens and turn client auth on')
    .action(async (options) => {
      await ensureFleetDirectories();
      // `--print-token` reads the token and `--token` sets one. Both read the
      // existing fleet rather than initialising it, so neither may be refused
      // by the "already initialized" guard — or there would be no way back to
      // an open fleet once auth had been turned on.
      const rotating = Boolean(options.forceNewToken);
      const printingOnly = !rotating && Boolean(options.printToken) && options.token === undefined;
      const settingToken = !rotating && options.token !== undefined;
      const config =
        printingOnly || settingToken ? await loadConfig() : await existingConfig(options);
      if (printingOnly) {
        console.log(`LAN token: ${config.token ?? '(client auth off)'}`);
        return;
      }
      if (options.token !== undefined) {
        const value = String(options.token);
        if (value !== 'none' && !/^[0-9a-f]{32,}$/i.test(value)) {
          throw new Error('--token must be 32 or more hex characters, or "none"');
        }
        config.token = value === 'none' ? null : value;
      }
      await saveConfig(config);
      if (options.printToken) {
        console.log(`LAN token: ${config.token ?? '(client auth off)'}`);
      }
      const headers: Record<string, string> = { 'X-Humanchrome-Agent': '<agent-name>' };
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      const entry = (url: string) => ({ type: 'http', url, headers });
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              humanchrome: entry(`http://<mac-host>:${config.gateway.port}/v1/pool/any/mcp`),
              humanchromeFleet: entry(`http://<mac-host>:${config.gateway.port}/v1/fleet/mcp`),
            },
          },
          null,
          2,
        ),
      );
    });

  const template = fleet.command('template').description('Manage the Chrome extension template');
  template
    .command('init')
    .description('Create the one-time Chrome extension template')
    .action(async () => {
      await initTemplate(await loadConfig());
    });

  fleet
    .command('serve')
    .description('Run the supervisor and LAN gateway')
    .action(async () => {
      const config = await loadConfig();
      const supervisor = new ProfileSupervisor(config);
      const leases = new FleetLeases(config.leaseIdleTtlSec);
      const gateway = new FleetGateway({ config, supervisor, leases });
      await fs.writeFile(path.join(FLEET_ROOT, 'run', 'serve.pid'), String(process.pid));
      await supervisor.start();
      console.log(await gateway.listen());
      const reload = async () => {
        try {
          const next = await loadConfig();
          await supervisor.reload(next);
          gateway.reload(next);
        } catch (error) {
          console.error(error);
        }
      };
      const shutdown = async () => {
        // The pid file and the exit are in a `finally`: a supervisor that
        // rejects must not leave a stale pid behind, which makes `fleet status`
        // report a serve that is not running.
        try {
          await gateway.close();
          await supervisor.shutdown();
        } finally {
          await fs.rm(path.join(FLEET_ROOT, 'run', 'serve.pid'), { force: true });
          process.exit(0);
        }
      };
      // `on`, not `once`: every fleet CLI mutation signals SIGHUP, and with
      // `once` the second one hits Node's default disposition and kills serve.
      process.on('SIGHUP', () => void reload());
      process.once('SIGTERM', () => void shutdown());
      process.once('SIGINT', () => void shutdown());
    });
  const profile = fleet.command('profile').description('Manage Chrome profiles');
  profile
    .command('add <name>')
    .description(
      'Add a Chrome profile. Seeds from this machine’s main Chrome by default, ' +
        'which is what carries a signed-in Google session into the fleet.',
    )
    .option('--labels <labels>', 'Comma-separated labels')
    .option(
      '--seed <source>',
      "Seed from a Chrome user-data-dir; 'daily' means this machine's main Chrome (default)",
    )
    .option('--no-seed', 'Start from an empty profile instead of inheriting this machine’s logins')
    .action(async (name, options) => {
      const labels = String(options.labels ?? '')
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean);
      // Default to seeding: an empty profile cannot be signed in to Google,
      // because Google refuses the login from a browser it flags as automated.
      // Inheriting the session is both the working path and the honest one.
      const useDaily = options.seed === undefined ? true : String(options.seed) === 'daily';
      const noSeed = Boolean(options.noSeed);
      let seedDir: string | null = null;
      if (!noSeed && (useDaily || options.seed !== undefined)) {
        seedDir =
          options.seed === undefined || String(options.seed) === 'daily'
            ? ((await loadConfig()).dailyProfileDir ?? DEFAULT_DAILY_PROFILE_DIR)
            : path.resolve(String(options.seed));
        console.log(`seeding ${name} from ${seedDir}`);
      } else if (noSeed) {
        console.log(`starting ${name} with an empty profile (--no-seed)`);
      }
      // Handed to a live `serve` like start/stop/restart: it runs in the Mac's
      // GUI session, where Chrome can read its cookie key. Without serve the add
      // runs here, and the launch refuses a session that cannot read it.
      const servePid = await liveServePid();
      if (servePid === null) {
        console.log(`added ${JSON.stringify(await addProfile(name, labels, seedDir))}`);
        return;
      }
      console.log(`provisioning through serve (pid ${servePid})`);
      const config = await loadConfig();
      const response = await fetch(`${gatewayUrl(config)}/v1/profiles`, {
        method: 'POST',
        headers: { ...gatewayHeaders(config), 'content-type': 'application/json' },
        body: JSON.stringify({ name, labels, seed: seedDir }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const reason =
          body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
            ? body.message
            : `${response.status} ${JSON.stringify(body)}`;
        throw new Error(`serve refused add ${name}: ${reason}`);
      }
      console.log(`added ${JSON.stringify(body)}`);
    });
  profile
    .command('rm <name>')
    .description('Remove a profile from the fleet; its data is kept unless --delete-data')
    .option('--delete-data', 'Delete Chrome profile data')
    .action(async (name, options) => removeProfile(name, Boolean(options.deleteData)));
  profile
    .command('ls')
    .description('List every profile in fleet.json as JSON')
    .action(async () => {
      console.log(JSON.stringify((await loadConfig()).profiles, null, 2));
    });

  /**
   * `start`/`stop`/`restart` go through the gateway whenever `serve` is live.
   * A second ProfileSupervisor in this CLI process would write the same pid file
   * and kill the serve process's Chrome (observed live as a hung
   * `fleet restart p01` fighting the running fleet).
   */
  const control = (name: 'start' | 'stop' | 'restart', description: string) =>
    fleet
      .command(`${name} <name>`)
      .description(description)
      .action(async (profileName: string) => {
        const config = await loadConfig();
        const servePid = await liveServePid();
        if (servePid !== null) {
          const response = await fetch(
            `${gatewayUrl(config)}/v1/profiles/${encodeURIComponent(profileName)}/${name}`,
            { method: 'POST', headers: gatewayHeaders(config) },
          );
          if (!response.ok) {
            throw new Error(
              `serve refused ${name} ${profileName}: ${response.status} ${await response.text()}`,
            );
          }
          console.log(`sent to serve (pid ${servePid})`);
          return;
        }
        const supervisor = new ProfileSupervisor(config);
        if (name === 'start') await supervisor.startProfile(profileName);
        if (name === 'stop') await supervisor.stopProfile(profileName);
        if (name === 'restart') await supervisor.restartProfile(profileName);
      });

  /**
   * `enabled` is honoured by the supervisor's start, reload and monitor loops;
   * disabling a profile stops it and keeps it stopped without deleting anything.
   */
  const setEnabled = (enabled: boolean) =>
    profile
      .command(`${enabled ? 'enable' : 'disable'} <name>`)
      .description(
        enabled
          ? 'Let the supervisor run this profile again'
          : 'Stop this profile and keep it stopped; its data is untouched',
      )
      .action(async (name: string) => {
        const config = await loadConfig();
        const entry = config.profiles.find((item) => item.name === name);
        if (!entry) throw new Error(`unknown profile: ${name}`);
        if (entry.enabled === enabled) {
          console.log(`${name} already ${enabled ? 'enabled' : 'disabled'}`);
          return;
        }
        entry.enabled = enabled;
        await saveConfig(config);
        await signalServe();
        console.log(`${name} ${enabled ? 'enabled' : 'disabled'}`);
      });

  const setParked = (parked: boolean) =>
    fleet
      .command(parked ? 'down' : 'up')
      .description(
        parked
          ? 'Park the fleet: stop every profile Chrome and keep it stopped'
          : 'Unpark the fleet and start every enabled profile',
      )
      .action(async () => {
        const config = await loadConfig();
        if (config.parked === parked) {
          console.log(`fleet already ${parked ? 'parked' : 'running'}`);
          return;
        }
        config.parked = parked;
        await saveConfig(config);
        await signalServe();
        console.log(
          parked
            ? 'fleet parked — every profile Chrome is stopping'
            : 'fleet running — every enabled profile is starting',
        );
      });

  const node = fleet.command('node').description('Manage peer machines running their own fleet');
  node
    .command('add <id> <host>')
    .description("Register a peer gateway (token is that machine's fleet gateway token)")
    .option('--port <port>', 'Peer gateway port', '12300')
    .option('--token <token>', 'Peer gateway token; omit on a trusted LAN (peer is open)')
    .action(async (id: string, host: string, options) => {
      const config = await loadConfig();
      // A `:` in a node id would break the `nodeId:profile` route key, and a
      // NaN port would silently produce an unreachable peer.
      if (!NAME_RE.test(id)) throw new Error(`invalid node id: ${id}`);
      if (id === config.nodeId) throw new Error(`node id ${id} is this machine's own nodeId`);
      const port = Number(options.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`invalid peer port: ${String(options.port)}`);
      }
      const entry = { id, host, port, token: String(options.token ?? '') };
      const existing = config.nodes.findIndex((node) => node.id === id);
      if (existing >= 0) config.nodes[existing] = entry;
      else config.nodes.push(entry);
      await saveConfig(config);
      await signalServe();
      console.log(`node ${id} -> http://${host}:${entry.port}`);
    });
  node
    .command('rm <id>')
    .description('Remove a peer machine')
    .action(async (id: string) => {
      const config = await loadConfig();
      const before = config.nodes.length;
      config.nodes = config.nodes.filter((entry) => entry.id !== id);
      if (config.nodes.length === before) throw new Error(`unknown node: ${id}`);
      await saveConfig(config);
      await signalServe();
      console.log(`node ${id} removed`);
    });
  node
    .command('ls')
    .description('List this machine node id and every configured peer')
    .action(async () => {
      const config = await loadConfig();
      console.log(
        JSON.stringify(
          {
            nodeId: config.nodeId,
            nodes: config.nodes.map(({ id, host, port }) => ({ id, host, port })),
          },
          null,
          2,
        ),
      );
    });
  setEnabled(true);
  setEnabled(false);

  const purpose = fleet
    .command('purpose')
    .description('Bind a purpose tag to exactly one browser in the fleet');
  purpose
    .command('add <tag> <profile>')
    .description('Bind a purpose tag to a profile on this machine')
    .action(async (tag: string, profileName: string) => {
      validatePurposeName(tag);
      const config = await loadConfig();
      const profile = config.profiles.find((entry) => entry.name === profileName);
      if (!profile) throw new Error(`unknown profile: ${profileName}`);
      if (profile.purpose) {
        throw new Error(`profile ${profileName} is already bound to purpose "${profile.purpose}"`);
      }
      // 1:1 is fleet-wide, and a local duplicate would make every later
      // loadConfig reject the file this command is about to write.
      const holder = config.profiles.find(
        (entry) => entry.name !== profileName && entry.purpose === tag,
      );
      if (holder) {
        throw new Error(`purpose "${tag}" is already bound to ${holder.name}`);
      }
      // Fail closed: uniqueness is fleet-wide, and a peer that does not answer
      // cannot clear a tag it might already hold.
      for (const node of config.nodes) {
        let remote;
        try {
          remote = await fetchNodeProfiles(node);
        } catch (error) {
          throw new Error(
            `cannot verify purpose "${tag}" is unique — ${node.id} at ${node.host}:${node.port} did not answer: ${(error as Error).message}`,
          );
        }
        const clash = remote.find((entry) => entry.purpose === tag);
        if (clash) {
          throw new Error(`purpose "${tag}" is already bound to ${node.id}:${clash.name}`);
        }
      }
      profile.purpose = tag;
      await saveConfig(config);
      await signalServe();
      console.log(`purpose ${tag} -> ${profileName}`);
    });
  purpose
    .command('rm <tag>')
    .description('Release a purpose tag; the browser and its logins are untouched')
    .action(async (tag: string) => {
      const config = await loadConfig();
      const profile = config.profiles.find((entry) => entry.purpose === tag);
      if (!profile) throw new Error(`unknown purpose: ${tag}`);
      delete profile.purpose;
      await saveConfig(config);
      await signalServe();
      console.log(`purpose ${tag} released`);
    });
  purpose
    .command('ls')
    .description('List every purpose tag in the fleet and the browser serving it')
    .option('--json', 'Emit JSON for agents')
    .action(async (options) => {
      const config = await loadConfig();
      const rows: {
        purpose: string;
        profile: string;
        node: string;
        state: ProfileState | 'unknown';
        labels: string[];
      }[] = [];
      // `serve` owns the real state; without it the only honest answer is
      // that nothing on this machine is reporting.
      const localStates = new Map<string, ProfileState>();
      try {
        for (const entry of await fetchLocalProfiles(
          localGatewayHost(config),
          config.gateway.port,
          config.token,
        )) {
          localStates.set(entry.name, entry.state);
        }
      } catch {
        console.error('fleet serve is not answering — local state unknown');
      }
      for (const profile of config.profiles) {
        if (!profile.purpose) continue;
        rows.push({
          purpose: profile.purpose,
          profile: profile.name,
          node: config.nodeId,
          // `unknown`, not `stopped`: with serve down, nothing is reporting.
          state: localStates.get(profile.name) ?? 'unknown',
          labels: profile.labels,
        });
      }
      for (const node of config.nodes) {
        let remote;
        try {
          remote = await fetchNodeProfiles(node);
        } catch (error) {
          console.error(`node ${node.id} did not answer: ${(error as Error).message}`);
          continue;
        }
        for (const entry of remote) {
          if (!entry.purpose) continue;
          rows.push({
            purpose: entry.purpose,
            profile: entry.name,
            node: node.id,
            state: entry.state,
            labels: entry.labels,
          });
        }
      }
      if (options.json) {
        console.log(JSON.stringify(rows));
        return;
      }
      if (!rows.length) {
        console.log('no purposes bound');
        return;
      }
      for (const row of rows) {
        console.log(
          `${row.purpose} -> ${row.node}:${row.profile}  ${row.state}  [${row.labels.join(', ')}]`,
        );
      }
    });
  setParked(true);
  setParked(false);
  control('start', 'Start a profile when serve is not running');
  control('stop', 'Stop a profile');
  control('restart', 'Restart a profile');

  fleet
    .command('status')
    .description('Show profile and lease status')
    .action(async () => {
      const config = await loadConfig();
      try {
        const pid = Number(await fs.readFile(path.join(FLEET_ROOT, 'run', 'serve.pid'), 'utf8'));
        process.kill(pid, 0);
        const headers = gatewayHeaders(config);
        const base = gatewayUrl(config);
        const [profiles, leases] = await Promise.all([
          fetch(`${base}/v1/profiles`, { headers }).then((response) => response.json()),
          fetch(`${base}/v1/leases`, { headers }).then((response) => response.json()),
        ]);
        console.log(
          JSON.stringify({ serve: 'up', parked: config.parked, profiles, leases }, null, 2),
        );
        return;
      } catch {
        /* serve is not running */
      }
      // No `leases` key offline: a freshly built, always-empty lease list reads
      // as a real measurement when nothing is actually reporting.
      console.log(
        JSON.stringify(
          {
            serve: 'down',
            parked: config.parked,
            profiles: new ProfileSupervisor(config).snapshot(),
          },
          null,
          2,
        ),
      );
    });

  fleet
    .command('install-agent')
    .description('Install and bootstrap the launchd supervisor')
    .action(async () => {
      await ensureFleetDirectories();
      const label = 'com.humanchrome.fleet';
      const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
      const xml = plistXml(
        label,
        path.resolve(__dirname, '../cli.js'),
        path.join(FLEET_ROOT, 'logs', 'serve.log'),
      );
      await fs.writeFile(plist, xml, { mode: 0o644 });
      await runLaunchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${label}`]).catch(
        () => undefined,
      );
      await runLaunchctl(['bootstrap', `gui/${process.getuid?.() ?? 0}`, plist]);
    });
  fleet
    .command('uninstall-agent')
    .description('Remove the launchd supervisor')
    .action(async () => {
      const label = 'com.humanchrome.fleet';
      await runLaunchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${label}`]).catch(
        () => undefined,
      );
      await fs.rm(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`), {
        force: true,
      });
    });
}

/** `fleet init`: load the existing config, rotate, or create a fresh one. */
async function existingConfig(options: {
  forceNewToken?: boolean;
  gatewayPort: string;
  basePort: string;
}): Promise<ReturnType<typeof createDefaultConfig>> {
  let existing;
  try {
    existing = await loadConfig();
  } catch (error) {
    if (!(error instanceof FleetNotInitializedError)) throw error;
    return createDefaultConfig(Number(options.gatewayPort), Number(options.basePort));
  }
  if (!options.forceNewToken) {
    throw new FleetAlreadyInitializedError(
      'fleet already initialized — use --force-new-token to rotate credentials',
    );
  }
  // Rotating both tokens also turns client auth on: the operator asked for new
  // credentials, and handing out a token nobody must present would be a lie.
  existing.bridgeToken = cryptoRandomToken();
  existing.token = cryptoRandomToken();
  return existing;
}

class FleetAlreadyInitializedError extends Error {}

/** The address a CLI command should dial: loopback unless the bind is concrete. */
function localGatewayHost(config: ReturnType<typeof createDefaultConfig>): string {
  return new URL(gatewayUrl(config)).hostname;
}

/** Gateway requests carry the token only when this fleet requires one. */
function gatewayHeaders(config: ReturnType<typeof createDefaultConfig>): Record<string, string> {
  return config.token ? { authorization: `Bearer ${config.token}` } : {};
}

/** The live `serve` pid, or null when serve is down or its pid file is stale. */
async function liveServePid(): Promise<number | null> {
  try {
    const pid = Number(await fs.readFile(path.join(FLEET_ROOT, 'run', 'serve.pid'), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** `&`, `<` and `>` are the XML metacharacters in a plist string value. */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cryptoRandomToken(): string {
  return randomBytes(32).toString('hex');
}
function plistXml(label: string, cliPath: string, logPath: string): string {
  const e = escapeXml;
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${e(label)}</string><key>ProgramArguments</key><array><string>${e(process.execPath)}</string><string>${e(cliPath)}</string><string>fleet</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${e(logPath)}</string><key>StandardErrorPath</key><string>${e(logPath)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict></dict></plist>`;
}
async function runLaunchctl(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('launchctl', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`launchctl exited ${code}`)),
    );
  });
}
