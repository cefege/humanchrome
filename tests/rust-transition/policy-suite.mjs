#!/usr/bin/env node
// Rust policy process checked against captured original Node observations.
// Omitted fields, JSON-in-text order, array order and UTF-16 remain contract data.

import assert from 'node:assert/strict';
import { isolatedRun } from './process-host.mjs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const policyFixtures = JSON.parse(await readFile(join(root, 'tests/rust-transition/policy-reference.json'), 'utf8'));
const defaultRustOracle = join(root, 'target/release/examples', `policy-oracle${process.platform === 'win32' ? '.exe' : ''}`);
const REQUEST_TIMEOUT_MS = 15_000;

class JsonlOracle {
  #lines = [];
  #waiter;
  #failure;
  #stderr = '';

  constructor(label, command, args, scope, env) {
    this.label = label;
    this.child = scope.spawn(command, args, env);
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    let remainder = '';
    this.child.stdout.on('data', (chunk) => {
      remainder += chunk;
      let newline;
      while ((newline = remainder.indexOf('\n')) !== -1) {
        const line = remainder.slice(0, newline);
        remainder = remainder.slice(newline + 1);
        if (!line) continue;
        try { this.#enqueue(JSON.parse(line)); }
        catch (error) { this.#fail(new Error(`${this.label} emitted invalid JSONL: ${error.message}\n${line.slice(0, 500)}`)); }
      }
    });
    this.child.stdout.on('end', () => {
      if (remainder.trim()) this.#fail(new Error(`${this.label} ended with unterminated JSONL output`));
    });
    this.child.stderr.on('data', (chunk) => { this.#stderr += chunk; });
    this.child.stdin.on('error', (error) => this.#fail(error));
    this.child.on('error', (error) => this.#fail(error));
    this.child.on('exit', (code, signal) => {
      if (code !== 0 && this.#failure === undefined) {
        this.#fail(new Error(`${this.label} exited (${code ?? signal})${this.#stderr ? `\n${this.#stderr}` : ''}`));
      }
    });
  }

  #enqueue(value) {
    if (this.#waiter) {
      const { resolve: done, timer } = this.#waiter;
      this.#waiter = undefined;
      clearTimeout(timer);
      done(value);
    } else {
      this.#lines.push(value);
    }
  }

  #fail(error) {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    if (this.#waiter) {
      const { reject, timer } = this.#waiter;
      this.#waiter = undefined;
      clearTimeout(timer);
      reject(error);
    }
  }

  async request(value) {
    if (this.#failure) throw this.#failure;
    const encoded = `${JSON.stringify(value)}\n`;
    if (!this.child.stdin.write(encoded)) await once(this.child.stdin, 'drain');
    if (this.#lines.length) return this.#lines.shift();
    return new Promise((resolveLine, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error(`${this.label} did not answer within ${REQUEST_TIMEOUT_MS}ms${this.#stderr ? `\n${this.#stderr}` : ''}`));
      }, REQUEST_TIMEOUT_MS);
      this.#waiter = { resolve: resolveLine, reject, timer };
    });
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const exit = once(this.child, 'exit');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try { await exit; } finally { clearTimeout(timer); }
    if (this.#failure) throw this.#failure;
  }
}

function oracleCommand(path, fallback) {
  if (!path) return fallback;
  return path.endsWith('.mjs') ? [process.execPath, [path]] : [path, []];
}

function explainMismatch(name, input, expected, rust) {
  return [
    `Policy mismatch: ${name}`,
    `input: ${JSON.stringify(input)}`,
    `Original contract: ${JSON.stringify(expected)}`,
    `Rust: ${JSON.stringify(rust)}`,
  ].join('\n');
}


/**
 * Run the captured input corpus against the separately spawned Rust executable.
 * Callers may supply a release artifact; no source-module runtime fallback exists.
 */
export async function runPolicySuite({
  fixtures = policyFixtures,
  rustOracle = process.env.HC_TEST_RUST_POLICY_ORACLE || defaultRustOracle,
  env = {},
} = {}) {
  return isolatedRun(async (scope) => {
    const [rustCommand, rustArgs] = oracleCommand(rustOracle, [defaultRustOracle, []]);
    const rust = new JsonlOracle('Rust policy oracle', rustCommand, rustArgs, scope, env);
    let completed = 0;
    const failures = [];
    try {
      for (const fixture of fixtures) {
        const rustOutput = await rust.request(fixture.input);
        try {
          assert.equal(JSON.stringify(rustOutput), JSON.stringify(fixture.output));
        } catch {
          failures.push(new assert.AssertionError({
            message: explainMismatch(fixture.name, fixture.input, fixture.output, rustOutput),
            actual: rustOutput,
            expected: fixture.output,
            operator: 'ordered JSON equality',
          }));
        }
        completed += 1;
      }
    } finally {
      await rust.close();
    }
    if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('\n\n'));
    return { cases: completed };
  });
}

function cliOption(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  if (!args[index + 1]) throw new Error(`${flag} requires a path`);
  return resolve(args[index + 1]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPolicySuite({
      rustOracle: cliOption(process.argv.slice(2), '--rust-oracle'),
    });
    process.stdout.write(`policy suite passed (${result.cases} cases)\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
