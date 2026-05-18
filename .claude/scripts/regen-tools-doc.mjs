#!/usr/bin/env node
/**
 * Regenerate docs/TOOLS.md after a change to packages/shared/src/tools.ts
 * (or any tool-schemas/*.ts after IMP-0021's slice). Wired into
 * lint-staged so the docs can't drift out of sync with the schema source.
 *
 * Why a wrapper script instead of inlining the command in package.json:
 *  - lint-staged passes the staged filenames as args. The generator script
 *    doesn't take filename args -- it scans the whole tools module. We
 *    drop the args and re-stage the regenerated docs/TOOLS.md.
 *  - On generator failure we exit non-zero so lint-staged blocks the
 *    commit (better than silently committing stale docs).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..', '..');
const GENERATOR = resolve(REPO_ROOT, 'app', 'native-server', 'scripts', 'generate-tools-doc.mjs');
const DOCS_PATH = resolve(REPO_ROOT, 'docs', 'TOOLS.md');

const gen = spawnSync('node', [GENERATOR], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' });
if (gen.status !== 0) {
  process.stderr.write(`regen-tools-doc: generator exited ${gen.status}\n`);
  process.exit(gen.status || 1);
}

// Re-stage the regenerated file so the commit includes the up-to-date docs.
const add = spawnSync('git', ['add', DOCS_PATH], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' });
if (add.status !== 0) {
  process.stderr.write(`regen-tools-doc: git add failed (${add.status})\n`);
  process.exit(add.status || 1);
}
process.exit(0);
