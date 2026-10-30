//! PostgreSQL-backed coordinator inventory, bindings, and fenced leases.

use std::sync::Arc;

use tokio::{
    sync::{Mutex, MutexGuard, OnceCell},
    task::JoinHandle,
};
use tokio_postgres::{Client, Row};
use uuid::Uuid;

use super::config::{ProfileSnapshot, ProfileState, WorkerInventory};
use super::connection;

/// A profile observed through a configured worker.
#[derive(Clone, Debug, PartialEq)]
pub struct CoordinatorProfile {
    /// Coordinator-qualified profile name (`worker:profile`).
    pub name: String,
    /// Worker identity.
    pub worker: String,
    /// Worker-local profile name.
    pub profile: String,
    /// Last validated worker snapshot.
    pub snapshot: ProfileSnapshot,
    /// Whether the worker confirmed this profile during the latest refresh.
    pub available: bool,
}

impl CoordinatorProfile {
    /// The state presented by the coordinator, replacing stale state when unavailable.
    #[must_use]
    pub fn state(&self) -> ProfileState {
        if self.available {
            self.snapshot.state.clone()
        } else {
            ProfileState::Unreachable
        }
    }
}

/// A durable lease and monotonically increasing worker fence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoordinatorLease {
    /// Coordinator-qualified profile name.
    pub profile: String,
    /// Client identity that owns the lease.
    pub client: String,
    /// Normalized agent identity within that client.
    pub agent: String,
    /// Random lease identity.
    pub lease_id: String,
    /// Database-wide strictly increasing fence generation.
    pub generation: i64,
    /// PostgreSQL-rendered expiration timestamp.
    pub expires_at: String,
    /// Whether the lease has been explicitly released.
    pub released: bool,
}

/// Public coordinator failures preserve the TypeScript status/code contract.
#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
#[error("{message}")]
pub struct CoordinatorError {
    /// HTTP status presented by the router.
    pub status: u16,
    /// Machine-readable error code.
    pub code: String,
    /// Credential-safe message.
    pub message: String,
}

impl CoordinatorError {
    /// Creates the conventional code-as-message response.
    #[must_use]
    pub fn new(status: u16, code: impl Into<String>) -> Self {
        let code = code.into();
        Self {
            status,
            message: code.clone(),
            code,
        }
    }

    /// Creates a response with a separately safe diagnostic.
    #[must_use]
    pub fn with_message(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}

struct Leader {
    client: Client,
    connection: JoinHandle<()>,
}

/// A PostgreSQL authority whose leader connection owns the coordinator singleton lock.
#[derive(Clone)]
pub struct CoordinatorStore {
    id: Arc<str>,
    database_url: Arc<str>,
    connector: Arc<OnceCell<connection::Connector>>,
    leader: Arc<Mutex<Option<Leader>>>,
}

impl CoordinatorStore {
    /// Creates an unopened store. [`Self::open`] acquires the singleton lock.
    #[must_use]
    pub fn new(id: impl Into<Arc<str>>, database_url: impl Into<Arc<str>>) -> Self {
        Self {
            id: id.into(),
            database_url: database_url.into(),
            connector: Arc::new(OnceCell::new()),
            leader: Arc::new(Mutex::new(None)),
        }
    }

    /// Acquires the PostgreSQL advisory lock and creates durable schema on its locked session.
    ///
    /// # Errors
    /// Returns `coordinator_unavailable` for connection/schema failure or an error when another
    /// coordinator already owns this id.
    pub async fn open(&self) -> Result<(), CoordinatorError> {
        let mut guard = self.leader.lock().await;
        if leader_is_live(&guard) {
            return Ok(());
        }
        guard.take();
        let id = self.id.as_ref();
        let (client, connection) = self
            .connector()
            .await?
            .connect()
            .await
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
        let locked = client
            .query_one(
                "SELECT pg_try_advisory_lock(hashtextextended('humanchrome-coordinator:' || $1, 0)) AS locked",
                &[&id],
            )
            .await
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?
            .try_get::<_, bool>("locked")
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
        if !locked {
            connection.abort();
            return Err(CoordinatorError::with_message(
                503,
                "coordinator_unavailable",
                format!("coordinator {id} is already running"),
            ));
        }
        client
            .batch_execute(
                "CREATE SEQUENCE IF NOT EXISTS hc_fleet_generation;
                 CREATE TABLE IF NOT EXISTS hc_fleet_profiles (
                   coordinator text NOT NULL, profile text NOT NULL, worker text NOT NULL,
                   snapshot jsonb NOT NULL, available boolean NOT NULL,
                   observed_at timestamptz NOT NULL DEFAULT now(),
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
                 );",
            )
            .await
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
        if client.is_closed() || connection.is_finished() {
            connection.abort();
            return Err(CoordinatorError::new(503, "coordinator_unavailable"));
        }
        *guard = Some(Leader { client, connection });
        Ok(())
    }

