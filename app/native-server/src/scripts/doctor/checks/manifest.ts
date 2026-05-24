/**
 * Check 5: Per-browser native messaging manifest. Emits one DoctorCheckResult
 * per target browser; verifies the manifest is present, parses, and points at
 * the installed wrapper with the expected extension origin allow-listed.
 */

import fs from 'fs';
import { EXTENSION_ID, HOST_NAME, COMMAND_NAME } from '../../constant';
import { getBrowserConfig } from '../../browser-config';
import { tccProtectedRootContaining } from '../../utils';
import { normalizeComparablePath, readJsonFile } from '../util';
import type { DoctorContext } from '../context';
import type { CheckOutput, DoctorCheckResult } from '../types';

export function runManifestCheck(ctx: DoctorContext): CheckOutput {
  const expectedOrigin = `chrome-extension://${EXTENSION_ID}/`;
  const checks: DoctorCheckResult[] = [];
  const nextSteps: string[] = [];

  for (const browser of ctx.browsersToCheck) {
    const config = getBrowserConfig(browser);
    const candidates = [config.userManifestPath, config.systemManifestPath];
    const found = candidates.find((p) => fs.existsSync(p));

    if (!found) {
      checks.push({
        id: `manifest.${browser}`,
        title: `${config.displayName} manifest`,
        status: 'error',
        message: 'Manifest not found',
        details: {
          expected: candidates,
          fix: [
            `${COMMAND_NAME} register --browser ${browser}`,
            `${COMMAND_NAME} register --detect`,
          ],
        },
      });
      nextSteps.push(`${COMMAND_NAME} register --detect`);
      continue;
    }

    const parsed = readJsonFile(found);
    if (!parsed.ok) {
      checks.push({
        id: `manifest.${browser}`,
        title: `${config.displayName} manifest`,
        status: 'error',
        message: `Failed to parse manifest: ${parsed.error}`,
        details: { path: found, fix: [`${COMMAND_NAME} register --browser ${browser}`] },
      });
      nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
      continue;
    }

    const manifest = parsed.value as Record<string, unknown>;
    const issues: string[] = [];
    if (manifest.name !== HOST_NAME) issues.push(`name != ${HOST_NAME}`);
    if (manifest.type !== 'stdio') issues.push(`type != stdio`);
    if (typeof manifest.path !== 'string') issues.push('path is missing');
    if (typeof manifest.path === 'string') {
      const actual = normalizeComparablePath(manifest.path);
      const expected = normalizeComparablePath(ctx.wrapperPath);
      if (actual !== expected) issues.push('path does not match installed wrapper');
      if (!fs.existsSync(manifest.path)) issues.push('path target does not exist');
      // macOS Tahoe TCC: Chrome cannot exec scripts under TCC-protected dirs
      // even with Full Disk Access. Manifest looks valid but every connectNative
      // call will silently fail. Surface this as an error with relocation hint.
      const tccRoot = tccProtectedRootContaining(manifest.path);
      if (tccRoot) {
        issues.push(
          `path is inside ${tccRoot} (macOS TCC-protected — Chrome cannot exec scripts here; reinstall under ~/Library/Application Support/humanchrome-bridge/)`,
        );
      }
    }
    const allowedOrigins = manifest.allowed_origins;
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.includes(expectedOrigin)) {
      issues.push(`allowed_origins missing ${expectedOrigin}`);
    }

    checks.push({
      id: `manifest.${browser}`,
      title: `${config.displayName} manifest`,
      status: issues.length === 0 ? 'ok' : 'error',
      message: issues.length === 0 ? found : `Invalid manifest (${issues.join('; ')})`,
      details: {
        path: found,
        expectedWrapperPath: ctx.wrapperPath,
        expectedOrigin,
        fix: issues.length === 0 ? undefined : [`${COMMAND_NAME} register --browser ${browser}`],
      },
    });
    if (issues.length > 0) nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
  }

  return { checks, nextSteps };
}
