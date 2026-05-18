#!/usr/bin/env node
/**
 * Self-diagnose CLI for humanchrome. One command, structured output (one
 * fact per line so Claude can grep-parse it), short-circuits the most
 * common false-bug investigations:
 *
 *  - "Tool not found" / call hangs / new code not taking effect:
 *    usually a stale bundle in one of 5 layers (build output, extension
 *    install dir, SW, bridge install dir, MCP schema cache). This script
 *    surfaces SHA mismatches between source and installed bundles so
 *    you can see staleness at a glance.
 *
 *  - "Bridge is down": enumerates the on-disk instance registry and
 *    probes each port's /health endpoint.
 *
 *  - "Did my fix land?": shows current repo HEAD + dirty state next to
 *    every installed-bundle build-info SHA.
 *
 * Usage:  pnpm doctor
 *         node scripts/claude-doctor.mjs [--json]
 *
 * Exit code: 0 always (this is diagnostic; it never claims failure). The
 * --strict flag exits non-zero on the first detected mismatch.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const REPO_ROOT = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..');
const STATE_PATH = resolve(REPO_ROOT, '.claude', 'loop-state.local.json');
const BRIDGE_INSTALL = join(homedir(), 'Library', 'Application Support', 'humanchrome-bridge');
const EXT_INSTALL = join(homedir(), 'Library', 'Application Support', 'humanchrome-extension');
const SRC_BRIDGE_DIST = resolve(REPO_ROOT, 'app', 'native-server', 'dist');
const SRC_EXT_OUTPUT = resolve(REPO_ROOT, 'app', 'chrome-extension', '.output', 'chrome-mv3');

const STRICT = process.argv.includes('--strict');
const JSON_OUT = process.argv.includes('--json');

const facts = [];
function fact(key, value, ok = null) {
  facts.push({ key, value, ok });
  if (!JSON_OUT) {
    const tag = ok === true ? 'ok' : ok === false ? 'FAIL' : '..';
    process.stdout.write(`[${tag}] ${key}: ${value}\n`);
  }
}

function sh(cmd, opts = {}) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: REPO_ROOT, ...opts });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function hashDir(dir) {
  if (!existsSync(dir)) return null;
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        h.update(name);
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}

function readBuildInfo(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// --- Repo state ---
const headSha = sh('git rev-parse HEAD').stdout.slice(0, 12);
fact('repo.head', headSha);

const dirty = sh('git status --porcelain').stdout;
fact('repo.clean', dirty.length === 0 ? 'yes' : `no (${dirty.split('\n').length} files)`, dirty.length === 0);

const branch = sh('git rev-parse --abbrev-ref HEAD').stdout;
fact('repo.branch', branch, branch === 'main');

// --- Bridge install ---
const srcBridgeHash = hashDir(SRC_BRIDGE_DIST);
const instBridgeHash = hashDir(join(BRIDGE_INSTALL, 'dist'));
if (srcBridgeHash && instBridgeHash) {
  const synced = srcBridgeHash === instBridgeHash;
  fact('bridge.dist.src', srcBridgeHash);
  fact('bridge.dist.installed', instBridgeHash);
  fact(
    'bridge.dist.synced',
    synced ? 'yes' : `STALE (src=${srcBridgeHash} install=${instBridgeHash})`,
    synced,
  );
} else {
  fact('bridge.dist.src', srcBridgeHash || 'MISSING (run pnpm build:native)', srcBridgeHash != null);
  fact('bridge.dist.installed', instBridgeHash || 'MISSING (run postbuild sync)', instBridgeHash != null);
}

// --- Extension build-info ---
const srcExtInfo = readBuildInfo(join(SRC_EXT_OUTPUT, 'build-info.json'));
const instExtInfo = readBuildInfo(join(EXT_INSTALL, 'build-info.json'));
if (srcExtInfo) fact('ext.build.src', `${srcExtInfo.buildHash?.slice(0, 12) || '?'} (${srcExtInfo.builtAt || '?'})`);
else fact('ext.build.src', 'MISSING (run pnpm build:extension)', false);
if (instExtInfo) {
  const synced = srcExtInfo && srcExtInfo.buildHash === instExtInfo.buildHash;
  fact(
    'ext.build.installed',
    `${instExtInfo.buildHash?.slice(0, 12) || '?'} (${instExtInfo.builtAt || '?'})`,
    synced === true,
  );
  if (srcExtInfo) {
    fact(
      'ext.build.synced',
      synced ? 'yes' : `STALE (src=${srcExtInfo.buildHash?.slice(0, 12)} install=${instExtInfo.buildHash?.slice(0, 12)})`,
      !!synced,
    );
  }
} else {
  fact('ext.build.installed', 'MISSING (extension not installed via postbuild sync)', null);
}

// --- Bridge instances ---
const instancesDir = join(BRIDGE_INSTALL, 'instances');
if (!existsSync(instancesDir)) {
  fact('bridge.instances', 'NONE (no running bridges)', null);
} else {
  const files = readdirSync(instancesDir).filter((f) => f.endsWith('.json'));
  fact('bridge.instances.count', String(files.length));
  for (const f of files) {
    try {
      const info = JSON.parse(readFileSync(join(instancesDir, f), 'utf8'));
      const r = sh(`curl -sfm 3 http://127.0.0.1:${info.port}/health`);
      fact(
        `bridge.instance[${info.pid}]`,
        `port=${info.port} ext=${info.extensionId} health=${r.code === 0 ? 'ok' : 'unreachable'}`,
        r.code === 0,
      );
    } catch (err) {
      fact(`bridge.instance[${f}]`, `parse error: ${err.message}`, false);
    }
  }
}

// --- gh rate limit ---
const ghRate = sh('gh api rate_limit --jq .resources.core.remaining 2>/dev/null');
fact('gh.rate.remaining', ghRate.stdout || 'unknown', parseInt(ghRate.stdout, 10) > 100);

// --- Loop state ---
if (existsSync(STATE_PATH)) {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    fact(
      'loop.state',
      `iter=${state.iteration} prsOpened=${state.prsOpened?.length || 0} prsMerged=${state.prsMerged?.length || 0} stall=${state.consecutiveNoPR || 0}`,
    );
    if (state.wallClockStartedAt) {
      const ageHrs = ((Date.now() - new Date(state.wallClockStartedAt).getTime()) / 3600000).toFixed(1);
      fact('loop.age.hours', ageHrs);
    }
    if (state.lastFailureSummary) {
      fact('loop.lastFailure', `${state.lastFailureSummary.imp || '?'}: ${state.lastFailureSummary.blocker || ''}`);
    }
  } catch (err) {
    fact('loop.state', `parse error: ${err.message}`, false);
  }
} else {
  fact('loop.state', 'no loop run in progress', null);
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(facts, null, 2) + '\n');
}

if (STRICT) {
  const failed = facts.find((f) => f.ok === false);
  if (failed) process.exit(1);
}
process.exit(0);
