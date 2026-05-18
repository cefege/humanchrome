#!/usr/bin/env node
/**
 * Pre-flight safety checks for /improve-auto. Called by the orchestrator
 * after the implementer agent returns, BEFORE the parent pushes / opens
 * the PR. Refuses the iteration on any of the seven guardrails below.
 *
 * Usage:
 *   node .claude/scripts/loop-guardrails.mjs <worktree-path>
 *
 * Output (stdout, one fact per line — grep-parseable):
 *   ok                  -- all checks passed
 *   refuse: <reason>    -- one of the seven guardrail violations
 *
 * Exit code:
 *   0  -- ok
 *   1  -- guardrail tripped (parent should mark IMP queued + blocker)
 *   2  -- usage error / script bug
 *
 * The guardrails reflect what an autonomous loop should never do
 * unattended; each one comes from a concrete failure mode that would
 * either land bad code or burn quota for no payoff.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const WORKTREE = process.argv[2];
if (!WORKTREE) {
  process.stderr.write('usage: loop-guardrails.mjs <worktree-path>\n');
  process.exit(2);
}

function sh(cmd, cwd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function refuse(reason) {
  process.stdout.write(`refuse: ${reason}\n`);
  process.exit(1);
}

const REPO_ROOT = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..', '..');

// 1) Parent branch must be `main` -- never push from a feature branch by accident.
{
  const r = sh('git rev-parse --abbrev-ref HEAD', REPO_ROOT);
  if (r.stdout.trim() !== 'main') {
    refuse(`parent repo not on main (HEAD=${r.stdout.trim()})`);
  }
}

// 2) gh API rate limit -- bail before we burn the loop on 429s.
{
  const r = sh('gh api rate_limit --jq .resources.core.remaining', REPO_ROOT);
  const remaining = parseInt(r.stdout.trim(), 10);
  if (!Number.isFinite(remaining)) refuse(`gh rate_limit query failed: ${r.stderr || r.stdout}`);
  if (remaining < 100) refuse(`gh rate_limit core.remaining=${remaining} < 100`);
}

// 3) Worktree must have <= 50 uncommitted files. Implementer overreach signal.
{
  const r = sh('git status --porcelain | wc -l', WORKTREE);
  const n = parseInt(r.stdout.trim(), 10);
  if (n > 50) refuse(`worktree has ${n} uncommitted files (cap 50)`);
}

// 4) Diff must not touch banned paths. Loop never mucks with release infra,
//    lockfiles, or manifest-affecting config.
{
  const r = sh('git diff main --name-only', WORKTREE);
  const banned = [
    /^pnpm-lock\.yaml$/,
    /^package-lock\.yaml$/,
    /^app\/native-server\/scripts\/codesign\//,
    /^\.github\/workflows\/release\.yml$/,
    /^app\/chrome-extension\/wxt\.config\.ts$/,
  ];
  for (const file of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    for (const re of banned) {
      if (re.test(file)) refuse(`diff touches banned path: ${file}`);
    }
  }
}

// 5) Total LOC added must be <= 800. Conservative cap; bigger changes need
//    a human eye.
{
  const r = sh("git diff main --shortstat", WORKTREE);
  // Format: " 7 files changed, 309 insertions(+), 107 deletions(-)"
  const m = r.stdout.match(/(\d+) insertions?\(\+\)/);
  const added = m ? parseInt(m[1], 10) : 0;
  if (added > 800) refuse(`diff adds ${added} LOC > 800 cap`);
}

// 6) HEAD commit message must not contain BREAKING CHANGE / `!:` -- loop
//    never ships breaking changes unattended.
{
  const r = sh('git log -1 --format=%B', WORKTREE);
  const msg = r.stdout;
  if (/BREAKING CHANGE/.test(msg)) refuse('commit message contains BREAKING CHANGE');
  if (/^[a-z]+(\([^)]+\))?!:/m.test(msg)) refuse('commit subject uses conventional-commits ! marker (breaking)');
}

// 7) Branch name must match auto/imp-NNNN-*. Prevents merging onto random
//    branches if the implementer created its own naming.
{
  const r = sh('git rev-parse --abbrev-ref HEAD', WORKTREE);
  const branch = r.stdout.trim();
  if (!/^auto\/imp-\d{4,}-[a-z0-9-]+$/.test(branch)) {
    refuse(`branch name does not match auto/imp-NNNN-slug pattern: ${branch}`);
  }
}

process.stdout.write('ok\n');
process.exit(0);
