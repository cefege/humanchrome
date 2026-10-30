import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, constants, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT, captureProcess, isolatedRun } from './process-host.mjs';

const RUST_FIXTURE = join(ROOT, 'target/release/examples', `registry-primitives${process.platform === 'win32' ? '.exe' : ''}`);
const STALE_MS = 5 * 60 * 1_000;

await requireExecutable(RUST_FIXTURE, 'cargo build -p humanchrome-native --release --example registry-primitives');

const observed = await observe();
process.stdout.write(`${JSON.stringify(observed)}\n`);

async function observe() {
  return isolatedRun(async (scope) => {
    const directory = join(scope.directory, 'registry');
    const pid = process.pid;
    const nowMs = 1_900_000_000_000;
    const record = {
      pid,
      port: 12_306,
      extensionId: 'registry-fixture',
      instanceId: 'fixture-instance',
      chromeBinary: '/fixture/Chrome',
      startedAt: '2030-03-17T17:46:40.000Z',
    };

    await invoke(scope, { operation: 'write', directory, record });
    const primary = `${pid}.json`;
    const rawKnown = await invoke(scope, { operation: 'readRaw', directory, file: primary });
    const metadata = await stat(join(directory, primary));
    const afterWrite = {
      rawKnown,
      noTrailingNewline: !rawKnown.endsWith('\n'),
      temporaryAbsent: !(await invoke(scope, { operation: 'exists', directory, file: `${primary}.tmp` })),
      mode: process.platform === 'win32' ? undefined : metadata.mode & 0o777,
    };
    assert.equal(rawKnown, JSON.stringify(record, null, 2));
    assert(afterWrite.noTrailingNewline, 'registry entry must not add a trailing newline');
    assert(afterWrite.temporaryAbsent, 'atomic temporary entry remained after write');
    if (process.platform !== 'win32') assert.equal(afterWrite.mode, 0o600, 'registry entry mode must be 0600');

    const live = (label, extra = {}) => ({
      pid,
      port: 12_306,
      extensionId: `registry-${label}`,
      startedAt: record.startedAt,
      label,
      ...extra,
    });
    const deadPid = await confirmedDeadPid(scope);
    await invoke(scope, { operation: 'writeRaw', directory, file: 'alpha.json', value: live('alpha', { futureField: { retained: true } }) });
    await invoke(scope, { operation: 'writeRaw', directory, file: 'beta.json', value: live('beta', { unknownArray: [null, { future: 'kept' }] }) });
    await invoke(scope, { operation: 'writeRaw', directory, file: 'boundary.json', value: live('boundary') });
    await invoke(scope, { operation: 'writeRaw', directory, file: 'stale.json', value: live('stale') });
    await invoke(scope, { operation: 'writeRaw', directory, file: 'dead.json', value: { ...live('dead'), pid: deadPid } });
    await invoke(scope, { operation: 'writeText', directory, file: 'corrupt.json', text: '{not valid json' });
    await invoke(scope, { operation: 'writeText', directory, file: 'unrelated.txt', text: 'must remain' });
    await invoke(scope, { operation: 'writeText', directory, file: 'ignored.json.tmp', text: 'must remain' });
    for (const file of [primary, 'alpha.json', 'beta.json', 'dead.json', 'corrupt.json']) {
      await invoke(scope, { operation: 'setMtime', directory, file, modifiedMs: nowMs });
    }
    await invoke(scope, { operation: 'setMtime', directory, file: 'boundary.json', modifiedMs: nowMs - STALE_MS });
    await invoke(scope, { operation: 'setMtime', directory, file: 'stale.json', modifiedMs: nowMs - STALE_MS - 1 });

    const rawUnknown = await invoke(scope, { operation: 'readRaw', directory, file: 'alpha.json' });
    assert.equal(rawUnknown, JSON.stringify(live('alpha', { futureField: { retained: true } }), null, 2));
    const listed = await invoke(scope, { operation: 'list', directory, nowMs });
    const labels = listed.filter((entry) => Object.hasOwn(entry, 'label')).map((entry) => entry.label);
    assert.deepEqual(labels, ['alpha', 'beta', 'boundary'], 'live registry records must retain sorted file order');
    assert.deepEqual(listed, [
      record,
      live('alpha', { futureField: { retained: true } }),
      live('beta', { unknownArray: [null, { future: 'kept' }] }),
      live('boundary'),
    ], 'discovery retains every live record and its complete fields');
    assert.deepEqual(listed.find((entry) => entry.label === 'alpha')?.futureField, { retained: true });
    assert.deepEqual(listed.find((entry) => entry.label === 'beta')?.unknownArray, [null, { future: 'kept' }]);
    assert(!(await invoke(scope, { operation: 'exists', directory, file: 'corrupt.json' })), 'corrupt entry must be collected');
    assert(!(await invoke(scope, { operation: 'exists', directory, file: 'stale.json' })), 'strictly stale entry must be collected');
    assert(!(await invoke(scope, { operation: 'exists', directory, file: 'dead.json' })), 'confirmed-dead entry must be collected');
    assert(await invoke(scope, { operation: 'exists', directory, file: 'unrelated.txt' }), 'unrelated file was removed');
    assert(await invoke(scope, { operation: 'exists', directory, file: 'ignored.json.tmp' }), 'non-json suffix file was removed');

    await invoke(scope, { operation: 'remove', directory, pid });
    await invoke(scope, { operation: 'remove', directory, pid });
    const primaryRemoved = !(await invoke(scope, { operation: 'exists', directory, file: primary }));
    assert(primaryRemoved, 'idempotent removal left primary entry behind');
    return { pid, afterWrite, rawUnknown, listed, primaryRemoved };
  });
}

async function invoke(scope, request) {
  const output = await captureProcess(RUST_FIXTURE, [JSON.stringify(request)], scope);
  return JSON.parse(output);
}

async function confirmedDeadPid(scope) {
  const child = scope.spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await once(child, 'exit');
  assert(pid, 'fixture child did not receive a PID');
  return pid;
}



async function requireExecutable(path, command) {
  return requireFile(path, command, constants.X_OK);
}

async function requireFile(path, command, mode = constants.R_OK) {
  try {
    await access(path, mode);
  } catch {
    throw new Error(`missing prerequisite ${path}; run ${command}`);
  }
}
