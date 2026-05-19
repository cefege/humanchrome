#!/usr/bin/env node
/**
 * Stop-condition check for /improve-auto. The orchestrator runs this at
 * the end of every iteration; if it prints `done-*` the parent emits the
 * `<promise>BACKLOG_DRAINED</promise>` tag that ralph-loop's stop-hook
 * watches for, terminating the loop cleanly.
 *
 * Usage:
 *   node .claude/scripts/loop-completion-check.mjs [--update-iteration]
 *
 * Reads .claude/loop-state.local.json + docs/improvement-backlog.md.
 *
 * Output (stdout, one line):
 *   continue           -- keep iterating
 *   done-drained       -- no Active items match scope+score, scouts recent
 *   done-stalled       -- 5 consecutive iterations produced no PR
 *   done-walltime      -- 12h since loop start
 *   done-ratelimit     -- gh core.remaining < 100
 *   done-bootstrap     -- state file missing AND active items count would
 *                          have already drained on iter 1 (rare)
 *
 * Exit code: always 0 (the parent reads stdout to decide).
 *
 * Scope: matches /improve-auto's pick scope -- bug/perf/refactor/docs only.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBacklog } from './scout-shared.mjs';

const REPO_ROOT = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..', '..');
const STATE_PATH = resolve(REPO_ROOT, '.claude', 'loop-state.local.json');

const SCOPE = new Set(['bug', 'perf', 'refactor', 'docs']);
const MIN_SCORE = 4;
const STALL_LIMIT = 5;
const WALL_CLOCK_MS = 12 * 3600 * 1000;
const RECENT_SCOUT_WINDOW = 2; // iterations

async function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(await readFile(STATE_PATH, 'utf8'));
}

function ghRateRemaining() {
  const r = spawnSync('sh', ['-c', 'gh api rate_limit --jq .resources.core.remaining'], {
    encoding: 'utf8',
  });
  return parseInt((r.stdout || '0').trim(), 10);
}

const state = await loadState();
const parsed = await loadBacklog();

// Status strings often have free-text after the keyword:
// "done (2026-05-17; rebuilt+resynced bridge, ...)". Match by the
// leading word, not equality, so historical entries with notes don't
// get re-picked.
const STATUS_BLOCKED = /^(in-progress|done|wontdo)\b/i;

const eligible = parsed.active.filter(
  (it) =>
    SCOPE.has(it.kind) && it.score >= MIN_SCORE && !STATUS_BLOCKED.test(it.status || ''),
);

// Skip items the loop has already attempted (avoid thrashing on a bad pick).
const attempted = new Set((state?.prsOpened || []).map((p) => p.imp));
const pickable = eligible.filter((it) => !attempted.has(it.id));

if (!state) {
  // First iteration -- never stop. (Even if pickable is empty, scouts haven't
  // run yet from the loop's perspective.)
  process.stdout.write('continue\n');
  process.exit(0);
}

const remaining = ghRateRemaining();
if (Number.isFinite(remaining) && remaining < 100) {
  process.stdout.write('done-ratelimit\n');
  process.exit(0);
}

if (state.wallClockStartedAt) {
  const elapsed = Date.now() - new Date(state.wallClockStartedAt).getTime();
  if (elapsed > WALL_CLOCK_MS) {
    process.stdout.write('done-walltime\n');
    process.exit(0);
  }
}

if ((state.consecutiveNoPR || 0) >= STALL_LIMIT) {
  process.stdout.write('done-stalled\n');
  process.exit(0);
}

if (pickable.length === 0) {
  // Drained -- but only declare done if scouts have been run recently.
  // Otherwise this might be a transient empty backlog that scouts would
  // refill.
  const lastScoutIter = state.lastScoutAt?.iteration ?? -1;
  const iterationsSinceScout = (state.iteration ?? 0) - lastScoutIter;
  if (iterationsSinceScout <= RECENT_SCOUT_WINDOW) {
    process.stdout.write('done-drained\n');
    process.exit(0);
  }
  // Otherwise: scouts haven't run recently; keep iterating so the next
  // /improve-auto iteration will trigger them.
}

process.stdout.write('continue\n');
process.exit(0);
