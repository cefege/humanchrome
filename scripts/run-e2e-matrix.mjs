#!/usr/bin/env node
// Standalone end-to-end matrix runner. POSTs straight to the bridge's
// /api/tools/:name HTTP endpoint to skip the MCP transport's session
// cache (the main reason matrix runs needed a Claude Code restart).
//
//   pnpm e2e:matrix          # use existing build + existing Chrome
//   pnpm e2e:full            # rebuild first + dump /tmp/e2e-result.json
//   pnpm e2e:full --launch-chrome
//                            # also spawn a dedicated headed Chrome with
//                            # --load-extension pointing at .output/chrome-mv3
//                            # in a throwaway user-data-dir. Avoids touching
//                            # the user's primary Chrome and skips the
//                            # bootstrap reload entirely (fresh Chrome →
//                            # fresh SW with latest bundle every run).
//
// Exit codes: 0 all pass, 1 some fail, 2 SW pre-bootstrap (one-time
// manual extension reload required when --launch-chrome is not used),
// 3 SW didn't pick up new bundle.
import { spawnSync, spawn } from 'node:child_process';
import {
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
  cpSync,
  statSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, homedir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_EXTENSION_ID = 'hbdgbgagpkpjffpklnamcljpakneikee';
const REGISTRY_DIR =
  process.env.HC_INSTANCE_REGISTRY_DIR ||
  resolve(homedir(), 'Library/Application Support/humanchrome-bridge/instances');
let BRIDGE_BASE = process.env.HC_BRIDGE_URL || 'http://127.0.0.1:12306';
const FIXTURE_URL = process.env.HC_FIXTURE_URL || 'http://127.0.0.1:4173/playwright-parity.html';
const ARGS = new Set(process.argv.slice(2));
const SHOULD_BUILD = ARGS.has('--build');
const LAUNCH_CHROME = ARGS.has('--launch-chrome');
const KEEP_CHROME = ARGS.has('--keep-chrome');
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
    name: 'offscreen (left:-9999) fails not_visible',
    // `position:absolute; left:-9999px` is the conventional .sr-only /
    // visually-hidden pattern. scrollIntoView is a no-op because there's
    // nowhere to scroll horizontally past x=0; Playwright treats these as
    // unactionable too. Expect NOT_ACTIONABLE not silent click success.
    run: () => callTool('chrome_click_element', { selector: '#vis-offscreen' }),
    check: (res) => expectFailure(res, 'not_visible'),
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

function resolveChromeBinary() {
  if (process.env.HC_CHROME_PATH) return process.env.HC_CHROME_PATH;
  // Stable Google Chrome on macOS no longer honors --load-extension
  // (silently warns + ignores), so prefer Chrome for Testing when it's
  // been installed via @puppeteer/browsers — install runs once and
  // drops the binary under <repo>/chrome/.
  const cftGlob = spawnSync('sh', [
    '-c',
    `ls -t '${REPO_ROOT}'/chrome/mac_*/chrome-mac-*/'Google Chrome for Testing.app'/Contents/MacOS/'Google Chrome for Testing' 2>/dev/null | head -1`,
  ]);
  const cft = cftGlob.stdout.toString().trim();
  if (cft) return cft;
  if (platform() === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (platform() === 'win32') {
    return 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  }
  return 'google-chrome';
}

function readRegistry() {
  if (!existsSync(REGISTRY_DIR)) return [];
  let files;
  try {
    files = readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const path = resolve(REGISTRY_DIR, file);
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      const mtimeMs = statSync(path).mtimeMs;
      // Skip dead pids — the bridge cleans up on graceful exit, but
      // SIGKILL / crashes leave orphans. Match the registry's read-time GC.
      try {
        process.kill(record.pid, 0);
      } catch (err) {
        if (err.code !== 'EPERM') continue;
      }
      out.push({ ...record, mtimeMs });
    } catch {
      /* corrupt or vanished */
    }
  }
  return out;
}

async function findSpawnedBridge(extensionId, afterMs, deadlineMs) {
  // Poll the on-disk registry written by the bridge after it binds its HTTP
  // port (IMP-0115). Returns the most recently-started bridge for the given
  // extension whose startedAt >= afterMs. Lets us route to the bridge owned
  // by the Chrome we just spawned, without contending with the user's
  // existing Chrome.
  let delay = 200;
  while (Date.now() < deadlineMs) {
    const entries = readRegistry().filter(
      (e) => e.extensionId === extensionId && new Date(e.startedAt).getTime() >= afterMs,
    );
    if (entries.length > 0) {
      entries.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
      return entries[0];
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 1500);
  }
  return null;
}

function stageExtensionForChrome() {
  // macOS TCC blocks Chrome from reading ~/Documents even with the bridge's
  // Full Disk Access, so --load-extension silently no-ops when the source
  // lives there. Mirror the bridge's workaround (IMP from project memory):
  // copy the build to ~/Library/Application Support/humanchrome-bridge/e2e-ext/
  // where Chrome is unrestricted, then point --load-extension at the copy.
  const src = resolve(REPO_ROOT, 'app/chrome-extension/.output/chrome-mv3');
  const tccSafe = resolve(homedir(), 'Library/Application Support/humanchrome-bridge/e2e-ext');
  if (existsSync(tccSafe)) rmSync(tccSafe, { recursive: true, force: true });
  mkdirSync(dirname(tccSafe), { recursive: true });
  cpSync(src, tccSafe, { recursive: true });
  return tccSafe;
}

function stageNativeMessagingHost(profile) {
  // Chrome for Testing (and any non-default Chrome channel) looks for native
  // messaging host manifests under <user-data-dir>/NativeMessagingHosts/
  // FIRST. Without this the SW gets "Specified native messaging host not
  // found." and the bridge never spawns for the dedicated instance.
  const src = resolve(
    homedir(),
    'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.humanchrome.nativehost.json',
  );
  if (!existsSync(src)) {
    console.warn('[e2e] no NM manifest at', src, '— skipping stage');
    return;
  }
  const dst = resolve(profile, 'NativeMessagingHosts');
  mkdirSync(dst, { recursive: true });
  cpSync(src, resolve(dst, 'com.humanchrome.nativehost.json'));
  console.log(`[e2e]   NM manifest staged   = ${dst}/`);
}

function launchChrome() {
  const profile = resolve(homedir(), 'Library/Application Support/humanchrome-bridge/e2e-profile');
  const ext = stageExtensionForChrome();
  if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  stageNativeMessagingHost(profile);

  const bin = resolveChromeBinary();
  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${ext}`,
    '--remote-debugging-port=9333',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
    FIXTURE_URL,
  ];
  console.log(`[e2e] launching dedicated Chrome → ${bin}`);
  console.log(`[e2e]   ext (TCC-safe copy) = ${ext}`);
  console.log(`[e2e]   profile             = ${profile}`);
  const spawnedAt = Date.now();
  const child = spawn(bin, args, { stdio: 'ignore', detached: true });
  child.unref();
  return { pid: child.pid, profile, spawnedAt };
}

async function main() {
  console.log(`[e2e] bridge=${BRIDGE_BASE} fixture=${FIXTURE_URL} clientId=${CLIENT_ID}`);

  if (SHOULD_BUILD) {
    console.log('[e2e] building shared + native + extension...');
    run('pnpm', ['build:shared']);
    run('pnpm', ['build:native']);
    run('pnpm', ['build:extension']);
  }

  let spawned = null;
  if (LAUNCH_CHROME) {
    spawned = launchChrome();
    console.log(`[e2e] Chrome spawned pid=${spawned.pid} profile=${spawned.profile}`);
    // Wait for the spawned Chrome's extension SW to come up and register its
    // bridge in the on-disk instance registry (IMP-0115). Once we know the
    // port, route all subsequent HTTP calls there — even if the user's
    // regular Chrome's bridge is also bound (on a different port).
    const entry = await findSpawnedBridge(
      EXPECTED_EXTENSION_ID,
      spawned.spawnedAt,
      Date.now() + 30_000,
    );
    if (!entry) {
      console.error('[e2e] spawned Chrome did not register a bridge within 30s.');
      console.error(`[e2e] registry dir: ${REGISTRY_DIR}`);
      process.exit(3);
    }
    BRIDGE_BASE = `http://127.0.0.1:${entry.port}`;
    console.log(
      `[e2e] discovered bridge instance=${entry.instanceId} pid=${entry.pid} port=${entry.port}`,
    );
    console.log(`[e2e] routing to ${BRIDGE_BASE}`);
  }

  const probe1 = await callTool('chrome_runtime_info', {});
  const probe1Available = !probe1.isError;
  const priorBuildHash = probe1.parsed?.buildHash;
  console.log(
    probe1Available
      ? `[e2e] SW info: buildHash=${priorBuildHash} uptimeMs=${probe1.parsed?.uptimeMs} toolCount=${probe1.parsed?.toolCount}`
      : '[e2e] chrome_runtime_info not on SW — will appear after chrome_dev_reload flushes',
  );

  // Skip dev_reload when the SW is already fresh — calling it on a current
  // SW just bounces it for no reason, and the buildHash doesn't change
  // without a rebuild so waitForFreshSw times out spuriously.
  let probe2 = probe1;
  const swIsFresh = probe1Available && (probe1.parsed?.uptimeMs ?? Infinity) < 60_000;
  if (!swIsFresh) {
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

    probe2 = await waitForFreshSw(priorBuildHash, probe1Available);
    if (!probe2) {
      console.error('[e2e] SW did not pick up the new build within 15s after dev_reload.');
      process.exit(3);
    }
    console.log(`[e2e] SW info after reload: ${JSON.stringify(probe2.parsed)}`);
  } else {
    console.log('[e2e] SW is fresh (uptime < 60s) — skipping reload');
  }

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

  if (spawned && !KEEP_CHROME) {
    try {
      process.kill(spawned.pid, 'SIGTERM');
      console.log(`[e2e] cleaned up spawned Chrome pid=${spawned.pid}`);
    } catch {
      /* already gone */
    }
  } else if (spawned) {
    console.log(`[e2e] --keep-chrome: leaving Chrome pid=${spawned.pid} running`);
  }

  process.exit(counts.FAIL ? 1 : 0);
}

main().catch((err) => {
  console.error('[e2e] fatal:', err);
  process.exit(99);
});
