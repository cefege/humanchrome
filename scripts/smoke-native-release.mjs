#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXECUTABLES = ['humanchrome-nativehost', 'humanchrome-bridge', 'humanchrome-stdio'];

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) fail(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (!['archive', 'engines-archive'].includes(key)) fail(`unknown option: ${argument}`);
    if (values.has(key)) fail(`option supplied more than once: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${argument}`);
    values.set(key, value);
    index += 1;
  }
  if (!values.has('archive')) {
    fail('usage: node scripts/smoke-native-release.mjs --archive <native archive> [--engines-archive <engines archive>]');
  }
  return {
    archive: resolve(ROOT, values.get('archive')),
    enginesArchive: values.has('engines-archive') ? resolve(ROOT, values.get('engines-archive')) : undefined,
  };
}

async function requireFile(path, description) {
  let details;
  try {
    details = await stat(path);
  } catch {
    fail(`${description} is missing: ${path}`);
  }
  if (!details.isFile()) fail(`${description} is not a file: ${path}`);
}

async function assertChecksum(archive) {
  const checksumPath = `${archive}.sha256`;
  await requireFile(checksumPath, 'native release checksum');
  const expected = `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${basename(archive)}\n`;
  const actual = await readFile(checksumPath, 'utf8');
  if (actual !== expected) fail(`native release checksum does not match ${basename(archive)}`);
}

async function extractArchive(archive, destination) {
  if (archive.endsWith('.zip')) {
    const command = `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`;
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ]);
  } else if (archive.endsWith('.tar.gz')) {
    await execFileAsync('tar', ['-xzf', archive, '-C', destination]);
  } else {
    fail(`unsupported native archive: ${archive}`);
  }
}

function executablePath(releaseRoot, name) {
  return join(releaseRoot, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
}

async function locateReleaseRoot(extractionRoot) {
  const entries = await readdir(extractionRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1 || !directories[0].name.startsWith('humanchrome-native-')) {
    fail('native archive must contain exactly one humanchrome-native release directory');
  }
  return join(extractionRoot, directories[0].name);
}

async function assertArchiveLayout(releaseRoot) {
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const allowedEntries = new Set([
    ...EXECUTABLES.map((name) => `${name}${suffix}`),
    'LICENSE',
    'licenses',
    'mcp',
  ]);
  for (const entry of entries) {
    if (!allowedEntries.has(entry.name)) fail(`native archive has an unexpected entry: ${entry.name}`);
  }
  for (const name of EXECUTABLES) {
    const path = executablePath(releaseRoot, name);
    await requireFile(path, `native executable ${name}`);
    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode;
      if ((mode & 0o111) === 0) fail(`native executable is not executable: ${path}`);
    }
  }
  for (const obsolete of ['run_host.sh', 'run_host.bat', 'node_path.txt', 'adapters', 'node_modules']) {
    if (names.has(obsolete)) fail(`native archive includes obsolete runtime entry: ${obsolete}`);
  }
  await requireFile(join(releaseRoot, 'mcp/stdio-config.json'), 'packaged stdio configuration');
  const mcpEntries = await readdir(join(releaseRoot, 'mcp'), { withFileTypes: true });
  if (mcpEntries.length !== 1 || !mcpEntries[0].isFile() || mcpEntries[0].name !== 'stdio-config.json') {
    fail('native archive mcp directory must contain only stdio-config.json');
  }
  const packagedConfig = await readFile(join(releaseRoot, 'mcp/stdio-config.json'), 'utf8');
  const sourceConfig = await readFile(join(ROOT, 'app/native-server/contracts/stdio-config.json'), 'utf8');
  if (packagedConfig !== sourceConfig) fail('packaged stdio configuration differs from the source contract');
  const licenses = join(releaseRoot, 'licenses');
  const licenseEntries = await readdir(licenses, { withFileTypes: true });
  if (!licenseEntries.some((entry) => entry.isFile())) fail('native archive has no license notices');
}

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function assertNoSymbolicLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) fail(`optional engines archive contains a symbolic link: ${path}`);
    if (details.isDirectory()) await assertNoSymbolicLinks(path);
  }
}

