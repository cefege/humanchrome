#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';
import { createRequire } from 'node:module';

const { Client } = createRequire(new URL('../app/native-server/package.json', import.meta.url))('pg');

const required = [
  'HC_TEST_COORDINATOR_TLS_STRICT_URL',
  'HC_TEST_COORDINATOR_TLS_VERIFY_CA_URL',
  'HC_TEST_COORDINATOR_TLS_NO_VERIFY_URL',
  'HC_TEST_COORDINATOR_TLS_DIRECT_URL',
  'HC_TEST_COORDINATOR_TLS_REJECT_URL',
  'HC_TEST_COORDINATOR_TLS_HOSTNAME_REJECT_URL',
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
}

async function acceptsTls(name, connectionString) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    if (result.rows[0]?.ssl !== true) {
      throw new Error(`${name} connected without TLS`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function rejectsTls(name, connectionString) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch {
    return;
  } finally {
    await client.end().catch(() => {});
  }
  throw new Error(`${name} unexpectedly accepted an untrusted certificate`);
}

await acceptsTls('strict TLS', process.env.HC_TEST_COORDINATOR_TLS_STRICT_URL);
await acceptsTls('verify-ca TLS', process.env.HC_TEST_COORDINATOR_TLS_VERIFY_CA_URL);
await acceptsTls('no-verify TLS', process.env.HC_TEST_COORDINATOR_TLS_NO_VERIFY_URL);
await acceptsTls('direct TLS', process.env.HC_TEST_COORDINATOR_TLS_DIRECT_URL);
await rejectsTls('strict rejection', process.env.HC_TEST_COORDINATOR_TLS_REJECT_URL);
await rejectsTls('strict hostname rejection', process.env.HC_TEST_COORDINATOR_TLS_HOSTNAME_REJECT_URL);

const cargo = spawn(
  'cargo',
  [
    'test',
    '-p',
    'humanchrome-native',
    '--test',
    'coordinator_tls',
    '--',
    '--ignored',
    '--exact',
    'node_pg_compatible_tls_modes_reach_the_public_coordinator_store',
  ],
  { cwd: new URL('..', import.meta.url), env: process.env, stdio: 'inherit' },
);

await new Promise((resolve, reject) => {
  cargo.once('error', reject).once('exit', (code, signal) => {
    if (signal) reject(new Error(`cargo terminated by ${signal}`));
    else if (code === 0) resolve();
    else reject(new Error(`cargo exited with ${code}`));
  });
});
