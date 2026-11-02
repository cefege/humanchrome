#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(homedir(), 'Library/Application Support/humanchrome-vm-pilot');
const label = 'com.humanchrome.vm-pilot';
const domain = `gui/${process.getuid?.()}`;
const plistPath = join(homedir(), `Library/LaunchAgents/${label}.plist`);
const runtime = join(root, 'runtime/tart.app/Contents/MacOS/tart');
const environment = { ...process.env, TART_HOME: join(root, 'tart'), TART_NO_AUTO_PRUNE: '1' };
const command = process.argv[2];

function run(executable, args, { inherit = false, allowFailure = false, input, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: inherit ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.stdin?.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    if (input !== undefined) child.stdin.end(input);
    child.on('close', (code, signal) => {
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${executable} failed (${signal ?? code}): ${stderr.trim()}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function xml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character],
  );
}

async function configuration() {
  if (process.platform !== 'darwin') throw new Error('The local fleet VM requires macOS.');
  const config = JSON.parse(await readFile(join(root, 'deployment.json'), 'utf8'));
  if (
    config.schemaVersion !== 1 ||
    config.owner !== 'humanchrome-vm-pilot' ||
    config.vmName !== 'humanchrome-pilot' ||
    config.guestUser !== 'admin'
  ) {
    throw new Error('Refusing an unrecognized VM deployment; see docs/FLEET.md.');
  }
  await access(runtime);
  return config;
}

async function guestAddress(config, wait = 0) {
  const result = await run(runtime, ['ip', config.vmName, '--wait', String(wait)]);
  const address = result.stdout.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    throw new Error('Tart did not return a guest IPv4 address.');
  }
  return address;
}

function sshArguments(config, address) {
  return [
    '-F',
    '/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'HostKeyAlias=humanchrome-pilot',
    '-o',
    `UserKnownHostsFile=${join(root, 'ssh/known_hosts')}`,
    '-i',
    join(root, 'ssh/id_ed25519'),
    `${config.guestUser}@${address}`,
  ];
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function start(config) {
  await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 });
  await mkdir(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
  const arguments_ = [
    runtime,
    'run',
    '--no-graphics',
    '--no-audio',
    '--no-usb-accessories',
    '--no-clipboard',
    config.vmName,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${arguments_.map((value) => `<string>${xml(value)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>
<key>TART_HOME</key><string>${xml(environment.TART_HOME)}</string>
<key>TART_NO_AUTO_PRUNE</key><string>1</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(root, 'logs/vm.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, 'logs/vm.log'))}</string>
</dict></plist>
`;
  let previous;
  try {
    previous = await readFile(plistPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous !== undefined && previous !== plist) {
    throw new Error(`Refusing to replace a different launch agent: ${plistPath}`);
  }
  await run('/bin/launchctl', ['enable', `${domain}/${label}`]);
  const loaded = await run('/bin/launchctl', ['print', `${domain}/${label}`], {
    allowFailure: true,
  });
  if (loaded.code !== 0) {
    await writeFile(plistPath, plist, { mode: 0o600 });
    await run('/bin/launchctl', ['bootstrap', domain, plistPath]);
  } else {
    await run('/bin/launchctl', ['kickstart', `${domain}/${label}`]);
  }
  console.log(`Started ${config.vmName} without a host viewer, audio or clipboard sharing.`);
  console.log(`Guest address: ${await guestAddress(config, 180)}`);
}

async function stop(config) {
  await run('/bin/launchctl', ['disable', `${domain}/${label}`]);
  const loaded = await run('/bin/launchctl', ['print', `${domain}/${label}`], {
    allowFailure: true,
  });
  if (loaded.code === 0) {
    if (/^\s*pid = \d+/m.test(loaded.stdout)) {
      const address = await guestAddress(config);
      const password = await readFile(join(root, 'private/guest-password'), 'utf8');
      const shutdown = await run(
        '/usr/bin/ssh',
        [...sshArguments(config, address), "sudo -S -p '' /sbin/shutdown -h now"],
        { input: password, allowFailure: true },
      );
      if (shutdown.code !== 0 && shutdown.code !== 255) {
        throw new Error('Guest OS shutdown failed; the VM has not been forcibly stopped.');
      }
      const deadline = Date.now() + 90000;
      while (true) {
        const state = await run('/bin/launchctl', ['print', `${domain}/${label}`], {
          allowFailure: true,
        });
        if (state.code !== 0 || !/^\s*pid = \d+/m.test(state.stdout)) break;
        if (Date.now() >= deadline) {
          throw new Error(
            'Guest shutdown did not finish; left VM running rather than risk disk writes.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await run('/bin/launchctl', ['bootout', `${domain}/${label}`]);
  } else {
    const inventory = JSON.parse(
      (await run(runtime, ['list', '--source', 'local', '--format', 'json'])).stdout,
    );
    console.log(JSON.stringify(inventory, null, 2));
    console.log('Launch agent is not loaded; no process was signalled.');
    return;
  }
  console.log(`Stopped ${config.vmName}; its disk, credentials and browser profiles are retained.`);
}

async function main() {
  if (!['start', 'stop', 'status', 'ssh'].includes(command)) {
    throw new Error('Usage: node scripts/fleet-vm.mjs start|stop|status|ssh [guest command ...]');
  }
  const config = await configuration();
  if (command === 'start') return start(config);
  if (command === 'stop') return stop(config);
  if (command === 'status') {
    const result = await run(runtime, ['list', '--source', 'local', '--format', 'json']);
    console.log(result.stdout.trim());
    return;
  }
  const arguments_ = sshArguments(config, await guestAddress(config));
  const guestCommand = process.argv.slice(3);
  if (guestCommand.length) arguments_.push(guestCommand.map(shellQuote).join(' '));
  await run('/usr/bin/ssh', arguments_, { inherit: true });
}

main().catch((error) => {
  console.error(`fleet-vm: ${error.message}`);
  process.exitCode = 1;
});
