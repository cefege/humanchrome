/**
 * Shared utility helpers for the doctor command.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { colorText } from '../utils';
import { COMMAND_NAME } from '../constant';
import type { DoctorCheckResult, DoctorStatus } from './types';

export function readPackageJson(): Record<string, unknown> {
  try {
    return require('../../../package.json') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getCommandInfo(pkg: Record<string, unknown>): {
  canonical: string;
  aliases: string[];
} {
  const bin = pkg.bin as Record<string, string> | undefined;
  if (!bin || typeof bin !== 'object') {
    return { canonical: COMMAND_NAME, aliases: [] };
  }

  const canonical = COMMAND_NAME;
  const canonicalTarget = bin[canonical];

  const aliases = canonicalTarget
    ? Object.keys(bin).filter((name) => name !== canonical && bin[name] === canonicalTarget)
    : [];

  return { canonical, aliases };
}

export function resolveDistDir(): string {
  // __dirname is dist/scripts/doctor when running from compiled code
  const candidateFromDistScripts = path.resolve(__dirname, '..', '..');
  const candidateFromSrcScripts = path.resolve(__dirname, '..', '..', '..', 'dist');

  const looksLikeDist = (dir: string): boolean => {
    return (
      fs.existsSync(path.join(dir, 'mcp', 'stdio-config.json')) ||
      fs.existsSync(path.join(dir, 'run_host.sh')) ||
      fs.existsSync(path.join(dir, 'run_host.bat'))
    );
  };

  if (looksLikeDist(candidateFromDistScripts)) return candidateFromDistScripts;
  if (looksLikeDist(candidateFromSrcScripts)) return candidateFromSrcScripts;
  return candidateFromDistScripts;
}

export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function canExecute(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function normalizeComparablePath(filePath: string): string {
  if (process.platform === 'win32') {
    return path.normalize(filePath).toLowerCase();
  }
  return path.normalize(filePath);
}

export function stripOuterQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function expandTilde(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function expandWindowsEnvVars(input: string): string {
  if (process.platform !== 'win32') return input;
  return input.replace(/%([^%]+)%/g, (_match, name: string) => {
    const key = String(name);
    return (
      process.env[key] ?? process.env[key.toUpperCase()] ?? process.env[key.toLowerCase()] ?? _match
    );
  });
}

export function parseVersionFromDirName(dirName: string): number[] | null {
  const cleaned = dirName.trim().replace(/^v/, '');
  if (!/^\d+(\.\d+){0,3}$/.test(cleaned)) return null;
  return cleaned.split('.').map((part) => Number(part));
}

/**
 * Parse Node.js version string from `node -v` output.
 * Handles versions like: v20.10.0, v22.0.0-nightly.2024..., v21.0.0-rc.1
 * Returns major version number or null if parsing fails.
 */
export function parseNodeMajorVersion(versionString: string): number | null {
  if (!versionString) return null;
  // Match pattern: v?MAJOR.MINOR.PATCH[-anything]
  const match = versionString.trim().match(/^v?(\d+)(?:\.\d+)*(?:[-+].*)?$/i);
  if (match?.[1]) {
    const major = Number(match[1]);
    return Number.isNaN(major) ? null : major;
  }
  return null;
}

export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function pickLatestVersionDir(parentDir: string): string | null {
  if (!fs.existsSync(parentDir)) return null;
  const dirents = fs.readdirSync(parentDir, { withFileTypes: true });
  let best: { name: string; version: number[] } | null = null;

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const parsed = parseVersionFromDirName(dirent.name);
    if (!parsed) continue;
    if (!best || compareVersions(parsed, best.version) > 0) {
      best = { name: dirent.name, version: parsed };
    }
  }

  return best ? path.join(parentDir, best.name) : null;
}

export function readJsonFile(
  filePath: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: stringifyError(e) };
  }
}

type FetchFn = typeof globalThis.fetch;

export async function checkConnectivity(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (typeof globalThis.fetch !== 'function') {
    return { ok: false, error: 'fetch is not available (requires Node.js >=18)' };
  }
  const fetchFn = globalThis.fetch.bind(globalThis) as FetchFn;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Prevent timeout from keeping the process alive
  if (typeof timeout.unref === 'function') {
    timeout.unref();
  }

  try {
    const res = await fetchFn(url, { method: 'GET', signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (e: unknown) {
    const errMessage = e instanceof Error ? e.message : String(e);
    const errName = e instanceof Error ? e.name : '';
    if (errName === 'AbortError' || errMessage.toLowerCase().includes('abort')) {
      return { ok: false, error: `Timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: errMessage };
  } finally {
    clearTimeout(timeout);
  }
}

export type RegistryValueType = 'REG_SZ' | 'REG_EXPAND_SZ';

export function queryWindowsRegistryDefaultValue(registryKey: string): {
  value?: string;
  valueType?: RegistryValueType;
  error?: string;
} {
  try {
    const output = execFileSync('reg', ['query', registryKey, '/ve'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2500,
      windowsHide: true,
    });
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const match = line.match(/\b(REG_SZ|REG_EXPAND_SZ)\b\s+(.*)$/i);
      if (match?.[2]) {
        const valueType = match[1].toUpperCase() as RegistryValueType;
        return { value: match[2].trim(), valueType };
      }
    }
    return { error: 'No REG_SZ/REG_EXPAND_SZ default value found' };
  } catch (e) {
    return { error: stringifyError(e) };
  }
}

export function computeSummary(checks: DoctorCheckResult[]): {
  ok: number;
  warn: number;
  error: number;
} {
  let ok = 0;
  let warn = 0;
  let error = 0;
  for (const check of checks) {
    if (check.status === 'ok') ok++;
    else if (check.status === 'warn') warn++;
    else error++;
  }
  return { ok, warn, error };
}

export function statusBadge(status: DoctorStatus): string {
  if (status === 'ok') return colorText('[OK]', 'green');
  if (status === 'warn') return colorText('[WARN]', 'yellow');
  return colorText('[ERROR]', 'red');
}
