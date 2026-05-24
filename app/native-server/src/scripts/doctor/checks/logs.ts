/**
 * Check 8: Logs directory existence. Wrapper logs are created on first Chrome
 * launch, so an absent directory is a warn rather than an error.
 */

import fs from 'fs';
import type { DoctorContext } from '../context';
import type { CheckOutput } from '../types';

export function runLogsCheck(ctx: DoctorContext): CheckOutput {
  return {
    checks: [
      {
        id: 'logs',
        title: 'Logs',
        status: fs.existsSync(ctx.logDir) ? 'ok' : 'warn',
        message: ctx.logDir,
        details: {
          hint: 'Wrapper logs are created when Chrome launches the native host.',
        },
      },
    ],
    nextSteps: [],
  };
}
