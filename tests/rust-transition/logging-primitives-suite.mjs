import assert from 'node:assert/strict';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT, isolatedRun } from './process-host.mjs';

const RUST_FIXTURE = join(ROOT, 'target/release/examples', `logging-primitives${process.platform === 'win32' ? '.exe' : ''}`);

await requireExecutable(RUST_FIXTURE, 'cargo build -p humanchrome-native --release --example logging-primitives');

const observed = await observe();
process.stdout.write(`${JSON.stringify(observed)}\n`);

async function observe() {
  return isolatedRun(async (scope) => {
    const { stdout, stderr } = await capture(scope, RUST_FIXTURE, []);
    assert.equal(stdout, '', 'logger wrote to stdout');
    const lines = stderr.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1, `logger did not emit one NDJSON event: ${stderr}`);
    const actual = JSON.parse(lines[0]);
    const fields = selectUserFields(actual);
    assert.deepEqual(fields, expectedFields(), 'redaction boundary changed');
    return fields;
  });
}

function capture(scope, command, args) {
  return new Promise((resolve, reject) => {
    const child = scope.spawn(command, args, { NODE_ENV: 'test', HUMANCHROME_LOG_LEVEL: 'info' });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code ?? signal}: ${Buffer.concat(stderr)}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
  });
}

function selectUserFields(event) {
  const {
    requestId,
    msg,
    token,
    password,
    authorization,
    headers,
    query,
    other,
    percentJson,
  } = event;
  return { requestId, msg, token, password, authorization, headers, query, other, percentJson };
}

function expectedFields() {
  return {
    requestId: 'correlated-request',
    msg: 'request complete',
    token: '[REDACTED]',
    password: '[REDACTED]',
    authorization: '[REDACTED]',
    headers: {
      Authorization: '[REDACTED]',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'set-cookie': '[REDACTED]',
      accept: 'application/json',
    },
    query: {
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      public: 'query-kept',
      deeper: { token: 'deeper-token-secret' },
    },
    other: { 'set-cookie': 'other-cookie-kept' },
    percentJson: {
      token: '[REDACTED]',
      public: 'percent-kept',
      deeper: { token: 'deeper-percent-secret' },
    },
  };
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
