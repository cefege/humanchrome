/**
 * Output Sanitizer - redact sensitive data and cap output size.
 *
 * Provides safe handling for JavaScript execution results:
 * 1. Redacts sensitive material (cookies, tokens, passwords, etc.)
 * 2. Limits output length (default 50KB)
 * 3. Walks objects with depth and key/array caps
 */

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

// Sensitive key markers (their values are redacted). Mirrors the list in mcp-tools.js.
const SENSITIVE_KEY_MARKERS = [
  'cookie',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'bearer',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apikey',
  'session',
  'sessionid',
  'sid',
  'csrf',
  'xsrf',
  // Additional keys covered by mcp-tools.js
  'credential',
  'privatekey',
  'accesskey',
  'auth',
  'oauth',
] as const;

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
  if (isRawOutputEnabled()) {
    return { text, redacted: false };
  }

  let out = text;
  let redacted = false;

  const replace = (
    re: RegExp,
    replacement: string | ((substring: string, ...args: string[]) => string),
  ) => {
    const next = out.replace(re, replacement as Parameters<typeof String.prototype.replace>[1]);
    if (next !== out) {
      out = next;
      redacted = true;
    }
  };

  // 1. Whole-string detection (mcp-tools.js style).
  // Cookie/query-string shape: contains '=' along with ';' or '&'.
  if (out.includes('=') && (out.includes(';') || out.includes('&'))) {
    if (looksLikeCookieString(out)) {
      return { text: '[BLOCKED: Cookie/query string data]', redacted: true };
    }
    if (looksLikeQueryString(out)) {
      return { text: '[BLOCKED: Cookie/query string data]', redacted: true };
    }
  }

  // Base64-encoded payload (20+ chars).
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(out)) {
    return { text: '[BLOCKED: Base64 encoded data]', redacted: true };
  }

  // Hex credential (32+ chars).
  if (/^[a-f0-9]{32,}$/i.test(out)) {
    return { text: '[BLOCKED: Hex credential]', redacted: true };
  }

  // 2. Bearer token
  replace(/\bBearer\s+([A-Za-z0-9._~+/=-]+)\b/gi, 'Bearer <redacted>');

  // 3. JWT (three-segment)
  replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted_jwt>');

  // 4. Sensitive values in URL query parameters
  replace(
    /(^|[?&])(access_token|refresh_token|id_token|token|api_key|apikey|password|passwd|pwd|secret|session|sid|credential|auth|oauth)=([^&#\s]+)/gi,
    (_m, p1, p2) => `${p1}${p2}=<redacted>`,
  );

  // 5. Header-like key/value pairs
  replace(
    /\b(authorization|cookie|set-cookie|x-api-key|api_key|apikey|password|passwd|pwd|secret|token|access_token|refresh_token|id_token|session|sid|credential|private_key|oauth)\b\s*[:=]\s*([^\s,;"']+)/gi,
    (_m, key) => `${key}=<redacted>`,
  );

  // 6. Inline base64 data within mixed content
  replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<redacted_base64>');

  // 7. Inline long hex strings (possible API keys, hashes, etc.)
  replace(/\b[a-f0-9]{40,}\b/gi, '<redacted_hex>');

  return { text: out, redacted };
}

/** Detect query-string-shaped text (key=value&key2=value2). */
function looksLikeQueryString(text: string): boolean {
  const s = (text || '').trim();
  if (!s || !s.includes('=') || !s.includes('&')) return false;

  const parts = s.split('&');
  if (parts.length < 2) return false;

  let pairs = 0;
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > 0) pairs += 1;
  }
  return pairs >= 2;
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
      let s = sanitized.text;
      if (s.length > maxStringLength) {
        s = `${s.slice(0, maxStringLength)}... [truncated ${s.length - maxStringLength} chars]`;
      }
      return s;
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
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

function normalizeKey(key: string): string {
  return (key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Detect cookie-shaped text (key=value; key2=value2). */
function looksLikeCookieString(text: string): boolean {
  const s = (text || '').trim();
  if (!s) return false;
  if (!s.includes('=') || !s.includes(';')) return false;

  const parts = s.split(';');
  if (parts.length < 2) return false;

  let pairs = 0;
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > 0) pairs += 1;
  }
  return pairs >= 2;
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
  const originalBytes = byteLength(text);
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }

  const suffix = `\n... [truncated to ${maxBytes} bytes; original ${originalBytes} bytes]`;
  const suffixBytes = byteLength(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes);

  // Binary-search the largest prefix that still fits the byte budget.
  let lo = 0;
  let hi = text.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid);
    if (byteLength(candidate) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const prefix = text.slice(0, lo);
  return { text: prefix + suffix, truncated: true, originalBytes };
}

export function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, n);
}
