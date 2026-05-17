#!/usr/bin/env node
// Standalone end-to-end matrix runner. POSTs straight to the bridge's
// /api/tools/:name HTTP endpoint to skip the MCP transport's session
// cache (the main reason matrix runs needed a Claude Code restart).
//
//   pnpm e2e:matrix          # use existing build
//   pnpm e2e:full            # rebuild first + dump /tmp/e2e-result.json
//
// Exit codes: 0 all pass, 1 some fail, 2 SW pre-bootstrap (one-time
// manual extension reload required), 3 SW didn't pick up new bundle.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_BASE = process.env.HC_BRIDGE_URL || 'http://127.0.0.1:12306';
const FIXTURE_URL = process.env.HC_FIXTURE_URL || 'http://127.0.0.1:4173/playwright-parity.html';
const ARGS = new Set(process.argv.slice(2));
const SHOULD_BUILD = ARGS.has('--build');
const JSON_OUT = (() => {
  const i = process.argv.indexOf('--json');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const CLIENT_ID = `e2e-matrix-${Date.now().toString(36)}`;

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
        // not JSON — leave parsed undefined
      }
    }
    return json;
  } catch (err) {
    return { isError: true, transportError: err.message };
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`);
}

function assert(cond, detail) {
  return cond ? { status: 'PASS' } : { status: 'FAIL', detail };
}

function detailsOf(res) {
  try {
    return JSON.parse(res?.content?.[0]?.text ?? '{}');
  } catch {
    return {};
  }
}

function failuresOf(res) {
  const d = detailsOf(res);
  return d?.details?.failures ?? d?.error?.details?.failures ?? [];
}

function expectFailure(res, code) {
  const failures = failuresOf(res);
  const match = code instanceof RegExp ? failures.some((f) => code.test(f)) : failures.includes(code);
  return assert(
    res.isError && match,
    `expected failure ${code}, got ${JSON.stringify(res).slice(0, 200)}`,
  );
}

const MATRIX = [
  {
    imp: 'IMP-0098',
    name: 'role + name (Submit)',
    run: () =>
      callTool('chrome_click_element', { selectorType: 'role', selector: 'button[name="Submit"]' }),
    check: (res) =>
      assert(!res.isError && res.parsed?.elementInfo?.id === 'submit-btn', JSON.stringify(res)),
  },
  {
    imp: 'IMP-0098',
    name: 'strict-mode multi-match without index',
    run: () => callTool('chrome_click_element', { selector: '.row-btn' }),
    check: (res) => {
      const d = detailsOf(res);
      const matchCount = d?.details?.matchCount ?? d?.error?.details?.matchCount;
      return assert(res.isError && matchCount === 3, `expected matchCount:3, got ${JSON.stringify(res)}`);
    },
  },
  {
    imp: 'IMP-0098',
    name: 'strict-mode multi-match with index:1',
    run: () => callTool('chrome_click_element', { selector: '.row-btn', index: 1 }),
    check: (res) => assert(!res.isError, JSON.stringify(res)),
  },
  {
    imp: 'IMP-0097',
    name: 'display:none → not_visible',
    run: () => callTool('chrome_click_element', { selector: '#vis-display-none' }),
    check: (res) => expectFailure(res, 'not_visible'),
  },
  {
    imp: 'IMP-0097',
    name: 'offscreen scrolls into view',
    run: () => callTool('chrome_click_element', { selector: '#vis-offscreen' }),
    check: (res) => assert(!res.isError, JSON.stringify(res)),
  },
  {
    imp: 'IMP-0097',
    name: 'animation unstable_bbox',
    run: () => callTool('chrome_click_element', { selector: '#sliding-btn' }),
    check: (res) => expectFailure(res, 'unstable_bbox'),
  },
  {
    imp: 'IMP-0097',
    name: 'occluded_by:*',
    run: () => callTool('chrome_click_element', { selector: '#occluded-btn' }),
    check: (res) => expectFailure(res, /^occluded_by:/),
  },
  {
    imp: 'IMP-0097',
    name: 'disabled button',
    run: () => callTool('chrome_click_element', { selector: '#disabled-btn' }),
    check: (res) => expectFailure(res, 'disabled'),
  },
  {
    imp: 'IMP-0097',
    name: 'aria-disabled button',
    run: () => callTool('chrome_click_element', { selector: '#aria-disabled-btn' }),
    check: (res) => expectFailure(res, 'disabled'),
  },
  {
    imp: 'IMP-0097',
    name: 'readonly input rejects fill',
    run: () => callTool('chrome_fill_or_select', { selector: '#readonly-in', value: 'x' }),
    check: (res) => expectFailure(res, 'not_editable'),
  },
  {
    imp: 'IMP-0100',
    name: 'register_default dialog policy',
    run: () =>
      callTool('chrome_handle_dialog', { action: 'register_default', defaultBehavior: 'accept' }),
    check: (res) => assert(!res.isError, JSON.stringify(res)),
  },
  {
    imp: 'IMP-0101',
    name: 'locator_handler list returns ok',
    run: () => callTool('chrome_locator_handler', { action: 'list' }),
    check: (res) => assert(!res.isError, JSON.stringify(res)),
  },
  {
    imp: 'IMP-0102',
    name: 'wait_for kind:url (already-matched)',
    run: () =>
      callTool('chrome_wait_for', { kind: 'url', pattern: 'playwright-parity', timeoutMs: 2000 }),
    check: (res) => assert(!res.isError, JSON.stringify(res)),
  },
  {
    imp: 'IMP-0102',
    name: 'wait_for kind:load_state',
    run: () =>
      callTool('chrome_wait_for', { kind: 'load_state', state: 'load', timeoutMs: 2000 }),
    check: (res) => assert(!res.isError, JSON.stringify(res)),
  },
  {
    imp: 'IMP-0092',
    name: 'coords-over-empty-space returns error envelope',
    run: () => callTool('chrome_click_element', { coordinates: { x: 9999, y: 9999 } }),
    check: (res) => assert(res.isError === true, `expected error, got ${JSON.stringify(res)}`),
  },
  {
    imp: 'IMP-0095',
    name: 'await_element absent envelope',
    run: async () => {
      await callTool('chrome_click_element', { selector: '#ephemeral-modal' });
      return callTool('chrome_await_element', {
        selector: '#ephemeral',
        state: 'absent',
        timeoutMs: 3000,
      });
    },
    check: (res) => {
      const p = res.parsed;
      return assert(!res.isError && p?.success === true && p?.absent === true, JSON.stringify(res));
    },
  },
];

async function waitForFreshSw(priorBuildHash, priorAvailable) {
  // Probe-first + exponential backoff: 150ms → 300 → 600 → 1200 capped at 1500.
  // Total budget ~15s. Exit on first hit so the happy path costs one RTT.
  let delay = 150;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const probe = await callTool('chrome_runtime_info', {});
    if (!probe.isError) {
      const fresh = !priorAvailable || probe.parsed?.buildHash !== priorBuildHash;
      if (fresh) return probe;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 1500);
  }
  return null;
}

async function main() {
  console.log(`[e2e] bridge=${BRIDGE_BASE} fixture=${FIXTURE_URL} clientId=${CLIENT_ID}`);

  if (SHOULD_BUILD) {
    console.log('[e2e] building shared + native + extension...');
    run('pnpm', ['build:shared']);
    run('pnpm', ['build:native']);
    run('pnpm', ['build:extension']);
  }

  const probe1 = await callTool('chrome_runtime_info', {});
  const probe1Available = !probe1.isError;
  const priorBuildHash = probe1.parsed?.buildHash;
  console.log(
    probe1Available
      ? `[e2e] SW info before reload: ${JSON.stringify(probe1.parsed)}`
      : '[e2e] chrome_runtime_info not on SW — will appear after chrome_dev_reload flushes',
  );

  console.log('[e2e] triggering chrome_dev_reload...');
  const reload = await callTool('chrome_dev_reload', {});
  if (reload.isError) {
    const txt = reload?.content?.[0]?.text ?? reload?.transportError ?? JSON.stringify(reload);
    if (typeof txt === 'string' && txt.includes('Tool chrome_dev_reload not found')) {
      console.error('[e2e] chrome_dev_reload not on SW — this is the ONE-TIME bootstrap.');
      console.error('[e2e] Reload the extension once at:');
      console.error('[e2e]   chrome://extensions/?id=hbdgbgagpkpjffpklnamcljpakneikee');
      console.error('[e2e] Then re-run. Every subsequent run is unattended.');
      process.exit(2);
    }
    console.warn(`[e2e] dev_reload returned an error envelope, continuing anyway: ${txt}`);
  }

  const probe2 = await waitForFreshSw(priorBuildHash, probe1Available);
  if (!probe2) {
    console.error('[e2e] SW did not pick up the new build within 15s after dev_reload.');
    process.exit(3);
  }
  console.log(`[e2e] SW info after reload: ${JSON.stringify(probe2.parsed)}`);

  console.log(`[e2e] opening fixture ${FIXTURE_URL}`);
  const nav = await callTool('chrome_navigate', { url: FIXTURE_URL });
  if (nav.isError) {
    console.error(`[e2e] navigate failed: ${JSON.stringify(nav)}`);
    process.exit(4);
  }

  console.log(`[e2e] running ${MATRIX.length} rows...`);
  const results = [];
  for (const row of MATRIX) {
    process.stdout.write(`  ${row.imp.padEnd(8)} ${row.name.padEnd(48)} `);
    let outcome;
    try {
      const res = await row.run();
      outcome = row.check(res);
      outcome.res = res;
    } catch (err) {
      outcome = { status: 'FAIL', detail: `threw: ${err.message}` };
    }
    console.log(outcome.status + (outcome.detail ? `  ${outcome.detail.slice(0, 100)}` : ''));
    results.push({
      imp: row.imp,
      name: row.name,
      status: outcome.status,
      detail: outcome.detail ?? null,
      res: outcome.res ?? null,
    });
  }

  const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  console.log(`\n[e2e] summary: ${JSON.stringify(counts)}`);

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          runAt: new Date().toISOString(),
          bridge: BRIDGE_BASE,
          fixture: FIXTURE_URL,
          swInfoBefore: probe1.parsed,
          swInfoAfter: probe2.parsed,
          results,
          counts,
        },
        null,
        2,
      ),
    );
    console.log(`[e2e] wrote ${JSON_OUT}`);
  }

  process.exit(counts.FAIL ? 1 : 0);
}

main().catch((err) => {
  console.error('[e2e] fatal:', err);
  process.exit(99);
});
