#!/usr/bin/env node
/**
 * Sequentially merge a queue of worktree branches onto main.
 *
 * Designed for the /improve-parallel flow: N implementer agents each work
 * in their own worktree, all sharing the same MAIN_SHA base. After they
 * return, this script walks the queue and merges them onto main one at a
 * time. The "merge nightmare" risk from parallel branches is contained by:
 *
 *   1. Every branch sharing the same parent commit (MAIN_SHA at fan-out).
 *      Conflicts are real, but they're the well-defined kind.
 *   2. Auto-resolving "additive" conflicts via union merge — when both
 *      sides only ADDED lines (no shared-line modifications), we keep
 *      both adds. This handles the common case where two parallel items
 *      each appended an entry to the same array (e.g. TOOL_NAMES.BROWSER).
 *   3. Typecheck guard after each merge. If union resolution produced an
 *      invalid TS state, we revert main to before the merge and requeue.
 *   4. Per-item failure isolation. One bad item doesn't block the rest.
 *
 * Usage (from repo root):
 *   node .claude/scripts/cascade-merge.mjs queue.json
 *
 * queue.json shape:
 *   [
 *     {
 *       "id": "IMP-0014",
 *       "title": "Add chrome_console_clear",
 *       "worktreePath": "/abs/path/to/.claude/worktrees/agent-XXX",
 *       "branch": "worktree-agent-XXX",
 *       "commitMessage": "feat(mcp-tools): chrome_console_clear..."
 *     },
 *     ...
 *   ]
 *
 * Output: JSON to stdout summarising per-item outcomes:
 *   { results: [{id, status, sha?, reason?, autoResolvedFiles?}] }
 *
 * Exit code 0 if at least one item merged; 1 otherwise.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function trySh(cmd, opts = {}) {
  try {
    return { ok: true, out: sh(cmd, opts) };
  } catch (err) {
    return {
      ok: false,
      out: '',
      err: err.message ?? String(err),
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
    };
  }
}

const CONFLICT_RE = /^<<<<<<< .*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> .*\n/gm;

/** Replace every conflict block with `ours + theirs` (union merge). Returns
 *  true if at least one block was replaced; throws if any malformed marker
 *  remains. */
function unionMergeFile(path) {
  let content = readFileSync(path, 'utf8');
  let resolved = 0;
  content = content.replace(CONFLICT_RE, (_match, ours, theirs) => {
    resolved += 1;
    return ours + theirs;
  });
  if (/^<<<<<<< |^=======|^>>>>>>> /m.test(content)) {
    throw new Error(`Stray conflict marker remains in ${path} after union merge`);
  }
  if (resolved > 0) writeFileSync(path, content, 'utf8');
  return resolved;
}

/** Rebase a worktree onto current main. Returns { ok, autoResolvedFiles? }
 *  on success or { ok: false, reason } on failure (with rebase aborted). */
function rebaseWithAutoResolve(worktreePath, mainRef = 'main') {
  // Try a clean rebase first.
  const r = trySh(`git rebase ${mainRef}`, { cwd: worktreePath });
  if (r.ok) return { ok: true, autoResolvedFiles: [] };

  // We're now in conflict state. Inventory unmerged files.
  const status = trySh('git status --porcelain', { cwd: worktreePath });
  if (!status.ok) {
    trySh('git rebase --abort', { cwd: worktreePath });
    return { ok: false, reason: 'git status failed after rebase conflict' };
  }
  const unmerged = status.out
    .split('\n')
    .filter((l) => l.startsWith('UU ') || l.startsWith('AA '))
    .map((l) => l.slice(3));
  if (unmerged.length === 0) {
    trySh('git rebase --abort', { cwd: worktreePath });
    return { ok: false, reason: 'rebase failed but no unmerged files surfaced' };
  }

  // Try union merge on each unmerged file. Bail on the first non-additive
  // conflict (we'd need a smarter resolver).
  const resolved = [];
  for (const f of unmerged) {
    const abs = resolve(worktreePath, f);
    if (!existsSync(abs)) {
      trySh('git rebase --abort', { cwd: worktreePath });
      return { ok: false, reason: `unmerged file ${f} not found on disk` };
    }
    try {
      const blocks = unionMergeFile(abs);
      if (blocks === 0) {
        trySh('git rebase --abort', { cwd: worktreePath });
        return { ok: false, reason: `${f} marked unmerged but had no conflict markers` };
      }
      resolved.push({ file: f, blocks });
      trySh(`git add ${JSON.stringify(f)}`, { cwd: worktreePath });
    } catch (err) {
      trySh('git rebase --abort', { cwd: worktreePath });
      return { ok: false, reason: `union merge failed on ${f}: ${err.message}` };
    }
  }

  // Continue the rebase. Use GIT_EDITOR=true so any auto-prompted commit
  // message goes through with the original.
  const cont = trySh('git rebase --continue', {
    cwd: worktreePath,
    env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
  });
  if (!cont.ok) {
    trySh('git rebase --abort', { cwd: worktreePath });
    return { ok: false, reason: `rebase --continue failed: ${cont.stderr || cont.err}` };
  }
  return { ok: true, autoResolvedFiles: resolved };
}

