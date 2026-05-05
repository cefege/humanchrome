#!/usr/bin/env node
/**
 * Refuse-when-dirty gate for /improve.
 *
 * Why: implementer agents work in `git worktree`s, which branch from the
 * committed state of `main`. Any uncommitted change in the main working tree
 * is invisible to the implementer — so each successive /improve would build
 * on stale code instead of on the work that just landed. This gate keeps
 * improvements compounding by requiring a clean tree before each run.
 *
 * Exit codes:
 *   0 — clean (prints "clean")
 *   1 — dirty (prints offending paths to stderr)
 *   2 — git command failed
 *
 * Always-ignored paths (don't count as dirty):
 *   - `.claude/worktrees/`  — implementer agent output staging
 *   - anything already in .gitignore (git status excludes these by default)
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

const IGNORE_PREFIXES = ['.claude/worktrees/'];

function getStatusLines() {
  try {
    const out = execSync('git status --porcelain', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return out.split('\n').filter((l) => l.length > 0);
  } catch (err) {
    process.stderr.write(`check-clean: git status failed: ${err.message}\n`);
    process.exit(2);
  }
}

/**
 * `git status --porcelain` lines look like:
 *   ` M docs/improvement-backlog.md`
 *   `?? .claude/worktrees/agent-foo/`
 *   `MM packages/shared/src/tools.ts`
 * The first two characters are status codes, then a space, then the path.
 * Renames look like ` R old -> new` — we take the new path on the right.
 */
function pathFromStatusLine(line) {
  const rest = line.slice(3);
  const arrow = rest.indexOf(' -> ');
  return arrow === -1 ? rest : rest.slice(arrow + 4);
}

function shouldIgnore(path) {
  return IGNORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const lines = getStatusLines();
const dirty = lines.filter((line) => !shouldIgnore(pathFromStatusLine(line)));

if (dirty.length === 0) {
  process.stdout.write('clean\n');
  process.exit(0);
}

process.stderr.write('dirty — uncommitted changes:\n');
for (const line of dirty) process.stderr.write(`  ${line}\n`);
process.stderr.write(
  '\nCommit (or stash) before running /improve so the implementer worktree branches from your latest state.\n',
);
process.exit(1);