async function locateEnginesRoot(extractionRoot) {
  const entries = await readdir(extractionRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1 || !directories[0].name.startsWith('humanchrome-engines-')) {
    fail('optional engines archive must contain exactly one humanchrome-engines release directory');
  }
  return join(extractionRoot, directories[0].name);
}

async function assertOptionalEnginesLayout(enginesRoot) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('optional engine smoke requires a darwin arm64 host');
  }
  const entries = await readdir(enginesRoot, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].name !== 'adapters') {
    fail('optional engines archive must contain only the adapters directory');
  }
  const adapters = join(enginesRoot, 'adapters');
  const thirdParty = join(adapters, 'third-party.mjs');
  const node = join(adapters, 'runtime', 'bin', 'node');
  const codex = join(adapters, 'runtime', 'bin', 'codex');
  const devtools = join(adapters, 'devtools-engine.mjs');
  const metadataPath = join(adapters, 'optional-engines.json');
  const sdkManifest = join(adapters, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
  const platformSdkManifest = join(adapters, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'package.json');
  for (const [path, description] of [
    [thirdParty, 'optional third-party adapter'],
    [devtools, 'optional DevTools adapter'],
    [join(adapters, 'package.json'), 'optional adapter manifest'],
    [sdkManifest, 'Claude SDK manifest'],
    [platformSdkManifest, 'arm64 Claude SDK manifest'],
    [join(adapters, 'licenses', 'NOTICE.json'), 'optional dependency notices'],
    [node, 'bundled Node runtime'],
    [codex, 'bundled Codex runtime'],
    [metadataPath, 'optional engine metadata'],
  ]) {
    await requireFile(path, description);
  }
  await assertNoSymbolicLinks(adapters);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.schemaVersion !== 1 || metadata.target !== 'aarch64-apple-darwin'
    || metadata.sdk?.version !== '0.3.215'
    || typeof metadata.sdk?.packageJsonSha256 !== 'string'
    || metadata.sdk?.platform?.version !== '0.3.215'
    || typeof metadata.sdk?.platform?.packageJsonSha256 !== 'string'
    || metadata.devtools?.version !== '1.0.1662965'
    || typeof metadata.adapter?.thirdPartySha256 !== 'string'
    || metadata.node?.version !== 'v24.22.2'
    || metadata.node?.sourceUrl !== 'https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.xz'
    || metadata.node?.archiveSha256 !== '1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115'
    || metadata.codex?.version !== '0.154.0'
    || typeof metadata.codex?.sourcePath !== 'string') {
    fail(`optional engine metadata is incomplete or has unexpected versions: ${metadataPath}`);
  }
  for (const [path, expected, description] of [
    [thirdParty, metadata.adapter.thirdPartySha256, 'third-party adapter'],
    [devtools, metadata.devtools.engineSha256, 'DevTools engine'],
    [sdkManifest, metadata.sdk.packageJsonSha256, 'Claude SDK manifest'],
    [platformSdkManifest, metadata.sdk.platform.packageJsonSha256, 'arm64 Claude SDK manifest'],
    [node, metadata.node.binarySha256, 'bundled Node runtime'],
    [codex, metadata.codex.binarySha256, 'bundled Codex runtime'],
  ]) {
    if (!/^[a-f0-9]{64}$/.test(expected) || await hashFile(path) !== expected) {
      fail(`optional ${description} checksum does not match its metadata`);
    }
  }
  for (const [path, description] of [[node, 'bundled Node runtime'], [codex, 'bundled Codex runtime']]) {
    if (((await stat(path)).mode & 0o111) === 0) fail(`optional ${description} is not executable: ${path}`);
  }
  const [sdk, platformSdk] = await Promise.all([
    JSON.parse(await readFile(sdkManifest, 'utf8')),
    JSON.parse(await readFile(platformSdkManifest, 'utf8')),
  ]);
  if (sdk.version !== metadata.sdk.version || platformSdk.version !== metadata.sdk.platform.version) {
    fail('optional Claude SDK package versions do not match engine metadata');
  }
  return { adapters, node, codex };
}

