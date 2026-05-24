/**
 * Check 2: Host files — verify the wrapper script, compiled entry, and stdio
 * MCP config all exist on disk in the resolved dist directory.
 */

import fs from 'fs';
import { COMMAND_NAME } from '../../constant';
import type { DoctorContext } from '../context';
import type { CheckOutput } from '../types';

export function runHostFilesCheck(ctx: DoctorContext): CheckOutput {
  const { wrapperPath, nodeScriptPath, stdioConfigPath } = ctx;
  const missing: string[] = [];
  if (!fs.existsSync(wrapperPath)) missing.push(wrapperPath);
  if (!fs.existsSync(nodeScriptPath)) missing.push(nodeScriptPath);
  if (!fs.existsSync(stdioConfigPath)) missing.push(stdioConfigPath);

  if (missing.length > 0) {
    return {
      checks: [
        {
          id: 'host.files',
          title: 'Host files',
          status: 'error',
          message: `Missing required files (${missing.length})`,
          details: { missing },
        },
      ],
      nextSteps: [`Reinstall: npm install -g ${COMMAND_NAME}`],
    };
  }

  return {
    checks: [
      {
        id: 'host.files',
        title: 'Host files',
        status: 'ok',
        message: `Wrapper: ${wrapperPath}`,
        details: { wrapperPath, nodeScriptPath, stdioConfigPath },
      },
    ],
    nextSteps: [],
  };
}
