#!/usr/bin/env node
/**
 * Reset the current git worktree to a specific main commit.
 *
 * Why this exists: `Agent({ isolation: 'worktree' })` branches from a
 * session-fixed commit, not current main HEAD. Implementer agents must
 * run this before doing any work — otherwise their worktree is missing
 * everything merged in earlier `/improve` runs and the change ships
 * fundamentally broken (missing renames, missing tools, etc).
 *
 * Usage (from inside the worktree):
 *   node /Users/mike/Documents/Code/humanchrome/.claude/scripts/sync-worktree-to-main.mjs <main-sha>
 *
 * On success: HEAD is reset to <main-sha>, prints "synced to <sha>", exits 0.
 * On failure: prints the mismatch / git error to stderr, exits 1.
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_REPO = resolve(here, '..', '..');

const sha = process.argv[2];
if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
  process.stderr.write(
    'sync-worktree-to-main: pass the target main commit SHA as the first argument.\n',
  );
  process.exit(1);
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  // Fetch main from the source repo into a throwaway local ref, hard-reset
  // to it, then drop the throwaway. This is the same recipe that worked for
  // rebasing IMP-0001/0003/0004/0002 worktrees post-hoc, just made callable.
  run(`git fetch ${SOURCE_REPO} main:_sync_target`);
  run(`git reset --hard _sync_target`);
  run('git branch -D _sync_target');

  const head = run('git rev-parse HEAD');
  if (!head.startsWith(sha) && !sha.startsWith(head)) {
    process.stderr.write(
      `sync-worktree-to-main: HEAD is ${head} but expected ${sha}. Aborting.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`synced to ${head}\n`);
} catch (err) {
  process.stderr.write(`sync-worktree-to-main failed: ${err.message ?? String(err)}\n`);
  process.exit(1);
}