async function overlayOptionalEngines(installedRoot, engines) {
  await cp(engines.adapters, join(installedRoot, 'adapters'), {
    recursive: true,
    force: false,
    dereference: false,
  });
  await assertNoSymbolicLinks(join(installedRoot, 'adapters'));
}

function childEnvironment(home, temporaryRoot, extra = {}) {
  const emptyPath = join(temporaryRoot, 'no-node-on-path');
  const path = process.platform === 'win32' && process.env.SystemRoot
    ? [emptyPath, join(process.env.SystemRoot, 'System32')].join(delimiter)
    : emptyPath;
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: join(temporaryRoot, 'tmp'),
    TMP: join(temporaryRoot, 'tmp'),
    TMPDIR: join(temporaryRoot, 'tmp'),
    PATH: path,
    HC_DISABLE_DAEMON: '1',
    HC_INSTANCE_REGISTRY_DIR: join(temporaryRoot, 'instances'),
    HC_BRIDGE_DAEMON_SOCKET: join(temporaryRoot, 'native.sock'),
    ...extra,
  };
  if (process.platform === 'win32') env.PATHEXT = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  return env;
}

function invoke(executable, args, env) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(executable, args, {
      cwd: resolve(executable, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveProcess({ code, signal, stdout, stderr }));
  });
}

const TRACE_FIXTURE = {
  traceEvents: [
    {
      args: { name: 'CrBrowserMain' },
      cat: '__metadata',
      name: 'thread_name',
      ph: 'M',
      pid: 101,
      tid: 1,
      ts: 0,
    },
    {
      args: {
        data: {
          frame: 'FRAME-1',
          frames: [{ frame: 'FRAME-1', name: '', processId: 101, url: 'https://example.test/' }],
          persistentIds: true,
        },
      },
      cat: 'disabled-by-default-devtools.timeline',
      name: 'TracingStartedInBrowser',
      ph: 'I',
      pid: 101,
      s: 't',
      tid: 1,
      ts: 1,
    },
    {
      args: {
        data: {
          documentLoaderURL: 'https://example.test/',
          frame: 'FRAME-1',
          isOutermostMainFrame: true,
          navigationId: 'NAV-1',
          url: 'https://example.test/',
        },
      },
      cat: 'loading,devtools.timeline',
      name: 'navigationStart',
      ph: 'R',
      pid: 101,
      s: 't',
      tid: 1,
      ts: 2,
    },
  ],
};

async function exerciseOptionalEngines(installedRoot, temporaryRoot, env) {
  const adapters = join(installedRoot, 'adapters');
  const node = join(adapters, 'runtime', 'bin', 'node');
  const codex = join(adapters, 'runtime', 'bin', 'codex');
  const nodeVersion = await invoke(node, ['--version'], env);
  if (nodeVersion.code !== 0 || nodeVersion.stdout.trim() !== 'v24.22.2') {
    fail(`bundled Node runtime did not start without PATH lookup: ${nodeVersion.stderr}`);
  }
  const codexVersion = await invoke(codex, ['--version'], env);
  if (codexVersion.code !== 0 || !/\b0\.154\.0\b/.test(`${codexVersion.stdout}\n${codexVersion.stderr}`)) {
    fail(`bundled Codex runtime did not start without PATH lookup: ${codexVersion.stderr}`);
  }
  const trace = join(temporaryRoot, 'optional-engine-trace.json');
  await writeFile(trace, JSON.stringify(TRACE_FIXTURE));
  const adapter = spawn(node, [join(adapters, 'third-party.mjs')], {
    cwd: adapters,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  adapter.stdout.setEncoding('utf8');
  adapter.stderr.setEncoding('utf8');
  adapter.stdout.on('data', (data) => { stdout += data; });
  adapter.stderr.on('data', (data) => { stderr += data; });
  const completed = new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      adapter.kill();
      reject(new Error(`timed out exercising the bundled DevTools adapter: ${stderr}`));
    }, 30_000);
    adapter.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    adapter.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal });
    });
  });
  adapter.stdin.end(`${JSON.stringify({ id: 'optional-engine-trace', method: 'trace.analyze', params: { path: trace } })}\n`);
  const exit = await completed;
  if (exit.code !== 0) fail(`bundled DevTools adapter failed (${exit.signal ?? exit.code}): ${stderr}`);
  const result = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .find((value) => value.id === 'optional-engine-trace' && value.event === 'result');
  if (typeof result?.value?.summary !== 'string' || result.value.summary.length === 0) {
    fail(`bundled DevTools adapter did not return a trace summary: ${stdout || stderr}`);
  }
  return trace;
}

