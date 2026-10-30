import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { ROOT, captureProcess, isolatedRun } from './process-host.mjs';

const fixtureBinary = join(
  ROOT,
  'target',
  'release',
  'examples',
  `coordinator_store_fixture${process.platform === 'win32' ? '.exe' : ''}`,
);

export async function verify() {
  disposableDatabaseUrl();
  await requireExecutable(
    fixtureBinary,
    'cargo build -p humanchrome-native --release --example coordinator_store_fixture',
  );
  await isolatedRun(async (scope) => {
    const result = JSON.parse(await captureProcess(fixtureBinary, [], scope));
    assert.equal(result.result, 'ok', `coordinator store fixture failed: ${JSON.stringify(result)}`);
    assert.match(result.coordinator, /^cs-[0-9a-f-]+$/, 'fixture must scope rows to a unique coordinator id');
  });
  console.log('PASS coordinator store: real PostgreSQL singleton ownership, contested reservations, durable release/expiry generations, and terminated-leader fail-closed writes');
}

export function disposableDatabaseUrl() {
  const value = process.env.HC_TEST_POSTGRES_URL;
  if (!value) {
    throw new Error('HC_TEST_POSTGRES_URL is required and must name a disposable test database');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('HC_TEST_POSTGRES_URL must be a PostgreSQL URL for a disposable test database');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('HC_TEST_POSTGRES_URL must be a PostgreSQL URL for a disposable test database');
  }

  let database;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('HC_TEST_POSTGRES_URL must name an explicit disposable test database');
  }
  const explicitTestName = /(?:^|[-_])(test|tests|testing)(?:$|[-_])/i;
  if (!database || database.includes('/') || !explicitTestName.test(database)) {
    throw new Error('HC_TEST_POSTGRES_URL must name an explicit disposable test database');
  }
  return value;
}

async function requireExecutable(path, command) {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`missing coordinator state safety fixture executable: ${path}\nRun: ${command}`);
  }
}
