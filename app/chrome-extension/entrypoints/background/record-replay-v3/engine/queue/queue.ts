import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';

export interface RunQueueConfig {
  maxParallelRuns: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
}

export const DEFAULT_QUEUE_CONFIG: RunQueueConfig = {
  maxParallelRuns: 3,
  leaseTtlMs: 15_000,
  heartbeatIntervalMs: 5_000,
};

export const QUEUE_ITEM_STATUSES = ['queued', 'running', 'paused'] as const;
export type QueueItemStatus = (typeof QUEUE_ITEM_STATUSES)[number];

export function isQueueItemStatus(value: unknown): value is QueueItemStatus {
  return (QUEUE_ITEM_STATUSES as readonly string[]).includes(value as string);
}

/** Comparator for queue items: priority DESC, then createdAt ASC (FIFO within priority). */
export function compareQueueItems(a: RunQueueItem, b: RunQueueItem): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.createdAt - b.createdAt;
}

export interface Lease {
  ownerId: string;
  expiresAt: UnixMillis;
}

export interface RunQueueItem {
  id: RunId;
  flowId: FlowId;
  status: QueueItemStatus;
  createdAt: UnixMillis;
  updatedAt: UnixMillis;
  /** Higher number = higher priority. */
  priority: number;
  attempt: number;
  maxAttempts: number;
  tabId?: number;
  args?: JsonObject;
  trigger?: TriggerFireContext;
  lease?: Lease;
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

/**
 * Enqueue input (auto-generated fields are omitted).
 * `priority` defaults to 0; `maxAttempts` defaults to 1.
 */
export type EnqueueInput = Omit<
  RunQueueItem,
  'status' | 'createdAt' | 'updatedAt' | 'attempt' | 'lease' | 'priority' | 'maxAttempts'
> & {
  id: RunId;
  priority?: number;
  maxAttempts?: number;
};

export interface RunQueue {
  enqueue(input: EnqueueInput): Promise<RunQueueItem>;

  /** Returns null when nothing is claimable. */
  claimNext(ownerId: string, now: UnixMillis): Promise<RunQueueItem | null>;

  heartbeat(ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Reclaim leases whose expiresAt < now (running/paused items become queued).
   * Returns the list of reclaimed Run IDs.
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * Recover orphaned leases after a Service Worker restart.
   * - Orphan `running` items are requeued (status -> queued, lease cleared).
   * - Orphan `paused` items are adopted (status stays paused; lease.ownerId is
   *   updated to the new ownerId).
   * Returns the affected runIds, including the previous ownerId for audit.
   */
  recoverOrphanLeases(
    ownerId: string,
    now: UnixMillis,
  ): Promise<{
    requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }>;
    adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }>;
  }>;

  markRunning(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;
  markPaused(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;
  /** Mark as done — removes from the queue. */
  markDone(runId: RunId, now: UnixMillis): Promise<void>;

  cancel(runId: RunId, now: UnixMillis, reason?: string): Promise<void>;

  get(runId: RunId): Promise<RunQueueItem | null>;
  list(status?: QueueItemStatus): Promise<RunQueueItem[]>;
}

export function createNotImplementedQueue(): RunQueue {
  const notImplemented = () => {
    throw new Error('RunQueue not implemented');
  };

  return {
    enqueue: async () => notImplemented(),
    claimNext: async () => notImplemented(),
    heartbeat: async () => notImplemented(),
    reclaimExpiredLeases: async () => notImplemented(),
    recoverOrphanLeases: async () => notImplemented(),
    markRunning: async () => notImplemented(),
    markPaused: async () => notImplemented(),
    markDone: async () => notImplemented(),
    cancel: async () => notImplemented(),
    get: async () => notImplemented(),
    list: async () => notImplemented(),
  };
}
