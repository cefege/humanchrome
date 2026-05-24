/**
 * Shared types for the doctor command.
 */

export interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  browser?: string;
}

export type DoctorStatus = 'ok' | 'warn' | 'error';

export interface DoctorFixAttempt {
  id: string;
  description: string;
  success: boolean;
  error?: string;
}

export interface DoctorCheckResult {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  schemaVersion: number;
  timestamp: string;
  ok: boolean;
  summary: {
    ok: number;
    warn: number;
    error: number;
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    node: {
      version: string;
      execPath: string;
    };
    package: {
      name: string;
      version: string;
      rootDir: string;
      distDir: string;
    };
    command: {
      canonical: string;
      aliases: string[];
    };
    nativeHost: {
      hostName: string;
      expectedPort: number;
    };
  };
  fixes: DoctorFixAttempt[];
  checks: DoctorCheckResult[];
  nextSteps: string[];
}

export interface NodeResolutionResult {
  nodePath?: string;
  source?: string;
  version?: string;
  versionError?: string;
  nodePathFile: {
    path: string;
    exists: boolean;
    value?: string;
    valid?: boolean;
    error?: string;
  };
}

/**
 * Result returned by each per-check module. Most checks emit a single result,
 * but the manifest and windows-registry checks emit one per target browser, so
 * checks return arrays. nextSteps is the list of repair commands to surface
 * at the bottom of the report.
 */
export interface CheckOutput {
  checks: DoctorCheckResult[];
  nextSteps: string[];
}

export const EXPECTED_PORT = 12306;
export const SCHEMA_VERSION = 1;
export const MIN_NODE_MAJOR_VERSION = 20;
