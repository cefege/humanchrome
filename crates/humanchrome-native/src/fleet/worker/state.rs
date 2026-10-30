//! SQLite-backed lease fences that survive worker restarts.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

/// Coordinator identity that is allowed to operate one profile.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseIdentity {
    /// Owning coordinator agent.
    pub agent: String,
    /// Unique coordinator-issued lease identifier.
    pub lease_id: String,
    /// Monotonically increasing coordinator generation.
    pub generation: u64,
}

/// A lease identity with its durable expiry timestamp in Unix milliseconds.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerLease {
    /// Owning coordinator agent.
    pub agent: String,
    /// Unique coordinator-issued lease identifier.
    pub lease_id: String,
    /// Monotonically increasing coordinator generation.
    pub generation: u64,
    /// Lease expiry timestamp in Unix milliseconds.
    pub expires_at: i64,
}

/// A worker-state rejection with its wire-stable error code and HTTP status.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct WorkerStateError {
    /// Machine-readable response code.
    pub code: &'static str,
    /// HTTP status used by the worker API.
    pub status: u16,
    /// Human-readable diagnostic.
    pub message: &'static str,
}

impl WorkerStateError {
    fn stale(message: &'static str) -> Self {
        Self {
            code: "stale_lease",
            status: 409,
            message,
        }
    }

    fn conflict(message: &'static str) -> Self {
        Self {
            code: "lease_conflict",
            status: 409,
            message,
        }
    }

    fn busy(message: &'static str) -> Self {
        Self {
            code: "profile_busy",
            status: 409,
            message,
        }
    }

    fn uncertain() -> Self {
        Self {
            code: "outcome_unknown",
            status: 409,
            message: "profile has an unresolved browser request",
        }
    }
}

/// Failures while opening or maintaining the durable fence store.
#[derive(Debug, thiserror::Error)]
pub enum WorkerStateStorageError {
    /// SQLite rejected a fence operation.
    #[error("worker fence storage failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The blocking storage task did not complete.
    #[error("worker fence storage task failed: {0}")]
    BlockingTask(tokio::task::JoinError),
    /// The system clock predates the Unix epoch.
    #[error("system clock is before the Unix epoch")]
    Clock,
}

#[derive(Debug)]
struct Inner {
    connection: Connection,
    active: HashMap<String, usize>,
    transitions: HashSet<String>,
}

/// Durable fencing authority for browser-profile access.
#[derive(Clone)]
pub struct WorkerState {
    inner: Arc<Mutex<Inner>>,
    now: Arc<dyn Fn() -> Result<i64, WorkerStateStorageError> + Send + Sync>,
}

impl std::fmt::Debug for WorkerState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerState")
            .finish_non_exhaustive()
    }
}

/// A one-shot guard over a proxied browser request.
#[derive(Clone, Debug)]
pub struct WorkerExecution {
    state: WorkerState,
    profile: String,
    identity: LeaseIdentity,
    durable: bool,
    flags: Arc<Mutex<ExecutionFlags>>,
}

#[derive(Debug, Default)]
struct ExecutionFlags {
    client_closed: bool,
    complete: bool,
}

impl WorkerExecution {
    /// Release only the in-memory connection guard when a downstream client disconnects.
    ///
    /// A mutating request keeps its durable uncertainty marker until [`Self::complete`].
    pub fn client_closed(&self) -> Result<(), WorkerStateStorageError> {
        let needs_decrement = {
            let mut flags = self
                .flags
                .lock()
                .expect("worker execution flags lock poisoned");
            if flags.client_closed {
                false
            } else {
                flags.client_closed = true;
                true
            }
        };
        if needs_decrement {
            self.state.decrement_active(&self.profile)?;
        }
        Ok(())
    }

    /// Confirm that the upstream browser response completed successfully.
    pub fn complete(&self) -> Result<(), WorkerStateStorageError> {
        let (needs_decrement, needs_durable_clear) = {
            let mut flags = self
                .flags
                .lock()
                .expect("worker execution flags lock poisoned");
            if flags.complete {
                (false, false)
            } else {
                flags.complete = true;
                let needs_decrement = !flags.client_closed;
                flags.client_closed = true;
                (needs_decrement, self.durable)
            }
        };
        if needs_decrement {
            self.state.decrement_active(&self.profile)?;
        }
        if needs_durable_clear {
            self.state
                .decrement_durable(&self.profile, &self.identity)?;
        }
        Ok(())
    }
}

/// Owns async request admission, including cancellation before the caller receives its guard.
#[derive(Debug)]
pub struct AsyncWorkerExecution {
    inner: Option<WorkerExecution>,
}

impl AsyncWorkerExecution {
    /// Releases connection accounting without clearing a mutation's durable uncertainty.
    pub async fn client_closed_async(mut self) -> Result<(), WorkerStateStorageError> {
        let execution = self.inner.take().expect("async execution is present");
        tokio::task::spawn_blocking(move || execution.client_closed())
            .await
            .map_err(WorkerStateStorageError::BlockingTask)?
    }

