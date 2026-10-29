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
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXECUTABLES = ['humanchrome-nativehost', 'humanchrome-bridge', 'humanchrome-stdio'];
const LICENSES = [
  ['LICENSE', 'LICENSE'],
  ['app/native-server/LICENSE', 'licenses/native-server-LICENSE'],
  ['packages/shared/LICENSE', 'licenses/shared-LICENSE'],
  ['packages/wasm-simd/LICENSE', 'licenses/wasm-simd-LICENSE'],
];
function fail(message) {
  throw new Error(message);
}

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function assertNoSymbolicLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) fail(`optional engine artifact contains a symbolic link: ${path}`);
    if (details.isDirectory()) await assertNoSymbolicLinks(path);
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) fail(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (!['target', 'bin-dir', 'output-dir', 'engines-dir'].includes(key)) {
      fail(`unknown option: ${argument}`);
    }
    if (values.has(key)) fail(`option supplied more than once: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${argument}`);
    values.set(key, value);
    index += 1;
  }
  for (const key of ['target', 'bin-dir', 'output-dir']) {
    if (!values.has(key)) fail(`missing required option --${key}`);
  }
  const target = values.get('target');
  if (!/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+){2,}$/.test(target)) {
    fail(`invalid Rust target triple: ${target}`);
  }
  return {
    target,
    binDir: resolve(ROOT, values.get('bin-dir')),
    outputDir: resolve(ROOT, values.get('output-dir')),
    enginesDir: values.has('engines-dir') ? resolve(ROOT, values.get('engines-dir')) : undefined,
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

async function readVersion() {
  const [packageJson, cargoToml, cargoLock] = await Promise.all([
    readFile(join(ROOT, 'package.json'), 'utf8'),
    readFile(join(ROOT, 'Cargo.toml'), 'utf8'),
    readFile(join(ROOT, 'Cargo.lock'), 'utf8'),
  ]);
  const packageVersion = JSON.parse(packageJson).version;
  const cargoMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  const lockMatch = cargoLock.match(/\[\[package\]\]\r?\nname = "humanchrome-native"\r?\nversion = "([^"]+)"/);
  if (!cargoMatch) fail('could not resolve workspace Cargo version');
  if (!lockMatch) fail('could not resolve humanchrome-native version in Cargo.lock');
  if (packageVersion !== cargoMatch[1] || packageVersion !== lockMatch[1]) {
    fail(`package, Cargo, and lock versions must match: ${packageVersion}, ${cargoMatch[1]}, ${lockMatch[1]}`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageVersion)) {
    fail(`invalid release version: ${packageVersion}`);
  }
  return packageVersion;
}

function archiveExtension(target) {
  return target.includes('windows') ? 'zip' : 'tar.gz';
}

async function makeArchive(stagingParent, directoryName, destination, target) {
  if (target.includes('windows')) {
    const source = join(stagingParent, directoryName);
    const command = `Compress-Archive -LiteralPath '${source.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -CompressionLevel Optimal -Force`;
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ]);
    return;
  }
  await execFileAsync('tar', ['-czf', destination, '-C', stagingParent, directoryName], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
}

async function writeChecksum(archivePath) {
  const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(checksumPath, `${digest}  ${basename(archivePath)}\n`, 'utf8');
  return checksumPath;
}

