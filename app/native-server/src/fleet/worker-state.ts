import Database from 'better-sqlite3';

export interface WorkerLeaseIdentity {
  agent: string;
  leaseId: string;
  generation: number;
}

export interface WorkerLease extends WorkerLeaseIdentity {
  expiresAt: number;
}

export interface WorkerExecution {
  clientClosed: () => void;
  complete: () => void;
}

export class WorkerStateError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'WorkerStateError';
  }
}

/**
 * The worker is the fencing authority for the browser process.  Coordinator
 * leases are intentionally mirrored here: a coordinator restart or split
 * brain must not turn an old lease into browser access.
 */
export class WorkerState {
  private readonly db: Database.Database;
  private readonly active = new Map<string, number>();
  private readonly transitions = new Set<string>();

  constructor(
    databasePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_fences (
        profile TEXT PRIMARY KEY NOT NULL,
        generation INTEGER NOT NULL,
        lease_id TEXT,
        agent TEXT,
        expires_at INTEGER,
        released INTEGER NOT NULL DEFAULT 0,
        in_flight INTEGER NOT NULL DEFAULT 0
      );
    `);
    try {
      this.db.exec('ALTER TABLE worker_fences ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 0');
    } catch {
      // A newly created table already has the column.
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * An expired identity is never usable again, but its browser lane can still
   * own tabs until the next assignment explicitly releases it.
   */
  expiredLeaseFor(profile: string): WorkerLease | null {
    const row = this.row(profile);
    if (!row || row.released || row.expiresAt > this.now()) return null;
    return {
      agent: row.agent,
      leaseId: row.leaseId,
      generation: row.generation,
      expiresAt: row.expiresAt,
    };
  }
  leaseFor(profile: string): WorkerLease | null {
    const row = this.row(profile);
    if (!row || row.released || row.expiresAt <= this.now()) return null;
    return {
      agent: row.agent,
      leaseId: row.leaseId,
      generation: row.generation,
      expiresAt: row.expiresAt,
    };
  }

  recordedLeaseFor(profile: string): WorkerLease | null {
    const row = this.row(profile);
    if (!row) return null;
    return {
      agent: row.agent,
      leaseId: row.leaseId,
      generation: row.generation,
      expiresAt: row.expiresAt,
    };
  }

  leasedBy(profile: string): string | null {
    return this.leaseFor(profile)?.agent ?? null;
  }

  hasLiveLeases(): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM worker_fences WHERE released = 0 AND expires_at > ? LIMIT 1')
      .get(this.now()) as { 1: number } | undefined;
    return row !== undefined;
  }

  hasActiveWork(): boolean {
    const durable = this.db
      .prepare('SELECT 1 FROM worker_fences WHERE in_flight > 0 LIMIT 1')
      .get() as { 1: number } | undefined;
    return (
      durable !== undefined ||
      [...this.active.values()].some((count) => count > 0) ||
      this.transitions.size > 0
    );
  }

  /**
   * Records a coordinator-issued fence.  Equal generations may only renew the
   * same still-live identity; a released or expired identity is a tombstone.
   */
  claim(profile: string, identity: WorkerLeaseIdentity, ttlSec: number): WorkerLease {
    const expiresAt = this.now() + ttlSec * 1000;
    const transaction = this.db.transaction(() => {
      const previous = this.row(profile);
      const active = this.active.get(profile) ?? 0;
      const transitioning = this.transitions.has(profile);
      if (previous) {
        if (identity.generation < previous.generation) {
          throw new WorkerStateError('stale_lease', 'lease generation is below the durable fence');
        }
        if (identity.generation === previous.generation) {
          if (
            previous.leaseId !== identity.leaseId ||
            previous.agent !== identity.agent ||
            previous.released ||
            previous.expiresAt <= this.now()
          ) {
            throw new WorkerStateError(
              'stale_lease',
              'lease identity is stale or cannot be revived',
            );
          }
          this.db
            .prepare('UPDATE worker_fences SET expires_at = ? WHERE profile = ?')
            .run(expiresAt, profile);
          return;
        }
        if (
          (!previous.released && previous.expiresAt > this.now()) ||
          previous.inFlight > 0 ||
          active > 0 ||
          transitioning
        ) {
          throw new WorkerStateError(
            'lease_conflict',
            'profile has a live lease or active operation',
          );
        }
      }
      this.db
        .prepare(
          `INSERT INTO worker_fences (profile, generation, lease_id, agent, expires_at, released, in_flight)
           VALUES (?, ?, ?, ?, ?, 0, 0)
           ON CONFLICT(profile) DO UPDATE SET
             generation = excluded.generation,
             lease_id = excluded.lease_id,
             agent = excluded.agent,
             expires_at = excluded.expires_at,
             released = 0,
             in_flight = 0`,
        )
        .run(profile, identity.generation, identity.leaseId, identity.agent, expiresAt);
    });
    transaction();
    return { ...identity, expiresAt };
  }

  /**
   * Reserves a higher-generation reassignment before bridge cleanup. A caller
   * must hold this reservation until it publishes the new lease, so a failed
   * fence check never clears the prior browser lane.
   */
  reserveHandoff(
    profile: string,
    identity: WorkerLeaseIdentity,
  ): {
    prior: WorkerLease;
    release: () => void;
  } | null {
    const previous = this.row(profile);
    if (!previous || previous.released || previous.expiresAt > this.now()) return null;
    if (identity.generation <= previous.generation) return null;
    if (
      previous.inFlight > 0 ||
      (this.active.get(profile) ?? 0) > 0 ||
      this.transitions.has(profile)
    ) {
      throw new WorkerStateError('lease_conflict', 'profile has an active operation');
    }
    this.transitions.add(profile);
    let released = false;
    return {
      prior: {
        agent: previous.agent,
        leaseId: previous.leaseId,
        generation: previous.generation,
        expiresAt: previous.expiresAt,
      },
      release: () => {
        if (released) return;
        released = true;
        this.transitions.delete(profile);
      },
    };
  }

  beginExecution(profile: string, identity: WorkerLeaseIdentity): WorkerExecution {
    this.assertCurrent(profile, identity);
    const current = this.row(profile);
    if (this.transitions.has(profile) || current?.inFlight) {
      throw new WorkerStateError('outcome_unknown', 'profile has an unresolved browser request');
    }
    this.db
      .prepare('UPDATE worker_fences SET in_flight = in_flight + 1 WHERE profile = ?')
      .run(profile);
    this.active.set(profile, (this.active.get(profile) ?? 0) + 1);
    let clientGone = false;
    let completed = false;
    const clientClosed = () => {
      if (clientGone) return;
      clientGone = true;
      this.decrementActive(profile);
    };
    return {
      clientClosed,
      complete: () => {
        if (completed) return;
        completed = true;
        clientClosed();
        this.db
          .prepare(
            'UPDATE worker_fences SET in_flight = CASE WHEN in_flight > 0 THEN in_flight - 1 ELSE 0 END WHERE profile = ?',
          )
          .run(profile);
      },
    };
  }

  /**
   * Read-only GET/HEAD traffic still excludes lifecycle changes while its
   * connection exists, but a dropped SSE reader cannot leave a browser action
   * with an unknown outcome and therefore needs no durable quarantine.
   */
  beginRead(profile: string, identity: WorkerLeaseIdentity): WorkerExecution {
    this.assertCurrent(profile, identity);
    const current = this.row(profile);
    if (this.transitions.has(profile) || current?.inFlight) {
      throw new WorkerStateError('outcome_unknown', 'profile has an unresolved browser request');
    }
    this.active.set(profile, (this.active.get(profile) ?? 0) + 1);
    let finished = false;
    const clientClosed = () => {
      if (finished) return;
      finished = true;
      this.decrementActive(profile);
    };
    return { clientClosed, complete: clientClosed };
  }

  /**
   * Restart is explicit operator recovery for an outcome that disconnected
   * before the browser bridge confirmed completion. It first kills/restarts the
   * browser; only then may its durable uncertainty be cleared.
   */
  clearUncertainAfterRestart(profile: string, identity: WorkerLeaseIdentity): void {
    this.assertCurrent(profile, identity);
    this.db.prepare('UPDATE worker_fences SET in_flight = 0 WHERE profile = ?').run(profile);
  }

  beginTransition(
    profile: string,
    identity: WorkerLeaseIdentity,
    allowUncertainRecovery = false,
  ): () => void {
    this.assertCurrent(profile, identity);
    const current = this.row(profile);
    if (
      (this.active.get(profile) ?? 0) > 0 ||
      this.transitions.has(profile) ||
      (!allowUncertainRecovery && (current?.inFlight ?? 0) > 0)
    ) {
      throw new WorkerStateError('profile_busy', 'profile has an active request or transition');
    }
    this.transitions.add(profile);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.transitions.delete(profile);
    };
  }

  /** Explicit operator recovery may only replace a browser after its lease expires. */
  beginRecovery(profile: string): () => void {
    const current = this.row(profile);
    if (
      (current && !current.released && current.expiresAt > this.now()) ||
      (this.active.get(profile) ?? 0) > 0 ||
      this.transitions.has(profile)
    ) {
      throw new WorkerStateError('profile_busy', 'profile has a live lease or active connection');
    }
    this.transitions.add(profile);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.transitions.delete(profile);
    };
  }

  clearUncertainAfterRecovery(profile: string): void {
    this.db.prepare('UPDATE worker_fences SET in_flight = 0 WHERE profile = ?').run(profile);
  }

  release(profile: string, identity: WorkerLeaseIdentity): void {
    this.assertCurrent(profile, identity);
    const current = this.row(profile);
    if (
      (this.active.get(profile) ?? 0) > 0 ||
      this.transitions.has(profile) ||
      (current?.inFlight ?? 0) > 0
    ) {
      throw new WorkerStateError('profile_busy', 'profile has an active request or transition');
    }
    this.db.prepare('UPDATE worker_fences SET released = 1 WHERE profile = ?').run(profile);
  }

  private assertCurrent(profile: string, identity: WorkerLeaseIdentity): void {
    const current = this.row(profile);
    if (!current || current.released || current.expiresAt <= this.now()) {
      throw new WorkerStateError('stale_lease', 'lease is released or expired');
    }
    if (
      current.generation !== identity.generation ||
      current.leaseId !== identity.leaseId ||
      current.agent !== identity.agent
    ) {
      throw new WorkerStateError('stale_lease', 'lease identity does not own this profile');
    }
  }

  private decrementActive(profile: string): void {
    const remaining = (this.active.get(profile) ?? 1) - 1;
    if (remaining <= 0) this.active.delete(profile);
    else this.active.set(profile, remaining);
  }

  private row(profile: string):
    | {
        generation: number;
        leaseId: string;
        agent: string;
        expiresAt: number;
        released: boolean;
        inFlight: number;
      }
    | undefined {
    const row = this.db
      .prepare(
        'SELECT generation, lease_id AS leaseId, agent, expires_at AS expiresAt, released, in_flight AS inFlight FROM worker_fences WHERE profile = ?',
      )
      .get(profile) as
      | {
          generation: number;
          leaseId: string | null;
          agent: string | null;
          expiresAt: number | null;
          released: number;
          inFlight: number;
        }
      | undefined;
    if (!row || row.leaseId === null || row.agent === null || row.expiresAt === null)
      return undefined;
    return {
      generation: row.generation,
      leaseId: row.leaseId,
      agent: row.agent,
      expiresAt: row.expiresAt,
      released: Boolean(row.released),
      inFlight: row.inFlight,
    };
  }
}
