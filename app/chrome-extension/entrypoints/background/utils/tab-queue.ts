/**
 * Per-tab serialization queue for mutating tool calls (IMP-0087).
 *
 * Successor to the anonymous Promise-chain in `tab-lock.ts`. Same
 * critical-section semantics — one mutating holder per tab at a time, reads
 * pass through — plus:
 *
 *   - **Round-robin fairness across clients.** A misbehaving client looping
 *     on a shared tab no longer starves a polite caller behind it.
 *   - **Bounded depth.** `MAX_TAB_QUEUE_DEPTH` waiters; the 17th attempt
 *     rejects with `QUEUE_FULL` synchronously rather than piling up
 *     `N × timeoutMs` of pending work behind a stuck holder.
 *   - **Per-call timeout opt-in.** `AcquireOptions.timeoutMs` already
 *     existed; the dispatcher now plumbs it from caller args (with clamp)
 *     and a `static tabLockTimeoutMs` on `BaseBrowserToolExecutor`.
 *   - **Observability.** `acquireTabLock` returns `{ release,
 *     queuedAtPosition, waitedMs }`. `inspectTabQueue` /
 *     `inspectAllTabQueues` expose snapshots for the new
 *     `chrome_queue_inspect` tool.
 *
 * Locks live only as long as the chain — when the last holder releases and
 * no waiters remain, the queue entry is dropped so an unused tab carries
 * no state. `chrome.tabs.onRemoved` cancels every waiter for a closing
 * tab with `TAB_CLOSED` instead of letting them lazily fail against a
 * dead tab.
 */

import { ToolError, ToolErrorCode } from 'humanchrome-shared';
import { getBrowserStateForClientPolicy, ensureClientStateReady } from './client-state';

export interface AcquireOptions {
  /** Cap on time spent waiting for prior holders. Default 60s. */
  timeoutMs?: number;
  /** Owning client (from request-context). Drives round-robin fairness. */
  clientId?: string;
}

export interface AcquireResult {
  release: Release;
  /** 1 = head (served immediately); higher = had to wait for that many holders. */
  queuedAtPosition: number;
  /** Wall-clock ms spent waiting before the critical section started. */
  waitedMs: number;
}

export type Release = () => void;

export interface QueueWaiterSnapshot {
  clientId: string | null;
  position: number;
  waitedMs: number;
  expectedWaitMs: number;
  ticket: number;
}

export interface QueueTabSnapshot {
  tabId: number;
  depth: number;
  servedTotal: number;
  meanHoldMs: number;
  holder: { clientId: string | null; heldMs: number; ticket: number } | null;
  waiters: QueueWaiterSnapshot[];
}

export interface QueueEntryTestSnapshot {
  ticket: number;
  clientId: string | undefined;
  enqueuedAt: number;
  startedAt: number | undefined;
}

interface PendingTicket {
  tabId: number;
  timeoutMs: number;
  timer: number;
  resolve: (result: AcquireResult) => void;
  reject: (error: Error) => void;
}

const pendingTickets = new Map<number, PendingTicket>();

/**
 * Acquires a Rust-owned queue slot. JavaScript owns only the waiting Promise,
 * timeout handle, and release callback keyed by Rust ticket.
 */
export async function acquireTabLock(tabId: number, opts: AcquireOptions = {}): Promise<Release> {
  const result = await acquireTabLockWithMeta(tabId, opts);
  return result.release;
}

export function acquireTabLockWithMeta(
  tabId: number,
  opts: AcquireOptions = {},
): Promise<AcquireResult> {
  const state = getBrowserStateForClientPolicy();
  const requestedTimeoutMs = normalizedTimeout(opts.timeoutMs);
  const admittedAt = Date.now();
  const admission = state.admitTabLock(tabId, opts.clientId, requestedTimeoutMs, admittedAt);
  if (admission.kind === 'rejected') return Promise.reject(toToolError(admission.error));
  if (admission.kind === 'granted') {
    return Promise.resolve(grantedResult(tabId, admission.grant));
  }

  const deferred = Promise.withResolvers<AcquireResult>();
  const timeoutMs = requestedTimeoutMs ?? state.defaultTabLockTimeout();
  const delayMs = Math.max(0, admission.ticket.deadlineAt - Date.now());
  const timer = setTimeout(() => {
    const pending = pendingTickets.get(admission.ticket.ticket);
    if (!pending) return;
    applyTransition(
      state.timeoutTabLock(tabId, admission.ticket.ticket, Date.now(), pending.timeoutMs),
    );
  }, delayMs) as unknown as number;
  pendingTickets.set(admission.ticket.ticket, {
    tabId,
    timeoutMs,
    timer,
    resolve: deferred.resolve,
    reject: deferred.reject,
  });
  return deferred.promise;
}

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

