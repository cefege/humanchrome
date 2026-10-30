import { getRustKernel } from './rust-bindings';

export type TruncateUnit = 'bytes' | 'items' | 'messages' | 'elements';
export type TruncateMode = 'preview' | 'raw';
export interface TruncateEnvelope<T> {
  data: T;
  truncated: boolean;
  originalSize: number;
  limit: number;
  rawAvailable: boolean;
}

export function truncateString(text: string, maxBytes: number, mode: TruncateMode = 'preview'): TruncateEnvelope<string> {
  return getRustKernel().tool_truncate_string(text, maxBytes, mode) as TruncateEnvelope<string>;
}

export function truncateArray<T>(values: T[], maxItems: number, mode: TruncateMode = 'preview'): TruncateEnvelope<T[]> {
  return getRustKernel().tool_truncate_array(values, maxItems, mode) as TruncateEnvelope<T[]>;
}

export function truncateJson<T>(value: T, maxBytes: number, mode: TruncateMode = 'preview'): TruncateEnvelope<string> {
  return getRustKernel().tool_truncate_json(value, maxBytes, mode) as TruncateEnvelope<string>;
}

export function modeFromRaw(raw: unknown): TruncateMode {
  return getRustKernel().tool_truncate_mode(raw) as TruncateMode;
}
