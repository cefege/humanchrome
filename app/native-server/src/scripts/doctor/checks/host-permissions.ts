/**
 * Check 3: Host permissions — Unix-only. Confirms run_host.sh is executable
 * by the current user. Windows skips with an N/A 'ok'.
 */

import fs from 'fs';
import { COMMAND_NAME } from '../../constant';
import { canExecute } from '../util';
import type { DoctorContext } from '../context';
import type { CheckOutput } from '../types';

export function runHostPermissionsCheck(ctx: DoctorContext): CheckOutput {
  const { wrapperPath } = ctx;

  if (process.platform !== 'win32' && fs.existsSync(wrapperPath)) {
    const executable = canExecute(wrapperPath);
    const nextSteps = executable ? [] : [`${COMMAND_NAME} fix-permissions`];
    return {
      checks: [
        {
          id: 'host.permissions',
          title: 'Host permissions',
          status: executable ? 'ok' : 'error',
          message: executable ? 'run_host.sh is executable' : 'run_host.sh is not executable',
          details: {
            path: wrapperPath,
            fix: executable
              ? undefined
              : [`${COMMAND_NAME} fix-permissions`, `chmod +x "${wrapperPath}"`],
          },
        },
      ],
      nextSteps,
    };
  }

  return {
    checks: [
      {
        id: 'host.permissions',
        title: 'Host permissions',
        status: 'ok',
        message: process.platform === 'win32' ? 'Not applicable on Windows' : 'N/A',
      },
    ],
    nextSteps: [],
  };
}
