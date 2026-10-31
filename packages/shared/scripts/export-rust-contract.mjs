#!/usr/bin/env node
/**
 * Build the Rust-owned compatibility contract from declarative shared sources.
 *
 * This deliberately compiles `src/rust-contract-source.ts`, not `src/index.ts`.
 * The entrypoint excludes browser/WASM wrappers and the package barrel, so this
 * command stays independent of the general shared build and can be used as a
 * pre-Cargo contract gate.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const ENTRYPOINT = path.join(PACKAGE_ROOT, 'src', 'rust-contract-source.ts');
const ARTIFACT_PATH = path.join(PACKAGE_ROOT, 'generated', 'rust-contract.json');
const SNAPSHOT_PATH = path.join(PACKAGE_ROOT, 'src', 'tool-index.snapshot.json');
const TYPE_DECLARATION_INPUTS = [
  'src/types.ts',
  'src/labels.ts',
  'src/rr-step-types.ts',
  'src/step-types.ts',
  'src/node-spec.ts',
  'src/node-specs-builtin.ts',
  'src/agent-types.ts',
  'src/tool-contract.ts',
  'src/sunset-tool-replacements.ts',
];
const ESBUILD_BIN = path.join(
  PACKAGE_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function usage() {
  return [
    'Usage: node packages/shared/scripts/export-rust-contract.mjs [--check | --stdout]',
    '  --check   fail unless packages/shared/generated/rust-contract.json is fresh',
    '  --stdout  print only the generated JSON; cannot be combined with other flags',
  ].join('\n');
}

function parseArgs(args) {
  if (args.length === 0) return { mode: 'write' };
  if (args.length === 1 && args[0] === '--check') return { mode: 'check' };
  if (args.length === 1 && args[0] === '--stdout') return { mode: 'stdout' };
  throw new Error(usage());
}

function assertDeclarativeMetafile(metafile) {
  const prohibited = [
    'index.ts',
    'tool-index.ts',
    'rr-graph.ts',
    'invalid-args.ts',
    'output-budget.ts',
    'rust-bindings.ts',
  ];
  const forbiddenInputs = Object.keys(metafile.inputs ?? {}).filter((input) =>
    prohibited.some((file) => input.endsWith(`/src/${file}`) || input === `src/${file}`),
  );
  if (forbiddenInputs.length > 0) {
    throw new Error(
      `Declarative contract build imported forbidden runtime sources: ${forbiddenInputs.join(', ')}`,
    );
  }
}

async function compileDeclarativeEntrypoint() {
  const outputDirectory = await mkdtemp(path.join(PACKAGE_ROOT, '.rust-contract-'));
  const outputPath = path.join(outputDirectory, 'contract-inputs.mjs');
  const metafilePath = path.join(outputDirectory, 'metafile.json');
  try {
    await execFileAsync(ESBUILD_BIN, [
      ENTRYPOINT,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node24',
      '--external:zod',
      `--metafile=${metafilePath}`,
      `--outfile=${outputPath}`,
      '--log-level=warning',
    ]);
    assertDeclarativeMetafile(JSON.parse(await readFile(metafilePath, 'utf8')));
    const module = await import(`${pathToFileURL(outputPath).href}?${Date.now()}`);
    if (typeof module.buildRustContractInputs !== 'function') {
      throw new Error('Declarative contract entrypoint did not export buildRustContractInputs()');
    }
    return module.buildRustContractInputs();
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function declarationInputs() {
  const entries = await Promise.all(
    TYPE_DECLARATION_INPUTS.map(async (relativePath) => {
      const source = await readFile(path.join(PACKAGE_ROOT, relativePath), 'utf8');
      return [relativePath, { sha256: sha256(source), source }];
    }),
  );
  return Object.fromEntries(entries);
}

function assertDescriptorSnapshot(snapshot, contract) {
  const descriptor = contract.descriptor;
  if (
    descriptor.toolCount !== snapshot.toolCount ||
    descriptor.descriptionLength !== snapshot.descriptionLength ||
    descriptor.descriptionSha256 !== snapshot.descriptionSha256 ||
    descriptor.description !== snapshot.description
  ) {
    throw new Error('Descriptor snapshot changed while exporting the Rust contract; update it only intentionally.');
  }
  if (JSON.stringify(descriptor.toolNames) !== JSON.stringify(snapshot.toolNames)) {
    throw new Error('Descriptor tool-name order changed while exporting the Rust contract.');
  }
}

export async function buildContract() {
  const [snapshotSource, inputs, declarations] = await Promise.all([
    readFile(SNAPSHOT_PATH, 'utf8'),
    compileDeclarativeEntrypoint(),
    declarationInputs(),
  ]);
  const snapshot = JSON.parse(snapshotSource);
  const descriptor = {
    toolCount: snapshot.toolCount,
    descriptionLength: snapshot.descriptionLength,
    descriptionSha256: snapshot.descriptionSha256,
    toolNames: snapshot.toolNames,
    description: snapshot.description,
  };
  const contract = {
    formatVersion: 1,
    generatedFrom: {
      entrypoint: 'packages/shared/src/rust-contract-source.ts',
      declarationInputs: declarations,
      descriptorSnapshot: 'packages/shared/src/tool-index.snapshot.json',
    },
    ...inputs,
    descriptor,
  };
  assertDescriptorSnapshot(snapshot, contract);
  return `${JSON.stringify(contract, null, 2)}\n`;
}

export async function main(args = process.argv.slice(2)) {
  const { mode } = parseArgs(args);
  const generated = await buildContract();

  if (mode === 'stdout') {
    process.stdout.write(generated);
    return;
  }

  if (mode === 'check') {
    let committed;
    try {
      committed = await readFile(ARTIFACT_PATH, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Missing generated contract artifact: ${path.relative(ROOT, ARTIFACT_PATH)}`);
      }
      throw error;
    }
    if (committed !== generated) {
      throw new Error(
        `Rust contract artifact is stale. Run: node packages/shared/scripts/export-rust-contract.mjs`,
      );
    }
    return;
  }

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, generated, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
