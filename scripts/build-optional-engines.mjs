#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildEngineAdapters } from '../app/native-server/scripts/build-devtools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'aarch64-apple-darwin';
const NODE_VERSION = '24.22.2';
const NODE_ARCHIVE_SHA256 = '1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115';
const NODE_DISTRIBUTION_URL = 'https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.xz';
const CODEX_VERSION = '0.154.0';
const SDK_VERSION = '0.3.215';
const DEVTOOLS_VERSION = '1.0.1662965';
const CPU_TYPE_ARM64 = 0x0100000c;

function fail(message) {
  throw new Error(message);
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function hashFile(path) {
  return digest(await readFile(path));
}

async function requireRegularFile(path, description) {
  let details;
  try {
    details = await stat(path);
  } catch {
    fail(`${description} is missing: ${path}`);
  }
  if (!details.isFile()) fail(`${description} is not a regular file: ${path}`);
  return details;
}

function run(command, arguments_, description) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${description} failed (${result.signal ?? result.status}): ${result.stderr.trim()}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

function isWithin(root, path) {
  const relativePath = relative(root, path);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..');
}

async function materializeTree(source, destination, sourceRoot, ancestors = new Set()) {
  const details = await lstat(source);
  if (details.isSymbolicLink()) {
    const resolved = await realpath(source);
    if (!isWithin(sourceRoot, resolved)) {
      fail(`refusing to materialize dependency symlink outside deployment: ${source} -> ${resolved}`);
    }
    if (ancestors.has(resolved)) fail(`dependency symlink cycle: ${source} -> ${resolved}`);
    return materializeTree(resolved, destination, sourceRoot, new Set([...ancestors, resolved]));
  }
  if (details.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: details.mode & 0o777 });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await materializeTree(join(source, entry.name), join(destination, entry.name), sourceRoot, ancestors);
    }
    return;
  }
  if (!details.isFile()) fail(`dependency deployment contains an unsupported filesystem entry: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, details.mode & 0o777);
}

async function assertNoSymbolicLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) fail(`engine artifact contains a symbolic link: ${path}`);
    if (details.isDirectory()) await assertNoSymbolicLinks(path);
  }
}

async function readPackage(directory, expectedName, expectedVersion) {
  const manifestPath = join(directory, 'package.json');
  await requireRegularFile(manifestPath, `${expectedName} package manifest`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    fail(`locked dependency mismatch at ${manifestPath}: expected ${expectedName}@${expectedVersion}`);
  }
  return manifest;
}

async function copyDependencyNotices(nodeModules, notices) {
  const seenPackages = new Set();
  const copied = new Set();
  const records = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const packageManifest = join(directory, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(packageManifest, 'utf8'));
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        const key = `${manifest.name}@${manifest.version}:${await realpath(directory)}`;
        if (!seenPackages.has(key)) {
          seenPackages.add(key);
          const licenseNames = entries
            .filter((entry) => entry.isFile() && /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(entry.name))
            .map((entry) => entry.name);
          for (const licenseName of licenseNames) {
            const source = join(directory, licenseName);
            const content = await readFile(source);
            const contentHash = digest(content);
            const outputName = `${contentHash}-${licenseName}`;
            if (!copied.has(outputName)) {
              copied.add(outputName);
              await copyFile(source, join(notices, outputName));
            }
            records.push({ package: manifest.name, version: manifest.version, license: manifest.license ?? null, file: outputName });
          }
        }
      }
    } catch {
      // Directories without package manifests are traversed below.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  }
  await mkdir(notices, { recursive: true });
  await visit(nodeModules);
  if (records.length === 0) fail('deployed optional dependencies contained no license notices');
  records.sort((left, right) => `${left.package}@${left.version}:${left.file}`.localeCompare(`${right.package}@${right.version}:${right.file}`));
  await writeFile(join(notices, 'NOTICE.json'), `${JSON.stringify(records, null, 2)}\n`);
}

function isArm64MachO(contents) {
  if (contents.length < 8) return false;
  if (contents.readUInt32LE(0) === 0xfeedfacf) return contents.readUInt32LE(4) === CPU_TYPE_ARM64;
  const magic = contents.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
  const count = contents.readUInt32BE(4);
  const entrySize = magic === 0xcafebabf ? 32 : 20;
  if (contents.length < 8 + (count * entrySize)) return false;
  for (let index = 0; index < count; index += 1) {
    if (contents.readUInt32BE(8 + (index * entrySize)) === CPU_TYPE_ARM64) return true;
  }
  return false;
}

async function installBundledNode(nodeArchive, runtimeBin, extractionRoot, notices) {
  await requireRegularFile(nodeArchive, 'Node distribution archive');
  const archiveHash = await hashFile(nodeArchive);
  if (archiveHash !== NODE_ARCHIVE_SHA256) {
    fail(`Node distribution checksum mismatch: expected ${NODE_ARCHIVE_SHA256}, received ${archiveHash}`);
  }
  await mkdir(extractionRoot, { recursive: true });
  run('tar', ['-xJf', nodeArchive, '-C', extractionRoot], 'Node distribution extraction');
  const entries = await readdir(extractionRoot, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].name !== `node-v${NODE_VERSION}-darwin-arm64`) {
    fail('Node distribution archive has an unexpected top-level directory');
  }
  const distribution = join(extractionRoot, entries[0].name);
  const node = join(distribution, 'bin', 'node');
  await requireRegularFile(node, 'bundled Node executable');
  const version = run(node, ['--version'], 'bundled Node version check');
  if (version !== `v${NODE_VERSION}`) fail(`bundled Node version mismatch: expected v${NODE_VERSION}, received ${version}`);
  await mkdir(runtimeBin, { recursive: true });
  await copyFile(node, join(runtimeBin, 'node'));
  await chmod(join(runtimeBin, 'node'), 0o755);
  await copyFile(join(distribution, 'LICENSE'), join(notices, 'NODE-LICENSE'));
  return {
    version,
    sourceUrl: NODE_DISTRIBUTION_URL,
    archiveSha256: archiveHash,
    binarySha256: await hashFile(join(runtimeBin, 'node')),
  };
}

async function installBundledCodex(codexPath, runtimeBin) {
  const canonical = await realpath(codexPath).catch(() => fail(`Codex executable is missing: ${codexPath}`));
  await requireRegularFile(canonical, 'Codex executable');
  if (!isArm64MachO(await readFile(canonical))) fail(`Codex executable is not an arm64 Mach-O binary: ${canonical}`);
  const versionOutput = run(canonical, ['--version'], 'Codex version check');
  const version = versionOutput.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (version !== CODEX_VERSION) fail(`Codex version mismatch: expected ${CODEX_VERSION}, received ${versionOutput}`);
  const destination = join(runtimeBin, 'codex');
  await copyFile(canonical, destination);
  await chmod(destination, 0o755);
  return { version, sourcePath: canonical, binarySha256: await hashFile(destination) };
}

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'output-dir': { type: 'string' },
    'node-archive': { type: 'string' },
    'codex-path': { type: 'string' },
  },
  strict: true,
});
for (const name of ['target', 'output-dir', 'node-archive', 'codex-path']) {
  if (!values[name]) fail(`--${name} is required`);
}
if (values.target !== TARGET) fail(`optional engines are only supported for ${TARGET}`);
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail(`optional engines for ${TARGET} must be built on darwin arm64 to select the locked native SDK dependency`);
}
const output = resolve(values['output-dir']);
const nodeArchive = resolve(values['node-archive']);
const codexPath = resolve(values['codex-path']);
try {
  await access(output);
  fail(`optional engine output already exists: ${output}; choose a fresh artifact directory`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const engines = join(ROOT, 'packages', 'optional-engines');
const application = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(engines, 'package.json'), 'utf8'));
if (manifest.version !== application.version) fail('optional engine and application versions differ');
if (manifest.dependencies['@anthropic-ai/claude-agent-sdk'] !== `^${SDK_VERSION}`) fail('optional engine SDK dependency is not pinned to the expected locked release');
if (manifest.devDependencies['chrome-devtools-frontend'] !== `^${DEVTOOLS_VERSION}`) fail('optional engine DevTools dependency is not pinned to the expected locked release');
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(dirname(output), '.humanchrome-engines-'));
try {
  const deployedAdapters = join(staging, 'deployed-adapters');
  const adapters = join(staging, 'adapters');
  const packageManager = process.env.npm_execpath;
  const pnpmScript = packageManager && /(?:^|[/\\])pnpm\.(?:c?js|mjs)$/.test(packageManager);
  const command = pnpmScript ? process.execPath : 'pnpm';
  const arguments_ = [
    ...(pnpmScript ? [packageManager] : []),
    '--config.inject-workspace-packages=true', '--config.node-linker=hoisted',
    '--filter', '@humanchrome/optional-engines', 'deploy', '--prod', '--frozen-lockfile',
    '--ignore-scripts', deployedAdapters,
  ];
  const deployed = spawnSync(command, arguments_, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: !pnpmScript && process.platform === 'win32',
  });
  if (deployed.error) throw deployed.error;
  if (deployed.status !== 0) fail(`optional SDK deployment failed (${deployed.signal ?? deployed.status})`);
  await readPackage(join(deployedAdapters, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), '@anthropic-ai/claude-agent-sdk', SDK_VERSION);
  await readPackage(join(deployedAdapters, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64'), '@anthropic-ai/claude-agent-sdk-darwin-arm64', SDK_VERSION);
  await readPackage(join(engines, 'node_modules', 'chrome-devtools-frontend'), 'chrome-devtools-frontend', DEVTOOLS_VERSION);
  await buildEngineAdapters(deployedAdapters, engines);
  await materializeTree(deployedAdapters, adapters, await realpath(deployedAdapters));
  await assertNoSymbolicLinks(adapters);
  await copyFile(join(ROOT, 'LICENSE'), join(adapters, 'LICENSE'));
  await copyDependencyNotices(join(adapters, 'node_modules'), join(adapters, 'licenses'));
  const runtimeBin = join(adapters, 'runtime', 'bin');
  const node = await installBundledNode(
    nodeArchive, runtimeBin, join(staging, 'node-distribution'), join(adapters, 'licenses'),
  );
  const codex = await installBundledCodex(codexPath, runtimeBin);
  const sdkManifest = join(adapters, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
  const platformSdkManifest = join(adapters, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'package.json');
  const sdk = JSON.parse(await readFile(sdkManifest, 'utf8'));
  const platformSdk = JSON.parse(await readFile(platformSdkManifest, 'utf8'));
  const devtools = JSON.parse(await readFile(join(engines, 'node_modules', 'chrome-devtools-frontend', 'package.json'), 'utf8'));
  await writeFile(join(adapters, 'optional-engines.json'), `${JSON.stringify({
    schemaVersion: 1,
    applicationVersion: application.version,
    target: TARGET,
    sdk: {
      name: sdk.name,
      version: sdk.version,
      packageJsonSha256: await hashFile(sdkManifest),
      platform: {
        name: platformSdk.name,
        version: platformSdk.version,
        packageJsonSha256: await hashFile(platformSdkManifest),
      },
    },
    devtools: { name: devtools.name, version: devtools.version, engineSha256: await hashFile(join(adapters, 'devtools-engine.mjs')) },
    adapter: { thirdPartySha256: await hashFile(join(adapters, 'third-party.mjs')) },
    node,
    codex,
    protocol: ['claude.query', 'claude.cancel', 'trace.analyze'],
  }, null, 2)}\n`);
  await assertNoSymbolicLinks(adapters);
  await rm(deployedAdapters, { recursive: true });
  await rm(join(staging, 'node-distribution'), { recursive: true });
  await rename(staging, output);
  console.log(`Built optional engines ${application.version} (${TARGET}, SDK ${sdk.version}, Node ${node.version}, Codex ${codex.version}) at ${output}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