export async function copyCoreRelease(stageRoot, binDir, target) {
  const executableSuffix = target.includes('windows') ? '.exe' : '';
  for (const name of EXECUTABLES) {
    const source = join(binDir, `${name}${executableSuffix}`);
    const destination = join(stageRoot, `${name}${executableSuffix}`);
    await requireFile(source, `required native executable ${name}`);
    await copyFile(source, destination);
    if (!target.includes('windows')) await chmod(destination, 0o755);
  }

  const configSource = join(ROOT, 'app/native-server/src/mcp/stdio-config.json');
  await requireFile(configSource, 'stdio configuration');
  await mkdir(join(stageRoot, 'mcp'), { recursive: true });
  await copyFile(configSource, join(stageRoot, 'mcp/stdio-config.json'));

  for (const [sourceRelative, destinationRelative] of LICENSES) {
    const source = join(ROOT, sourceRelative);
    await requireFile(source, `license notice ${sourceRelative}`);
    const destination = join(stageRoot, destinationRelative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function copyOptionalEngines(stageRoot, enginesDir, target, version) {
  if (target !== 'aarch64-apple-darwin') {
    fail(`optional engines are only available for aarch64-apple-darwin, not ${target}`);
  }
  const adapters = join(enginesDir, 'adapters');
  const thirdParty = join(adapters, 'third-party.mjs');
  const devtools = join(adapters, 'devtools-engine.mjs');
  const node = join(adapters, 'runtime', 'bin', 'node');
  const codex = join(adapters, 'runtime', 'bin', 'codex');
  const metadataPath = join(adapters, 'optional-engines.json');
  const sdkManifest = join(adapters, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
  const platformSdkManifest = join(adapters, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'package.json');
  for (const [path, description] of [
    [thirdParty, 'optional third-party adapter'],
    [devtools, 'optional DevTools adapter'],
    [join(adapters, 'package.json'), 'optional adapter manifest'],
    [sdkManifest, 'optional Claude SDK manifest'],
    [platformSdkManifest, 'optional arm64 Claude SDK manifest'],
    [node, 'bundled Node runtime'],
    [codex, 'bundled Codex runtime'],
    [metadataPath, 'optional engine metadata'],
    [join(adapters, 'licenses', 'NOTICE.json'), 'optional dependency notices'],
  ]) {
    await requireFile(path, description);
  }
  let dependencies;
  try {
    dependencies = await stat(join(adapters, 'node_modules'));
  } catch {
    fail(`optional adapter dependencies are missing: ${join(adapters, 'node_modules')}`);
  }
  if (!dependencies.isDirectory()) fail('optional adapter dependencies are not a directory');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.schemaVersion !== 1 || metadata.applicationVersion !== version || metadata.target !== target
    || typeof metadata.sdk?.version !== 'string'
    || typeof metadata.sdk?.packageJsonSha256 !== 'string'
    || typeof metadata.sdk?.platform?.version !== 'string'
    || typeof metadata.sdk?.platform?.packageJsonSha256 !== 'string'
    || typeof metadata.devtools?.version !== 'string'
    || typeof metadata.adapter?.thirdPartySha256 !== 'string'
    || typeof metadata.node?.version !== 'string'
    || typeof metadata.node?.sourceUrl !== 'string'
    || typeof metadata.node?.archiveSha256 !== 'string'
    || typeof metadata.codex?.version !== 'string'
    || typeof metadata.codex?.sourcePath !== 'string') {
    fail(`optional engine metadata is incomplete or targets a different platform: ${metadataPath}`);
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
  await assertNoSymbolicLinks(adapters);
  await cp(adapters, join(stageRoot, 'adapters'), { recursive: true, force: false, dereference: false });
}

async function packageArchive({ outputDir, target, version, kind, populate }) {
  const directoryName = `humanchrome-${kind}-${version}-${target}`;
  const extension = archiveExtension(target);
  const archiveName = `${directoryName}.${extension}`;
  const archivePath = join(outputDir, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  const stagingParent = await mkdtemp(join(tmpdir(), `humanchrome-${kind}-${randomUUID()}-`));
  try {
    const stagingRoot = join(stagingParent, directoryName);
    await mkdir(stagingRoot);
    await populate(stagingRoot);
    await rm(archivePath, { force: true });
    await rm(checksumPath, { force: true });
    await makeArchive(stagingParent, directoryName, archivePath, target);
    await writeChecksum(archivePath);
    return { archivePath, checksumPath };
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!isAbsolute(options.binDir) || !isAbsolute(options.outputDir)) fail('release paths must be absolute');
  const version = await readVersion();
  await mkdir(options.outputDir, { recursive: true });

  const core = await packageArchive({
    outputDir: options.outputDir,
    target: options.target,
    version,
    kind: 'native',
    populate: (stageRoot) => copyCoreRelease(stageRoot, options.binDir, options.target),
  });
  const produced = [core.archivePath, core.checksumPath];

  if (options.enginesDir) {
    const engines = await packageArchive({
      outputDir: options.outputDir,
      target: options.target,
      version,
      kind: 'engines',
      populate: (stageRoot) => copyOptionalEngines(stageRoot, options.enginesDir, options.target, version),
    });
    produced.push(engines.archivePath, engines.checksumPath);
  }

  process.stdout.write(`${produced.map((path) => relative(ROOT, path)).join('\n')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`package-native-release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