export function inspectTabQueue(tabId: number): QueueTabSnapshot | null {
  return getBrowserStateForClientPolicy().inspectTabQueue(tabId, Date.now());
}

export function inspectAllTabQueues(): QueueTabSnapshot[] {
  return getBrowserStateForClientPolicy().inspectAllTabQueues(Date.now());
}

/** Diagnostic — number of tabs with pending or held locks. */
export function activeLockedTabCount(): number {
  return getBrowserStateForClientPolicy().activeLockedTabCount();
}

export function _resetTabQueueForTests(): void {
  for (const pending of pendingTickets.values()) clearTimeout(pending.timer);
  pendingTickets.clear();
  try {
    getBrowserStateForClientPolicy()._resetQueuesForTest();
  } catch {
    // The state handle has not been initialized in this test realm.
  }
}

export function _snapshotTabQueueForTests(tabId: number): QueueEntryTestSnapshot[] {
  return getBrowserStateForClientPolicy()
    ._queueEntriesForTest(tabId)
    .map((entry) => ({
      ticket: entry.ticket,
      clientId: entry.clientId ?? undefined,
      enqueuedAt: entry.enqueuedAt,
      startedAt: entry.startedAt ?? undefined,
    }));
}

export function _advanceMeanHoldForTests(tabId: number, ms: number): void {
  getBrowserStateForClientPolicy()._setQueueMeanHoldForTest(tabId, ms);
}

function normalizedTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function grantedResult(
  tabId: number,
  grant: { ticket: number; queuedAtPosition: number; waitedMs: number },
): AcquireResult {
  return {
    release: releaseFor(tabId, grant.ticket),
    queuedAtPosition: grant.queuedAtPosition,
    waitedMs: grant.waitedMs,
  };
}

function releaseFor(tabId: number, ticket: number): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    applyTransition(getBrowserStateForClientPolicy().releaseTabLock(tabId, ticket, Date.now()));
  };
}

function applyTransition(transition: {
  promoted: { ticket: number; queuedAtPosition: number; waitedMs: number } | null;
  cancelled: Array<{
    ticket: number;
    error: { code: string; message: string; details: unknown };
  }>;
}): void {
  for (const cancelled of transition.cancelled) {
    const pending = pendingTickets.get(cancelled.ticket);
    if (!pending) continue;
    pendingTickets.delete(cancelled.ticket);
    clearTimeout(pending.timer);
    pending.reject(toToolError(cancelled.error));
  }
  if (!transition.promoted) return;
  const pending = pendingTickets.get(transition.promoted.ticket);
  if (!pending) return;
  pendingTickets.delete(transition.promoted.ticket);
  clearTimeout(pending.timer);
  pending.resolve(grantedResult(pending.tabId, transition.promoted));
}

function toToolError(error: { code: string; message: string; details: unknown }): ToolError {
  const code =
    error.code === 'QUEUE_FULL'
      ? ToolErrorCode.QUEUE_FULL
      : error.code === 'TAB_LOCK_TIMEOUT'
        ? ToolErrorCode.TAB_LOCK_TIMEOUT
        : error.code === 'TAB_CLOSED'
          ? ToolErrorCode.TAB_CLOSED
          : ToolErrorCode.UNKNOWN;
  return new ToolError(code, error.message, error.details as Record<string, unknown>);
}

// Register synchronously; state work follows the shared initialization barrier.
try {
  chrome.tabs?.onRemoved?.addListener((closedTabId) => {
    void ensureClientStateReady()
      .then(() => applyTransition(getBrowserStateForClientPolicy().closeTabQueue(closedTabId)))
      .catch(() => undefined);
  });
} catch {
  // Non-extension test context.
}
