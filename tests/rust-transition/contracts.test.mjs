import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');

async function withIsolatedContract(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hc-contract-test-'));
  const shared = path.join(directory, 'packages/shared');
  await mkdir(path.join(shared, 'scripts'), { recursive: true });
  try {
    await cp(path.join(ROOT, 'packages/shared/src'), path.join(shared, 'src'), { recursive: true });
    await cp(path.join(ROOT, 'packages/shared/scripts/export-rust-contract.mjs'), path.join(shared, 'scripts/export-rust-contract.mjs'));
    await cp(path.join(ROOT, 'packages/shared/generated'), path.join(shared, 'generated'), { recursive: true });
    await symlink(path.join(ROOT, 'packages/shared/node_modules'), path.join(shared, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const invoke = (...args) => spawnSync(process.execPath, [path.join(shared, 'scripts/export-rust-contract.mjs'), ...args], { encoding: 'utf8', timeout: 30_000 });
    await run({ shared, invoke });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('stale artifact blocks the gate without overwriting the evidence', async () => {
  await withIsolatedContract(async ({ shared, invoke }) => {
    const file = path.join(shared, 'generated/rust-contract.json');
    const corrupted = `${await readFile(file, 'utf8')} `;
    await writeFile(file, corrupted);
    const result = invoke('--check');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /contract artifact is stale/);
    assert.equal(await readFile(file, 'utf8'), corrupted);
  });
});

test('contract build rejects a newly introduced runtime dependency cycle', async () => {
  await withIsolatedContract(async ({ shared, invoke }) => {
    const entry = path.join(shared, 'src/rust-contract-source.ts');
    await writeFile(entry, `${await readFile(entry, 'utf8')}\nimport './index';\n`);
    const result = invoke('--stdout');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /runtime|forbidden|declarative/i);
    assert.equal(result.stdout, '');
  });
});
