#!/usr/bin/env node
/**
 * Regression test for the macOS TCC guard.
 *
 * The guard fires inside `getMainPath()` when the resolved wrapper path
 * sits inside a TCC-protected dir (`~/Documents`, `~/Desktop`, iCloud,
 * etc). With Full Disk Access alone Chrome still cannot `exec()` scripts
 * from those dirs, so registering a Native Messaging manifest pointing
 * there is a silent-failure trap. The guard refuses to write such a
 * manifest.
 *
 * This test stages a copy of the built bridge dist under ~/Documents and
 * confirms `tccProtectedRootContaining` flags the path. No real Chrome
 * needed — we exercise the guard helper directly.
 *
 * Used by both:
 *   - `.github/workflows/ci.yml` (macos-build job)
 *   - `scripts/ci-local.sh` (developer pre-push check)
 *
 * Run from repo root:  node scripts/verify-tcc-guard.mjs
 *
 * Exits 0 on success, 1 on guard failure, 2 on setup error.
 */
import { execSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const DIST_SRC = resolve(REPO_ROOT, 'app/native-server/dist');
const STAGE_BASE = resolve(homedir(), 'Documents/humanchrome-tcc-guard-smoke');
const STAGE_DIST = resolve(STAGE_BASE, 'dist');

if (!existsSync(DIST_SRC)) {
  process.stderr.write(
    `verify-tcc-guard: ${DIST_SRC} missing — run \`pnpm build\` first.\n`,
  );
  process.exit(2);
}

let exitCode = 0;
try {
  rmSync(STAGE_BASE, { recursive: true, force: true });
  mkdirSync(STAGE_DIST, { recursive: true });
  cpSync(DIST_SRC, STAGE_DIST, { recursive: true });

  const require = createRequire(import.meta.url);
  const { tccProtectedRootContaining } = require(
    resolve(STAGE_DIST, 'scripts/utils.js'),
  );
  const candidate = resolve(STAGE_DIST, 'run_host.sh');
  const flaggedRoot = tccProtectedRootContaining(candidate);
  if (!flaggedRoot) {
    process.stderr.write(
      `verify-tcc-guard: FAIL — guard did not flag ${candidate}.\n`,
    );
    exitCode = 1;
  } else {
    process.stdout.write(`verify-tcc-guard: OK (flagged under ${flaggedRoot})\n`);
  }
} catch (err) {
  process.stderr.write(`verify-tcc-guard: setup error: ${err?.message ?? err}\n`);
  exitCode = 2;
} finally {
  rmSync(STAGE_BASE, { recursive: true, force: true });
}

process.exit(exitCode);
