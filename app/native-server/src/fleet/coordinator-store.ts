import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import type { ProfileSnapshot } from './supervisor';
import { workerInventorySchema } from './coordinator-config';

export interface CoordinatorProfile extends ProfileSnapshot {
  worker: string;
  profile: string;
  available: boolean;
}

export interface CoordinatorLease {
  profile: string;
  client: string;
  agent: string;
  leaseId: string;
  generation: number;
  expiresAt: string;
  released: boolean;
}

type LeaseRow = {
  profile: string;
  client_id: string;
  agent: string;
  lease_id: string;
  generation: string;
  expires_at: Date;
  released: boolean;
};

export class CoordinatorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

/** PostgreSQL is canonical; workers independently enforce every issued fence. */
export class CoordinatorStore {
  private readonly pool: Pool;
  private leader: PoolClient | null = null;
  private healthy = false;
  private closed = false;

  constructor(
    private readonly id: string,
    databaseUrl: string,
  ) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 10_000,
    });
    this.pool.on('error', () => {
      this.healthy = false;
    });
  }

  async open(): Promise<void> {
    this.leader = await this.pool.connect();
    this.leader.on('error', () => {
      this.healthy = false;
    });
    this.leader.on('end', () => {
      this.healthy = false;
    });
    const lock = await this.leader.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [`humanchrome-coordinator:${this.id}`],
    );
    if (!lock.rows[0].locked) {
      this.leader.release();
      this.leader = null;
      throw new Error(`coordinator ${this.id} is already running`);
    }
    await this.leader.query(`
      CREATE SEQUENCE IF NOT EXISTS hc_fleet_generation;
      CREATE TABLE IF NOT EXISTS hc_fleet_profiles (
        coordinator text NOT NULL, profile text NOT NULL, worker text NOT NULL,
        snapshot jsonb NOT NULL, available boolean NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (coordinator, profile)
      );
      CREATE TABLE IF NOT EXISTS hc_fleet_leases (
        coordinator text NOT NULL, profile text NOT NULL, client_id text NOT NULL,
        agent text NOT NULL, lease_id text NOT NULL, generation bigint NOT NULL,
        expires_at timestamptz NOT NULL, released boolean NOT NULL DEFAULT false,
        PRIMARY KEY (coordinator, profile)
      );
      CREATE TABLE IF NOT EXISTS hc_fleet_bindings (
        coordinator text NOT NULL, client_id text NOT NULL, agent text NOT NULL,
        route text NOT NULL, profile text NOT NULL, lease_id text NOT NULL,
        PRIMARY KEY (coordinator, client_id, agent, route)
      );
    `);
    this.healthy = true;
  }

  async ready(): Promise<boolean> {
    if (!this.healthy || !this.leader) return false;
    try {
      await this.leader.query('SELECT 1');
      return this.healthy;
    } catch {
      this.healthy = false;
      return false;
    }
  }

  private assertReady(): void {
    if (!this.healthy) throw new CoordinatorError(503, 'coordinator_unavailable');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.healthy = false;
    if (this.leader) {
      const leader = this.leader;
      this.leader = null;
      // Destroying the connection releases the session lock even if the network is broken.
      leader.release(true);
    }
    await this.pool.end();
  }

  async observe(worker: string, profiles: ProfileSnapshot[] | null): Promise<void> {
    this.assertReady();
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(
        'UPDATE hc_fleet_profiles SET available=false WHERE coordinator=$1 AND worker=$2',
        [this.id, worker],
      );
      for (const snapshot of profiles ?? []) {
        const qualified = `${worker}:${snapshot.name}`;
        await db.query(
          `INSERT INTO hc_fleet_profiles (coordinator,profile,worker,snapshot,available)
          VALUES ($1,$2,$3,$4,true) ON CONFLICT (coordinator,profile) DO UPDATE
          SET snapshot=excluded.snapshot,available=true,observed_at=now()`,
          [this.id, qualified, worker, JSON.stringify(snapshot)],
        );
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async profiles(workers: string[]): Promise<CoordinatorProfile[]> {
    this.assertReady();
    const result = await this.pool.query<{
      profile: string;
      worker: string;
      snapshot: ProfileSnapshot;
      available: boolean;
    }>(
      'SELECT profile,worker,snapshot,available FROM hc_fleet_profiles WHERE coordinator=$1 AND worker=ANY($2::text[]) ORDER BY profile',
      [this.id, workers],
    );
    return result.rows.map((row) => {
      const snapshot = workerInventorySchema.parse({ id: row.worker, profiles: [row.snapshot] })
        .profiles[0];
      return {
        ...snapshot,
        name: row.profile,
        worker: row.worker,
        profile: snapshot.name,
        available: row.available,
        state: row.available ? snapshot.state : 'unreachable',
      };
    });
  }

  async leases(
    client?: string,
    agent?: string,
    includeExpired = false,
  ): Promise<CoordinatorLease[]> {
    this.assertReady();
    const rows = await this.pool.query<LeaseRow>(
      `SELECT * FROM hc_fleet_leases
      WHERE coordinator=$1 AND released=false AND ($4 OR expires_at>now())
      AND ($2::text IS NULL OR client_id=$2) AND ($3::text IS NULL OR agent=$3) ORDER BY profile`,
      [this.id, client ?? null, agent ?? null, includeExpired],
    );
    return rows.rows.map(leaseFromRow);
  }

  /** A coordinator-wide transaction lock keeps pool and named allocation consistent. */
  async acquire(
    client: string,
    agent: string,
    profiles: CoordinatorProfile[],
    ttlSec: number,
    named?: string,
    label = 'any',
  ): Promise<CoordinatorLease> {
    this.assertReady();
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `hc-allocation:${this.id}`,
      ]);
      const live = await db.query<LeaseRow>(
        'SELECT * FROM hc_fleet_leases WHERE coordinator=$1 AND released=false AND expires_at>now() FOR UPDATE',
        [this.id],
      );
      const route = named ? `profile:${named}` : `pool:${label}`;
      const bound = await db.query<{ profile: string; lease_id: string }>(
        'SELECT profile,lease_id FROM hc_fleet_bindings WHERE coordinator=$1 AND client_id=$2 AND agent=$3 AND route=$4',
        [this.id, client, agent, route],
      );
      const binding = bound.rows[0];
      const candidates = profiles.filter((p) =>
        named
          ? p.name === named
          : label === 'any' || p.labels.includes(label) || p.purpose === label,
      );
      const own = binding
        ? live.rows.find(
            (l) =>
              l.profile === binding.profile &&
              l.lease_id === binding.lease_id &&
              l.client_id === client &&
              l.agent === agent,
          )
        : live.rows.find(
            (l) =>
              l.client_id === client &&
              l.agent === agent &&
              candidates.some((p) => p.name === l.profile),
          );
      // Expiry frees capacity, but never silently rebinds an existing workflow.
      if (binding && !own) throw new CoordinatorError(409, 'lease_expired');
      const profile = own
        ? profiles.find((p) => p.name === own.profile)
        : candidates.find(
            (p) => p.available && p.enabled && !live.rows.some((l) => l.profile === p.name),
          );
      if (!profile) {
        if (named && live.rows.some((l) => l.profile === named))
          throw new CoordinatorError(409, 'profile_busy');
        throw new CoordinatorError(503, named ? 'profile_unavailable' : 'no_free_profile');
      }
      if (!profile.available) throw new CoordinatorError(503, 'worker_unavailable');
      if (!profile.enabled) throw new CoordinatorError(503, 'profile_disabled');
      let lease: CoordinatorLease;
      if (own) lease = leaseFromRow(own);
      else {
        const result = await db.query<LeaseRow>(
          `INSERT INTO hc_fleet_leases
          (coordinator,profile,client_id,agent,lease_id,generation,expires_at,released)
          VALUES ($1,$2,$3,$4,$5,nextval('hc_fleet_generation'),now()+$6*interval '1 second',false)
          ON CONFLICT (coordinator,profile) DO UPDATE SET client_id=excluded.client_id,agent=excluded.agent,
          lease_id=excluded.lease_id,generation=excluded.generation,expires_at=excluded.expires_at,released=false RETURNING *`,
          [this.id, profile.name, client, agent, randomUUID(), ttlSec],
        );
        lease = leaseFromRow(result.rows[0]);
      }
      await db.query(
        `INSERT INTO hc_fleet_bindings (coordinator,client_id,agent,route,profile,lease_id)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (coordinator,client_id,agent,route) DO NOTHING`,
        [this.id, client, agent, route, lease.profile, lease.leaseId],
      );
      await db.query('COMMIT');
      return lease;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async renewalDeadline(ttlSec: number): Promise<Date> {
    this.assertReady();
    const result = await this.pool.query<{ deadline: Date }>(
      "SELECT clock_timestamp()+$1*interval '1 second' AS deadline",
      [ttlSec],
    );
    return result.rows[0].deadline;
  }

  async renew(lease: CoordinatorLease, confirmedDeadline: Date): Promise<void> {
    this.assertReady();
    const result = await this.pool.query(
      `UPDATE hc_fleet_leases SET expires_at=GREATEST(expires_at,$5)
      WHERE coordinator=$1 AND profile=$2 AND lease_id=$3 AND generation=$4 AND released=false AND expires_at>now()`,
      [this.id, lease.profile, lease.leaseId, lease.generation, confirmedDeadline],
    );
    if (result.rowCount !== 1) throw new CoordinatorError(409, 'stale_lease');
  }

  async release(lease: CoordinatorLease): Promise<void> {
    this.assertReady();
    await this.pool.query(
      `WITH cleared AS (
      DELETE FROM hc_fleet_bindings WHERE coordinator=$1 AND lease_id=$3 RETURNING 1
    ) UPDATE hc_fleet_leases SET released=true,expires_at=now()
      WHERE coordinator=$1 AND profile=$2 AND lease_id=$3 AND generation=$4`,
      [this.id, lease.profile, lease.leaseId, lease.generation],
    );
  }

  async clearBindings(client: string, agent: string): Promise<void> {
    this.assertReady();
    await this.pool.query(
      'DELETE FROM hc_fleet_bindings WHERE coordinator=$1 AND client_id=$2 AND agent=$3',
      [this.id, client, agent],
    );
  }
}

function leaseFromRow(row: LeaseRow): CoordinatorLease {
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error('fleet lease generation exhausted');
  return {
    profile: row.profile,
    client: row.client_id,
    agent: row.agent,
    leaseId: row.lease_id,
    generation,
    expiresAt: row.expires_at.toISOString(),
    released: row.released,
  };
}