    /// Confirms a complete upstream response only after its durable completion write succeeds.
    pub async fn complete_async(mut self) -> Result<(), WorkerStateStorageError> {
        let execution = self.inner.take().expect("async execution is present");
        tokio::task::spawn_blocking(move || execution.complete())
            .await
            .map_err(WorkerStateStorageError::BlockingTask)?
    }
}

impl Drop for AsyncWorkerExecution {
    fn drop(&mut self) {
        if let Some(execution) = self.inner.take() {
            schedule_cleanup(
                "worker execution disconnect fence update failed",
                move || execution.client_closed(),
            );
        }
    }
}

/// Reserved handoff of an expired profile lane.
#[derive(Debug)]
pub struct HandoffReservation {
    /// Lease whose browser lane must be released before replacement is claimed.
    pub prior: WorkerLease,
    state: WorkerState,
    profile: String,
    released: bool,
}

impl HandoffReservation {
    /// Release the in-memory transition reservation. This is idempotent.
    pub fn release(mut self) -> Result<(), WorkerStateStorageError> {
        if !self.released {
            self.state.finish_transition(&self.profile)?;
            self.released = true;
        }
        Ok(())
    }
}

impl Drop for HandoffReservation {
    fn drop(&mut self) {
        if !self.released {
            if let Err(error) = self.state.finish_transition(&self.profile) {
                tracing::error!(%error, profile = %self.profile, "worker handoff reservation cleanup failed");
            }
            self.released = true;
        }
    }
}

/// Guard that excludes a profile lifecycle transition.
#[derive(Debug)]
pub struct TransitionGuard {
    state: WorkerState,
    profile: String,
    finished: bool,
}

impl TransitionGuard {
    /// End the transition. This is idempotent.
    pub fn finish(mut self) -> Result<(), WorkerStateStorageError> {
        if !self.finished {
            self.state.finish_transition(&self.profile)?;
            self.finished = true;
        }
        Ok(())
    }
}

impl Drop for TransitionGuard {
    fn drop(&mut self) {
        if !self.finished {
            if let Err(error) = self.state.finish_transition(&self.profile) {
                tracing::error!(%error, profile = %self.profile, "worker transition cleanup failed");
            }
            self.finished = true;
        }
    }
}
/// Async handoff reservation whose cleanup never waits for SQLite on a runtime worker.
#[derive(Debug)]
pub struct AsyncHandoffReservation {
    /// Lease whose browser lane must be released before replacement is claimed.
    pub prior: WorkerLease,
    inner: Option<HandoffReservation>,
}

impl AsyncHandoffReservation {
    /// Release the transition reservation on the blocking storage executor.
    pub async fn release(mut self) -> Result<(), WorkerStateStorageError> {
        let reservation = self
            .inner
            .take()
            .expect("async handoff reservation is present");
        tokio::task::spawn_blocking(move || reservation.release())
            .await
            .map_err(WorkerStateStorageError::BlockingTask)?
    }
}

impl Drop for AsyncHandoffReservation {
    fn drop(&mut self) {
        if let Some(reservation) = self.inner.take() {
            schedule_cleanup("worker handoff reservation cleanup failed", move || {
                reservation.release()
            });
        }
    }
}

/// Async lifecycle guard whose cleanup never waits for SQLite on a runtime worker.
#[derive(Debug)]
pub struct AsyncTransitionGuard {
    inner: Option<TransitionGuard>,
}

impl AsyncTransitionGuard {
    /// End the transition on the blocking storage executor.
    pub async fn finish(mut self) -> Result<(), WorkerStateStorageError> {
        let guard = self
            .inner
            .take()
            .expect("async transition guard is present");
        tokio::task::spawn_blocking(move || guard.finish())
            .await
            .map_err(WorkerStateStorageError::BlockingTask)?
    }
}

impl Drop for AsyncTransitionGuard {
    fn drop(&mut self) {
        if let Some(guard) = self.inner.take() {
            schedule_cleanup("worker transition cleanup failed", move || guard.finish());
        }
    }
}

fn schedule_cleanup(
    message: &'static str,
    cleanup: impl FnOnce() -> Result<(), WorkerStateStorageError> + Send + 'static,
) {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            // Dropping the join handle intentionally detaches cleanup from a destructor.
            std::mem::drop(handle.spawn_blocking(move || {
                if let Err(error) = cleanup() {
                    tracing::error!(%error, "{message}");
                }
            }));
        }
        Err(_) => {
            // Guards may outlive their Tokio runtime. Keep cleanup off the dropping thread
            // without leaking the state/connection or clearing durable mutation uncertainty.
            std::mem::drop(std::thread::spawn(move || {
                if let Err(error) = cleanup() {
                    tracing::error!(%error, "{message}");
                }
            }));
        }
    }
}

