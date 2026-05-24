/**
 * Check 4: Node executable — resolve the Node.js binary that run_host.sh/bat
 * would pick, run `node -v` against it, and classify version / source issues.
 */

import { execFileSync } from 'child_process';
import { COMMAND_NAME } from '../../constant';
import { resolveNodeCandidate } from '../node-resolution';
import { parseNodeMajorVersion, stringifyError } from '../util';
import { MIN_NODE_MAJOR_VERSION } from '../types';
import type { DoctorContext } from '../context';
import type { CheckOutput, DoctorStatus } from '../types';

export function runNodeCheck(ctx: DoctorContext): CheckOutput {
  const nodeResolution = resolveNodeCandidate(ctx.distDir);
  if (nodeResolution.nodePath) {
    try {
      nodeResolution.version = execFileSync(nodeResolution.nodePath, ['-v'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2500,
        windowsHide: true,
      }).trim();
    } catch (e) {
      nodeResolution.versionError = stringifyError(e);
    }
  }

  // Parse Node version and check if it meets minimum requirement
  const nodeMajorVersion = parseNodeMajorVersion(nodeResolution.version || '');
  const nodeVersionTooOld = nodeMajorVersion !== null && nodeMajorVersion < MIN_NODE_MAJOR_VERSION;

  const nodePathWarn =
    Boolean(nodeResolution.nodePath) &&
    (!nodeResolution.nodePathFile.exists || nodeResolution.nodePathFile.valid === false) &&
    !process.env.HUMANCHROME_NODE_PATH;

  let nodeStatus: DoctorStatus;
  let nodeMessage: string;
  let nodeFix: string[] | undefined;
  const nextSteps: string[] = [];

  if (!nodeResolution.nodePath) {
    nodeStatus = 'error';
    nodeMessage = 'Node.js executable not found by wrapper search order';
    nodeFix = [
      `${COMMAND_NAME} doctor --fix`,
      `Or set HUMANCHROME_NODE_PATH to an absolute node path`,
    ];
    nextSteps.push(`${COMMAND_NAME} doctor --fix`);
  } else if (nodeResolution.versionError) {
    nodeStatus = 'error';
    nodeMessage = `Found ${nodeResolution.source}: ${nodeResolution.nodePath} but failed to run "node -v" (${nodeResolution.versionError})`;
    nodeFix = [
      `Verify the executable: "${nodeResolution.nodePath}" -v`,
      `Reinstall/repair Node.js`,
    ];
    nextSteps.push(`Verify Node.js: "${nodeResolution.nodePath}" -v`);
  } else if (nodeVersionTooOld) {
    nodeStatus = 'error';
    nodeMessage = `Node.js ${nodeResolution.version} is too old (requires >= ${MIN_NODE_MAJOR_VERSION}.0.0)`;
    nodeFix = [`Upgrade Node.js to version ${MIN_NODE_MAJOR_VERSION} or higher`];
    nextSteps.push(`Upgrade Node.js to version ${MIN_NODE_MAJOR_VERSION}+`);
  } else if (nodePathWarn) {
    nodeStatus = 'warn';
    nodeMessage = `Using ${nodeResolution.source}: ${nodeResolution.nodePath}${nodeResolution.version ? ` (${nodeResolution.version})` : ''}`;
    nodeFix = [
      `${COMMAND_NAME} doctor --fix`,
      `Or set HUMANCHROME_NODE_PATH to an absolute node path`,
    ];
  } else {
    nodeStatus = 'ok';
    nodeMessage = `Using ${nodeResolution.source}: ${nodeResolution.nodePath}${nodeResolution.version ? ` (${nodeResolution.version})` : ''}`;
  }

  return {
    checks: [
      {
        id: 'node',
        title: 'Node executable',
        status: nodeStatus,
        message: nodeMessage,
        details: {
          resolved: nodeResolution.nodePath
            ? {
                source: nodeResolution.source,
                path: nodeResolution.nodePath,
                version: nodeResolution.version,
                versionError: nodeResolution.versionError,
                majorVersion: nodeMajorVersion,
              }
            : undefined,
          nodePathFile: nodeResolution.nodePathFile,
          minRequired: `>=${MIN_NODE_MAJOR_VERSION}.0.0`,
          fix: nodeFix,
        },
      },
    ],
    nextSteps,
  };
}
