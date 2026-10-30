/**
 * Encoding helpers for SW contexts.
 *
 * The Rust policy kernel owns TextEncoder-compatible byte accounting and base64 emission;
 * callers retain JavaScript strings at the boundary, including lone-surrogate semantics.
 */
import { sharedPolicy } from 'humanchrome-shared';

/** UTF-8 byte length of a string. */
export function utf8ByteLength(s: string): number {
  return sharedPolicy.utf8ByteLengthPolicy(s);
}

/** Encode a UTF-8 string as base64. */
export function utf8ToBase64(s: string): string {
  return sharedPolicy.utf8ToBase64Policy(s);
}
