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
import { DEFAULT_TAB_LOCK_TIMEOUT_MS, MAX_TAB_QUEUE_DEPTH } from './timeouts';

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

interface QueueEntry {
  /** Monotonic ticket — FIFO tie-break inside a single client. */
  ticket: number;
  clientId: string | undefined;
  enqueuedAt: number;
  /** Resolves to start the holder's critical section. */
  start: () => void;
  /** Rejects when the holder exceeded its timeout or the tab closed. */
  cancel: (err: Error) => void;
  /** Settles after `release()` is called so the next pick can run. */
  released: Promise<void>;
  /** Set when this entry becomes the holder. */
  startedAt?: number;
  /** Used to guard against double-cancel after release. */
  settled: boolean;
}

interface TabQueueState {
  entries: QueueEntry[];
  /** EWMA of completed critical-section durations, for ETA. */
  meanHoldMs: number;
  servedTotal: number;
  /** Last clientId to finish a hold — drives the round-robin tie-break. */
  lastServedClientId: string | undefined;
}

const tabs = new Map<number, TabQueueState>();
let nextTicket = 1;

function getState(tabId: number): TabQueueState {
  let s = tabs.get(tabId);
  if (!s) {
    s = { entries: [], meanHoldMs: 0, servedTotal: 0, lastServedClientId: undefined };
    tabs.set(tabId, s);
  }
  return s;
}

/**
 * Acquire the queue slot for a tab. Awaits any prior holders, then returns
 * the release callback the caller MUST invoke (use try/finally). Throws
 * `TAB_LOCK_TIMEOUT` if the wait exceeds `timeoutMs`, or `QUEUE_FULL` if
 * the queue is at depth cap.
 */
export async function acquireTabLock(tabId: number, opts: AcquireOptions = {}): Promise<Release> {
  const result = await acquireTabLockWithMeta(tabId, opts);
  return result.release;
}

/**
 * Same as `acquireTabLock` but returns the queue position + waited time.
 * Used by the dispatcher for tool-call-start logging without changing the
 * downstream caller surface.
 */
export async function acquireTabLockWithMeta(
  tabId: number,
  opts: AcquireOptions = {},
): Promise<AcquireResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TAB_LOCK_TIMEOUT_MS;
  const state = getState(tabId);

  if (state.entries.length >= MAX_TAB_QUEUE_DEPTH) {
    throw new ToolError(
      ToolErrorCode.QUEUE_FULL,
      `Tab ${tabId} queue is at capacity (${MAX_TAB_QUEUE_DEPTH} waiters); back off and retry, or pin a different tabId.`,
      { tabId, depth: state.entries.length, max: MAX_TAB_QUEUE_DEPTH },
    );
  }

  const enqueuedAt = Date.now();
  const ticket = nextTicket++;
  const queuedAtPosition = state.entries.length + 1;

  let startWait!: () => void;
  let cancelWait!: (err: Error) => void;
  const waitForTurn = new Promise<void>((resolve, reject) => {
    startWait = resolve;
    cancelWait = reject;
  });

  let releaseHold!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  const entry: QueueEntry = {
    ticket,
    clientId: opts.clientId,
    enqueuedAt,
    start: startWait,
    cancel: cancelWait,
    released,
    settled: false,
  };

  state.entries.push(entry);

  // Fast path: head of queue, start immediately.
  if (state.entries.length === 1) {
    entry.startedAt = enqueuedAt;
    entry.start();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      waitForTurn,
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
    // Remove our slot so the chain doesn't deadlock. If we were the holder
    // (very rare race: we hit the timer immediately after start()), promote
    // the next waiter.
    removeAndPromote(state, entry);
    throw err;
  }
  clearTimeout(timer);

  const startedAt = entry.startedAt ?? Date.now();
  return {
    release: () => releaseEntry(state, entry, releaseHold),
    queuedAtPosition,
    waitedMs: startedAt - enqueuedAt,
  };
}

function releaseEntry(state: TabQueueState, entry: QueueEntry, releaseHold: () => void): void {
  if (entry.settled) return;
  entry.settled = true;

  if (typeof entry.startedAt === 'number') {
    const sample = Date.now() - entry.startedAt;
    state.meanHoldMs = state.meanHoldMs === 0 ? sample : state.meanHoldMs * 0.7 + sample * 0.3;
    state.servedTotal += 1;
    state.lastServedClientId = entry.clientId;
  }
  releaseHold();

  const idx = state.entries.indexOf(entry);
  if (idx !== -1) state.entries.splice(idx, 1);

  promoteNext(state);
}

/**
 * Pick the next entry to run via round-robin across distinct clientIds,
 * tie-breaking by ticket order. Entries with `clientId === undefined`
 * share one lane.
 */
