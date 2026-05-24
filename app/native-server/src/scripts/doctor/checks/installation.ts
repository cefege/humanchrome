/**
 * Check 1: Installation info — always emits a single 'ok' result describing
 * the package, platform, and Node version the doctor is running under.
 */

import type { DoctorContext } from '../context';
import type { CheckOutput } from '../types';

export function runInstallationCheck(ctx: DoctorContext): CheckOutput {
  return {
    checks: [
      {
        id: 'installation',
        title: 'Installation',
        status: 'ok',
        message: `${ctx.packageName}@${ctx.packageVersion}, ${process.platform}-${process.arch}, node ${process.version}`,
        details: {
          packageRoot: ctx.rootDir,
          distDir: ctx.distDir,
          execPath: process.execPath,
          aliases: ctx.commandInfo.aliases,
        },
      },
    ],
    nextSteps: [],
  };
}