    /// Reports whether the singleton lock connection remains usable.
    pub async fn ready(&self) -> bool {
        let mut guard = self.leader.lock().await;
        let ready = match guard.as_mut() {
            Some(leader) if !leader.client.is_closed() && !leader.connection.is_finished() => {
                leader.client.simple_query("SELECT 1").await.is_ok()
            }
            _ => false,
        };
        if !ready {
            guard.take();
        }
        ready
    }

    /// Drops the singleton session, which releases its advisory lock.
    pub async fn close(&self) {
        let mut guard = self.leader.lock().await;
        if let Some(leader) = guard.take() {
            drop(leader.client);
            leader.connection.abort();
        }
    }

    /// Persists one worker observation, marking omitted or unreachable profiles unavailable.
    ///
    /// # Errors
    /// Fails closed when the coordinator leader/database is unavailable.
    pub async fn observe(
        &self,
        worker: &str,
        profiles: Option<&[ProfileSnapshot]>,
    ) -> Result<(), CoordinatorError> {
        let id = self.id.as_ref();
        let mut leader = self.leader_session().await?;
        let result = {
            let client = leader_client(&mut leader)?;
            let transaction = client.transaction().await.map_err(db_unavailable)?;
            let result = async {
                transaction
                    .execute(
                        "UPDATE hc_fleet_profiles SET available=false WHERE coordinator=$1 AND worker=$2",
                        &[&id, &worker],
                    )
                    .await
                    .map_err(db_unavailable)?;
                for snapshot in profiles.unwrap_or_default() {
                    let encoded = tokio_postgres::types::Json(snapshot);
                    let profile = format!("{worker}:{}", snapshot.name);
                    transaction
                        .execute(
                            "INSERT INTO hc_fleet_profiles (coordinator,profile,worker,snapshot,available)
                             VALUES ($1,$2,$3,$4::jsonb,true)
                             ON CONFLICT (coordinator,profile) DO UPDATE
                             SET snapshot=excluded.snapshot,available=true,observed_at=now()",
                            &[&id, &profile, &worker, &encoded],
                        )
                        .await
                        .map_err(db_unavailable)?;
                }
                Ok::<(), CoordinatorError>(())
            }
            .await;
            finish(transaction, result).await
        };
        discard_lost_leader(&mut leader);
        result
    }

    /// Returns stored inventory in coordinator-qualified lexical order.
    pub async fn profiles(
        &self,
        workers: &[String],
    ) -> Result<Vec<CoordinatorProfile>, CoordinatorError> {
        let id = self.id.as_ref();
        let mut leader = self.leader_session().await?;
        let result = leader_client(&mut leader)?
            .query(
                "SELECT profile,worker,snapshot::text AS snapshot,available
                 FROM hc_fleet_profiles WHERE coordinator=$1 AND worker=ANY($2::text[]) ORDER BY profile",
                &[&id, &workers],
            )
            .await
            .map_err(db_unavailable)
            .and_then(|rows| rows.into_iter().map(profile_from_row).collect());
        discard_lost_leader(&mut leader);
        result
    }

