/**
 * Idempotency cache for the IMP-0177 dispatcher (IMP-0183).
 *
 * MCP clients sometimes double-fire a tool call — a network blip, a "did
 * that go through?" retry, an LLM that re-tries after a perceived timeout.
 * For state-changing tools (navigate, click, fill, inject, tab-group
 * create, …) a double-fire is a real bug. The dispatcher exposes an
 * optional `idemKey: string` on the outer schema; when the same
 * `(clientId, toolName, idemKey)` is replayed within TTL we return the
 * cached prior result with `_meta.idempotent_hit: true` instead of
 * dispatching again.
 *
 * Universal at the dispatcher — no per-tool plumbing. Read-only tools
 * still incur cache overhead per-call (single Map lookup), but that's
 * negligible and the safety guarantee is the same regardless of mutation.
 *
 * Bounded:
 *   - 30s TTL (configurable via `setIdemCacheConfig` for tests)
 *   - 1000-entry LRU eviction so a runaway client can't grow the heap.
 *
 * Stored value carries the original tool result + epoch ms of expiry.
 * Errors and successes both cache — duplicates of a failed call should
 * see the same failure shape, otherwise the LLM might guess that retrying
 * with the same idemKey is safe (it isn't; that's the contract).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

interface CachedEntry {
  result: CallToolResult;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1000;

let ttlMs = DEFAULT_TTL_MS;
let maxEntries = DEFAULT_MAX_ENTRIES;

// JavaScript Maps preserve insertion order, so a simple Map + LRU eviction
// (delete oldest = first key) gives O(1) amortized access. Re-inserting on
// hit moves the entry to "newest" (refresh the LRU position).
const cache = new Map<string, CachedEntry>();

function makeKey(clientId: string | undefined, toolName: string, idemKey: string): string {
  return `${clientId ?? '_'}:${toolName}:${idemKey}`;
}

function evictExpired(now: number): void {
  // Invariant: `recordIdempotentResult` and lookup-on-hit both delete+reinsert,
  // so Map insertion order tracks "most-recent expiry extension". With a
  // constant TTL, insertion order == expiry order, so the early-break is sound.
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
    else break;
  }
}

function evictForCapacity(): void {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/**
 * Attempt to return a previously-cached result. Returns `null` on miss or
 * if any of the key components are absent. Refreshes the entry's LRU
 * position on hit so it doesn't age out under steady reuse.
 *
 * NOTE: returns the result with `_meta.idempotent_hit: true` patched in
 * so callers can distinguish a replay from a fresh dispatch.
 */
export function lookupIdempotentResult(
  clientId: string | undefined,
  toolName: string,
  idemKey: string | undefined,
): CallToolResult | null {
  if (!idemKey || !toolName) return null;
  const now = Date.now();
  evictExpired(now);
  const key = makeKey(clientId, toolName, idemKey);
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, hit);
  return withIdempotentHit(hit.result);
}

/**
 * Cache a result against `(clientId, toolName, idemKey)` for the configured
 * TTL. No-op if any of the key components are absent.
 */
export function recordIdempotentResult(
  clientId: string | undefined,
  toolName: string,
  idemKey: string | undefined,
  result: CallToolResult,
): void {
  if (!idemKey || !toolName) return;
  const key = makeKey(clientId, toolName, idemKey);
  const expiresAt = Date.now() + ttlMs;
  // Re-insert to refresh LRU order.
  cache.delete(key);
  cache.set(key, { result, expiresAt });
  evictForCapacity();
}

function withIdempotentHit(result: CallToolResult): CallToolResult {
  return { ...result, _meta: { ...(result._meta ?? {}), idempotent_hit: true } };
}

/** Test-only: tune TTL / max entries. */
export function _setIdemCacheConfigForTest(opts: { ttlMs?: number; maxEntries?: number } = {}): void {
  if (typeof opts.ttlMs === 'number') ttlMs = opts.ttlMs;
  if (typeof opts.maxEntries === 'number') maxEntries = opts.maxEntries;
}

/** Test-only: drop all cached entries and restore defaults. */
export function _resetIdemCacheForTest(): void {
  cache.clear();
  ttlMs = DEFAULT_TTL_MS;
  maxEntries = DEFAULT_MAX_ENTRIES;
}

/** Test-only: inspect cache size. */
export function _idemCacheSizeForTest(): number {
  return cache.size;
}
