/**
 * Check 6: Windows-only registry validation. For each target browser, query
 * the per-user and per-machine native messaging keys; compare against the
 * expected manifest path and flag missing / pointing-to-deleted-file cases.
 * Returns an empty CheckOutput on non-Windows platforms.
 */

import fs from 'fs';
import { COMMAND_NAME } from '../../constant';
import { getBrowserConfig } from '../../browser-config';
import {
  expandWindowsEnvVars,
  normalizeComparablePath,
  queryWindowsRegistryDefaultValue,
  stripOuterQuotes,
} from '../util';
import type { DoctorContext } from '../context';
import type { CheckOutput, DoctorCheckResult, DoctorStatus } from '../types';

export function runWindowsRegistryCheck(ctx: DoctorContext): CheckOutput {
  if (process.platform !== 'win32') {
    return { checks: [], nextSteps: [] };
  }

  const checks: DoctorCheckResult[] = [];
  const nextSteps: string[] = [];

  for (const browser of ctx.browsersToCheck) {
    const config = getBrowserConfig(browser);
    const keySpecs = [
      config.registryKey ? { key: config.registryKey, expected: config.userManifestPath } : null,
      config.systemRegistryKey
        ? { key: config.systemRegistryKey, expected: config.systemManifestPath }
        : null,
    ].filter(Boolean) as Array<{ key: string; expected: string }>;
    if (keySpecs.length === 0) continue;

    let anyValue = false;
    let anyExistingTarget = false;
    let anyMissingTarget = false;
    let anyMismatch = false;

    const results: Array<{
      key: string;
      expected: string;
      value?: string;
      valueType?: string;
      expandedValue?: string;
      exists?: boolean;
      matchesExpected?: boolean;
      error?: string;
    }> = [];

    for (const spec of keySpecs) {
      const res = queryWindowsRegistryDefaultValue(spec.key);
      if (!res.value) {
        results.push({ key: spec.key, expected: spec.expected, error: res.error });
        continue;
      }

      anyValue = true;
      // Expand environment variables for REG_EXPAND_SZ values
      const expandedValue = expandWindowsEnvVars(stripOuterQuotes(res.value));
      const exists = fs.existsSync(expandedValue);
      const matchesExpected =
        normalizeComparablePath(expandedValue) === normalizeComparablePath(spec.expected);

      if (exists) {
        anyExistingTarget = true;
        if (!matchesExpected) anyMismatch = true;
      } else {
        anyMissingTarget = true;
      }

      results.push({
        key: spec.key,
        expected: spec.expected,
        value: res.value,
        valueType: res.valueType,
        expandedValue: expandedValue !== res.value ? expandedValue : undefined,
        exists,
        matchesExpected,
      });
    }

    let status: DoctorStatus;
    let message: string;
    if (!anyValue) {
      status = 'error';
      message = 'Registry entry not found';
    } else if (!anyExistingTarget) {
      status = 'error';
      message = 'Registry entry points to missing manifest';
    } else if (anyMissingTarget || anyMismatch) {
      status = 'warn';
      message = 'Registry entry found but inconsistent';
    } else {
      status = 'ok';
      message = 'Registry entry points to manifest';
    }

    checks.push({
      id: `registry.${browser}`,
      title: `${config.displayName} registry`,
      status,
      message,
      details: {
        keys: keySpecs.map((s) => s.key),
        results,
        fix: status === 'ok' ? undefined : [`${COMMAND_NAME} register --browser ${browser}`],
      },
    });
    if (status !== 'ok') nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
  }

  return { checks, nextSteps };
}
