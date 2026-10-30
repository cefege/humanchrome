/**
 * Runtime validators / normalisers for inbound web-editor message payloads.
 *
 * The web editor's message router receives untyped JSON over
 * chrome.runtime.onMessage. These helpers bound the trust at the
 * boundary: they coerce values into known shapes, drop garbage,
 * and throw with a precise reason when a required field is missing.
 *
 * Public aliases preserve the web-editor module's existing type surface while
 * `humanchrome-shared` remains the single runtime-policy owner.
 */

import type { ElementChangeSummary, WebEditorApplyBatchPayload } from '@/common/web-editor-types';
import {
  normalizeEditorApplyBatchPayload,
  normalizeEditorApplyPayload,
  normalizeEditorString,
  type EditorApplyDebugSource,
  type EditorApplyFingerprint,
  type EditorApplyInstructionType,
  type EditorApplyPayload,
  type EditorApplyStyleOperation,
} from 'humanchrome-shared';

export type WebEditorInstructionType = EditorApplyInstructionType;
export type WebEditorFingerprint = EditorApplyFingerprint;
export type DebugSource = EditorApplyDebugSource;
export type StyleOperation = EditorApplyStyleOperation;
export type WebEditorApplyPayload = EditorApplyPayload;

/**
 * Coerce an unknown value to a primitive string. The Rust kernel owns the
 * non-string fallback so every background consumer shares one policy.
 */
export function normalizeString(value: unknown): string {
  return normalizeEditorString(value);
}

/** Normalizes and validates one single-element apply payload in the Rust policy kernel. */
export function normalizeApplyPayload(raw: unknown): WebEditorApplyPayload {
  return normalizeEditorApplyPayload(raw);
}

/** Normalizes a batch apply payload while retaining its element array identity. */
export function normalizeApplyBatchPayload(raw: unknown): WebEditorApplyBatchPayload {
  return normalizeEditorApplyBatchPayload<ElementChangeSummary>(raw);
}
