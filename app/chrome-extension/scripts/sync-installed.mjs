#!/usr/bin/env node
/**
 * Sync .output/chrome-mv3/ to the install dir Chrome loaded the extension
 * from. Mirrors the bridge's sync-installed.mjs pattern.
 *
 * Why this exists: Chrome's "Load Unpacked" reads from a fixed path
 * baked into Secure Preferences. If the user installed humanchrome at
 * ~/Library/Application Support/humanchrome-extension/chrome-mv3 (the
 * TCC-safe default — see the project memory), every `pnpm build` only
 * updates .output/chrome-mv3/ under ~/Documents. Chrome never sees the
 * new code until the install dir is also updated, which requires
 * re-pointing "Load Unpacked" or manually rsync'ing. This postbuild
 * does the rsync.
 *
 * No-ops when the install dir doesn't exist (fresh checkout, or user
 * loaded directly from .output/chrome-mv3/). Honors HC_EXTENSION_INSTALL_DIR
 * env override for non-default install locations.
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_OUTPUT = path.resolve(HERE, '..', '.output', 'chrome-mv3');

function installDirCandidates() {
  if (process.env.HC_EXTENSION_INSTALL_DIR) return [process.env.HC_EXTENSION_INSTALL_DIR];
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library/Application Support/humanchrome-extension/chrome-mv3')];
  }
  if (process.platform === 'linux') {
    return [path.join(home, '.config/humanchrome-extension/chrome-mv3')];
  }
  if (process.platform === 'win32') {
    return [path.join(home, 'AppData/Local/humanchrome-extension/chrome-mv3')];
  }
  return [];
}

async function copyRecursive(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await copyRecursive(s, d);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        await fs.copyFile(s, d);
      }
    }),
  );
}

async function pruneOrphans(src, dst) {
  const srcEntries = new Set(await fs.readdir(src));
  const dstEntries = await fs.readdir(dst, { withFileTypes: true });
  await Promise.all(
    dstEntries.map(async (entry) => {
      if (srcEntries.has(entry.name)) {
        if (entry.isDirectory()) {
          await pruneOrphans(path.join(src, entry.name), path.join(dst, entry.name));
        }
        return;
      }
      await fs.rm(path.join(dst, entry.name), { recursive: true, force: true });
    }),
  );
}

async function main() {
  if (!existsSync(REPO_OUTPUT)) {
    console.log(`[sync-installed-ext] no build output at ${REPO_OUTPUT} — skipping`);
    return;
  }
  for (const dst of installDirCandidates()) {
    if (!existsSync(dst)) continue;
    console.log(`[sync-installed-ext] ${REPO_OUTPUT} → ${dst}`);
    await copyRecursive(REPO_OUTPUT, dst);
    await pruneOrphans(REPO_OUTPUT, dst);
  }
}

main().catch((err) => {
  console.error('[sync-installed-ext] failed:', err);
  // Non-fatal — don't break the build over a sync failure.
  process.exit(0);
});
