#!/usr/bin/env node

/**
 * doctor.ts
 *
 * Diagnoses common installation and runtime issues for the Chrome Native
 * Messaging host. Provides checks for manifest files, Node.js path,
 * permissions, and connectivity.
 *
 * The implementation lives in ./doctor/ — split into per-check modules so each
 * check is small and isolated. This file is the public entry point consumed by
 * cli.ts (`runDoctor`) and report.ts (`collectDoctorReport`).
 */

export { runDoctor } from './doctor/run';
export { collectDoctorReport } from './doctor/collect';
export type {
  DoctorOptions,
  DoctorStatus,
  DoctorFixAttempt,
  DoctorCheckResult,
  DoctorReport,
} from './doctor/types';
