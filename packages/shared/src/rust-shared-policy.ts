import { getRustKernel } from './rust-bindings';

/** Rust/WASM methods for shared policy. Kept narrow so opaque values stay in JavaScript. */


function kernel() { return getRustKernel(); }

/** Runs typo suggestion policy over one complete candidate collection. */
export function didYouMeanPolicy(
  received: unknown,
  candidates: readonly string[],
  maxDistance = 2,
): string | null {
  return kernel().shared_did_you_mean(received, [...candidates], maxDistance);
}

/** Truncates a surfaced invalid value without turning `undefined` into `null`. */
export function truncateReceivedPolicy(value: unknown): unknown {
  return kernel().shared_truncate_received(value);
}

/** Normalizes an output-sanitizer cap using the historical finite-positive rule. */
export function normalizePositiveIntPolicy(value: unknown, fallback: number): number {
  return kernel().shared_normalize_positive_int(typeof value === 'number' ? value : Number.NaN, fallback);
}

/** Determines whether a key's value is sensitive when raw output is disabled. */
export function isSensitiveOutputKey(key: string): boolean {
  return kernel().shared_is_sensitive_key(key);
}

/** Limits a string by JavaScript UTF-16 code units with the existing suffix. */
export function limitOutputString(text: string, maxLength: number): string {
  return kernel().shared_limit_string(text, maxLength);
}

/** TextEncoder-compatible UTF-8 length, including lone-surrogate replacement. */
export function utf8ByteLengthPolicy(text: string): number {
  return kernel().shared_utf8_byte_length(text);
}

/** TextEncoder-compatible UTF-8-to-base64 encoding. */
export function utf8ToBase64Policy(text: string): string {
  return kernel().shared_utf8_to_base64(text);
}

/** Plans the formatted-output byte cap without serializing opaque output values. */
export function truncateOutputTextPolicy(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  return kernel().shared_truncate_output_text(text, maxBytes);
}

/** Applies the ordered sensitive-text policy while JS retains its String/RegExp semantics. */
export function sanitizeTextPolicy(text: string, raw: boolean): { text: string; redacted: boolean } {
  return kernel().shared_sanitize_text(text, raw);
}

export interface RustToolSearchHit {
  name: string;
  summary: string;
  score: number;
}

/** Filters one tool result's suggested-next metadata without mutating its content blocks. */
export function suggestedNextPolicy(hints: readonly string[], limit: number): string[] {
  return kernel().shared_suggested_next([...hints], limit);
}

/** Returns embedded catalog names in the contract-defined order. */
export function catalogKnownToolNames(): string[] {
  return kernel().shared_catalog_known_names();
}

/** Tests a static catalog name using the Rust catalog index. */
export function catalogHasToolName(name: string): boolean {
  return kernel().shared_catalog_is_known(name);
}

/** Resolves a static or dynamic catalog name through Rust's alias policy. */
export function resolveCatalogToolName(name: string, extras: readonly string[]): string | null {
  return kernel().shared_catalog_resolve(name, [...extras]);
}

/** Suggests a static or dynamic catalog name through Rust's UTF-16 edit-distance policy. */
export function suggestCatalogToolName(received: string, extras: readonly string[]): string | null {
  return kernel().shared_catalog_suggest(received, [...extras]);
}

/** Ranks the embedded catalog through Rust. */
export function searchCatalogTools(query: string): RustToolSearchHit[] {
  return kernel().shared_catalog_search(query);
}

/** Builds the embedded catalog's `chrome_help` payload through Rust. */
export function buildCatalogToolHelp(argument: unknown): Record<string, unknown> {
  return kernel().shared_catalog_help(argument);
}
