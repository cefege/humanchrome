/**
 * Unified truncation envelope.
 *
 * Why this exists
 * ---------------
 * Different tools used to truncate differently — `chrome_javascript` returned
 * `{truncated: bool}`, `chrome_console` appended a `[...truncated]` sentinel,
 * `chrome_read_page` silently capped at 150 elements, `chrome_network_capture`
 * trimmed bodies with no surfaced flag. LLMs had to guess whether a response
 * was complete and could not consistently retry for a fuller read.
 *
 * This module centralizes the contract:
 *
 *   {
 *     data: <truncated payload>,
 *     truncated: boolean,
 *     originalSize: number,   // bytes for strings, item count for arrays
 *     limit: number,          // matches the units of originalSize
 *     rawAvailable: boolean,  // whether passing { raw: true } would yield more
 *   }
 *
 * Tools should serialize this shape inside their `text` response. The shape
 * is stable so callers can rely on `.truncated` to decide whether to
 * follow-up with `{ raw: true }`.
 */
import { byteLength } from './output-sanitizer';

export type TruncateUnit = 'bytes' | 'items' | 'messages' | 'elements';

export interface TruncateEnvelope<T> {
  data: T;
  truncated: boolean;
  originalSize: number;
  limit: number;
  rawAvailable: boolean;
}

export type TruncateMode = 'preview' | 'raw';

/**
 * Cap a string to `maxBytes`. UTF-8 aware: never splits a character mid-byte
 * because we slice in code-unit space and bisect on byte length.
 */
export function truncateString(
  text: string,
  maxBytes: number,
  mode: TruncateMode = 'preview',
): TruncateEnvelope<string> {
  const originalSize = byteLength(text);
  if (mode === 'raw' || originalSize <= maxBytes) {
    return {
      data: text,
      truncated: false,
      originalSize,
      limit: maxBytes,
      rawAvailable: false,
    };
  }

  // Bisect on string-length space to find the largest prefix that fits.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }

  return {
    data: text.slice(0, lo),
    truncated: true,
    originalSize,
    limit: maxBytes,
    rawAvailable: true,
  };
}

/**
 * Cap an array to `maxItems`. The unit of `originalSize`/`limit` is item
 * count, not bytes — that's the distinction callers branch on.
 */
export function truncateArray<T>(
  arr: T[],
  maxItems: number,
  mode: TruncateMode = 'preview',
): TruncateEnvelope<T[]> {
  const originalSize = arr.length;
  if (mode === 'raw' || originalSize <= maxItems) {
    return {
      data: arr,
      truncated: false,
      originalSize,
      limit: maxItems,
      rawAvailable: false,
    };
  }
  return {
    data: arr.slice(0, maxItems),
    truncated: true,
    originalSize,
    limit: maxItems,
    rawAvailable: true,
  };
}

/**
 * Convenience for tools whose response is "JSON-stringified, byte-capped".
 * Stringifies, truncates by bytes, surfaces the envelope.
 */
export function truncateJson<T>(
  value: T,
  maxBytes: number,
  mode: TruncateMode = 'preview',
): TruncateEnvelope<string> {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return truncateString(text, maxBytes, mode);
}

/**
 * Resolve mode from a tool's `raw?: boolean` argument. Centralized so every
 * tool spells the same thing.
 */
export function modeFromRaw(raw: unknown): TruncateMode {
  return raw === true ? 'raw' : 'preview';
}
