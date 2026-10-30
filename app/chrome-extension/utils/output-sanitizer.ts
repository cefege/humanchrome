/**
 * Output Sanitizer - redact sensitive data and cap output size.
 *
 * Provides safe handling for JavaScript execution results:
 * 1. Redacts sensitive material (cookies, tokens, passwords, etc.)
 * 2. Limits output length (default 50KB)
 * 3. Walks objects with depth and key/array caps
 */
import { sharedPolicy } from 'humanchrome-shared';

export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;

export interface OutputSanitizerOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

export interface SanitizedOutput {
  text: string;
  truncated: boolean;
  redacted: boolean;
  originalBytes: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ARRAY_LENGTH = 200;
const DEFAULT_MAX_OBJECT_KEYS = 200;
const DEFAULT_MAX_STRING_LENGTH = 10_000;

// ----------------------------------------------------------------------------
// Raw-output bypass
//
// The default sanitizer redacts every base64 string >=40 chars, hex >=40 chars,
// JWT-shaped tokens, and outright blocks any cookie/query-shaped string. That
// is over-aggressive for legitimate workloads — LinkedIn URNs, Voyager IDs,
// OAuth state, and JSON whose values happen to look base64-like all get
// destroyed.
//
// This bypass is opt-in. Two equivalent gates:
//   1. globalThis.__MCP_RAW_OUTPUT__ = true   (live toggle in service worker)
//   2. chrome.storage.local: { rawOutput: true }   (persisted user preference)
// Either gate set => sanitizeText becomes a passthrough and sanitizeValue
// stops walking objects to redact sensitive keys.
// ----------------------------------------------------------------------------

const RAW_OUTPUT_STORAGE_KEY = 'rawOutput';
// HumanChrome: rawOutput defaults ON. Upstream redaction destroys LinkedIn
// URNs, JWTs, OAuth state, and any base64-shaped data — which is exactly
// what most production workflows need. Set `rawOutput=false` in
// chrome.storage.local to opt back into the conservative redaction posture.
let rawOutputCache: boolean | null = true;

type GlobalThisWithRawOutput = typeof globalThis & { __MCP_RAW_OUTPUT__?: boolean };

export function isRawOutputEnabled(): boolean {
  if (
    typeof globalThis !== 'undefined' &&
    (globalThis as GlobalThisWithRawOutput).__MCP_RAW_OUTPUT__ === false
  ) {
    return false;
  }
  return rawOutputCache !== false;
}

export function setRawOutputCache(value: boolean): void {
  rawOutputCache = !!value;
}

// Best-effort init from chrome.storage.local at module load. Failures are
// silent — a Node test harness or a non-extension context will simply have
// rawOutputCache stay null, which means redaction stays on (safe default).
type ChromeStorageGetCb = (result: Record<string, unknown>) => void;
type ChromeStorageOnChangedCb = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;
type ChromeShim = {
  storage?: {
    local?: { get?: (keys: string[], cb: ChromeStorageGetCb) => void };
    onChanged?: { addListener?: (cb: ChromeStorageOnChangedCb) => void };
  };
};
try {
  const c = (globalThis as unknown as { chrome?: ChromeShim }).chrome;
  const get = c?.storage?.local?.get;
  if (typeof get === 'function') {
    get([RAW_OUTPUT_STORAGE_KEY], (result) => {
      rawOutputCache = !!result?.[RAW_OUTPUT_STORAGE_KEY];
    });
    // Subscribe to live changes so toggling the option page applies without
    // a service-worker restart.
    const addListener = c?.storage?.onChanged?.addListener;
    if (typeof addListener === 'function') {
      addListener((changes, areaName) => {
        if (areaName === 'local' && RAW_OUTPUT_STORAGE_KEY in changes) {
          rawOutputCache = !!changes[RAW_OUTPUT_STORAGE_KEY]?.newValue;
        }
      });
    }
  }
} catch {
  // ignore — non-extension context
}

// Sensitive-key matching is Rust-owned; this host retains only object enumeration.

/** Sanitize any value and cap the resulting text. */
export function sanitizeAndLimitOutput(
  value: unknown,
  options: OutputSanitizerOptions = {},
): SanitizedOutput {
  const maxBytes = normalizePositiveInt(options.maxBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const maxDepth = normalizePositiveInt(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxArrayLength = normalizePositiveInt(options.maxArrayLength, DEFAULT_MAX_ARRAY_LENGTH);
  const maxObjectKeys = normalizePositiveInt(options.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS);
  const maxStringLength = normalizePositiveInt(options.maxStringLength, DEFAULT_MAX_STRING_LENGTH);

  const { value: sanitizedValue, redacted } = sanitizeValue(value, {
    maxDepth,
    maxArrayLength,
    maxObjectKeys,
    maxStringLength,
  });

  const formatted = formatValueForOutput(sanitizedValue);
  const truncated = truncateTextBytes(formatted, maxBytes);

  return {
    text: truncated.text,
    truncated: truncated.truncated,
    redacted,
    originalBytes: truncated.originalBytes,
  };
}

/**
 * Redact sensitive material in a string.
 * Mirrors mcp-tools.js with extra base64/hex/cookie-query detection.
 */
export function sanitizeText(text: string): { text: string; redacted: boolean } {
  return sharedPolicy.sanitizeTextPolicy(text, isRawOutputEnabled());
}
function sanitizeValue(
  value: unknown,
  limits: {
    maxDepth: number;
    maxArrayLength: number;
    maxObjectKeys: number;
    maxStringLength: number;
  },
): { value: unknown; redacted: boolean } {
  const { maxDepth, maxArrayLength, maxObjectKeys, maxStringLength } = limits;
  const seen = new WeakMap<object, unknown>();
  let redacted = false;

  const walk = (v: unknown, depth: number): unknown => {
    if (depth < 0) return '[MaxDepth]';

    if (typeof v === 'string') {
      const sanitized = sanitizeText(v);
      if (sanitized.redacted) redacted = true;
      return sharedPolicy.limitOutputString(sanitized.text, maxStringLength);
    }

    if (
      v === null ||
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      typeof v === 'bigint' ||
      typeof v === 'undefined'
    ) {
      return v;
    }

    if (typeof v === 'symbol') return v.toString();
    if (typeof v === 'function') return `[Function${v.name ? `: ${v.name}` : ''}]`;

    if (typeof v !== 'object') return String(v);

    const obj = v as Record<string, unknown>;

    if (seen.has(obj)) return '[Circular]';

    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      seen.set(obj, out);
      const len = Math.min(obj.length, maxArrayLength);
      for (let i = 0; i < len; i++) {
        out.push(walk(obj[i], depth - 1));
      }
      if (obj.length > maxArrayLength) out.push('[...truncated]');
      return out;
    }

    const out: Record<string, unknown> = {};
    seen.set(obj, out);

    const rawMode = isRawOutputEnabled();
    const keys = Object.keys(obj);
    const len = Math.min(keys.length, maxObjectKeys);
    for (let i = 0; i < len; i++) {
      const key = keys[i];
      if (!rawMode && isSensitiveKey(key)) {
        out[key] = '<redacted>';
        redacted = true;
        continue;
      }
      out[key] = walk(obj[key], depth - 1);
    }
    if (keys.length > maxObjectKeys) out.__truncated__ = true;

    return out;
  };

  return { value: walk(value, maxDepth), redacted };
}

function isSensitiveKey(key: string): boolean {
  return sharedPolicy.isSensitiveOutputKey(key);
}
function formatValueForOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'undefined') return 'undefined';

  try {
    return safeJsonStringify(value);
  } catch {
    return String(value);
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return `${val.toString()}n`;
    if (typeof val === 'symbol') return val.toString();
    if (typeof val === 'function') return `[Function${val.name ? `: ${val.name}` : ''}]`;
    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  });
}

function truncateTextBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  return sharedPolicy.truncateOutputTextPolicy(text, maxBytes);
}
export function byteLength(text: string): number {
  return sharedPolicy.utf8ByteLengthPolicy(text);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  return sharedPolicy.normalizePositiveIntPolicy(value, fallback);
}
