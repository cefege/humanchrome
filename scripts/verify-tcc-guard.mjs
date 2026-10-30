#!/usr/bin/env node
/**
 * Regression test for the macOS TCC guard in the Rust registration CLI.
 *
 * It stages a native host inside an isolated HOME/Documents directory and
 * proves registration rejects it before a manifest can be created. No real
 * Chrome profile or installation is read or modified.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const bridge = resolve(root, 'target', 'release', `humanchrome-bridge${suffix}`);
const nativeHost = resolve(root, 'target', 'release', `humanchrome-nativehost${suffix}`);

if (process.platform !== 'darwin') {
  process.stderr.write('verify-tcc-guard: macOS only\n');
  process.exit(2);
}
if (!existsSync(bridge) || !existsSync(nativeHost)) {
  process.stderr.write('verify-tcc-guard: native release binaries missing — run `pnpm build:native` first.\n');
  process.exit(2);
}

const stage = mkdtempSync(join(tmpdir(), 'humanchrome-tcc-guard-'));
try {
  const home = join(stage, 'home');
  const documents = join(home, 'Documents');
  const stagedHost = join(documents, `humanchrome-nativehost${suffix}`);
  mkdirSync(documents, { recursive: true });
  cpSync(nativeHost, stagedHost);
  chmodSync(stagedHost, 0o755);

  const result = spawnSync(
    bridge,
    ['register', '--host-path', stagedHost, '--browser', 'chrome'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
      },
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0 || !output.includes('TCC-protected native host path')) {
    process.stderr.write(`verify-tcc-guard: FAIL — expected TCC refusal, got: ${output}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('verify-tcc-guard: OK (Rust registration rejected isolated Documents host)\n');
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
