/**
 * Execution Mode Configuration
 *
 * Routing policy lives in the shared Rust kernel. This module retains the public
 * configuration shape used by the effect-host executors.
 */

import { replayPolicy } from 'humanchrome-shared';
import type { Step } from '../types';

export type ExecutionMode = 'legacy' | 'actions' | 'hybrid';

export interface ExecutionModeConfig {
  mode: ExecutionMode;
  legacyOnlyTypes?: Set<string>;
  actionsAllowlist?: Set<string>;
  logFallbacks?: boolean;
  skipActionsRetry?: boolean;
  skipActionsNavWait?: boolean;
}

export const DEFAULT_EXECUTION_MODE_CONFIG: ExecutionModeConfig = {
  mode: 'legacy',
  logFallbacks: true,
  skipActionsRetry: true,
  skipActionsNavWait: true,
};

export const MINIMAL_HYBRID_ACTION_TYPES = new Set<string>();
export const MIGRATED_ACTION_TYPES = new Set<string>();
export const NEEDS_VALIDATION_TYPES = new Set<string>();
export const LEGACY_ONLY_TYPES = new Set<string>();

let routingSetsLoaded = false;

function routingSets(): {
  minimalHybridActionTypes: Set<string>;
  migratedActionTypes: Set<string>;
  needsValidationTypes: Set<string>;
  legacyOnlyTypes: Set<string>;
} {
  if (!routingSetsLoaded) {
    const sets = replayPolicy.replayExecutionModeSets();
    MINIMAL_HYBRID_ACTION_TYPES.clear();
    MIGRATED_ACTION_TYPES.clear();
    NEEDS_VALIDATION_TYPES.clear();
    LEGACY_ONLY_TYPES.clear();
    for (const type of sets.minimalHybridActionTypes) MINIMAL_HYBRID_ACTION_TYPES.add(type);
    for (const type of sets.migratedActionTypes) MIGRATED_ACTION_TYPES.add(type);
    for (const type of sets.needsValidationTypes) NEEDS_VALIDATION_TYPES.add(type);
    for (const type of sets.legacyOnlyTypes) LEGACY_ONLY_TYPES.add(type);
    routingSetsLoaded = true;
  }
  return {
    minimalHybridActionTypes: MINIMAL_HYBRID_ACTION_TYPES,
    migratedActionTypes: MIGRATED_ACTION_TYPES,
    needsValidationTypes: NEEDS_VALIDATION_TYPES,
    legacyOnlyTypes: LEGACY_ONLY_TYPES,
  };
}

/** Routes an executable step using the Rust-owned mode and allowlist policy. */
export function shouldUseActions(step: Step, config: ExecutionModeConfig): boolean {
  routingSets();
  return replayPolicy.replayShouldUseActions(
    config.mode,
    step.type,
    config.legacyOnlyTypes,
    config.actionsAllowlist,
  );
}

/** Creates the conservative hybrid routing configuration. */
export function createHybridConfig(overrides?: Partial<ExecutionModeConfig>): ExecutionModeConfig {
  const sets = routingSets();
  return {
    ...DEFAULT_EXECUTION_MODE_CONFIG,
    mode: 'hybrid',
    legacyOnlyTypes: new Set(sets.legacyOnlyTypes),
    actionsAllowlist: new Set(sets.minimalHybridActionTypes),
    ...overrides,
  };
}

/** Creates the strict action-registry configuration. */
export function createActionsOnlyConfig(
  overrides?: Partial<ExecutionModeConfig>,
): ExecutionModeConfig {
  return {
    ...DEFAULT_EXECUTION_MODE_CONFIG,
    mode: 'actions',
    skipActionsRetry: true,
    skipActionsNavWait: true,
    ...overrides,
  };
}