    /// Lists unreleased leases, with the same expiration filtering as the TypeScript store.
    pub async fn leases(
        &self,
        client_id: Option<&str>,
        agent: Option<&str>,
        include_expired: bool,
    ) -> Result<Vec<CoordinatorLease>, CoordinatorError> {
        let id = self.id.as_ref();
        let mut leader = self.leader_session().await?;
        let result = leader_client(&mut leader)?
            .query(
                "SELECT profile,client_id,agent,lease_id,generation,
                        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS expires_at,released
                 FROM hc_fleet_leases
                 WHERE coordinator=$1 AND released=false AND ($4 OR expires_at>now())
                   AND ($2::text IS NULL OR client_id=$2) AND ($3::text IS NULL OR agent=$3)
                 ORDER BY profile",
                &[&id, &client_id, &agent, &include_expired],
            )
            .await
            .map_err(db_unavailable)
            .and_then(|rows| rows.into_iter().map(lease_from_row).collect());
        discard_lost_leader(&mut leader);
        result
    }

    /// Acquires or renews a durable route binding under a transaction advisory lock.
    ///
    /// Expired bindings fail rather than silently moving a workflow to another profile.
    pub async fn acquire(
        &self,
        client_id: &str,
        agent: &str,
        profiles: &[CoordinatorProfile],
        ttl_sec: u32,
        named: Option<&str>,
        label: &str,
    ) -> Result<CoordinatorLease, CoordinatorError> {
        let id = self.id.as_ref();
        let mut leader = self.leader_session().await?;
        let result = {
            let client = leader_client(&mut leader)?;
            let transaction = client.transaction().await.map_err(db_unavailable)?;
            let result = async {
                transaction
                    .execute(
                        "SELECT pg_advisory_xact_lock(hashtextextended('hc-allocation:' || $1, 0))",
                        &[&id],
                    )
                    .await
                    .map_err(db_unavailable)?;
                let live = transaction
                    .query(
                        "SELECT profile,client_id,agent,lease_id,generation,
                                to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS expires_at,released
                         FROM hc_fleet_leases WHERE coordinator=$1 AND released=false AND expires_at>now() FOR UPDATE",
                        &[&id],
                    )
                    .await
                    .map_err(db_unavailable)?;
                let live: Vec<CoordinatorLease> = live.into_iter().map(lease_from_row).collect::<Result<_, _>>()?;
                let route = named.map_or_else(|| format!("pool:{label}"), |name| format!("profile:{name}"));
                let binding = transaction
                    .query_opt(
                        "SELECT profile,lease_id FROM hc_fleet_bindings
                         WHERE coordinator=$1 AND client_id=$2 AND agent=$3 AND route=$4",
                        &[&id, &client_id, &agent, &route],
                    )
                    .await
                    .map_err(db_unavailable)?
                    .map(|row| (row.get::<_, String>("profile"), row.get::<_, String>("lease_id")));
                let candidates: Vec<&CoordinatorProfile> = profiles.iter().filter(|profile| {
                    named.is_some_and(|name| profile.name == name)
                        || named.is_none() && (label == "any" || profile.snapshot.labels.iter().any(|entry| entry == label) || profile.snapshot.purpose.as_deref() == Some(label))
                }).collect();
                let own = if let Some((bound_profile, bound_lease)) = &binding {
                    live.iter().find(|lease| lease.profile == *bound_profile && lease.lease_id == *bound_lease && lease.client == client_id && lease.agent == agent)
                } else {
                    live.iter().find(|lease| lease.client == client_id && lease.agent == agent && candidates.iter().any(|profile| profile.name == lease.profile))
                };
                if binding.is_some() && own.is_none() {
                    return Err(CoordinatorError::new(409, "lease_expired"));
                }
                let profile = if let Some(lease) = own {
                    profiles.iter().find(|profile| profile.name == lease.profile)
                } else {
                    candidates.into_iter().find(|profile| profile.available && profile.snapshot.enabled && !live.iter().any(|lease| lease.profile == profile.name))
                };
                let Some(profile) = profile else {
                    if named.is_some_and(|name| live.iter().any(|lease| lease.profile == name)) {
                        return Err(CoordinatorError::new(409, "profile_busy"));
                    }
                    return Err(CoordinatorError::new(503, if named.is_some() { "profile_unavailable" } else { "no_free_profile" }));
                };
                if !profile.available { return Err(CoordinatorError::new(503, "worker_unavailable")); }
                if !profile.snapshot.enabled { return Err(CoordinatorError::new(503, "profile_disabled")); }
                let lease = if let Some(lease) = own {
                    lease.clone()
                } else {
                    let lease_id = Uuid::new_v4().to_string();
                    let row = transaction
                        .query_one(
                            "INSERT INTO hc_fleet_leases
                             (coordinator,profile,client_id,agent,lease_id,generation,expires_at,released)
                             VALUES ($1,$2,$3,$4,$5,nextval('hc_fleet_generation'),now()+$6::int*interval '1 second',false)
                             ON CONFLICT (coordinator,profile) DO UPDATE SET client_id=excluded.client_id,agent=excluded.agent,
                               lease_id=excluded.lease_id,generation=excluded.generation,expires_at=excluded.expires_at,released=false
                             RETURNING profile,client_id,agent,lease_id,generation,
                               to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS expires_at,released",
                            &[&id, &profile.name, &client_id, &agent, &lease_id, &(ttl_sec as i32)],
                        )
                        .await
                        .map_err(db_unavailable)?;
                    lease_from_row(row)?
                };
                transaction
                    .execute(
                        "INSERT INTO hc_fleet_bindings (coordinator,client_id,agent,route,profile,lease_id)
                         VALUES ($1,$2,$3,$4,$5,$6)
                         ON CONFLICT (coordinator,client_id,agent,route) DO NOTHING",
                        &[&id, &client_id, &agent, &route, &lease.profile, &lease.lease_id],
                    )
                    .await
                    .map_err(db_unavailable)?;
                Ok(lease)
            }.await;
            finish(transaction, result).await
        };
        discard_lost_leader(&mut leader);
        result
    }