function waitForClose(child) {
  return new Promise((resolveExit) => child.once('close', resolveExit));
}


function expectedManifestPath(home) {
  const filename = 'com.humanchrome.nativehost.json';
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', filename);
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Roaming', 'Google', 'Chrome', 'NativeMessagingHosts', filename);
  }
  return join(home, '.config', 'google-chrome', 'NativeMessagingHosts', filename);
}

async function assertRegistration(bridge, nativeHost, home, env) {
  const manifestPath = expectedManifestPath(home);
  await mkdir(resolve(manifestPath, '..'), { recursive: true });
  const foreign = '{"name":"foreign.example","path":"/not/humanchrome"}\n';
  await writeFile(manifestPath, foreign, 'utf8');
  const refused = await invoke(bridge, ['register', '--browser', 'chrome', '--host-path', nativeHost], env);
  if (refused.code === 0) fail('register accepted a foreign native-messaging manifest');
  if ((await readFile(manifestPath, 'utf8')) !== foreign) fail('register changed a foreign native-messaging manifest');
  await rm(manifestPath);

  if (process.platform === 'darwin') {
    const protectedHost = join(home, 'Documents', 'humanchrome-nativehost');
    await mkdir(resolve(protectedHost, '..'), { recursive: true });
    await copyFile(nativeHost, protectedHost);
    await chmod(protectedHost, 0o755);
    const tccRefusal = await invoke(bridge, ['register', '--browser', 'chrome', '--host-path', protectedHost], env);
    if (tccRefusal.code === 0 || !/TCC-protected/i.test(tccRefusal.stderr)) {
      fail(`register did not reject TCC-protected host path: ${tccRefusal.stderr}`);
    }
  }

  const registered = await invoke(bridge, ['register', '--browser', 'chrome'], env);
  if (registered.code !== 0) fail(`register failed: ${registered.stderr}`);
  let installedHost;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    installedHost = manifest.path;
    if (installedHost === await realpath(nativeHost) || manifest.type !== 'stdio'
      || basename(installedHost) !== basename(nativeHost)
      || basename(dirname(dirname(installedHost))) !== 'releases') {
      fail('registration must target a complete installed native release, not the extracted archive');
    }
    await assertArchiveLayout(dirname(installedHost));
    const previousHost = installedHost;
    const installedBridge = executablePath(dirname(installedHost), 'humanchrome-bridge');
    const updated = await invoke(installedBridge, ['update-port', '12666'], env);
    if (updated.code !== 0) fail(`installed update-port failed: ${updated.stderr}`);
    const preserved = await readFile(join(dirname(installedHost), 'mcp/stdio-config.json'), 'utf8');
    const upgraded = await invoke(bridge, ['register', '--browser', 'chrome', '--force'], env);
    if (upgraded.code !== 0) fail(`native release upgrade failed: ${upgraded.stderr}`);
    const next = JSON.parse(await readFile(manifestPath, 'utf8'));
    installedHost = next.path;
    if (installedHost === previousHost) fail('archive upgrade did not activate a distinct complete release');
    await requireFile(previousHost, 'retained previous native release');
    if (await readFile(join(dirname(installedHost), 'mcp/stdio-config.json'), 'utf8') !== preserved) {
      fail('native release upgrade changed the installed stdio configuration');
    }
    for (const executable of EXECUTABLES) {
      await requireFile(executablePath(dirname(installedHost), executable), `installed ${executable}`);
    }

    if (process.platform === 'win32') {
      const registry = await invoke(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), [
        'query',
        'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.humanchrome.nativehost',
        '/ve',
      ], env);
      const registeredPath = registry.stdout.match(/\bREG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
      if (registry.code !== 0 || !registeredPath) {
        fail(`Windows HKCU native-messaging query failed (${registry.code}): ${registry.stdout}\n${registry.stderr}`);
      }
      // Windows can render the same file with different case, 8.3 aliases, or a
      // verbatim path prefix. Compare file identity, not CLI path spelling.
      const [registeredFile, expectedFile] = await Promise.all([
        stat(registeredPath, { bigint: true }),
        stat(manifestPath, { bigint: true }),
      ]);
      if (registeredFile.dev !== expectedFile.dev || registeredFile.ino !== expectedFile.ino) {
        fail(`Windows HKCU native-messaging value targets ${registeredPath}, expected ${manifestPath}`);
      }
    }
  } finally {
    const unregistered = await invoke(bridge, ['unregister', '--browser', 'chrome', '--host-path', installedHost], env);
    if (unregistered.code !== 0) fail(`unregister failed: ${unregistered.stderr}`);
  }
  try {
    await stat(manifestPath);
    fail('unregister left the owned native-messaging manifest behind');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (process.platform === 'win32') {
    const registry = await invoke(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), [
      'query',
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.humanchrome.nativehost',
    ], env);
    if (registry.code === 0) fail('unregister left the Windows HKCU native-messaging registration behind');
  }
  return dirname(installedHost);
}

function encodeNativeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function collectNativeFrames(stream, onFrame) {
  let buffer = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const frame = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onFrame(JSON.parse(frame.toString('utf8')));
    }
  });
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('could not reserve loopback port'));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    predicate((value) => {
      clearTimeout(timer);
      resolveValue(value);
    });
  });
}

async function parseMcpResponse(response, label) {
  if (!response.ok) fail(`${label} returned HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const event = text.split('\n').find((line) => line.startsWith('data:'));
    if (!event) fail(`${label} returned a non-JSON MCP response: ${text}`);
    return JSON.parse(event.slice('data:'.length).trim());
  }
}

async function assertMcpAndStdio(stdio, env, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const ping = await fetch(`${baseUrl}/ping`);
  if (!ping.ok) fail(`/ping returned HTTP ${ping.status}`);

  const protocolVersion = '2025-06-18';
  const initialized = await parseMcpResponse(await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: { name: 'native-release-smoke', version: '1.0.0' } },
    }),
  }), 'MCP initialize');
  if (!initialized.result) fail('MCP initialize did not return a result');

  const tools = await parseMcpResponse(await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  }), 'MCP tools/list');
  if (!Array.isArray(tools.result?.tools) || tools.result.tools.length === 0) {
    fail('MCP tools/list did not return the native tool catalog');
  }

  const proxy = spawn(stdio, [], {
    cwd: resolve(stdio, '..'),
    env: { ...env, HUMANCHROME_URL: `${baseUrl}/mcp` },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  proxy.stderr.setEncoding('utf8');
  proxy.stderr.on('data', (data) => { stderr += data; });
  const response = new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for stdio tools/list: ${stderr}`)), 15_000);
    proxy.stdout.setEncoding('utf8');
    let pending = '';
    proxy.stdout.on('data', (chunk) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline === -1) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        if (value.id === 77) {
          clearTimeout(timer);
          resolveResponse(value);
        }
      }
    });
  });
  let completed = false;
  try {
    proxy.stdin.write('{"jsonrpc":"2.0","id":77,"method":"tools/list","params":{}}\n');
    const value = await response;
    if (!Array.isArray(value.result?.tools) || value.result.tools.length === 0) {
      fail('humanchrome-stdio did not proxy tools/list through the native bridge');
    }
    completed = true;
  } finally {
    const exited = waitForClose(proxy);
    proxy.stdin.end();
    if (!completed && !proxy.killed) proxy.kill();
    await exited;
  }
}

