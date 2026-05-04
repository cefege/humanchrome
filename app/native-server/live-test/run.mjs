#!/usr/bin/env node
/**
 * Live-test orchestrator.
 *
 * Usage:
 *   node app/native-server/live-test/run.mjs
 *
 * Pre-requisites:
 *   - Chrome running with the extension loaded (extension auto-spawns the
 *     native messaging host which in turn starts the bridge on :12306).
 *   - `pnpm --filter humanchrome-extension build` has been run if you want the
 *     latest extension code under test.
 *
 * Output:
 *   live-test/results/live-test-results.jsonl   (one assertion per line)
 *   live-test/results/failures/<name>.md         (per-failure LLM-paste prompt)
 *   live-test/results/live-test-summary.md       (top-level pass/fail summary)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, connectClients, closeFixtureTabs } from './setup.mjs';
import { dumpForRequest } from './client.mjs';
import { initRunDir, recordResult, writeSummary, PATHS } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.join(HERE, 'tests');

const cliFlags = new Set(process.argv.slice(2));
const SKIP_MANUAL = !cliFlags.has('--with-manual');

async function loadTests() {
  const files = (await fs.readdir(TESTS_DIR)).filter((f) => f.endsWith('.mjs')).sort();
  const suites = [];
  for (const f of files) {
    const mod = await import(path.join(TESTS_DIR, f));
    if (Array.isArray(mod.default)) suites.push({ file: f, tests: mod.default });
    else if (Array.isArray(mod.tests)) suites.push({ file: f, tests: mod.tests });
  }
  return suites;
}

async function runOne(test, ctx) {
  // Tests yield a stream of outcome records. We attach debug-dumps to fails.
  let outcomes = [];
  try {
    outcomes = await test.run(ctx);
    if (!Array.isArray(outcomes)) outcomes = outcomes ? [outcomes] : [];
  } catch (err) {
    outcomes = [
      {
        name: test.name,
        status: 'fail',
        expected: 'no thrown error',
        got: { thrown: err?.message, stack: err?.stack?.split('\n').slice(0, 5).join('\n') },
        note: 'test threw — likely a harness bug or unexpected protocol error',
      },
    ];
  }
  for (const rec of outcomes) {
    if (rec.status === 'fail' && rec.requestId && ctx.A) {
      rec.debugDump = await dumpForRequest(ctx.A, rec.requestId);
    }
    await recordResult(rec);
  }
  return outcomes;
}

async function main() {
  await initRunDir();
  console.log(`Run starting — results → ${PATHS.RESULTS_DIR}`);

  const fixtureServer = await startFixtureServer();
  console.log(`Fixture server  → ${fixtureServer.baseUrl}`);

  let A, B, baseUrl;
  try {
    ({ A, B, baseUrl } = await connectClients());
  } catch (err) {
    console.error(`\n✘ Setup failed: ${err.message}\n`);
    await fixtureServer.close();
    process.exit(2);
  }
  console.log(`Bridge          → ${baseUrl}`);
  console.log(`Client A session: ${A.sessionId}`);
  console.log(`Client B session: ${B.sessionId}\n`);

  const ctx = {
    A,
    B,
    fixtureBase: fixtureServer.baseUrl,
    skipManual: SKIP_MANUAL,
  };

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const all = [];

  const suites = await loadTests();
  for (const suite of suites) {
    console.log(`▶ ${suite.file}`);
    for (const test of suite.tests) {
      const outcomes = await runOne(test, ctx);
      for (const rec of outcomes) {
        all.push(rec);
        const sym = rec.status === 'pass' ? '✓' : rec.status === 'skip' ? '○' : '✘';
        const line = `   ${sym} ${rec.name}` + (rec.note ? `  — ${rec.note}` : '');
        console.log(line);
        if (rec.status === 'pass') passed += 1;
        else if (rec.status === 'skip') skipped += 1;
        else failed += 1;
      }
    }
  }

  console.log('\nTearing down…');
  await closeFixtureTabs(A, fixtureServer.baseUrl);
  await fixtureServer.close();

  await writeSummary({ passed, failed, skipped, byTest: all });
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`Summary: ${PATHS.SUMMARY_PATH}`);
  console.log(`JSONL:   ${PATHS.JSONL_PATH}`);
  if (failed > 0) console.log(`Failures: ${PATHS.FAILURES_DIR}/`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('runner crashed:', err);
  process.exit(2);
});
