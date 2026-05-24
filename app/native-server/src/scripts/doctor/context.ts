/**
 * Build the shared state passed into each per-check module.
 * `collectDoctorReport()` constructs this once and passes it down so the checks
 * are pure (input -> CheckOutput) and trivial to test in isolation.
 */

import path from 'path';
import { BrowserType } from '../browser-config';
import { getLogDir } from '../utils';
import { getCommandInfo, readPackageJson, resolveDistDir } from './util';
import { resolveTargetBrowsers, resolveBrowsersToCheck } from './browser-resolution';
import type { DoctorOptions } from './types';

export interface DoctorContext {
  pkg: Record<string, unknown>;
  packageName: string;
  packageVersion: string;
  distDir: string;
  rootDir: string;
  commandInfo: { canonical: string; aliases: string[] };
  targetBrowsers: BrowserType[] | undefined;
  browsersToCheck: BrowserType[];
  wrapperPath: string;
  nodeScriptPath: string;
  stdioConfigPath: string;
  logDir: string;
}

export function buildDoctorContext(options: DoctorOptions): DoctorContext {
  const pkg = readPackageJson();
  const distDir = resolveDistDir();
  const rootDir = path.resolve(distDir, '..');
  const packageName = typeof pkg.name === 'string' ? pkg.name : 'humanchrome-bridge';
  const packageVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  const commandInfo = getCommandInfo(pkg);

  const targetBrowsers = resolveTargetBrowsers(options.browser);
  const browsersToCheck = resolveBrowsersToCheck(targetBrowsers);

  const wrapperScriptName = process.platform === 'win32' ? 'run_host.bat' : 'run_host.sh';
  const wrapperPath = path.resolve(distDir, wrapperScriptName);
  const nodeScriptPath = path.resolve(distDir, 'index.js');
  const logDir = getLogDir();
  const stdioConfigPath = path.resolve(distDir, 'mcp', 'stdio-config.json');

  return {
    pkg,
    packageName,
    packageVersion,
    distDir,
    rootDir,
    commandInfo,
    targetBrowsers,
    browsersToCheck,
    wrapperPath,
    nodeScriptPath,
    stdioConfigPath,
    logDir,
  };
}
