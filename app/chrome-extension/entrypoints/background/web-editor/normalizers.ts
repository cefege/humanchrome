/**
 * Runtime validators / normalisers for inbound web-editor message payloads.
 *
 * The web editor's message router receives untyped JSON over
 * chrome.runtime.onMessage. These helpers bound the trust at the
 * boundary: they coerce values into known shapes, drop garbage,
 * and throw with a precise reason when a required field is missing.
 *
 * Public types are re-exported so the prompt-builder + message-router
 * see the same shape definitions without importing this module twice.
 */

import type { ElementChangeSummary, WebEditorApplyBatchPayload } from '@/common/web-editor-types';

export type WebEditorInstructionType = 'update_text' | 'update_style';

export interface WebEditorFingerprint {
  tag: string;
  id?: string;
  classes: string[];
  text?: string;
}

/** Debug source from React/Vue fiber (file, line, component name). */
export interface DebugSource {
  file: string;
  line?: number;
  column?: number;
  componentName?: string;
}

/** Style operation details (before/after diff). */
export interface StyleOperation {
  type: 'update_style';
  before: Record<string, string>;
  after: Record<string, string>;
  removed: string[];
}

export interface WebEditorApplyPayload {
  pageUrl: string;
  targetFile?: string;
  fingerprint: WebEditorFingerprint;
  techStackHint?: string[];
  instruction: {
    type: WebEditorInstructionType;
    description: string;
    text?: string;
    style?: Record<string, string>;
  };

  // V2 extended fields (best-effort, optional)
  selectorCandidates?: string[];
  debugSource?: DebugSource;
  operation?: StyleOperation;
}

/**
 * Coerce an unknown value to a string. Used at every JSON-payload field
 * read so callers can always `.trim()` the result without an undefined
 * check; non-strings collapse to ''. Exported because index.ts also
 * needs this primitive for ad-hoc payload fields the routers handle
 * directly without going through the dedicated normaliser functions.
 */
export function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizeStyleMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeString(k).trim();
    const val = normalizeString(v).trim();
    if (!key || !val) continue;
    out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeStyleMapAllowEmpty(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeString(k).trim();
    if (!key) continue;
    // Allow empty values (represents removed styles)
    out[key] = normalizeString(v).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeDebugSource(value: unknown): DebugSource | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const file = normalizeString(obj.file).trim();
  if (!file) return undefined;

  const source: DebugSource = { file };
  const line = Number(obj.line);
  if (Number.isFinite(line) && line > 0) source.line = line;
  const column = Number(obj.column);
  if (Number.isFinite(column) && column >= 0) source.column = column;
  const componentName = normalizeString(obj.componentName).trim();
  if (componentName) source.componentName = componentName;

  return source;
}

function normalizeOperation(value: unknown): StyleOperation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.type !== 'update_style') return undefined;

  const before = normalizeStyleMapAllowEmpty(obj.before);
  const after = normalizeStyleMapAllowEmpty(obj.after);
  const removed = normalizeStringArray(obj.removed);

  if (!before && !after && removed.length === 0) return undefined;

  return {
    type: 'update_style',
    before: before ?? {},
    after: after ?? {},
    removed,
  };
}

export function normalizeApplyPayload(raw: unknown): WebEditorApplyPayload {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pageUrl = normalizeString(obj.pageUrl).trim();
  const targetFile = normalizeString(obj.targetFile).trim() || undefined;
  const techStackHint = normalizeStringArray(obj.techStackHint);

  const fingerprintRaw = (
    obj.fingerprint && typeof obj.fingerprint === 'object' ? obj.fingerprint : {}
  ) as Record<string, unknown>;
  const fingerprint: WebEditorFingerprint = {
    tag: normalizeString(fingerprintRaw.tag).trim() || 'unknown',
    id: normalizeString(fingerprintRaw.id).trim() || undefined,
    classes: normalizeStringArray(fingerprintRaw.classes),
    text: normalizeString(fingerprintRaw.text).trim() || undefined,
  };

  const instructionRaw = (
    obj.instruction && typeof obj.instruction === 'object' ? obj.instruction : {}
  ) as Record<string, unknown>;
  const type = normalizeString(instructionRaw.type).trim() as WebEditorInstructionType;
  if (type !== 'update_text' && type !== 'update_style') {
    throw new Error('Invalid instruction.type');
  }

  const instruction = {
    type,
    description: normalizeString(instructionRaw.description).trim() || '',
    text: normalizeString(instructionRaw.text).trim() || undefined,
    style: normalizeStyleMap(instructionRaw.style),
  };

  if (!pageUrl) {
    throw new Error('pageUrl is required');
  }
  if (!instruction.description) {
    throw new Error('instruction.description is required');
  }

  // V2 extended fields (optional)
  const selectorCandidates = normalizeStringArray(obj.selectorCandidates);
  const debugSource = normalizeDebugSource(obj.debugSource);
  const operation = normalizeOperation(obj.operation);

  return {
    pageUrl,
    targetFile,
    fingerprint,
    techStackHint: techStackHint.length ? techStackHint : undefined,
    instruction,
    selectorCandidates: selectorCandidates.length ? selectorCandidates : undefined,
    debugSource,
    operation,
  };
}

/**
 * Normalize and validate batch apply payload.
 * Runtime validation for WebEditorApplyBatchPayload.
 */
export function normalizeApplyBatchPayload(raw: unknown): WebEditorApplyBatchPayload {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const tabIdRaw = Number(obj.tabId);
  const tabId = Number.isFinite(tabIdRaw) && tabIdRaw > 0 ? tabIdRaw : 0;

  const elements = Array.isArray(obj.elements) ? (obj.elements as ElementChangeSummary[]) : [];

  const excludedKeys = Array.isArray(obj.excludedKeys)
    ? obj.excludedKeys.map((k) => normalizeString(k).trim()).filter((k): k is string => Boolean(k))
    : [];

  const pageUrl = normalizeString(obj.pageUrl).trim() || undefined;

  return { tabId, elements, excludedKeys, pageUrl };
}