    /// Gets the database-clock deadline before asking a worker to renew its matching fence.
    ///
    /// The ordering prevents a slow worker request from leaving PostgreSQL authoritative longer
    /// than the fence the worker accepted.
    pub async fn renewal_deadline(&self, ttl_sec: u32) -> Result<String, CoordinatorError> {
        let mut leader = self.leader_session().await?;
        let result = leader_client(&mut leader)?
            .query_one(
                "SELECT to_char((clock_timestamp()+$1::int*interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS deadline",
                &[&(ttl_sec as i32)],
            )
            .await
            .map_err(db_unavailable)
            .and_then(|row| row.try_get("deadline").map_err(|_| CoordinatorError::new(503, "coordinator_unavailable")));
        discard_lost_leader(&mut leader);
        result
    }

    /// Extends a worker-confirmed current lease to its precomputed database-clock deadline.
    pub async fn renew(
        &self,
        lease: &CoordinatorLease,
        confirmed_deadline: &str,
    ) -> Result<(), CoordinatorError> {
        let id = self.id.as_ref();
        let mut leader = self.leader_session().await?;
        let result = async {
            let updated = leader_client(&mut leader)?
                .execute(
                    "UPDATE hc_fleet_leases SET expires_at=GREATEST(expires_at,$5::text::timestamptz)
                     WHERE coordinator=$1 AND profile=$2 AND lease_id=$3 AND generation=$4
                       AND released=false AND expires_at>now()",
                    &[&id, &lease.profile, &lease.lease_id, &lease.generation, &confirmed_deadline],
                )
                .await
                .map_err(db_unavailable)?;
            if updated != 1 {
                return Err(CoordinatorError::new(409, "stale_lease"));
            }
            Ok(())
        }
        .await;
        discard_lost_leader(&mut leader);
        result
    }

    /// Releases a lease only when its full identity still matches the durable fence.
    pub async fn release(&self, lease: &CoordinatorLease) -> Result<(), CoordinatorError> {
        let id = self.id.as_ref();
        let mut leader = self.leader_session().await?;
        let result = async {
            leader_client(&mut leader)?
                .execute(
                    "WITH cleared AS (DELETE FROM hc_fleet_bindings WHERE coordinator=$1 AND lease_id=$3 RETURNING 1)
                     UPDATE hc_fleet_leases SET released=true,expires_at=now()
                     WHERE coordinator=$1 AND profile=$2 AND lease_id=$3 AND generation=$4",
                    &[&id, &lease.profile, &lease.lease_id, &lease.generation],
                )
                .await
                .map_err(db_unavailable)?;
            Ok(())
        }
        .await;
        discard_lost_leader(&mut leader);
        result
    }

