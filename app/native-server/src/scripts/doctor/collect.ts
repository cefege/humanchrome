/**
 * Top-level orchestrator. Builds the shared DoctorContext once, runs each
 * per-check module in sequence, accumulates results + nextSteps, and assembles
 * the final DoctorReport (including the optional --fix attempts).
 */

import { HOST_NAME } from '../constant';
import { buildDoctorContext } from './context';
import { attemptFixes } from './fixes';
import { computeSummary } from './util';
import { EXPECTED_PORT, SCHEMA_VERSION } from './types';
import type {
  CheckOutput,
  DoctorCheckResult,
  DoctorOptions,
  DoctorReport,
} from './types';

import { runInstallationCheck } from './checks/installation';
import { runHostFilesCheck } from './checks/host-files';
import { runHostPermissionsCheck } from './checks/host-permissions';
import { runNodeCheck } from './checks/node';
import { runManifestCheck } from './checks/manifest';
import { runWindowsRegistryCheck } from './checks/windows-registry';
import { runPortCheck } from './checks/port';
import { runLogsCheck } from './checks/logs';

export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const ctx = buildDoctorContext(options);

  // Run fixes if requested (mutates filesystem before the read-only checks
  // observe state, so --fix can flip checks from error -> ok in the same run).
  const fixes = await attemptFixes(
    Boolean(options.fix),
    Boolean(options.json),
    ctx.distDir,
    ctx.targetBrowsers,
  );

  const checks: DoctorCheckResult[] = [];
  const nextSteps: string[] = [];

  const accumulate = (out: CheckOutput) => {
    checks.push(...out.checks);
    nextSteps.push(...out.nextSteps);
  };

  // Order matters: results are presented to the user in this sequence.
  accumulate(runInstallationCheck(ctx));
  accumulate(runHostFilesCheck(ctx));
  accumulate(runHostPermissionsCheck(ctx));
  accumulate(runNodeCheck(ctx));
  accumulate(runManifestCheck(ctx));
  accumulate(runWindowsRegistryCheck(ctx));
  accumulate(await runPortCheck(ctx));
  accumulate(runLogsCheck(ctx));

  const summary = computeSummary(checks);
  const ok = summary.error === 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ok,
    summary,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: { version: process.version, execPath: process.execPath },
      package: {
        name: ctx.packageName,
        version: ctx.packageVersion,
        rootDir: ctx.rootDir,
        distDir: ctx.distDir,
      },
      command: { canonical: ctx.commandInfo.canonical, aliases: ctx.commandInfo.aliases },
      nativeHost: { hostName: HOST_NAME, expectedPort: EXPECTED_PORT },
    },
    fixes,
    checks,
    nextSteps: Array.from(new Set(nextSteps)).slice(0, 10),
  };
}
