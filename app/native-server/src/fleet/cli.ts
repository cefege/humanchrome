import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { FleetGateway } from './gateway';
import {
  createDefaultConfig,
  ensureFleetDirectories,
  FLEET_ROOT,
  loadConfig,
  saveConfig,
} from './config';
import { addProfile, initTemplate, removeProfile } from './provision';
import { ProfileSupervisor } from './supervisor';
import { FleetLeases } from './leases';

export function registerFleetCommands(program: Command): void {
  const fleet = program.command('fleet').description('Manage a multi-profile Chrome fleet');
  fleet
    .command('init')
    .description('Initialize fleet storage and credentials')
    .option('--gateway-port <port>', 'Gateway port', '12300')
    .option('--base-port <port>', 'First profile port', '12500')
    .option('--force-new-token', 'Rotate both bearer tokens, preserving profiles')
    .action(async (options) => {
      await ensureFleetDirectories();
      let config: ReturnType<typeof createDefaultConfig>;
      try {
        config = await loadConfig();
        if (!options.forceNewToken)
          throw new Error(
            'fleet already initialized — use --force-new-token to rotate credentials',
          );
        config.token = cryptoRandomToken();
        config.bridgeToken = cryptoRandomToken();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('fleet not initialized'))
          throw error;
        config = createDefaultConfig(Number(options.gatewayPort), Number(options.basePort));
      }
      await saveConfig(config);
      console.log(`LAN token: ${config.token}`);
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              humanchrome: {
                type: 'http',
                url: `http://<mac-host>:${config.gateway.port}/v1/pool/any/mcp`,
                headers: {
                  Authorization: `Bearer ${config.token}`,
                  'X-Humanchrome-Agent': '<agent-name>',
                },
              },
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
          await supervisor.reload(await loadConfig());
        } catch (error) {
          console.error(error);
        }
      };
      const shutdown = async () => {
        await gateway.close();
        await supervisor.shutdown();
        await fs.rm(path.join(FLEET_ROOT, 'run', 'serve.pid'), { force: true });
        process.exit(0);
      };
      process.once('SIGHUP', () => void reload());
      process.once('SIGTERM', () => void shutdown());
      process.once('SIGINT', () => void shutdown());
    });
  const profile = fleet.command('profile').description('Manage Chrome profiles');
  profile
    .command('add <name>')
    .option('--labels <labels>', 'Comma-separated labels')
    .action(async (name, options) => {
      await addProfile(
        name,
        String(options.labels ?? '')
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean),
      );
    });
  profile
    .command('rm <name>')
    .option('--delete-data', 'Delete Chrome profile data')
    .action(async (name, options) => removeProfile(name, Boolean(options.deleteData)));
  profile.command('ls').action(async () => {
    console.log(JSON.stringify((await loadConfig()).profiles, null, 2));
  });

  const control = (name: string, description: string) =>
    fleet
      .command(`${name} <name>`)
      .description(description)
      .action(async (profileName) => {
        const config = await loadConfig();
        const supervisor = new ProfileSupervisor(config);
        if (name === 'start') await supervisor.startProfile(profileName);
        if (name === 'stop') await supervisor.stopProfile(profileName);
        if (name === 'restart') await supervisor.restartProfile(profileName);
      });
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
        const headers = { authorization: `Bearer ${config.token}` };
        const base = `http://127.0.0.1:${config.gateway.port}`;
        const [profiles, leases] = await Promise.all([
          fetch(`${base}/v1/profiles`, { headers }).then((response) => response.json()),
          fetch(`${base}/v1/leases`, { headers }).then((response) => response.json()),
        ]);
        console.log(JSON.stringify({ profiles, leases }, null, 2));
        return;
      } catch {
        /* serve is not running */
      }
      const supervisor = new ProfileSupervisor(config);
      const leases = new FleetLeases(config.leaseIdleTtlSec);
      console.log(
        JSON.stringify({ profiles: supervisor.snapshot(), leases: leases.list() }, null, 2),
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

function cryptoRandomToken(): string {
  return randomBytes(32).toString('hex');
}
function plistXml(label: string, cliPath: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${cliPath}</string><string>fleet</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${logPath}</string><key>StandardErrorPath</key><string>${logPath}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict></dict></plist>`;
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
