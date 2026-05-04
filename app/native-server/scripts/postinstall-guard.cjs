#!/usr/bin/env node
/* eslint-env node */
/**
 * Postinstall guard: only runs the real postinstall when `dist/` is present.
 *
 * - Fresh clones (`pnpm install` from source) skip it because dist hasn't been
 *   built yet — the user runs `pnpm build` separately.
 * - npm-published installs include `dist/` (per the `files` field), so the real
 *   postinstall runs and registers the native messaging host.
 */
const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'dist', 'scripts', 'postinstall.js');

if (!fs.existsSync(target)) {
  // Silent no-op; common for fresh clones before the first build.
  process.exit(0);
}

require(target);
