/**
 * Encoding helpers for SW contexts.
 *
 * Chrome service workers have no Node `Buffer`; the standard
 * `TextEncoder` + `btoa` combination is the portable way to handle
 * UTF-8 byte length and base64 encoding. These helpers exist so
 * tools that wrap CDP commands (`Fetch.fulfillRequest`,
 * `chrome.downloads.download({url:'data:...'})`, etc.) don't each
 * re-derive the same byte-loop.
 */

/** UTF-8 byte length of a string. */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Encode a UTF-8 string as base64. SW `btoa` only handles Latin-1, so
 * we encode to bytes first then walk the byte array as Latin-1 chars
 * before handing to `btoa`. Works in browser + SW + Node.
 */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
