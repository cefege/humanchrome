#!/usr/bin/env node
/**
 * Sync the freshly built `dist/` to the location Chrome's native-messaging
 * host is registered to use. No-ops cleanly when there's no registered host
 * yet (fresh checkout) or the manifest can't be parsed.
 *
 * Why this exists
 * ---------------
 * The native host is launched by Chrome from a path baked into a manifest
 * under ~/Library/Application Support/<browser>/NativeMessagingHosts/. That
 * path can point at *any* dist/ — typically a user-data-local copy created
 * by `register-dev` or `postinstall`, NOT the repo. Without this sync,
 * `pnpm build` rebuilds the repo's dist but Chrome keeps running the stale
 * installed copy → fixes don't take effect after extension reload.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIST = path.resolve(HERE, '..', '..', 'dist');
const SHARED_DIST = path.resolve(HERE, '..', '..', '..', '..', 'packages', 'shared', 'dist');

const MANIFEST_NAME = 'com.humanchrome.nativehost.json';

/** Workspace deps that pnpm deploy bundled into <install>/node_modules. Their
 *  source-of-truth dist directories must be re-synced or the bridge boots with
 *  stale TOOL_SCHEMAS, error codes, etc. after a `pnpm build`. */
const WORKSPACE_DEPS = [{ name: 'humanchrome-shared', distSrc: SHARED_DIST }];

function manifestCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', MANIFEST_NAME),
      path.join(home, 'Library/Application Support/Google/Chrome Beta/NativeMessagingHosts', MANIFEST_NAME),
      path.join(home, 'Library/Application Support/Google/Chrome Canary/NativeMessagingHosts', MANIFEST_NAME),
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join(home, '.config/google-chrome/NativeMessagingHosts', MANIFEST_NAME),
      path.join(home, '.config/chromium/NativeMessagingHosts', MANIFEST_NAME),
    ];
  }
  // Windows manifests live in the registry; users on Windows can do their
  // own sync — out of scope for this script.
  return [];
}

async function readManifest(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  let installedDist = null;
  for (const file of manifestCandidates()) {
    const manifest = await readManifest(file);
    if (!manifest?.path) continue;
    // The manifest points at run_host.sh inside the install's dist. Walk
    // up one level to get the dist directory itself.
    installedDist = path.dirname(manifest.path);
    break;
  }
  if (!installedDist) {
    console.log('[sync-installed] no native-host manifest found — skipping');
    return;
  }
  if (path.resolve(installedDist) === path.resolve(REPO_DIST)) {
    console.log('[sync-installed] manifest already points at repo dist — no copy needed');
    return;
  }
  try {
    await fs.cp(REPO_DIST, installedDist, { recursive: true, force: true });
    console.log(`[sync-installed] ${REPO_DIST} → ${installedDist}`);
  } catch (err) {
    console.warn(`[sync-installed] copy failed: ${err.message}`);
  }

  // Also refresh the bundled workspace deps so a `pnpm build` of e.g.
  // humanchrome-shared actually reaches the running bridge. Without this,
  // pnpm-deploy's snapshot of these packages stays frozen at deploy time
  // and the bridge keeps booting with old TOOL_SCHEMAS / error codes.
  const installRoot = path.dirname(installedDist);
  for (const dep of WORKSPACE_DEPS) {
    const target = path.join(installRoot, 'node_modules', dep.name, 'dist');
    try {
      await fs.access(dep.distSrc);
    } catch {
      continue;
    }
    try {
      await fs.cp(dep.distSrc, target, { recursive: true, force: true });
      console.log(`[sync-installed] ${dep.distSrc} → ${target}`);
    } catch (err) {
      console.warn(`[sync-installed] dep ${dep.name} copy failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.warn(`[sync-installed] fatal: ${err.message}`);
});