impl WorkerState {
    async fn blocking_storage<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, WorkerStateStorageError> + Send + 'static,
    ) -> Result<T, WorkerStateStorageError> {
        tokio::task::spawn_blocking(operation)
            .await
            .map_err(WorkerStateStorageError::BlockingTask)?
    }

    async fn blocking_state<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, WorkerStateError> + Send + 'static,
    ) -> Result<T, WorkerStateError> {
        tokio::task::spawn_blocking(operation)
            .await
            .map_err(|error| storage_as_state(WorkerStateStorageError::BlockingTask(error)))?
    }

    /// Open the durable fence store without blocking the async runtime.
    pub async fn open_async(path: impl AsRef<Path>) -> Result<Self, WorkerStateStorageError> {
        let path = path.as_ref().to_path_buf();
        tokio::task::spawn_blocking(move || Self::open(path))
            .await
            .map_err(WorkerStateStorageError::BlockingTask)?
    }

    /// Read the current unexpired lease without blocking the async runtime.
    pub async fn lease_for_async(
        &self,
        profile: impl Into<String>,
    ) -> Result<Option<WorkerLease>, WorkerStateStorageError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_storage(move || state.lease_for(&profile))
            .await
    }

    /// Read the expired handoff candidate without blocking the async runtime.
    pub async fn expired_lease_for_async(
        &self,
        profile: impl Into<String>,
    ) -> Result<Option<WorkerLease>, WorkerStateStorageError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_storage(move || state.expired_lease_for(&profile))
            .await
    }

    /// Read the last durable lease record without blocking the async runtime.
    pub async fn recorded_lease_for_async(
        &self,
        profile: impl Into<String>,
    ) -> Result<Option<WorkerLease>, WorkerStateStorageError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_storage(move || state.recorded_lease_for(&profile))
            .await
    }

    /// Read the current owning agent without blocking the async runtime.
    pub async fn leased_by_async(
        &self,
        profile: impl Into<String>,
    ) -> Result<Option<String>, WorkerStateStorageError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_storage(move || state.leased_by(&profile))
            .await
    }

    /// Check for any live durable lease without blocking the async runtime.
    pub async fn has_live_leases_async(&self) -> Result<bool, WorkerStateStorageError> {
        let state = self.clone();
        self.blocking_storage(move || state.has_live_leases()).await
    }

    /// Check for durable or in-memory work without blocking the async runtime.
    pub async fn has_active_work_async(&self) -> Result<bool, WorkerStateStorageError> {
        let state = self.clone();
        self.blocking_storage(move || state.has_active_work()).await
    }

    /// Claim or renew a lease without blocking the async runtime.
    pub async fn claim_async(
        &self,
        profile: impl Into<String>,
        identity: LeaseIdentity,
        ttl_seconds: u64,
    ) -> Result<WorkerLease, WorkerStateError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_state(move || state.claim(&profile, &identity, ttl_seconds))
            .await
    }

    /// Reserve an expired lane handoff without blocking the async runtime.
    pub async fn reserve_handoff_async(
        &self,
        profile: impl Into<String>,
        identity: LeaseIdentity,
    ) -> Result<Option<AsyncHandoffReservation>, WorkerStateError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_state(move || {
            state
                .reserve_handoff(&profile, &identity)
                .map(|reservation| {
                    reservation.map(|inner| AsyncHandoffReservation {
                        prior: inner.prior.clone(),
                        inner: Some(inner),
                    })
                })
        })
        .await
    }

    /// Begin a mutating browser request without blocking the async runtime.
    pub async fn begin_execution_async(
        &self,
        profile: impl Into<String>,
        identity: LeaseIdentity,
    ) -> Result<AsyncWorkerExecution, WorkerStateError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_state(move || {
            state
                .begin_execution(&profile, &identity)
                .map(|inner| AsyncWorkerExecution { inner: Some(inner) })
        })
        .await
    }

    /// Begin a read-only browser request without blocking the async runtime.
    pub async fn begin_read_async(
        &self,
        profile: impl Into<String>,
        identity: LeaseIdentity,
    ) -> Result<AsyncWorkerExecution, WorkerStateError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_state(move || {
            state
                .begin_read(&profile, &identity)
                .map(|inner| AsyncWorkerExecution { inner: Some(inner) })
        })
        .await
    }

    /// Begin a lifecycle transition without blocking the async runtime.
    pub async fn begin_transition_async(
        &self,
        profile: impl Into<String>,
        identity: LeaseIdentity,
        allow_uncertain_recovery: bool,
    ) -> Result<AsyncTransitionGuard, WorkerStateError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_state(move || {
            state
                .begin_transition(&profile, &identity, allow_uncertain_recovery)
                .map(|inner| AsyncTransitionGuard { inner: Some(inner) })
        })
        .await
    }

    /// Begin explicit recovery without blocking the async runtime.
    pub async fn begin_recovery_async(
        &self,
        profile: impl Into<String>,
    ) -> Result<AsyncTransitionGuard, WorkerStateError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_state(move || {
            state
                .begin_recovery(&profile)
                .map(|inner| AsyncTransitionGuard { inner: Some(inner) })
        })
        .await
    }

    /// Clear durable uncertainty after restart without blocking the async runtime.
    pub async fn clear_uncertain_after_restart_async(
        &self,
        profile: impl Into<String>,
        identity: LeaseIdentity,
    ) -> Result<(), WorkerStateError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_state(move || state.clear_uncertain_after_restart(&profile, &identity))
            .await
    }

    /// Clear durable uncertainty after administrator recovery without blocking the runtime.
    pub async fn clear_uncertain_after_recovery_async(
        &self,
        profile: impl Into<String>,
    ) -> Result<(), WorkerStateStorageError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_storage(move || state.clear_uncertain_after_recovery(&profile))
            .await
    }

    /// Release a lease without blocking the async runtime.
    pub async fn release_async(
        &self,
        profile: impl Into<String>,
        identity: LeaseIdentity,
    ) -> Result<(), WorkerStateError> {
        let state = self.clone();
        let profile = profile.into();
        self.blocking_state(move || state.release(&profile, &identity))
            .await
    }

    /// Open or create a durable fence database at `path`.
    ///
    /// # Errors
    /// Returns a SQLite or clock error and never changes profile state if initialization fails.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, WorkerStateStorageError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection, system_now_millis)
    }

    /// Create an isolated in-memory fence database.
    ///
    /// This exists for tests and must not be used for a real worker process.
    pub fn in_memory() -> Result<Self, WorkerStateStorageError> {
        Self::from_connection(Connection::open_in_memory()?, system_now_millis)
    }

    /// Create a state store with a deterministic clock for behavioral tests.
    ///
    /// # Errors
    /// Returns an initialization error from SQLite.
    pub fn with_clock(
        connection: Connection,
        now: impl Fn() -> Result<i64, WorkerStateStorageError> + Send + Sync + 'static,
    ) -> Result<Self, WorkerStateStorageError> {
        Self::from_connection(connection, now)
    }

    fn from_connection(
        connection: Connection,
        now: impl Fn() -> Result<i64, WorkerStateStorageError> + Send + Sync + 'static,
    ) -> Result<Self, WorkerStateStorageError> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS worker_fences (
                profile TEXT PRIMARY KEY NOT NULL,
                generation INTEGER NOT NULL,
                lease_id TEXT,
                agent TEXT,
                expires_at INTEGER,
                released INTEGER NOT NULL DEFAULT 0,
                in_flight INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        if let Err(error) = connection.execute(
            "ALTER TABLE worker_fences ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 0",
            [],
        ) {
            let duplicate_column = matches!(
                &error,
                rusqlite::Error::SqliteFailure(_, Some(message))
                    if message.as_str() == "duplicate column name: in_flight"
            );
            if !duplicate_column {
                return Err(error.into());
            }
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                connection,
                active: HashMap::new(),
                transitions: HashSet::new(),
            })),
            now: Arc::new(now),
        })
    }

    /// Return the unexpired lease currently owning `profile`.
    pub fn lease_for(&self, profile: &str) -> Result<Option<WorkerLease>, WorkerStateStorageError> {
        let now = self.now()?;
        let inner = self.inner.lock().expect("worker state lock poisoned");
        Ok(row(&inner.connection, profile)?
            .filter(|lease| !lease.released && lease.expires_at > now)
            .map(LeaseRow::into_lease))
    }

    /// Return the expired but unreleased identity that may be handed off.
    pub fn expired_lease_for(
        &self,
        profile: &str,
    ) -> Result<Option<WorkerLease>, WorkerStateStorageError> {
        let now = self.now()?;
        let inner = self.inner.lock().expect("worker state lock poisoned");
        Ok(row(&inner.connection, profile)?
            .filter(|lease| !lease.released && lease.expires_at <= now)
            .map(LeaseRow::into_lease))
    }

    /// Return the last durable identity, including a released or expired tombstone.
    pub fn recorded_lease_for(
        &self,
        profile: &str,
    ) -> Result<Option<WorkerLease>, WorkerStateStorageError> {
        let inner = self.inner.lock().expect("worker state lock poisoned");
        Ok(row(&inner.connection, profile)?.map(LeaseRow::into_lease))
    }

    /// Return the agent holding a live lease, if any.
    pub fn leased_by(&self, profile: &str) -> Result<Option<String>, WorkerStateStorageError> {
        Ok(self.lease_for(profile)?.map(|lease| lease.agent))
    }

    /// Whether any profile has a live lease.
    pub fn has_live_leases(&self) -> Result<bool, WorkerStateStorageError> {
        let now = self.now()?;
        let inner = self.inner.lock().expect("worker state lock poisoned");
        let live = inner
            .connection
            .query_row(
                "SELECT 1 FROM worker_fences WHERE released = 0 AND expires_at > ? LIMIT 1",
                [now],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        Ok(live)
    }

    /// Whether any profile has a durable uncertain outcome or active connection/transition.
    pub fn has_active_work(&self) -> Result<bool, WorkerStateStorageError> {
        let inner = self.inner.lock().expect("worker state lock poisoned");
        let durable = inner
            .connection
            .query_row(
                "SELECT 1 FROM worker_fences WHERE in_flight > 0 LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        Ok(durable
            || inner.active.values().any(|count| *count > 0)
            || !inner.transitions.is_empty())
    }

    /// Record a coordinator-issued lease fence.
    ///
    /// Equal generations only renew a still-live matching identity. Released and expired
    /// records are tombstones, so an old coordinator can never revive access.
    pub fn claim(
        &self,
        profile: &str,
        identity: &LeaseIdentity,
        ttl_seconds: u64,
    ) -> Result<WorkerLease, WorkerStateError> {
        let now = self.now().map_err(storage_as_state)?;
        let ttl_ms = i64::try_from(ttl_seconds)
            .ok()
            .and_then(|seconds| seconds.checked_mul(1_000))
            .ok_or_else(|| WorkerStateError::conflict("lease expiry overflows timestamp range"))?;
        let expires_at = now
            .checked_add(ttl_ms)
            .ok_or_else(|| WorkerStateError::conflict("lease expiry overflows timestamp range"))?;
        let mut inner = self.inner.lock().expect("worker state lock poisoned");
        let active = inner.active.get(profile).copied().unwrap_or_default();
        let transitioning = inner.transitions.contains(profile);
        let transaction = inner
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_as_state)?;
        let previous = row(&transaction, profile).map_err(storage_as_state)?;
        if let Some(previous) = previous {
            if identity.generation < previous.generation {
                return Err(WorkerStateError::stale(
                    "lease generation is below the durable fence",
                ));
            }
            if identity.generation == previous.generation {
                if previous.lease_id != identity.lease_id
                    || previous.agent != identity.agent
                    || previous.released
                    || previous.expires_at <= now
                {
                    return Err(WorkerStateError::stale(
                        "lease identity is stale or cannot be revived",
                    ));
                }
                transaction
                    .execute(
                        "UPDATE worker_fences SET expires_at = ? WHERE profile = ?",
                        params![expires_at, profile],
                    )
                    .map_err(storage_as_state)?;
                transaction.commit().map_err(storage_as_state)?;
                return Ok(WorkerLease {
                    agent: identity.agent.clone(),
                    lease_id: identity.lease_id.clone(),
                    generation: identity.generation,
                    expires_at,
                });
            }
            if (!previous.released && previous.expires_at > now)
                || previous.in_flight > 0
                || active > 0
                || transitioning
            {
                return Err(WorkerStateError::conflict(
                    "profile has a live lease or active operation",
                ));
            }
        }
        transaction.execute(
            "INSERT INTO worker_fences (profile, generation, lease_id, agent, expires_at, released, in_flight)
             VALUES (?, ?, ?, ?, ?, 0, 0)
             ON CONFLICT(profile) DO UPDATE SET generation = excluded.generation, lease_id = excluded.lease_id,
             agent = excluded.agent, expires_at = excluded.expires_at, released = 0, in_flight = 0",
            params![profile, identity.generation, identity.lease_id, identity.agent, expires_at],
        ).map_err(storage_as_state)?;
        transaction.commit().map_err(storage_as_state)?;
        Ok(WorkerLease {
            agent: identity.agent.clone(),
            lease_id: identity.lease_id.clone(),
            generation: identity.generation,
            expires_at,
        })
    }

    /// Reserve a higher-generation handoff before its old bridge lane is released.
    pub fn reserve_handoff(
        &self,
        profile: &str,
        identity: &LeaseIdentity,
    ) -> Result<Option<HandoffReservation>, WorkerStateError> {
        let now = self.now().map_err(storage_as_state)?;
        let mut inner = self.inner.lock().expect("worker state lock poisoned");
        let Some(previous) = row(&inner.connection, profile).map_err(storage_as_state)? else {
            return Ok(None);
        };
        if previous.released
            || previous.expires_at > now
            || identity.generation <= previous.generation
        {
            return Ok(None);
        }
        if previous.in_flight > 0
            || inner.active.get(profile).copied().unwrap_or_default() > 0
            || inner.transitions.contains(profile)
        {
            return Err(WorkerStateError::conflict(
                "profile has an active operation",
            ));
        }
        inner.transitions.insert(profile.to_owned());
        Ok(Some(HandoffReservation {
            prior: previous.into_lease(),
            state: self.clone(),
            profile: profile.to_owned(),
            released: false,
        }))
    }

    /// Begin a mutating browser request and durably quarantine its outcome.
    pub fn begin_execution(
        &self,
        profile: &str,
        identity: &LeaseIdentity,
    ) -> Result<WorkerExecution, WorkerStateError> {
        self.begin(profile, identity, true)
    }

    /// Begin a read-only browser stream without durable uncertainty quarantine.
    pub fn begin_read(
        &self,
        profile: &str,
        identity: &LeaseIdentity,
    ) -> Result<WorkerExecution, WorkerStateError> {
        self.begin(profile, identity, false)
    }

    fn begin(
        &self,
        profile: &str,
        identity: &LeaseIdentity,
        durable: bool,
    ) -> Result<WorkerExecution, WorkerStateError> {
        let now = self.now().map_err(storage_as_state)?;
        let mut inner = self.inner.lock().expect("worker state lock poisoned");
        assert_current(&inner.connection, profile, identity, now)?;
        let current = row(&inner.connection, profile).map_err(storage_as_state)?;
        if inner.transitions.contains(profile) || current.is_some_and(|lease| lease.in_flight > 0) {
            return Err(WorkerStateError::uncertain());
        }
        if durable {
            inner
                .connection
                .execute(
                    "UPDATE worker_fences SET in_flight = in_flight + 1 WHERE profile = ?",
                    [profile],
                )
                .map_err(storage_as_state)?;
        }
        *inner.active.entry(profile.to_owned()).or_default() += 1;
        Ok(WorkerExecution {
            state: self.clone(),
            profile: profile.to_owned(),
            identity: identity.clone(),
            durable,
            flags: Arc::new(Mutex::new(ExecutionFlags::default())),
        })
    }

    /// Permit one lifecycle action for the current lease.
    pub fn begin_transition(
        &self,
        profile: &str,
        identity: &LeaseIdentity,
        allow_uncertain_recovery: bool,
    ) -> Result<TransitionGuard, WorkerStateError> {
        let now = self.now().map_err(storage_as_state)?;
        let mut inner = self.inner.lock().expect("worker state lock poisoned");
        assert_current(&inner.connection, profile, identity, now)?;
        let current = row(&inner.connection, profile).map_err(storage_as_state)?;
        if inner.active.get(profile).copied().unwrap_or_default() > 0
            || inner.transitions.contains(profile)
            || (!allow_uncertain_recovery && current.is_some_and(|lease| lease.in_flight > 0))
        {
            return Err(WorkerStateError::busy(
                "profile has an active request or transition",
            ));
        }
        inner.transitions.insert(profile.to_owned());
        Ok(TransitionGuard {
            state: self.clone(),
            profile: profile.to_owned(),
            finished: false,
        })
    }

    /// Begin explicit administrator recovery after any live lease has expired.
    pub fn begin_recovery(&self, profile: &str) -> Result<TransitionGuard, WorkerStateError> {
        let now = self.now().map_err(storage_as_state)?;
        let mut inner = self.inner.lock().expect("worker state lock poisoned");
        let current = row(&inner.connection, profile).map_err(storage_as_state)?;
        if current.is_some_and(|lease| !lease.released && lease.expires_at > now)
            || inner.active.get(profile).copied().unwrap_or_default() > 0
            || inner.transitions.contains(profile)
        {
            return Err(WorkerStateError::busy(
                "profile has a live lease or active connection",
            ));
        }
        inner.transitions.insert(profile.to_owned());
        Ok(TransitionGuard {
            state: self.clone(),
            profile: profile.to_owned(),
            finished: false,
        })
    }

    /// Clear durable uncertainty after a successful owning-lease restart.
    pub fn clear_uncertain_after_restart(
        &self,
        profile: &str,
        identity: &LeaseIdentity,
    ) -> Result<(), WorkerStateError> {
        let now = self.now().map_err(storage_as_state)?;
        let inner = self.inner.lock().expect("worker state lock poisoned");
        assert_current(&inner.connection, profile, identity, now)?;
        inner
            .connection
            .execute(
                "UPDATE worker_fences SET in_flight = 0 WHERE profile = ?",
                [profile],
            )
            .map_err(storage_as_state)?;
        Ok(())
    }

    /// Clear durable uncertainty after successful administrator recovery.
    pub fn clear_uncertain_after_recovery(
        &self,
        profile: &str,
    ) -> Result<(), WorkerStateStorageError> {
        let inner = self.inner.lock().expect("worker state lock poisoned");
        inner.connection.execute(
            "UPDATE worker_fences SET in_flight = 0 WHERE profile = ?",
            [profile],
        )?;
        Ok(())
    }

    /// Release a lease only when it has no open browser work or lifecycle transition.
    pub fn release(&self, profile: &str, identity: &LeaseIdentity) -> Result<(), WorkerStateError> {
        let now = self.now().map_err(storage_as_state)?;
        let inner = self.inner.lock().expect("worker state lock poisoned");
        assert_current(&inner.connection, profile, identity, now)?;
        let current = row(&inner.connection, profile).map_err(storage_as_state)?;
        if inner.active.get(profile).copied().unwrap_or_default() > 0
            || inner.transitions.contains(profile)
            || current.is_some_and(|lease| lease.in_flight > 0)
        {
            return Err(WorkerStateError::busy(
                "profile has an active request or transition",
            ));
        }
        inner
            .connection
            .execute(
                "UPDATE worker_fences SET released = 1 WHERE profile = ?",
                [profile],
            )
            .map_err(storage_as_state)?;
        Ok(())
    }

    fn decrement_active(&self, profile: &str) -> Result<(), WorkerStateStorageError> {
        let mut inner = self.inner.lock().expect("worker state lock poisoned");
        match inner.active.get_mut(profile) {
            Some(count) if *count > 1 => *count -= 1,
            Some(_) => {
                inner.active.remove(profile);
            }
            None => {}
        }
        Ok(())
    }

    fn decrement_durable(
        &self,
        profile: &str,
        identity: &LeaseIdentity,
    ) -> Result<(), WorkerStateStorageError> {
        let inner = self.inner.lock().expect("worker state lock poisoned");
        inner.connection.execute(
            "UPDATE worker_fences
             SET in_flight = CASE WHEN in_flight > 0 THEN in_flight - 1 ELSE 0 END
             WHERE profile = ? AND generation = ? AND lease_id = ? AND agent = ?",
            params![
                profile,
                identity.generation,
                identity.lease_id,
                identity.agent
            ],
        )?;
        Ok(())
    }

    fn finish_transition(&self, profile: &str) -> Result<(), WorkerStateStorageError> {
        let mut inner = self.inner.lock().expect("worker state lock poisoned");
        inner.transitions.remove(profile);
        Ok(())
    }

    fn now(&self) -> Result<i64, WorkerStateStorageError> {
        (self.now)()
    }
}