async function assertFramingAndServices(nativeHost, stdio, env, optionalTrace) {
  const port = await reservePort();
  const host = spawn(nativeHost, [], {
    cwd: resolve(nativeHost, '..'),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', (data) => { stderr += data; });
  let finishFrame;
  let finishTrace;
  const traceRequestId = 'optional-engine-native-trace';
  const started = waitFor((finish) => { finishFrame = finish; }, 15_000, 'native host server_started frame');
  const traceResult = optionalTrace
    ? waitFor((finish) => { finishTrace = finish; }, 30_000, 'native bundled DevTools trace response')
    : undefined;
  collectNativeFrames(host.stdout, (frame) => {
    if (frame.type === 'server_started') finishFrame?.(frame);
    if (frame.type === 'file_operation_response' && frame.responseToRequestId === traceRequestId) finishTrace?.(frame);
    if (frame.type === 'rr_list_published_flows' && frame.requestId) {
      host.stdin.write(encodeNativeFrame({
        responseToRequestId: frame.requestId,
        payload: { status: 'success', items: [] },
      }));
    }
  });
  try {
    host.stdin.write(encodeNativeFrame({ type: 'start', payload: { port } }));
    const frame = await started;
    if (frame.payload?.port !== port) fail(`native host started on unexpected port: ${JSON.stringify(frame)}`);
    await assertMcpAndStdio(stdio, env, port);
    if (optionalTrace) {
      host.stdin.write(encodeNativeFrame({
        type: 'file_operation',
        requestId: traceRequestId,
        payload: { action: 'analyzeTrace', traceFilePath: optionalTrace },
      }));
      const response = await traceResult;
      if (response.payload?.success !== true || typeof response.payload?.summary !== 'string') {
        fail(`native host did not use the overlaid DevTools engine: ${JSON.stringify(response)}`);
      }
    }
  } finally {
    const exited = waitForClose(host);
    host.stdin.end();
    if (!host.killed) host.kill();
    await exited;
  }
  if (stderr.includes('node: not found')) fail(`native core required Node during startup: ${stderr}`);
}


async function main() {
  const { archive, enginesArchive } = parseArguments(process.argv.slice(2));
  await requireFile(archive, 'native release archive');
  await assertChecksum(archive);
  if (enginesArchive) {
    await requireFile(enginesArchive, 'optional engines archive');
    await assertChecksum(enginesArchive);
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), `humanchrome-native-smoke-${randomUUID()}-`));
  try {
    const extractionRoot = join(temporaryRoot, 'archive');
    const enginesExtractionRoot = join(temporaryRoot, 'engines-archive');
    const home = join(temporaryRoot, 'home');
    await Promise.all([
      mkdir(extractionRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(join(temporaryRoot, 'tmp'), { recursive: true }),
      mkdir(join(temporaryRoot, 'no-node-on-path'), { recursive: true }),
      ...(enginesArchive ? [mkdir(enginesExtractionRoot, { recursive: true })] : []),
    ]);
    await extractArchive(archive, extractionRoot);
    const releaseRoot = await locateReleaseRoot(extractionRoot);
    await assertArchiveLayout(releaseRoot);
    let engines;
    if (enginesArchive) {
      await extractArchive(enginesArchive, enginesExtractionRoot);
      engines = await assertOptionalEnginesLayout(await locateEnginesRoot(enginesExtractionRoot));
    }
    const env = childEnvironment(home, temporaryRoot);
    const nativeHost = executablePath(releaseRoot, 'humanchrome-nativehost');
    const bridge = executablePath(releaseRoot, 'humanchrome-bridge');
    const installedRoot = await assertRegistration(bridge, nativeHost, home, env);
    const optionalTrace = engines
      ? await (async () => {
        await overlayOptionalEngines(installedRoot, engines);
        return exerciseOptionalEngines(installedRoot, temporaryRoot, env);
      })()
      : undefined;
    await assertFramingAndServices(
      executablePath(installedRoot, 'humanchrome-nativehost'),
      executablePath(installedRoot, 'humanchrome-stdio'),
      env,
      optionalTrace,
    );
    process.stdout.write(`native release smoke passed: ${relative(ROOT, archive)}${enginesArchive ? ` with ${relative(ROOT, enginesArchive)}` : ''}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`smoke-native-release: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
