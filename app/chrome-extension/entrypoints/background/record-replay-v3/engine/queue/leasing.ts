import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { RunQueue, RunQueueConfig, Lease } from './queue';

export interface LeaseManager {
  startHeartbeat(ownerId: string): void;
  stopHeartbeat(ownerId: string): void;

  /** Returns the list of reclaimed Run IDs. */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  isLeaseExpired(lease: Lease, now: UnixMillis): boolean;
  createLease(ownerId: string, now: UnixMillis): Lease;

  /** Stop all heartbeats. */
  dispose(): void;
}

export function createLeaseManager(queue: RunQueue, config: RunQueueConfig): LeaseManager {
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  return {
    startHeartbeat(ownerId: string): void {
      this.stopHeartbeat(ownerId);

      const timer = setInterval(async () => {
        try {
          await queue.heartbeat(ownerId, Date.now());
        } catch (error) {
          console.error(`[LeaseManager] Heartbeat failed for ${ownerId}:`, error);
        }
      }, config.heartbeatIntervalMs);

      heartbeatTimers.set(ownerId, timer);
    },

    stopHeartbeat(ownerId: string): void {
      const timer = heartbeatTimers.get(ownerId);
      if (timer) {
        clearInterval(timer);
        heartbeatTimers.delete(ownerId);
      }
    },

    async reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]> {
      // Delegate to the queue implementation which uses the lease_expiresAt index
      // for efficient scanning and updates storage atomically.
      return queue.reclaimExpiredLeases(now);
    },

    isLeaseExpired(lease: Lease, now: UnixMillis): boolean {
      return lease.expiresAt < now;
    },

    createLease(ownerId: string, now: UnixMillis): Lease {
      return {
        ownerId,
        expiresAt: now + config.leaseTtlMs,
      };
    },

    dispose(): void {
      for (const timer of heartbeatTimers.values()) {
        clearInterval(timer);
      }
      heartbeatTimers.clear();
    },
  };
}

/** Generate a unique owner ID for the current Service Worker instance. */
export function generateOwnerId(): string {
  return `sw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