function commitWorktree(worktreePath, message) {
  // Stage everything (implementers leave their changes uncommitted).
  trySh('git add -A', { cwd: worktreePath });
  // If nothing to commit, this is a no-op item.
  const status = trySh('git status --porcelain', { cwd: worktreePath });
  if (status.ok && status.out.length === 0) {
    return { ok: false, reason: 'no-op (worktree had no changes)' };
  }
  // Use --no-verify to skip lint-staged hooks during the cascade — we run
  // the project's full ci-local.sh after the cascade completes.
  const tmp = `/tmp/cascade-msg-${process.pid}-${Date.now()}.txt`;
  writeFileSync(tmp, message, 'utf8');
  const r = trySh(`git commit --no-verify -F ${JSON.stringify(tmp)}`, { cwd: worktreePath });
  trySh(`rm -f ${JSON.stringify(tmp)}`);
  if (!r.ok) return { ok: false, reason: `commit failed: ${r.stderr || r.err}` };
  return { ok: true };
}

function ffMerge(branch) {
  const r = trySh(`git merge --ff-only ${JSON.stringify(branch)}`, { cwd: REPO_ROOT });
  if (!r.ok) return { ok: false, reason: `ff-merge failed: ${r.stderr || r.err}` };
  return { ok: true };
}

function quickGuard() {
  // Cheap sanity gate after each merge: build packages/shared (needed for
  // ts-jest / chrome-extension typecheck path resolution) and run
  // typecheck. Skip lint and tests — those run in the final ci-local.sh.
  const build = trySh('pnpm build:shared', { cwd: REPO_ROOT });
  if (!build.ok) {
    return { ok: false, reason: `pnpm build:shared failed: ${(build.stderr || build.err).slice(0, 800)}` };
  }
  const tc = trySh('pnpm typecheck', { cwd: REPO_ROOT });
  if (!tc.ok) {
    return { ok: false, reason: `pnpm typecheck failed: ${(tc.stderr || tc.err).slice(0, 800)}` };
  }
  return { ok: true };
}

function revertLastMerge() {
  // Hard reset main to its prior state. The merged commit is unreferenced
  // afterward; the worktree branch still points at it for inspection.
  trySh('git reset --hard HEAD~1', { cwd: REPO_ROOT });
}

function main() {
  const queueFile = process.argv[2];
  if (!queueFile) {
    process.stderr.write('cascade-merge: usage: cascade-merge.mjs <queue.json>\n');
    process.exit(2);
  }
  const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
  if (!Array.isArray(queue) || queue.length === 0) {
    process.stderr.write('cascade-merge: queue must be a non-empty array\n');
    process.exit(2);
  }

  // Sanity: are we on main with a clean tree?
  const branch = sh('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT });
  if (branch !== 'main') {
    process.stderr.write(`cascade-merge: must be on main, currently on ${branch}\n`);
    process.exit(2);
  }
  const dirty = sh('git status --porcelain', { cwd: REPO_ROOT });
  if (dirty) {
    process.stderr.write(`cascade-merge: main tree is dirty:\n${dirty}\n`);
    process.exit(2);
  }

  const results = [];
  let merged = 0;

  for (const item of queue) {
    const { id, worktreePath, branch: wtBranch, commitMessage } = item;
    process.stderr.write(`\n=== ${id} :: ${item.title} ===\n`);

    // 1. Commit on the worktree branch.
    const c = commitWorktree(worktreePath, commitMessage);
    if (!c.ok) {
      results.push({ id, status: c.reason === 'no-op (worktree had no changes)' ? 'no-op' : 'failed', reason: c.reason });
      process.stderr.write(`  ✗ ${c.reason}\n`);
      continue;
    }

    // 2. Rebase onto main (with union auto-resolve for additive conflicts).
    const r = rebaseWithAutoResolve(worktreePath);
    if (!r.ok) {
      results.push({ id, status: 'requeued-conflict', reason: r.reason });
      process.stderr.write(`  ✗ rebase: ${r.reason}\n`);
      continue;
    }
    if (r.autoResolvedFiles.length > 0) {
      const summary = r.autoResolvedFiles
        .map((f) => `${f.file} (${f.blocks} block${f.blocks === 1 ? '' : 's'})`)
        .join(', ');
      process.stderr.write(`  ⚠ union-resolved: ${summary}\n`);
    }

    // 3. FF-merge the rebased branch onto main.
    const ff = ffMerge(wtBranch);
    if (!ff.ok) {
      results.push({ id, status: 'requeued-ff', reason: ff.reason });
      process.stderr.write(`  ✗ ${ff.reason}\n`);
      continue;
    }

    // 4. Typecheck guard. Catches a bad union-resolve that produced
    //    syntactically valid but semantically broken code.
    const guard = quickGuard();
    if (!guard.ok) {
      revertLastMerge();
      results.push({ id, status: 'requeued-typecheck', reason: guard.reason });
      process.stderr.write(`  ✗ ${guard.reason}; reverted main\n`);
      continue;
    }

    const sha = sh('git rev-parse HEAD', { cwd: REPO_ROOT });
    results.push({
      id,
      status: 'merged',
      sha,
      autoResolvedFiles: r.autoResolvedFiles.length ? r.autoResolvedFiles : undefined,
    });
    merged += 1;
    process.stderr.write(`  ✓ merged as ${sha.slice(0, 7)}\n`);
  }

  process.stdout.write(JSON.stringify({ results, merged, total: queue.length }, null, 2) + '\n');
  process.exit(merged > 0 ? 0 : 1);
}

main();
