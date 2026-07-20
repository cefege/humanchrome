#!/usr/bin/env node
// Task-level scenario runner. Drives humanchrome via the bridge's HTTP
// surface (same path as the matrix runner — /api/tools/:name) and scores
// each scenario against its predicate.
//
// Usage:
//   pnpm e2e:tasks                 # fixture-only scenarios
//   pnpm e2e:tasks --live          # include live-network scenarios
//   pnpm e2e:tasks --json out.json # also dump structured result
//   HC_BRIDGE_URL=http://127.0.0.1:12306 pnpm e2e:tasks
//
// Exit codes: 0 all pass, 1 some fail, 2 bridge unreachable.
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getScenarios } from '../app/chrome-extension/tests/e2e/scenarios/index.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_BASE = process.env.HC_BRIDGE_URL || 'http://127.0.0.1:12306';
const CLIENT_ID = `task-scenarios-${Date.now().toString(36)}`;
const FIXTURE_DIR = resolve(REPO_ROOT, 'app/chrome-extension/tests/e2e/fixtures');
const FIXTURE_PROBE = 'http://127.0.0.1:4173/task-scenarios.html';

const argv = process.argv.slice(2);
const INCLUDE_LIVE = argv.includes('--live');
const JSON_OUT = (() => {
  const i = argv.indexOf('--json');
  return i >= 0 ? argv[i + 1] : null;
})();
const FILTER = (() => {
  const i = argv.indexOf('--filter');
  return i >= 0 ? argv[i + 1] : null;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callTool(name, args = {}, timeoutMs = 15_000) {
  try {
    const res = await fetch(`${BRIDGE_BASE}/api/tools/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { isError: true, httpStatus: res.status, body: await res.text() };
    const json = await res.json();
    if (json?.content?.[0]?.text) {
      try {
        json.parsed = JSON.parse(json.content[0].text);
      } catch {
        json.parsed = json.content[0].text;
      }
    }
    return json;
  } catch (err) {
    return { isError: true, transportError: err.message };
  }
}

async function probeBridge() {
  try {
    const res = await fetch(`${BRIDGE_BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return true;
  } catch {
    /* fall through */
  }
  // Some builds don't expose /healthz — fall back to a no-side-effect tool.
  const probe = await callTool('chrome_pace', {}, 3000);
  return !probe?.transportError;
}

async function ensureFixtureServer() {
  try {
    const res = await fetch(FIXTURE_PROBE, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return null;
  } catch {
    /* not running */
  }
  if (!existsSync(FIXTURE_DIR)) {
    throw new Error(`fixture dir missing: ${FIXTURE_DIR}`);
  }
  console.log(`[tasks] spawning fixture server: python3 -m http.server 4173 -d ${FIXTURE_DIR}`);
  const child = spawn('python3', ['-m', 'http.server', '4173', '--directory', FIXTURE_DIR], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(FIXTURE_PROBE, { signal: AbortSignal.timeout(500) });
      if (res.ok) return child;
    } catch {
      await sleep(150);
    }
  }
  throw new Error('fixture server did not come up within 5s');
}

async function runScenario(scenario) {
  const start = Date.now();
  const log = (...args) => console.log(`  [${scenario.id}]`, ...args);
  try {
    // Per-run cache-bust — chrome_navigate to the same URL+fragment otherwise
    // just activates the existing tab without reloading, so state from the
    // previous scenario leaks into this one (form fields, counters, etc).
    const bust = `__run=${Date.now().toString(36)}`;
    const target = scenario.target.url.includes('?')
      ? scenario.target.url.replace('?', `?${bust}&`)
      : scenario.target.url.replace(/(#|$)/, (m) => `?${bust}${m}`);
    const nav = await callTool('chrome_navigate', { url: target });
    if (nav?.isError) {
      return {
        id: scenario.id,
        failureClass: scenario.failureClass,
        ok: false,
        reason: `navigate failed: ${JSON.stringify(nav).slice(0, 200)}`,
        elapsedMs: Date.now() - start,
      };
    }
    const tabId = nav?.parsed?.tabId ?? nav?.parsed?.tab?.id;
    if (typeof tabId === 'number') {
      // Foreground the tab — type_into / hover / paste need visible state.
      await callTool('chrome_switch_tab', { tabId });
    }
    // brief settle — some fixtures schedule listeners on load
    await sleep(150);
    // Auto-inject tabId on every call so mutating tools target the
    // navigated tab instead of spawning a fresh one (per-client autoSpawnTab).
    const call = (name, args = {}, timeoutMs) => {
      const merged = typeof tabId === 'number' && args.tabId == null ? { ...args, tabId } : args;
      return callTool(name, merged, timeoutMs);
    };
    const answer = await scenario.steps({ call, log, tabId });
    const verdict = scenario.predicate(answer);
    return {
      id: scenario.id,
      failureClass: scenario.failureClass,
      ok: !!verdict.ok,
      reason: verdict.reason,
      answer,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: scenario.id,
      failureClass: scenario.failureClass,
      ok: false,
      reason: `threw: ${err.message}`,
      elapsedMs: Date.now() - start,
    };
  }
}

function fmt(ms) {
  return `${ms}ms`.padStart(7);
}

async function main() {
  console.log(`[tasks] bridge=${BRIDGE_BASE} client=${CLIENT_ID} live=${INCLUDE_LIVE}`);

  const reachable = await probeBridge();
  if (!reachable) {
    console.error(
      `[tasks] bridge unreachable at ${BRIDGE_BASE}. Is the extension loaded and the user's Chrome running? You can override with HC_BRIDGE_URL.`,
    );
    process.exit(2);
  }

  const fixtureServer = await ensureFixtureServer();
  if (fixtureServer) {
    process.on('exit', () => {
      try {
        process.kill(-fixtureServer.pid, 'SIGTERM');
      } catch {
        /* best effort */
      }
    });
  }

  let scenarios = getScenarios({ includeLive: INCLUDE_LIVE });
  if (FILTER) scenarios = scenarios.filter((s) => s.id.includes(FILTER));

  console.log(`[tasks] running ${scenarios.length} scenario(s)`);

  const results = [];
  for (const s of scenarios) {
    const r = await runScenario(s);
    results.push(r);
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`  ${tag} ${fmt(r.elapsedMs)}  [${r.failureClass}]  ${r.id}`);
    if (!r.ok) console.log(`         ↳ ${r.reason}`);
  }

  const byClass = {};
  for (const r of results) {
    byClass[r.failureClass] ??= { pass: 0, fail: 0 };
    byClass[r.failureClass][r.ok ? 'pass' : 'fail']++;
  }
  console.log('\n[tasks] summary by failure class');
  for (const [cls, c] of Object.entries(byClass)) {
    console.log(`  ${cls.padEnd(13)} pass=${c.pass} fail=${c.fail}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[tasks] total: ${results.length - failed.length}/${results.length} passed`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ bridge: BRIDGE_BASE, results, byClass }, null, 2));
    console.log(`[tasks] wrote ${JSON_OUT}`);
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[tasks] runner crashed:', err);
  process.exit(1);
});
