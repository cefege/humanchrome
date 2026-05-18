#!/usr/bin/env node
/**
 * Atomic updater for .claude/loop-state.local.json. Used by /improve-auto
 * to track per-iteration state without races (sequential writes from the
 * single orchestrator, but we still write atomically via tmp + rename).
 *
 * Usage:
 *   node .claude/scripts/loop-state-update.mjs <action> [args...]
 *
 * Actions:
 *   init                                 -- create state file with iteration=0,
 *                                            wallClockStartedAt=now (idempotent;
 *                                            only writes if file missing)
 *   begin-iteration                      -- iteration += 1; prints new iteration
 *   record-scout                         -- lastScoutAt = {iteration, ts}
 *   record-pr <imp> <prNumber> <url>     -- appends to prsOpened, resets
 *                                            consecutiveNoPR, increments
 *                                            consecutivePRs
 *   record-no-pr <imp> <blocker>         -- increments consecutiveNoPR; logs
 *                                            blocker into lastFailureSummary
 *   record-merge <imp> <prNumber>        -- moves entry from prsOpened to
 *                                            prsMerged
 *   show                                 -- prints whole state to stdout
 *
 * Exit code 0 on success, 1 on usage error or filesystem failure.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..', '..');
const STATE_PATH = resolve(REPO_ROOT, '.claude', 'loop-state.local.json');

async function load() {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(await readFile(STATE_PATH, 'utf8'));
}

async function save(state) {
  const tmp = STATE_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(tmp, STATE_PATH);
}

function emptyState() {
  return {
    iteration: 0,
    wallClockStartedAt: new Date().toISOString(),
    lastScoutAt: null,
    consecutivePRs: 0,
    consecutiveNoPR: 0,
    prsOpened: [],
    prsMerged: [],
    lastFailureSummary: null,
  };
}

const [, , action, ...args] = process.argv;
let state = await load();

switch (action) {
  case 'init':
    if (!state) {
      state = emptyState();
      await save(state);
      process.stdout.write('initialized\n');
    } else {
      process.stdout.write('already-initialized\n');
    }
    break;

  case 'begin-iteration': {
    if (!state) state = emptyState();
    state.iteration += 1;
    await save(state);
    process.stdout.write(String(state.iteration) + '\n');
    break;
  }

  case 'record-scout': {
    if (!state) state = emptyState();
    state.lastScoutAt = { iteration: state.iteration, ts: new Date().toISOString() };
    await save(state);
    process.stdout.write('ok\n');
    break;
  }

  case 'record-pr': {
    const [imp, num, url] = args;
    if (!imp || !num) {
      process.stderr.write('usage: record-pr <imp> <prNumber> [url]\n');
      process.exit(1);
    }
    if (!state) state = emptyState();
    state.prsOpened.push({
      imp,
      pr: parseInt(num, 10),
      url: url || '',
      ts: new Date().toISOString(),
      iteration: state.iteration,
    });
    state.consecutivePRs = (state.consecutivePRs || 0) + 1;
    state.consecutiveNoPR = 0;
    await save(state);
    process.stdout.write('ok\n');
    break;
  }

  case 'record-no-pr': {
    const [imp, ...blockerWords] = args;
    if (!state) state = emptyState();
    state.consecutiveNoPR = (state.consecutiveNoPR || 0) + 1;
    state.consecutivePRs = 0;
    state.lastFailureSummary = {
      imp: imp || null,
      blocker: blockerWords.join(' '),
      iteration: state.iteration,
      ts: new Date().toISOString(),
    };
    await save(state);
    process.stdout.write('ok\n');
    break;
  }

  case 'record-merge': {
    const [imp, num] = args;
    if (!imp || !num) {
      process.stderr.write('usage: record-merge <imp> <prNumber>\n');
      process.exit(1);
    }
    if (!state) state = emptyState();
    const idx = state.prsOpened.findIndex((p) => p.imp === imp && p.pr === parseInt(num, 10));
    if (idx >= 0) {
      const [moved] = state.prsOpened.splice(idx, 1);
      state.prsMerged.push({ ...moved, mergedAt: new Date().toISOString() });
    }
    await save(state);
    process.stdout.write('ok\n');
    break;
  }

  case 'show': {
    if (!state) {
      process.stdout.write('null\n');
    } else {
      process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    }
    break;
  }

  default:
    process.stderr.write(`unknown action: ${action}\n`);
    process.stderr.write(
      'actions: init | begin-iteration | record-scout | record-pr | record-no-pr | record-merge | show\n',
    );
    process.exit(1);
}
