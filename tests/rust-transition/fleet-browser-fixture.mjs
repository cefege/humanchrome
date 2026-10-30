import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { ROOT, isolatedRun } from './process-host.mjs';

export async function fleetBrowserFixture() {
  assert.equal(process.platform, 'darwin', 'first-target browser proof requires Apple Silicon macOS');
  return isolatedRun(async (scope) => {
    const cli = await realpath(process.env.HC_TEST_CLI_BIN ?? join(ROOT, 'target/release/humanchrome-bridge'));
    const native = await realpath(process.env.HC_TEST_NATIVE_BIN ?? join(ROOT, 'target/release/humanchrome-nativehost'));
    const externalBrowser = await realpath(process.env.HC_TEST_FLEET_EXTERNAL_BROWSER_BIN ?? join(
      ROOT,
      'target/release/examples',
      `fleet-external-browser${process.platform === 'win32' ? '.exe' : ''}`,
    ));
    scope.env.HC_TEST_NATIVE_BIN = native;
    const chrome = process.env.HC_CHROME_PATH;
    assert(chrome, 'HC_CHROME_PATH must name an isolated-capable Chrome for Testing binary');
    // Keep Chrome manifests/profiles in temporary HOME while using this GUI session's
    // existing unlocked login Keychain. This reads settings; it never changes keychain
    // search lists, passwords, items, or the real HOME's native-host registration.
    const loginKeychain = JSON.parse(execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' }).trim());
    const keychainDirectory = join(scope.env.HOME, 'Library', 'Keychains');
    await mkdir(keychainDirectory, { recursive: true });
    await symlink(loginKeychain, join(keychainDirectory, 'login.keychain-db'));
    const root = scope.env.HC_FLEET_ROOT;
    const configPath = join(root, 'fleet.json');
    let profilePorts;
    const profileName = 'rust-lifecycle-fixture';
    const observed = [];
    const fixture = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Rust fleet lifecycle</title><button id="action" onclick="this.textContent=\'clicked\'">fixture</button><input id="input">');
    });
    let url;
    async function command(args, success = true, deadline = 180_000) {
      const child = scope.spawn(cli, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
      let code;
      try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
      const diagnostic = `${args.join(' ')}: exit ${code}\n${stdout}\n${stderr}`;
      if (success) assert.equal(code, 0, diagnostic);
      else assert.notEqual(code, 0, diagnostic);
      return { stdout, stderr, code };
    }
    async function waitFor(read, accept, description, deadlineMs = 180_000) {
      const deadline = Date.now() + deadlineMs;
      let last;
      while (Date.now() < deadline) {
        try { last = await read(); if (accept(last)) return last; } catch (error) { last = error.message; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`${description}: ${JSON.stringify(last)}`);
    }
    let gateway;
    let gatewayExit;
    let gatewayLogs = '';
    let bridgePort;
    let config;
    try {
      profilePorts = await reserveProfilePorts();
      const basePort = profilePorts.basePort;
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      url = `http://127.0.0.1:${fixture.address().port}/`;
      await command(['register', '--host-path', native, '--browser', 'chrome']);
      await command(['fleet', 'init', '--gateway-port', String(scope.port), '--base-port', String(basePort)]);
      config = JSON.parse(await readFile(configPath, 'utf8'));
      config.chromePath = chrome;
      config.extensionDir = process.env.HC_E2E_EXTENSION_DIR ?? join(ROOT, 'app/chrome-extension/.output/chrome-mv3');
      config.gateway.host = '127.0.0.1';
      config.parked = false;
      await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      const hostArgs = ['--host-path', native];
      await profilePorts.release(0);
      await command(['fleet', 'template', 'init', ...hostArgs]);
      await command(['fleet', 'profile', 'add', profileName, '--no-seed', '--labels', 'fixture', ...hostArgs]);
      const provisionedPid = Number(await readFile(join(root, 'run', `${profileName}.pid`), 'utf8'));
      assert.doesNotThrow(() => process.kill(provisionedPid, 0), 'provisioned Chrome must outlive the provisioning CLI');
      config = JSON.parse(await readFile(configPath, 'utf8'));
      const profile = config.profiles.find((profile) => profile.name === profileName);
      assert(profile);
      bridgePort = profile.port;
      const manifestPath = join(root, 'profiles', profileName, 'NativeMessagingHosts/com.humanchrome.nativehost.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.equal(manifest.path, native, 'Rust provisioner must select the explicitly requested candidate host');
      assert.deepEqual(profile.labels, ['fixture']);
      const externalOwner = scope.spawn(externalBrowser, [
        configPath, profileName, String(provisionedPid),
      ]);
      let externalLogs = '';
      externalOwner.stdout.on('data', (chunk) => { externalLogs += chunk; });
      externalOwner.stderr.on('data', (chunk) => { externalLogs += chunk; });
      await waitFor(() => externalLogs, (output) => /EXTERNAL_BROWSER_READY \d+\n/.test(output), 'real external Chrome private-pipe owner', 90_000);
      const externalPid = Number(/EXTERNAL_BROWSER_READY (\d+)\n/.exec(externalLogs)[1]);
      await waitFor(() => fetch(`http://127.0.0.1:${bridgePort}/ping`, { signal: AbortSignal.timeout(2000) }).then((response) => response.status), (status) => status === 200, 'external Chrome native bridge');
      const gatewayHeaders = config.token ? { authorization: `Bearer ${config.token}` } : {};
      const inventory = () => fetch(`http://127.0.0.1:${scope.port}/v1/profiles`, { headers: gatewayHeaders, signal: AbortSignal.timeout(2000) }).then((response) => response.json());
      async function startGateway() {
        gateway = scope.spawn(cli, ['fleet', 'serve', '--host-path', native]);
        gateway.stdout.on('data', (chunk) => { gatewayLogs += chunk; });
        gateway.stderr.on('data', (chunk) => { gatewayLogs += chunk; });
        gatewayExit = once(gateway, 'exit');
        return waitFor(inventory, (profiles) => profiles.find((profile) => profile.name === profileName)?.state === 'healthy', 'gateway profile startup/adoption');
      }
      async function stopGateway() {
        gateway.kill('SIGTERM');
        const timer = setTimeout(() => gateway.kill('SIGKILL'), 15_000);
        let code;
        try { [code] = await gatewayExit; } finally { clearTimeout(timer); }
        assert.equal(code, 0, gatewayLogs);
        gateway = undefined;
      }
      const adopted = await startGateway();
      assert.equal(adopted.find((profile) => profile.name === profileName).pid, externalPid, `gateway must adopt the externally managed Chrome rather than replace it\n${externalLogs}\n${gatewayLogs}`);
      async function tool(name, args) {
        const response = await fetch(`http://127.0.0.1:${bridgePort}/api/tools/${name}`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.bridgeToken}`, 'x-client-id': 'rust-lifecycle-fixture' },
          body: JSON.stringify({ args }), signal: AbortSignal.timeout(125_000),
        });
        assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json();
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const text = result.content.find((block) => block.type === 'text')?.text;
        assert(text, JSON.stringify(result));
        return JSON.parse(text);
      }
      await waitFor(() => fetch(`http://127.0.0.1:${bridgePort}/ping`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok), Boolean, 'candidate native bridge');
      const instance = await waitFor(async () => {
        const directory = join(root, 'registry/instances');
        for (const file of await readdir(directory)) {
          if (!file.endsWith('.json')) continue;
          const record = JSON.parse(await readFile(join(directory, file), 'utf8'));
          if (record.port === bridgePort) return record;
        }
        return null;
      }, (record) => Number.isInteger(record?.pid), 'profile-owned native bridge registry');
      const nativeCommand = execFileSync('/bin/ps', ['-p', String(instance.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
      assert(nativeCommand === native || nativeCommand.startsWith(`${native} `),
        `fleet browser must execute the Rust candidate, not an installed Node host: ${nativeCommand}`);
      const navigation = await tool('chrome_navigate', { url });
      assert.equal(typeof navigation.tabId, 'number', JSON.stringify(navigation));
      const tabId = navigation.tabId;
      await tool('chrome_wait_for', { tabId, kind: 'load_state', state: 'complete', timeoutMs: 15_000 });
      const page = await tool('chrome_javascript', { tabId, code: 'return { title: document.title, href: location.href };' });
      const evaluated = JSON.parse(page.result);
      assert.equal(evaluated.href, url, JSON.stringify({ navigation, page }));
      assert.equal(evaluated.title, 'Rust fleet lifecycle', JSON.stringify(page));
      const nativeProbe = await command(['fleet', 'profile', 'verify', profileName], false);
      function googleOutcome(probe) {
        const text = `${probe.stdout}\n${probe.stderr}`;
        const http = text.match(/ListAccounts answered HTTP (\d+)/);
        if (http) return { kind: 'http-error', status: Number(http[1]) };
        const state = text.match(/"state"\s*:\s*"(none|remembered)"/);
        assert(state, `Google verification failed without a classified state or upstream error: ${text}`);
        return { kind: 'state', state: state[1] };
      }
      const google = googleOutcome(nativeProbe);
      observed.push(`Google verification fail-closed result: ${JSON.stringify(google)}`);
      await tool('chrome_cookies', { action: 'set', url, name: 'rust_session_fixture', value: 'retained', path: '/' });
      await stopGateway();
      assert.doesNotThrow(() => process.kill(externalPid, 0), 'gateway shutdown must leave the adopted Chrome process alive');
      await waitFor(() => fetch(`http://127.0.0.1:${bridgePort}/ping`, { signal: AbortSignal.timeout(2000) }).then((response) => response.status), (status) => status === 200, 'adopted Chrome native bridge after gateway shutdown', 10_000);
      const pidPath = join(root, 'run', `${profileName}.pid`);
      const beforeRemoval = await readFile(configPath, 'utf8');
      const unrelated = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      try {
        await writeFile(pidPath, String(unrelated.pid));
        await command(['fleet', 'profile', 'rm', profileName, '--delete-data'], false);
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'mismatched PID must not be signalled');
        assert.equal(await readFile(configPath, 'utf8'), beforeRemoval, 'mismatched PID must not remove configuration');
        await unlink(pidPath);
        await command(['fleet', 'profile', 'rm', profileName], false);
        assert.equal(await readFile(configPath, 'utf8'), beforeRemoval, 'missing PID must not orphan a live browser');
        assert.doesNotThrow(() => process.kill(externalPid, 0), 'missing PID must leave the externally owned browser untouched');
        await writeFile(pidPath, String(externalPid));
        const marker = join(root, 'run/supervisor-restart.marker');
        await writeFile(marker, JSON.stringify({ [profileName]: unrelated.pid }), { mode: 0o600 });
        const restarted = await startGateway();
        assert.equal(restarted.find((profile) => profile.name === profileName).pid, externalPid, 'a stale restart marker must not replace the newly adopted browser');
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'a stale restart marker must never signal its unrelated PID');
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
        observed.push('PID-bound stale restart marker cleared without signalling unrelated processes');
      } finally {
        await writeFile(pidPath, String(externalPid));
        unrelated.kill('SIGTERM');
      }
      const stillLive = await tool('chrome_cookies', { action: 'get', domain: '127.0.0.1', name: 'rust_session_fixture' });
      assert(stillLive.cookies.some((cookie) => cookie.value === 'retained'), 'adopted session must remain unchanged while its gateway restarts');
      await command(['fleet', 'stop', profileName]);
      await waitFor(inventory, (profiles) => profiles.find((profile) => profile.name === profileName)?.state === 'stopped', 'explicit profile stop');
      await command(['fleet', 'start', profileName]);
      await waitFor(inventory, (profiles) => profiles.find((profile) => profile.name === profileName)?.state === 'healthy', 'profile restart');
      await tool('chrome_cookies', { action: 'set', url, name: 'rust_session_fixture', value: 'retained', path: '/', sameSite: 'lax' });
      await command(['fleet', 'stop', profileName]);
      await waitFor(inventory, (profiles) => profiles.find((profile) => profile.name === profileName)?.state === 'stopped', 'owned profile stop');
      await command(['fleet', 'start', profileName]);
      await waitFor(inventory, (profiles) => profiles.find((profile) => profile.name === profileName)?.state === 'healthy', 'owned profile restart');
      const cookies = await tool('chrome_cookies', { action: 'get', domain: '127.0.0.1', name: 'rust_session_fixture' });
      assert(cookies.cookies.some((cookie) => cookie.name === 'rust_session_fixture' && cookie.value === 'retained'), 'session cookies must survive owned profile restart');
      await tool('chrome_cookies', { action: 'set', url, name: 'rust_shutdown_fixture', value: 'snapshotted', path: '/', sameSite: 'lax' });
      await tool('chrome_cookies', { action: 'set', url, name: 'rust_seed_fixture', value: 'same-mac-persistent', path: '/', sameSite: 'lax', expirationDate: Date.now() / 1000 + 3600 });
      const Database = createRequire(join(ROOT, 'app/native-server/package.json'))('better-sqlite3');
      await waitFor(() => {
        const db = new Database(join(root, 'profiles', profileName, 'Default/Cookies'), { readonly: true, fileMustExist: true });
        try {
          return db.prepare("SELECT length(encrypted_value) AS encryptedBytes FROM cookies WHERE name = ? AND is_persistent = 1").get('rust_seed_fixture')?.encryptedBytes > 0;
        } finally { db.close(); }
      }, (persisted) => persisted, 'real encrypted seed cookie flushed to SQLite', 60_000);
      await stopGateway();
      await waitFor(
        async () => { try { return (await fetch(`http://127.0.0.1:${bridgePort}/ping`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } },
        (alive) => !alive, 'owned Chrome shutdown', 10_000,
      );
      await startGateway();
      const restored = await tool('chrome_cookies', { action: 'get', domain: '127.0.0.1', name: 'rust_shutdown_fixture' });
      assert(restored.cookies.some((cookie) => cookie.name === 'rust_shutdown_fixture' && cookie.value === 'snapshotted'), 'graceful owned shutdown must snapshot session cookies before termination');
      observed.push('native-host registration confined to temporary HOME', 'template and profile provisioned with unchanged extension', 'adopted Chrome survives gateway shutdown', 'real navigation and JavaScript through candidate native host', 'session cookie persisted across explicit stop/start and owned gateway shutdown');
      await command(['fleet', 'stop', profileName]);
      await waitFor(inventory, (profiles) => profiles.find((profile) => profile.name === profileName)?.state === 'stopped', 'final profile stop');
      const seededName = 'rust-seeded-fixture';
      // Remove the persistent fixture from plaintext replay: its value must
      // survive through the encrypted store, separately from session replay.
      const sourceSnapshotPath = join(root, 'profiles', profileName, '.hc-session.json');
      const sourceSnapshot = JSON.parse(await readFile(sourceSnapshotPath, 'utf8'));
      sourceSnapshot.cookies = sourceSnapshot.cookies.filter((cookie) => cookie.name !== 'rust_seed_fixture');
      await writeFile(sourceSnapshotPath, `${JSON.stringify(sourceSnapshot)}\n`, { mode: 0o600 });
      await profilePorts.release(1);
      const seededResult = await command([
        'fleet', 'profile', 'add', seededName, '--seed', join(root, 'profiles', profileName),
        '--labels', 'seed-fixture', '--host-path', native,
      ]);
      const copied = JSON.parse(seededResult.stdout.slice(seededResult.stdout.indexOf('{')));
      assert(copied.copied.persistent >= 1, 'the real same-Mac seed must exercise the persistent-cookie launch gate');
      config = JSON.parse(await readFile(configPath, 'utf8'));
      const seededProfile = config.profiles.find((profile) => profile.name === seededName);
      assert(seededProfile);
      await waitFor(inventory, (profiles) => profiles.find((profile) => profile.name === seededName)?.state === 'healthy', 'same-Mac seeded profile through live gateway');
      bridgePort = seededProfile.port;
      const seededPersistent = await tool('chrome_cookies', { action: 'get', domain: '127.0.0.1', name: 'rust_seed_fixture' });
      assert(seededPersistent.cookies.some((cookie) => cookie.value === 'same-mac-persistent'), 'the seeded browser must retain the encrypted same-Mac persistent cookie');
      const seededSession = await tool('chrome_cookies', { action: 'get', domain: '127.0.0.1', name: 'rust_shutdown_fixture' });
      assert(seededSession.cookies.some((cookie) => cookie.value === 'snapshotted'), 'the seeded browser must replay the source session snapshot');
      await command(['fleet', 'stop', seededName]);
      await waitFor(inventory, (profiles) => profiles.find((profile) => profile.name === seededName)?.state === 'stopped', 'seeded profile stop');
      await command(['fleet', 'profile', 'rm', seededName, '--delete-data']);
      bridgePort = profile.port;
      observed.push('same-Mac encrypted-cookie and session-snapshot seeding through authenticated live gateway', 'mismatched/missing PID removal refused without signalling or orphaning Chrome');
      await stopGateway();
      const workerRoot = join(root, 'enrolled-worker');
      const enrollment = [
        'fleet', 'worker', 'init', 'isolated-worker', '--root', workerRoot,
        '--host', '100.64.99.2', '--base-port', String(basePort),
        '--seed-source', 'daily=null', '--allow-profile', 'research',
        '--chrome-path', chrome, '--extension-dir', config.extensionDir, '--host-path', native,
      ];
      await command(enrollment);
      const workerPath = join(workerRoot, 'worker.json');
      const workerBytes = await readFile(workerPath, 'utf8');
      const worker = JSON.parse(workerBytes);
      assert.equal(worker.port, 12320, 'worker HTTP port retains the original default without binding production');
      assert.equal(worker.seedSources.daily, null, 'empty enrollment must not read a daily profile');
      assert.deepEqual(worker.profiles, ['browser', 'research'], 'enrollment persists the coordinator profile allowlist');
      assert.equal((await stat(workerPath)).mode & 0o777, 0o600, 'worker credentials must be owner-only');
      const enrolledFleet = JSON.parse(await readFile(join(workerRoot, 'fleet.json'), 'utf8'));
      assert.deepEqual(enrolledFleet.profiles.map((profile) => profile.name), ['browser']);
      const enrolledPid = Number(await readFile(join(workerRoot, 'run/browser.pid'), 'utf8'));
      assert.doesNotThrow(() => process.kill(enrolledPid, 0), 'successful enrollment must provision a real detached Chrome');
      const repeatEnrollment = [...enrollment];
      repeatEnrollment[2] = 'enroll';
      await command(repeatEnrollment, false);
      assert.equal(await readFile(workerPath, 'utf8'), workerBytes, 're-enrollment must not rotate existing credentials');
      for (const action of ['install-agent', 'uninstall-agent']) {
        await command(['fleet', 'worker', action, '--root', workerRoot, '--host-path', native], false);
      }
      await assert.rejects(stat(join(scope.env.HOME, 'Library/LaunchAgents/com.humanchrome.fleet-worker.plist')), { code: 'ENOENT' });
      await command(['fleet', 'stop', 'browser', '--root', workerRoot, '--host-path', native]);
      await command(['fleet', 'profile', 'rm', 'browser', '--root', workerRoot, '--delete-data']);
      observed.push('real isolated worker enrollment, preserved credentials and opt-in launchd guards');
      console.log(`PASS isolated CfT lifecycle: ${observed.join('; ')}`);
      return observed;
    } finally {
      if (gateway && gateway.exitCode === null) {
        gateway.kill('SIGTERM');
        const timer = setTimeout(() => gateway.kill('SIGKILL'), 15_000);
        try { await gatewayExit; } finally { clearTimeout(timer); }
      }
      // Re-read process identity before either signal; a reused PID cannot authorize a kill.
      const roots = [root, await realpath(root).catch(() => root)];
      async function ownedBrowsers() {
        const listing = scope.spawn('/bin/ps', ['-axo', 'pid=,command=']);
        let rows = '';
        listing.stdout.on('data', (chunk) => { rows += chunk; });
        await once(listing, 'exit');
        return rows.split('\n').flatMap((row) => {
          const match = row.trim().match(/^(\d+)\s+(.*)$/);
          return match && !match[2].includes('--type=') && roots.some((root) => match[2].includes(`--user-data-dir=${root}/profiles/`))
            ? [Number(match[1])] : [];
        });
      }
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const pid of await ownedBrowsers()) {
          try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const deadline = Date.now() + 10_000;
        while ((await ownedBrowsers()).length && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.deepEqual(await ownedBrowsers(), [], 'owned Chrome must exit before temporary profile deletion');
      await profilePorts?.release();
      if (fixture.listening) await new Promise((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    }
  });
}

async function reserveProfilePorts() {
  for (let attempt = 0; attempt < 32; attempt++) {
    // Stay below macOS's ephemeral range: outbound browser/fixture requests must
    // not consume the next sequential profile port before provisioning reaches it.
    const basePort = randomInt(20_000, 30_000);
    const listeners = [];
    const release = async (index) => {
      const selected = index === undefined ? listeners : [listeners[index]];
      await Promise.all(selected.map((listener) => !listener?.listening ? undefined
        : new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))));
    };
    try {
      for (let index = 0; index < 2; index++) {
        const listener = createNetServer((socket) => socket.destroy());
        listeners.push(listener);
        listener.listen(basePort + index, '127.0.0.1');
        await once(listener, 'listening');
      }
      return { basePort, release };
    } catch (error) {
      await release();
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no isolated consecutive profile ports available');
}