#[derive(Debug)]
struct LeaseRow {
    generation: u64,
    lease_id: String,
    agent: String,
    expires_at: i64,
    released: bool,
    in_flight: u64,
}

impl LeaseRow {
    fn into_lease(self) -> WorkerLease {
        WorkerLease {
            agent: self.agent,
            lease_id: self.lease_id,
            generation: self.generation,
            expires_at: self.expires_at,
        }
    }
}

fn row(connection: &Connection, profile: &str) -> Result<Option<LeaseRow>, rusqlite::Error> {
    connection.query_row(
        "SELECT generation, lease_id, agent, expires_at, released, in_flight FROM worker_fences WHERE profile = ?",
        [profile],
        |row| Ok(LeaseRow {
            generation: row.get(0)?,
            lease_id: row.get(1)?,
            agent: row.get(2)?,
            expires_at: row.get(3)?,
            released: row.get::<_, i64>(4)? != 0,
            in_flight: row.get(5)?,
        }),
    ).optional()
}

fn assert_current(
    connection: &Connection,
    profile: &str,
    identity: &LeaseIdentity,
    now: i64,
) -> Result<(), WorkerStateError> {
    let current = row(connection, profile).map_err(storage_as_state)?;
    let Some(current) = current else {
        return Err(WorkerStateError::stale("lease is released or expired"));
    };
    if current.released || current.expires_at <= now {
        return Err(WorkerStateError::stale("lease is released or expired"));
    }
    if current.generation != identity.generation
        || current.lease_id != identity.lease_id
        || current.agent != identity.agent
    {
        return Err(WorkerStateError::stale(
            "lease identity does not own this profile",
        ));
    }
    Ok(())
}

