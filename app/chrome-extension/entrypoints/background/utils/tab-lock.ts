/**
 * Per-tab serialization for mutating tool calls.
 *
 * Why this exists
 * ---------------
 * Two MCP clients (or one agent juggling parallel actions) calling
 * `chrome_click_element` on the same tab at the same time will race on CDP
 * attach + content-script ping/pong, and neither caller learns that their
 * action interleaved with the other. The fix is a simple FIFO queue keyed
 * on `tabId`: mutating ops wait their turn, reads pass through.
 *
 * Locks live only as long as the chain — we delete the queue entry when
 * its tail releases, so an unused tab never carries stale state.
 *
 * The lock is per-tabId because that's the granularity of the conflict.
 * A scope wider than that (e.g. a single global lock) would needlessly
 * serialize independent tabs and defeat the multi-tab story.
 */

import { ToolError, ToolErrorCode } from 'humanchrome-shared';
import { DEFAULT_TAB_LOCK_TIMEOUT_MS } from './timeouts';

const queues = new Map<number, Promise<void>>();

const DEFAULT_TIMEOUT_MS = DEFAULT_TAB_LOCK_TIMEOUT_MS;

export interface AcquireOptions {
  /** Cap on time spent waiting for prior holders. Default 60s. */
  timeoutMs?: number;
}

export type Release = () => void;

/**
 * Acquire the lock for a tab. Awaits any pending holder, then resolves to a
 * `release` callback the caller MUST invoke (use try/finally) to advance
 * the chain. If the wait exceeds `timeoutMs`, throws TAB_LOCK_TIMEOUT —
 * the caller's slot is still cleaned up so subsequent acquirers don't
 * deadlock on a phantom holder.
 */
export async function acquireTabLock(tabId: number, opts: AcquireOptions = {}): Promise<Release> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prev = queues.get(tabId) ?? Promise.resolve();

  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  // Append our slot to the chain immediately so a third caller queues
  // behind us, even while we're still waiting on `prev`.
  queues.set(tabId, next);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // We don't care if prev rejected — its caller has already moved on.
      prev.catch(() => undefined),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolError(
              ToolErrorCode.TAB_LOCK_TIMEOUT,
              `Lock acquisition for tab ${tabId} timed out after ${timeoutMs}ms`,
              { tabId, timeoutMs },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    // We never acquired — release our slot so the chain doesn't deadlock.
    releaseNext();
    if (queues.get(tabId) === next) queues.delete(tabId);
    throw err;
  }
  clearTimeout(timer);

  return () => {
    releaseNext();
    // Clean up only if we're still the tail. A later acquirer may have
    // already chained off `next`; that's fine, they own the entry now.
    if (queues.get(tabId) === next) queues.delete(tabId);
  };
}

/**
 * Run `fn` with the tab's lock held; releases automatically.
 */
export async function withTabLock<T>(
  tabId: number,
  fn: () => Promise<T>,
  opts?: AcquireOptions,
): Promise<T> {
  const release = await acquireTabLock(tabId, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test helper. */
export function _resetTabLocksForTests(): void {
  queues.clear();
}

/** Diagnostic — number of tabs with pending or held locks. */
export function activeLockedTabCount(): number {
  return queues.size;
}

// Drop the queue entry as soon as the tab dies. Holders will still settle their
// own async work normally; this just frees the Map slot before the chain drains.
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    queues.delete(tabId);
  });
}
