/**
 * @fileoverview Bidirectional V2/V3 Flow conversion utilities.
 *
 * Bridges the Builder's V2 Flow types with the V3 RPC FlowV3 types:
 * the Builder store still uses V2 (type, version, steps), while the RPC
 * layer uses V3 (kind, schemaVersion, entryNodeId). This module wraps the
 * underlying converters with a UI-friendly surface.
 */

import { builderPolicy } from 'humanchrome-shared';

import type { Flow as FlowV2 } from '@/entrypoints/background/record-replay/types';
import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';
import {
  convertFlowV2ToV3,
  convertFlowV3ToV2,
} from '@/entrypoints/background/record-replay-v3/storage/import/v2-to-v3';

// ==================== Types ====================

export interface FlowConversionResult<T> {
  flow: T;
  warnings: string[];
}

// ==================== V2 -> V3 (for RPC calls) ====================

/**
 * Convert a V2 Flow to V3 for saving via RPC.
 * @param flowV2 V2 Flow from the Builder store
 * @returns V3 Flow plus any conversion warnings
 * @throws if the conversion fails
 */
export function flowV2ToV3ForRpc(flowV2: FlowV2): FlowConversionResult<FlowV3> {
  const result = convertFlowV2ToV3(flowV2 as unknown as Parameters<typeof convertFlowV2ToV3>[0]);

  if (!result.success || !result.data) {
    const errorMsg =
      result.errors.length > 0 ? result.errors.join('; ') : 'Unknown conversion error';
    throw new Error(`V2→V3 conversion failed: ${errorMsg}`);
  }

  return {
    flow: result.data,
    warnings: result.warnings,
  };
}

// ==================== V3 -> V2 (for Builder display) ====================

/**
 * Convert a V3 Flow to V2 so the Builder can display and edit it.
 * @param flowV3 V3 Flow returned from RPC
 * @returns V2 Flow plus any conversion warnings
 * @throws if the conversion fails
 */
export function flowV3ToV2ForBuilder(flowV3: FlowV3): FlowConversionResult<FlowV2> {
  const result = convertFlowV3ToV2(flowV3);

  if (!result.success || !result.data) {
    const errorMsg =
      result.errors.length > 0 ? result.errors.join('; ') : 'Unknown conversion error';
    throw new Error(`V3→V2 conversion failed: ${errorMsg}`);
  }

  return {
    flow: result.data as unknown as FlowV2,
    warnings: result.warnings,
  };
}

// ==================== Type Guards ====================

/** Detect a V3 Flow shape (used when classifying imported JSON). */
export function isFlowV3(value: unknown): value is FlowV3 {
  return builderPolicy.builderIsFlowV3(value);
}

/** Detect a V2 Flow shape (used when classifying imported JSON). */
export function isFlowV2(value: unknown): value is FlowV2 {
  return builderPolicy.builderIsFlowV2(value);
}

// ==================== Import Helpers ====================

/**
 * Extract candidate Flows from imported JSON.
 * Accepts a single Flow, a Flow array, or { flows: Flow[] }.
 */
export function extractFlowCandidates(parsed: unknown): unknown[] {
  return builderPolicy.builderExtractFlowCandidates(parsed);
}