fn storage_as_state(error: impl Into<WorkerStateStorageError>) -> WorkerStateError {
    let error = error.into();
    tracing::error!(%error, "worker fence storage failed");
    WorkerStateError {
        code: "operation_failed",
        status: 422,
        message: "worker fence storage failed",
    }
}

fn system_now_millis() -> Result<i64, WorkerStateStorageError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorkerStateStorageError::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| WorkerStateStorageError::Clock)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;

    fn identity(generation: u64) -> LeaseIdentity {
        LeaseIdentity {
            agent: format!("agent-{generation}"),
            lease_id: format!("lease-{generation}"),
            generation,
        }
    }

    fn state(now: Arc<AtomicI64>) -> WorkerState {
        WorkerState::with_clock(
            Connection::open_in_memory().expect("open sqlite"),
            move || Ok(now.load(Ordering::Relaxed)),
        )
        .expect("initialize state")
    }

    #[test]
    fn durable_fence_rejects_stale_and_released_identities() {
        let now = Arc::new(AtomicI64::new(1_000));
        let state = state(now);
        let first = identity(1);
        state.claim("browser", &first, 15).expect("claim first");
        assert_eq!(
            state
                .claim("browser", &identity(0), 15)
                .expect_err("reject stale")
                .code,
            "stale_lease"
        );
        state.release("browser", &first).expect("release first");
        assert_eq!(
            state
                .claim("browser", &first, 15)
                .expect_err("reject revival")
                .code,
            "stale_lease"
        );
    }

    #[test]
    fn persisted_fence_survives_worker_restart() {
        let directory = tempfile::tempdir().expect("create temporary fence directory");
        let file = directory.path().join("fences.sqlite");
        let first = identity(1);
        {
            let state = WorkerState::open(&file).expect("open durable fence");
            state.claim("browser", &first, 60).expect("claim profile");
        }
        let restarted = WorkerState::open(&file).expect("reopen durable fence");
        assert_eq!(
            restarted.leased_by("browser").expect("read lease"),
            Some(first.agent)
        );
        assert_eq!(
            restarted
                .claim("browser", &identity(0), 60)
                .expect_err("reject stale generation")
                .code,
            "stale_lease"
        );
    }

    #[test]
    fn reopened_fence_keeps_uncertainty_until_explicit_recovery_then_rejects_stale_generation() {
        let directory = tempfile::tempdir().expect("create temporary fence directory");
        let file = directory.path().join("fences.sqlite");
        let now = Arc::new(AtomicI64::new(1_000));
        let first = identity(1);
        {
            let clock = now.clone();
            let state = WorkerState::with_clock(
                Connection::open(&file).expect("open durable fence"),
                move || Ok(clock.load(Ordering::Relaxed)),
            )
            .expect("initialize durable fence");
            state.claim("browser", &first, 15).expect("claim profile");
            state
                .begin_execution("browser", &first)
                .expect("begin mutation")
                .client_closed()
                .expect("record disconnected caller");
        }

        now.store(16_001, Ordering::Relaxed);
        let clock = now.clone();
        let restarted = WorkerState::with_clock(
            Connection::open(&file).expect("reopen durable fence"),
            move || Ok(clock.load(Ordering::Relaxed)),
        )
        .expect("reinitialize durable fence");
        let next = identity(2);
        assert_eq!(
            restarted
                .claim("browser", &next, 60)
                .expect_err("durable uncertainty blocks reassignment")
                .code,
            "lease_conflict"
        );

        let recovery = restarted
            .begin_recovery("browser")
            .expect("start explicit recovery");
        restarted
            .clear_uncertain_after_recovery("browser")
            .expect("clear only after recovery");
        recovery.finish().expect("finish recovery transition");
        assert_eq!(
            restarted
                .claim("browser", &first, 60)
                .expect_err("expired generation cannot be revived")
                .code,
            "stale_lease"
        );
        assert_eq!(
            restarted
                .claim("browser", &next, 60)
                .expect("claim higher generation")
                .generation,
            next.generation
        );
    }

    #[test]
    fn client_loss_quarantines_mutation_until_restart_recovery() {
        let now = Arc::new(AtomicI64::new(1_000));
        let state = state(now);
        let first = identity(1);
        state.claim("browser", &first, 15).expect("claim first");
        state
            .begin_execution("browser", &first)
            .expect("begin mutation")
            .client_closed()
            .expect("record disconnect");
        assert!(state.has_active_work().expect("inspect work"));
        assert_eq!(
            state
                .release("browser", &first)
                .expect_err("block release")
                .code,
            "profile_busy"
        );
        let transition = state
            .begin_transition("browser", &first, true)
            .expect("restart transition");
        state
            .clear_uncertain_after_restart("browser", &first)
            .expect("clear after restart");
        transition.finish().expect("finish transition");
        state
            .release("browser", &first)
            .expect("release after recovery");
    }

    #[test]
    fn read_disconnect_does_not_create_durable_uncertainty() {
        let now = Arc::new(AtomicI64::new(1_000));
        let state = state(now);
        let first = identity(1);
        state.claim("browser", &first, 15).expect("claim first");
        let read = state.begin_read("browser", &first).expect("begin read");
        read.client_closed().expect("close read");
        state
            .release("browser", &first)
            .expect("release after read");
    }

    #[test]
    fn old_mutation_completion_cannot_clear_a_replacement_lease_quarantine() {
        let now = Arc::new(AtomicI64::new(1_000));
        let state = state(now.clone());
        let first = identity(1);
        state.claim("browser", &first, 15).expect("claim first");
        let disconnected = state
            .begin_execution("browser", &first)
            .expect("begin first mutation");
        disconnected
            .client_closed()
            .expect("record disconnected caller");

        now.store(16_001, Ordering::Relaxed);
        let recovery = state
            .begin_recovery("browser")
            .expect("begin explicit recovery");
        state
            .clear_uncertain_after_recovery("browser")
            .expect("clear recovered uncertainty");
        recovery.finish().expect("finish recovery");

        let replacement = identity(2);
        state
            .claim("browser", &replacement, 15)
            .expect("claim replacement");
        let replacement_execution = state
            .begin_execution("browser", &replacement)
            .expect("begin replacement mutation");
        disconnected
            .complete()
            .expect("complete obsolete mutation after recovery");

        assert_eq!(
            state
                .begin_execution("browser", &replacement)
                .expect_err("replacement uncertainty remains fenced")
                .code,
            "outcome_unknown"
        );
        replacement_execution
            .client_closed()
            .expect("preserve replacement quarantine for test cleanup");
    }

    #[tokio::test]
    async fn async_execution_completion_clears_only_its_durable_quarantine() {
        let now = Arc::new(AtomicI64::new(1_000));
        let state = state(now);
        let first = identity(1);
        state
            .claim_async("browser", first.clone(), 15)
            .await
            .expect("claim through blocking executor");
        let execution = state
            .begin_execution_async("browser", first.clone())
            .await
            .expect("begin mutation through blocking executor");

        assert!(
            state
                .has_active_work_async()
                .await
                .expect("inspect durable uncertainty")
        );
        execution
            .complete_async()
            .await
            .expect("complete durable mutation through blocking executor");
        assert!(
            !state
                .has_active_work_async()
                .await
                .expect("completion clears durable uncertainty")
        );
        state
            .release_async("browser", first)
            .await
            .expect("release after completed mutation");
    }
}
