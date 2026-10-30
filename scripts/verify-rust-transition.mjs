#!/usr/bin/env node
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT, captureProcess, isolatedRun } from '../tests/rust-transition/process-host.mjs';
import { framingFixture, httpFixture } from '../tests/rust-transition/native-fixtures.mjs';

const suites = new Set(['contracts', 'native', 'agent', 'fleet', 'browser']);
const args = process.argv.slice(2);
assert(args.length === 1 && args[0] === '--coverage' || args.length === 2 && args[0] === '--suite' && suites.has(args[1]),
  'usage: node scripts/verify-rust-transition.mjs --suite contracts|native|agent|fleet|browser OR --coverage');

async function requireFile(path, command, executable = false) {
  try { await access(path, executable ? constants.X_OK : constants.R_OK); }
  catch { throw new Error(`Missing prerequisite ${relative(ROOT, path)}; run ${command}`); }
}

async function processBaseline() {
  return {
    framing: await framingFixture(),
    lazy: await httpFixture(),
    legacy: await httpFixture('legacy'),
  };
}

async function verifyBaseline() {
  const fixture = JSON.parse(await readFile(join(ROOT, 'tests/rust-transition/typescript-baseline.json'), 'utf8'));
  const actual = await processBaseline();
  assert.deepStrictEqual(actual, fixture.process, 'Rust public framing/HTTP/MCP contract drift');
  console.log('PASS Rust: split/coalesced frames, invalid lengths/JSON, 100-frame yielding, HTTP, concurrent MCP, catalog/help/aliases and security');
  return actual;
}

async function verifyContracts() {
  const exporter = join(ROOT, 'packages/shared/scripts/export-rust-contract.mjs');
  const rust = join(ROOT, 'target/release/examples', `export${process.platform === 'win32' ? '.exe' : ''}`);
  await requireFile(rust, 'cargo build -p humanchrome-contracts --example export --release', true);
  await isolatedRun(async (scope) => {
    await captureProcess(process.execPath, [exporter, '--check'], scope);
    const typescript = await captureProcess(process.execPath, [exporter, '--stdout'], scope);
    const candidate = await captureProcess(rust, [], scope);
    assert.equal(candidate, typescript, 'Rust embedded contract bytes diverge from declarative TypeScript export');
    JSON.parse(candidate);
  });
  console.log('PASS contracts: generated artifact fresh; separate Rust and TypeScript processes emit identical bytes');
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(relative(ROOT, path).replaceAll('\\', '/'));
  }
  return result;
}

async function verifyCoverage() {
  const inventory = JSON.parse(await readFile(join(ROOT, 'tests/rust-transition/source-map.json'), 'utf8'));
  const { verifySourceCoverage } = await import('../tests/rust-transition/source-coverage.mjs');
  const result = await verifySourceCoverage({ root: ROOT, inventory, walk });
  console.log(`PASS coverage: ${result.files} production files classified (${result.active} active Rust-owned boundaries, ${result.pending} pending policy boundaries)`);
}

async function verifyBrowser() {
  assert.equal(process.platform, 'darwin', 'the native browser gate requires isolated macOS Chrome for Testing');
  const candidate = process.env.HC_TEST_NATIVE_BIN ?? join(ROOT, 'target/release/humanchrome-nativehost');
  await requireFile(candidate, 'cargo build --locked --release -p humanchrome-native --bins', true);
  assert(process.env.HC_CHROME_PATH, 'HC_CHROME_PATH must select Chrome for Testing, not the daily browser');
  await isolatedRun(async (scope) => {
    // Framing fixtures accelerate idle exit to 1s; browser reload uses the real 5-minute default.
    scope.env.HC_DAEMON_IDLE_TIMEOUT_MS = '0';
    const extensionRoot = join(ROOT, 'app/chrome-extension');
    const buildDirectory = join(scope.directory, 'extension-build');
    const wxtEntry = createRequire(join(extensionRoot, 'package.json')).resolve('wxt');
    const buildProgram = `process.chdir(${JSON.stringify(extensionRoot)}); const { build } = await import(${JSON.stringify(pathToFileURL(wxtEntry).href)}); await build(${JSON.stringify({ root: extensionRoot, outDir: buildDirectory, alias: { 'humanchrome-shared': join(ROOT, 'packages/shared/src/index.ts') } })});`;
    process.stdout.write(await captureProcess(process.execPath, ['--input-type=module', '-e', buildProgram],
      scope, { timeoutMs: 180_000 }));
    scope.env.HC_E2E_EXTENSION_DIR = join(buildDirectory, 'chrome-mv3');
    scope.env.HC_TEST_NATIVE_BIN = candidate;
    const manifestDirectory = join(scope.env.HOME, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(manifestDirectory, 'com.humanchrome.nativehost.json'), JSON.stringify({
      name: 'com.humanchrome.nativehost',
      description: 'Isolated Rust transition candidate',
      path: candidate,
      type: 'stdio',
      allowed_origins: ['chrome-extension://hbdgbgagpkpjffpklnamcljpakneikee/'],
    }));
    const outputDirectory = join(ROOT, 'target/rust-transition');
    await mkdir(outputDirectory, { recursive: true });
    const output = join(outputDirectory, `browser-${scope.directory.split('/').at(-1)}.json`);
    console.log(`Browser evidence: ${output}`);
    const observed = await captureProcess(process.execPath, [
      join(ROOT, 'scripts/run-e2e-matrix.mjs'), '--launch-chrome', '--with-tasks', '--json', output,
    ], scope, { timeoutMs: 15 * 60 * 1000, gracefulTimeout: true });
    process.stdout.write(observed);
  });
}

try {
  if (args[0] === '--coverage') await verifyCoverage();
  else if (args[1] === 'contracts') await verifyContracts();
  else if (args[1] === 'native') {
    const candidate = join(ROOT, 'target/release', `humanchrome-nativehost${process.platform === 'win32' ? '.exe' : ''}`);
    await requireFile(candidate, 'cargo build -p humanchrome-native --release', true);
    await verifyBaseline();
    const { verify } = await import('../tests/rust-transition/native-suite.mjs');
    await verify();
  } else if (args[1] === 'browser') {
    await verifyBrowser();
  } else {
    const file = join(ROOT, 'tests/rust-transition', `${args[1]}-suite.mjs`);
    await requireFile(file, `complete the ${args[1]} migration gate fixtures before attempting cutover`);
    const { verify } = await import(pathToFileURL(file).href);
    await verify();
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