    /// Clears all route bindings for an explicit client-agent teardown.
    pub async fn clear_bindings(
        &self,
        client_id: &str,
        agent: &str,
    ) -> Result<(), CoordinatorError> {
        let id = self.id.as_ref();
        let mut leader = self.leader_session().await?;
        let result = async {
            leader_client(&mut leader)?
                .execute(
                    "DELETE FROM hc_fleet_bindings WHERE coordinator=$1 AND client_id=$2 AND agent=$3",
                    &[&id, &client_id, &agent],
                )
                .await
                .map_err(db_unavailable)?;
            Ok(())
        }
        .await;
        discard_lost_leader(&mut leader);
        result
    }

    async fn leader_session(&self) -> Result<MutexGuard<'_, Option<Leader>>, CoordinatorError> {
        let mut leader = self.leader.lock().await;
        if !leader_is_live(&leader) {
            leader.take();
            return Err(CoordinatorError::new(503, "coordinator_unavailable"));
        }
        Ok(leader)
    }

    async fn connector(&self) -> Result<&connection::Connector, CoordinatorError> {
        self.connector
            .get_or_try_init(|| connection::Connector::new(&self.database_url))
            .await
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))
    }
}

fn leader_is_live(leader: &Option<Leader>) -> bool {
    leader
        .as_ref()
        .is_some_and(|leader| !leader.client.is_closed() && !leader.connection.is_finished())
}

fn discard_lost_leader(leader: &mut Option<Leader>) {
    if !leader_is_live(leader) {
        leader.take();
    }
}

fn leader_client(leader: &mut Option<Leader>) -> Result<&mut Client, CoordinatorError> {
    leader
        .as_mut()
        .map(|leader| &mut leader.client)
        .ok_or_else(|| CoordinatorError::new(503, "coordinator_unavailable"))
}

async fn finish<T>(
    transaction: tokio_postgres::Transaction<'_>,
    result: Result<T, CoordinatorError>,
) -> Result<T, CoordinatorError> {
    match result {
        Ok(value) => {
            transaction.commit().await.map_err(db_unavailable)?;
            Ok(value)
        }
        Err(error) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
    }
}

fn profile_from_row(row: Row) -> Result<CoordinatorProfile, CoordinatorError> {
    let name: String = row
        .try_get("profile")
        .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
    let worker: String = row
        .try_get("worker")
        .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
    let snapshot: String = row
        .try_get("snapshot")
        .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
    let snapshot: ProfileSnapshot = serde_json::from_str(&snapshot)
        .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
    let mut inventory = WorkerInventory {
        id: worker,
        profiles: vec![snapshot],
    }
    .validate()
    .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
    let worker = inventory.id;
    let snapshot = inventory
        .profiles
        .pop()
        .expect("one profile was supplied for legacy-row validation");
    let profile = snapshot.name.clone();
    let available = row
        .try_get("available")
        .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
    Ok(CoordinatorProfile {
        name,
        worker,
        profile,
        snapshot,
        available,
    })
}

fn lease_from_row(row: Row) -> Result<CoordinatorLease, CoordinatorError> {
    // PostgreSQL permits bigint values JavaScript cannot represent exactly.
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

    let generation: i64 = row
        .try_get("generation")
        .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?;
    if !(1..=MAX_SAFE_INTEGER).contains(&generation) {
        return Err(CoordinatorError::new(503, "coordinator_unavailable"));
    }
    Ok(CoordinatorLease {
        profile: row
            .try_get("profile")
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?,
        client: row
            .try_get("client_id")
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?,
        agent: row
            .try_get("agent")
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?,
        lease_id: row
            .try_get("lease_id")
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?,
        generation,
        expires_at: row
            .try_get("expires_at")
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?,
        released: row
            .try_get("released")
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?,
    })
}

fn db_unavailable(_: tokio_postgres::Error) -> CoordinatorError {
    CoordinatorError::new(503, "coordinator_unavailable")
}