function promoteNext(state: TabQueueState): void {
  if (state.entries.length === 0) {
    // If this queue has no waiters and no holder, drop the slot so unused
    // tabs carry no state.
    for (const [tabId, s] of tabs) {
      if (s === state) {
        tabs.delete(tabId);
        break;
      }
    }
    return;
  }

  // Already a holder? Don't promote — they're mid-critical-section.
  const head = state.entries[0];
  if (head && typeof head.startedAt === 'number') return;

  const last = state.lastServedClientId;
  let pickIdx = 0;
  if (last !== undefined) {
    const fromOtherClient = state.entries.findIndex((e) => e.clientId !== last);
    if (fromOtherClient !== -1) pickIdx = fromOtherClient;
  }

  if (pickIdx !== 0) {
    const [picked] = state.entries.splice(pickIdx, 1);
    if (picked) state.entries.unshift(picked);
  }
  const next = state.entries[0];
  if (!next) return;
  next.startedAt = Date.now();
  next.start();
}

function removeAndPromote(state: TabQueueState, entry: QueueEntry): void {
  if (entry.settled) return;
  entry.settled = true;
  const idx = state.entries.indexOf(entry);
  if (idx !== -1) state.entries.splice(idx, 1);
  promoteNext(state);
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

// ---------------------------------------------------------------------------
// Inspectors (used by chrome_queue_inspect)
// ---------------------------------------------------------------------------

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

/** Default expected-wait per waiter when EWMA has no samples yet. */
const DEFAULT_EXPECTED_HOLD_MS = 250;

function snapshotTab(tabId: number, state: TabQueueState): QueueTabSnapshot {
  const now = Date.now();
  const head = state.entries[0];
  const holder =
    head && typeof head.startedAt === 'number'
      ? {
          clientId: head.clientId ?? null,
          heldMs: now - head.startedAt,
          ticket: head.ticket,
        }
      : null;
  const waiterEntries = holder ? state.entries.slice(1) : state.entries;
  const baseHold = state.meanHoldMs > 0 ? state.meanHoldMs : DEFAULT_EXPECTED_HOLD_MS;
  const waiters: QueueWaiterSnapshot[] = waiterEntries.map((entry, idx) => ({
    clientId: entry.clientId ?? null,
    position: idx + (holder ? 2 : 1),
    waitedMs: now - entry.enqueuedAt,
    expectedWaitMs: (idx + 1) * baseHold,
    ticket: entry.ticket,
  }));
  return {
    tabId,
    depth: state.entries.length,
    servedTotal: state.servedTotal,
    meanHoldMs: state.meanHoldMs,
    holder,
    waiters,
  };
}

export function inspectTabQueue(tabId: number): QueueTabSnapshot | null {
  const state = tabs.get(tabId);
  if (!state) return null;
  return snapshotTab(tabId, state);
}

export function inspectAllTabQueues(): QueueTabSnapshot[] {
  const out: QueueTabSnapshot[] = [];
  for (const [tabId, state] of tabs) {
    out.push(snapshotTab(tabId, state));
  }
  return out;
}

/** Diagnostic — number of tabs with pending or held locks. */
export function activeLockedTabCount(): number {
  return tabs.size;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _resetTabQueueForTests(): void {
  tabs.clear();
  nextTicket = 1;
}

export interface QueueEntryTestSnapshot {
  ticket: number;
  clientId: string | undefined;
  enqueuedAt: number;
  startedAt: number | undefined;
}

export function _snapshotTabQueueForTests(tabId: number): QueueEntryTestSnapshot[] {
  const state = tabs.get(tabId);
  if (!state) return [];
  return state.entries.map((e) => ({
    ticket: e.ticket,
    clientId: e.clientId,
    enqueuedAt: e.enqueuedAt,
    startedAt: e.startedAt,
  }));
}

export function _advanceMeanHoldForTests(tabId: number, ms: number): void {
  const state = getState(tabId);
  state.meanHoldMs = ms;
}

// ---------------------------------------------------------------------------
// chrome.tabs.onRemoved — cancel every waiter for a closing tab
// ---------------------------------------------------------------------------

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((closedTabId) => {
    const state = tabs.get(closedTabId);
    if (!state) return;
    tabs.delete(closedTabId);
    for (const entry of state.entries) {
      if (entry.settled) continue;
      entry.settled = true;
      entry.cancel(
        new ToolError(
          ToolErrorCode.TAB_CLOSED,
          `Tab ${closedTabId} closed while ${
            typeof entry.startedAt === 'number' ? 'holding' : 'waiting for'
          } the tab queue`,
          { tabId: closedTabId },
        ),
      );
    }
  });
}
