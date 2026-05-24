/**
 * Check 7: Port config + bridge connectivity. Parses stdio-config.json, asserts
 * the URL points at EXPECTED_PORT, cross-checks the in-process NATIVE_SERVER_PORT
 * constant, and pings the bridge /ping endpoint. May emit up to 3 results.
 */

import fs from 'fs';
import { COMMAND_NAME } from '../../constant';
import { NATIVE_SERVER_PORT } from '../../../constant';
import { checkConnectivity, readJsonFile, stringifyError } from '../util';
import { EXPECTED_PORT } from '../types';
import type { DoctorContext } from '../context';
import type { CheckOutput, DoctorCheckResult } from '../types';

export async function runPortCheck(ctx: DoctorContext): Promise<CheckOutput> {
  const { stdioConfigPath } = ctx;

  if (!fs.existsSync(stdioConfigPath)) {
    return { checks: [], nextSteps: [] };
  }

  const checks: DoctorCheckResult[] = [];
  const nextSteps: string[] = [];

  const cfg = readJsonFile(stdioConfigPath);
  if (!cfg.ok) {
    checks.push({
      id: 'port.config',
      title: 'Port config',
      status: 'error',
      message: `Failed to parse stdio-config.json: ${cfg.error}`,
    });
    return { checks, nextSteps };
  }

  try {
    const configValue = cfg.value as Record<string, unknown>;
    const url = new URL(configValue.url as string);
    const port = Number(url.port);
    const portOk = port === EXPECTED_PORT;
    checks.push({
      id: 'port.config',
      title: 'Port config',
      status: portOk ? 'ok' : 'error',
      message: configValue.url as string,
      details: {
        expectedPort: EXPECTED_PORT,
        actualPort: port,
        fix: portOk ? undefined : [`${COMMAND_NAME} update-port ${EXPECTED_PORT}`],
      },
    });
    if (!portOk) nextSteps.push(`${COMMAND_NAME} update-port ${EXPECTED_PORT}`);

    // Check constant consistency
    const nativePortOk = NATIVE_SERVER_PORT === EXPECTED_PORT;
    checks.push({
      id: 'port.constant',
      title: 'Port constant',
      status: nativePortOk ? 'ok' : 'warn',
      message: `NATIVE_SERVER_PORT=${NATIVE_SERVER_PORT}`,
      details: { expectedPort: EXPECTED_PORT },
    });

    // Connectivity check
    const pingUrl = new URL('/ping', url);
    const ping = await checkConnectivity(pingUrl.toString(), 1500);
    checks.push({
      id: 'connectivity',
      title: 'Connectivity',
      status: ping.ok ? 'ok' : 'warn',
      message: ping.ok
        ? `GET ${pingUrl} -> ${ping.status}`
        : `GET ${pingUrl} failed (${ping.error || 'unknown error'})`,
      details: {
        hint: 'If the server is not running, click "Connect" in the extension and retry.',
      },
    });
    if (!ping.ok) nextSteps.push('Click "Connect" in the extension, then re-run doctor');
  } catch (e) {
    checks.push({
      id: 'port.config',
      title: 'Port config',
      status: 'error',
      message: `Invalid URL in stdio-config.json: ${stringifyError(e)}`,
    });
  }

  return { checks, nextSteps };
}
