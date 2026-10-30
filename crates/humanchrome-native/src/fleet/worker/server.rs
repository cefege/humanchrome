//! Private bearer-authenticated fleet-worker HTTP routes and streaming browser proxy.

use std::{
    collections::HashMap,
    future::Future,
    net::IpAddr,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, Request, State},
    http::{HeaderMap, HeaderName, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post, put},
};
use bytes::Bytes;
use chrono::{SecondsFormat, Utc};
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::fs;
use uuid::{Uuid, Variant};

use super::state::{
    AsyncWorkerExecution, LeaseIdentity, WorkerLease, WorkerState, WorkerStateError,
    WorkerStateStorageError,
};

const MAX_SAFE_GENERATION: u64 = (1_u64 << 53) - 1;

use crate::fleet::{
    config::ConfigStore,
    runtime::{FleetProfile, FleetRuntimeConfig, LaunchConfig},
};

/// Heap-pinned future used by object-safe worker runtime interfaces.
pub type WorkerFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, SupervisorError>> + Send + 'a>>;

/// A profile's lifecycle state as exposed by the worker inventory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileState {
    /// No browser process is running.
    Stopped,
    /// Chrome process launch is in progress.
    Starting,
    /// Chrome is running but its bridge has not yet answered.
    Running,
    /// The profile-local bridge answered its health check.
    Healthy,
    /// A failed profile is waiting before retrying.
    Backoff,
    /// A configured remote profile did not answer.
    Unreachable,
}

/// Consumer-visible profile inventory returned by the worker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSnapshot {
    /// Allowed profile name.
    pub name: String,
    /// Local bridge port.
    pub port: u16,
    /// Operator labels.
    pub labels: Vec<String>,
    /// Whether the profile is enabled.
    pub enabled: bool,
    /// Optional assigned purpose.
    pub purpose: Option<String>,
    /// Current lifecycle state.
    pub state: ProfileState,
    /// Browser process ID, when known.
    pub pid: Option<u32>,
    /// Agent owning a live worker lease.
    pub leased_by: Option<String>,
    /// Last lifecycle error.
    pub last_error: Option<String>,
    /// Demand-start audit details.
    pub started_by: Option<Value>,
}

/// A real supervisor failure surfaced by the worker route.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct SupervisorError {
    /// Error detail safe to expose to the coordinator.
    pub message: String,
}

/// Adapter boundary for the real native fleet supervisor.
///
/// Implement this over the fleet runtime's `ProfileSupervisor`; production callers must
/// provide that adapter rather than a test substitute. The worker never owns Chrome itself.
pub trait WorkerSupervisor: Send + Sync + 'static {
    /// Return all locally known profiles.
    fn snapshot(&self) -> WorkerFuture<'_, Vec<ProfileSnapshot>>;
    /// Return the state of one profile.
    fn state(&self, name: String) -> WorkerFuture<'_, Option<ProfileState>>;
    /// Start one profile.
    fn start_profile(&self, name: String) -> WorkerFuture<'_, ()>;
    /// Stop one profile.
    fn stop_profile(&self, name: String) -> WorkerFuture<'_, ()>;
    /// Restart one profile.
    fn restart_profile(&self, name: String) -> WorkerFuture<'_, ()>;
    /// Demand-start a parked profile for the fenced lease lane.
    fn demand_start(&self, name: String, agent: String, request: String) -> WorkerFuture<'_, ()>;
    /// Reap demand-started profiles that have no live lease.
    fn reap_idle(&self, leased: Arc<dyn Fn(&str) -> bool + Send + Sync>) -> WorkerFuture<'_, ()>;
    /// Adopt an updated fleet runtime configuration after a profile or parking mutation.
    fn reload(&self, config: FleetRuntimeConfig) -> WorkerFuture<'_, ()>;
}

/// Concrete adapter from the native fleet runtime to the worker route boundary.
///
/// It delegates every browser lifecycle effect to the process-owning
/// [`crate::fleet::runtime::ProfileSupervisor`]; it never fabricates runtime state.
#[derive(Clone, Debug)]
pub struct NativeWorkerSupervisor {
    supervisor: crate::fleet::runtime::ProfileSupervisor,
}

impl NativeWorkerSupervisor {
    /// Wrap the process-owning native supervisor.
    #[must_use]
    pub fn new(supervisor: crate::fleet::runtime::ProfileSupervisor) -> Self {
        Self { supervisor }
    }

    /// Return the wrapped native runtime for lifecycle ownership by the caller.
    #[must_use]
    pub fn inner(&self) -> &crate::fleet::runtime::ProfileSupervisor {
        &self.supervisor
    }
}

impl WorkerSupervisor for NativeWorkerSupervisor {
    fn snapshot(&self) -> WorkerFuture<'_, Vec<ProfileSnapshot>> {
        Box::pin(async move {
            Ok(self
                .supervisor
                .snapshot_unleased()
                .await
                .into_iter()
                .map(native_snapshot)
                .collect())
        })
    }

    fn state(&self, name: String) -> WorkerFuture<'_, Option<ProfileState>> {
        Box::pin(async move {
            Ok(self
                .supervisor
                .snapshot_unleased()
                .await
                .into_iter()
                .find(|snapshot| snapshot.name == name)
                .map(|snapshot| native_state(snapshot.state)))
        })
    }

    fn start_profile(&self, name: String) -> WorkerFuture<'_, ()> {
        Box::pin(async move {
            self.supervisor
                .start_profile(&name)
                .await
                .map_err(supervisor_error)
        })
    }

    fn stop_profile(&self, name: String) -> WorkerFuture<'_, ()> {
        Box::pin(async move {
            self.supervisor
                .stop_profile(&name)
                .await
                .map_err(supervisor_error)
        })
    }

    fn restart_profile(&self, name: String) -> WorkerFuture<'_, ()> {
        Box::pin(async move {
            self.supervisor
                .restart_profile(&name)
                .await
                .map_err(supervisor_error)
        })
    }

    fn demand_start(&self, name: String, agent: String, request: String) -> WorkerFuture<'_, ()> {
        Box::pin(async move {
            let reason = crate::fleet::runtime::DemandReason {
                agent,
                session: None,
                operation: request,
                at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            };
            self.supervisor
                .demand_start(&name, reason)
                .await
                .map_err(supervisor_error)
        })
    }

    fn reap_idle(&self, leased: Arc<dyn Fn(&str) -> bool + Send + Sync>) -> WorkerFuture<'_, ()> {
        Box::pin(async move {
            self.supervisor
                .reap_idle(move |profile| leased(profile))
                .await;
            Ok(())
        })
    }

    fn reload(&self, config: FleetRuntimeConfig) -> WorkerFuture<'_, ()> {
        Box::pin(async move {
            self.supervisor
                .reload(config)
                .await
                .map_err(supervisor_error)
        })
    }
}

fn native_snapshot(snapshot: crate::fleet::runtime::ProfileSnapshot) -> ProfileSnapshot {
    ProfileSnapshot {
        name: snapshot.name,
        port: snapshot.port,
        labels: snapshot.labels,
        enabled: snapshot.enabled,
        purpose: snapshot.purpose,
        state: native_state(snapshot.state),
        pid: snapshot.pid,
        leased_by: snapshot.leased_by,
        last_error: snapshot.last_error,
        started_by: snapshot.started_by.map(|reason| {
            json!({
                "agent": reason.agent,
                "session": reason.session,
                "operation": reason.operation,
                "at": reason.at,
            })
        }),
    }
}

fn native_state(state: crate::fleet::runtime::ProfileState) -> ProfileState {
    match state {
        crate::fleet::runtime::ProfileState::Stopped => ProfileState::Stopped,
        crate::fleet::runtime::ProfileState::Starting => ProfileState::Starting,
        crate::fleet::runtime::ProfileState::Running => ProfileState::Running,
        crate::fleet::runtime::ProfileState::Healthy => ProfileState::Healthy,
        crate::fleet::runtime::ProfileState::Backoff => ProfileState::Backoff,
    }
}

fn supervisor_error(error: impl std::fmt::Display) -> SupervisorError {
    SupervisorError {
        message: error.to_string(),
    }
}

/// Typed fleet settings paired with their original JSON, so worker mutations preserve unknown fields.
#[derive(Clone, Debug)]
pub struct WorkerRuntimeConfig {
    runtime: FleetRuntimeConfig,
    raw: Value,
}

impl WorkerRuntimeConfig {
    /// Borrow the parsed runtime settings for supervisor construction or reload.
    #[must_use]
    pub fn runtime(&self) -> &FleetRuntimeConfig {
        &self.runtime
    }
}

/// Durable fleet configuration mutation boundary used by profile provisioning and parking.
pub trait WorkerFleetConfig: Send + Sync + 'static {
    /// Load typed runtime settings while retaining their original persisted JSON.
    fn load(&self) -> WorkerFuture<'_, WorkerRuntimeConfig>;
    /// Atomically persist a mutation without dropping unrelated configuration fields.
    fn save(&self, config: WorkerRuntimeConfig) -> WorkerFuture<'_, ()>;
}

/// Production worker configuration adapter over the durable [`ConfigStore`].
#[derive(Clone, Debug)]
pub struct NativeWorkerFleetConfig {
    store: ConfigStore,
}

impl NativeWorkerFleetConfig {
    /// Bind worker configuration changes to one explicit fleet root.
    #[must_use]
    pub fn new(store: ConfigStore) -> Self {
        Self { store }
    }

    /// Load the runtime settings while retaining the JSON needed for lossless persistence.
    pub async fn load(&self) -> Result<WorkerRuntimeConfig, SupervisorError> {
        let raw = self.store.load().await.map_err(supervisor_error)?;
        parse_worker_runtime_config(&self.store, raw)
    }

    /// Persist a config mutation without dropping unknown fields.
    pub async fn save(&self, config: &WorkerRuntimeConfig) -> Result<(), SupervisorError> {
        self.store.save(&config.raw).await.map_err(supervisor_error)
    }
}

impl WorkerFleetConfig for NativeWorkerFleetConfig {
    fn load(&self) -> WorkerFuture<'_, WorkerRuntimeConfig> {
        Box::pin(async move { NativeWorkerFleetConfig::load(self).await })
    }

    fn save(&self, config: WorkerRuntimeConfig) -> WorkerFuture<'_, ()> {
        Box::pin(async move { NativeWorkerFleetConfig::save(self, &config).await })
    }
}

fn parse_worker_runtime_config(
    store: &ConfigStore,
    raw: Value,
) -> Result<WorkerRuntimeConfig, SupervisorError> {
    let object = raw.as_object().ok_or_else(|| SupervisorError {
        message: "invalid fleet configuration".into(),
    })?;
    let string = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| SupervisorError {
                message: format!("invalid fleet configuration: {name}"),
            })
    };
    let duration =
        |name: &str, default: u64| object.get(name).and_then(Value::as_u64).unwrap_or(default);
    let profiles = object
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or_else(|| SupervisorError {
            message: "invalid fleet configuration: profiles".into(),
        })?
        .iter()
        .map(|profile| {
            let profile = profile.as_object().ok_or_else(|| SupervisorError {
                message: "invalid fleet profile".into(),
            })?;
            let name = profile
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| SupervisorError {
                    message: "invalid fleet profile name".into(),
                })?;
            let port = profile
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|port| u16::try_from(port).ok())
                .filter(|port| *port != 0)
                .ok_or_else(|| SupervisorError {
                    message: format!("invalid fleet profile port: {name}"),
                })?;
            let labels = profile
                .get("labels")
                .and_then(Value::as_array)
                .map_or_else(
                    || Ok(Vec::new()),
                    |labels| {
                        labels
                            .iter()
                            .map(|label| {
                                label
                                    .as_str()
                                    .map(str::to_owned)
                                    .ok_or_else(|| SupervisorError {
                                        message: format!("invalid fleet profile label: {name}"),
                                    })
                            })
                            .collect()
                    },
                )?;
            let purpose = match profile.get("purpose") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) => Some(value.clone()),
                Some(_) => {
                    return Err(SupervisorError {
                        message: format!("invalid fleet profile purpose: {name}"),
                    });
                }
            };
            Ok(FleetProfile {
                name: name.to_owned(),
                port,
                labels,
                purpose,
                enabled: profile
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                idle_stop: profile
                    .get("idleStopSec")
                    .and_then(Value::as_u64)
                    .map(Duration::from_secs),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let runtime = FleetRuntimeConfig {
        root: store.root().to_path_buf(),
        launch: LaunchConfig {
            fleet_root: store.root().to_path_buf(),
            chrome_path: PathBuf::from(string("chromePath")?),
            extension_dir: PathBuf::from(string("extensionDir")?),
            bridge_token: string("bridgeToken")?.to_owned(),
        },
        profiles,
        parked: object
            .get("parked")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        demand_start_timeout: Duration::from_secs(duration("demandStartTimeoutSec", 90)),
        lease_idle_ttl: Duration::from_secs(duration("leaseIdleTtlSec", 900)),
    };
    Ok(WorkerRuntimeConfig { runtime, raw })
}
pub trait WorkerProvisioner: Send + Sync + 'static {
    /// Create a profile only after it is usable, returning the public provision result.
    fn add_profile(
        &self,
        name: String,
        labels: Vec<String>,
        seed_dir: Option<PathBuf>,
    ) -> WorkerFuture<'_, Value>;
}

/// Concrete adapter for the runtime's guarded profile-provisioning transaction.
///
/// The wrapped provisioner clones only fleet-owned profiles, verifies native-host
/// availability, waits for bridge readiness, and registers a profile only after
/// its cookie/session gates pass.
#[derive(Clone, Debug)]
pub struct NativeWorkerProvisioner {
    provisioner: crate::fleet::runtime::ProfileProvisioner,
}

impl NativeWorkerProvisioner {
    /// Wrap a production profile provisioner configured with a verified native-host manifest.
    #[must_use]
    pub fn new(provisioner: crate::fleet::runtime::ProfileProvisioner) -> Self {
        Self { provisioner }
    }

    /// Build a provisioner only from a CLI-verified native host.
    ///
    /// The caller must await [`crate::cli::RegistrationContext::verify_native_host`]
    /// before this constructor; its verified path is canonical, executable, and
    /// safe to put in a per-profile native-messaging manifest.
    pub fn from_verified_host(
        store: ConfigStore,
        launch: LaunchConfig,
        verified: &crate::cli::VerifiedNativeHost,
    ) -> Result<Self, SupervisorError> {
        let manifest = serde_json::to_value(verified.manifest()).map_err(supervisor_error)?;
        let provisioner = crate::fleet::runtime::ProfileProvisioner::new(
            store,
            launch,
            manifest,
            verified.path().to_path_buf(),
        )
        .map_err(supervisor_error)?;
        Ok(Self::new(provisioner))
    }
}

impl WorkerProvisioner for NativeWorkerProvisioner {
    fn add_profile(
        &self,
        name: String,
        labels: Vec<String>,
        seed_dir: Option<PathBuf>,
    ) -> WorkerFuture<'_, Value> {
        Box::pin(async move {
            let added = self
                .provisioner
                .add(&name, labels, seed_dir.as_deref())
                .await
                .map_err(supervisor_error)?;
            Ok(added_profile_json(added))
        })
    }
}

pub(crate) fn added_profile_json(added: crate::fleet::runtime::AddedProfile) -> Value {
    let google = added.google.map(|session| {
        let state = match session.state {
            crate::fleet::runtime::GoogleSessionState::Session => "session",
            crate::fleet::runtime::GoogleSessionState::Remembered => "remembered",
            crate::fleet::runtime::GoogleSessionState::None => "none",
        };
        json!({"state": state, "accounts": session.accounts, "signedIn": session.signed_in})
    });
    json!({
        "name": added.name,
        "port": added.port,
        "copied": {"persistent": added.copied.persistent, "google": added.copied.google},
        "kept": {"persistent": added.kept.persistent, "google": added.kept.google},
        "google": google,
    })
}

/// Operator-owned worker endpoint configuration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerConfig {
    /// Stable worker identifier.
    pub id: String,
    /// Tailscale IP or MagicDNS hostname.
    pub host: String,
    /// Private HTTP listener port.
    pub port: u16,
    /// Private coordinator bearer token.
    pub token: String,
    /// Operator allowlist of profiles this worker may expose or create.
    pub profiles: Vec<String>,
    /// Symbolic, operator-approved profile seed aliases.
    pub seed_sources: HashMap<String, Option<PathBuf>>,
}

/// Invalid worker configuration.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct WorkerConfigError {
    message: String,
}

impl WorkerConfig {
    /// Validate the complete operator configuration before worker effects begin.
    pub fn validate(&self) -> Result<(), WorkerConfigError> {
        if !valid_name(&self.id) {
            return Err(config_error("invalid worker id"));
        }
        assert_tailscale_bind(&self.host)?;
        if self.port == 0 {
            return Err(config_error("invalid worker port"));
        }
        if self.token.len() < 32 {
            return Err(config_error("worker token is too short"));
        }
        if self.profiles.is_empty() {
            return Err(config_error("worker profiles are required"));
        }
        for profile in &self.profiles {
            if !valid_name(profile) {
                return Err(config_error("invalid worker profile"));
            }
        }
        let unique: std::collections::HashSet<_> = self.profiles.iter().collect();
        if unique.len() != self.profiles.len() {
            return Err(config_error("worker profiles are duplicated"));
        }
        for (name, source) in &self.seed_sources {
            if !valid_name(name) {
                return Err(config_error("invalid worker seed source"));
            }
            if source.as_ref().is_some_and(|path| !path.is_absolute()) {
                return Err(config_error(
                    "worker seed source must be an absolute path or null",
                ));
            }
        }
        Ok(())
    }

    /// Load and validate a worker JSON document without touching browser or fence storage.
    pub async fn load(path: impl AsRef<Path>) -> Result<Self, WorkerServerError> {
        let bytes = fs::read(path).await.map_err(WorkerServerError::Io)?;
        let config: Self = serde_json::from_slice(&bytes).map_err(WorkerServerError::Json)?;
        config.validate().map_err(WorkerServerError::Config)?;
        Ok(config)
    }

    /// Atomically save configuration with owner-only permissions on Unix.
    pub async fn save(&self, path: impl AsRef<Path>) -> Result<(), WorkerServerError> {
        self.validate().map_err(WorkerServerError::Config)?;
        let path = path.as_ref();
        let parent = path.parent().ok_or_else(|| {
            WorkerServerError::Invalid("worker config has no parent directory".into())
        })?;
        fs::create_dir_all(parent)
            .await
            .map_err(WorkerServerError::Io)?;
        let temporary = parent.join(format!(
            ".{}.{}.tmp",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("worker.json"),
            std::process::id()
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let bytes = serde_json::to_vec_pretty(self).map_err(WorkerServerError::Json)?;
        let mut file = options
            .open(&temporary)
            .await
            .map_err(WorkerServerError::Io)?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &bytes)
            .await
            .map_err(WorkerServerError::Io)?;
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(WorkerServerError::Io)?;
        drop(file);
        fs::rename(&temporary, path)
            .await
            .map_err(WorkerServerError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .await
                .map_err(WorkerServerError::Io)?;
        }
        Ok(())
    }
}

/// Return the worker endpoint configuration path below an explicit fleet root.
#[must_use]
pub fn worker_config_path(root: &Path) -> PathBuf {
    root.join("worker.json")
}

/// Return the durable worker fencing path below an explicit fleet root.
#[must_use]
pub fn worker_fences_path(root: &Path) -> PathBuf {
    root.join("worker-fences.sqlite")
}

/// Worker construction and request-processing failure.
#[derive(Debug, thiserror::Error)]
pub enum WorkerServerError {
    /// Invalid operator configuration.
    #[error(transparent)]
    Config(#[from] WorkerConfigError),
    /// Worker config I/O failure.
    #[error(transparent)]
    Io(std::io::Error),
    /// Worker config JSON failure.
    #[error(transparent)]
    Json(serde_json::Error),
    /// State database setup failure.
    #[error(transparent)]
    State(#[from] super::state::WorkerStateStorageError),
    /// Invalid server construction input.
    #[error("{0}")]
    Invalid(String),
}

/// Private worker route owner. It has no Chrome side effects until a route invokes its supervisor.
#[derive(Clone)]
pub struct WorkerHttp {
    config: Arc<WorkerConfig>,
    state: WorkerState,
    supervisor: Arc<dyn WorkerSupervisor>,
    config_store: Arc<dyn WorkerFleetConfig>,
    provisioner: Arc<dyn WorkerProvisioner>,
    bridge_token: Arc<str>,
    client: reqwest::Client,
    proxy_client: reqwest::Client,
    parking: Arc<AtomicBool>,
    configuration: Arc<tokio::sync::Mutex<()>>,
}

impl std::fmt::Debug for WorkerHttp {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerHttp")
            .field("id", &self.config.id)
            .finish_non_exhaustive()
    }
}

impl WorkerHttp {
    /// Construct a worker HTTP surface around concrete native runtime adapters.
    ///
    /// # Errors
    /// Rejects invalid endpoint configuration before it opens a listener or contacts Chrome.
    pub fn new(
        config: WorkerConfig,
        state: WorkerState,
        supervisor: Arc<dyn WorkerSupervisor>,
        config_store: Arc<dyn WorkerFleetConfig>,
        provisioner: Arc<dyn WorkerProvisioner>,
        bridge_token: impl Into<Arc<str>>,
    ) -> Result<Self, WorkerServerError> {
        config.validate()?;
        let proxy_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| {
                WorkerServerError::Invalid("could not initialize worker proxy client".into())
            })?;
        Ok(Self {
            config: Arc::new(config),
            state,
            supervisor,
            config_store,
            provisioner,
            bridge_token: bridge_token.into(),
            client: reqwest::Client::new(),
            proxy_client,
            parking: Arc::new(AtomicBool::new(false)),
            configuration: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    /// Build the complete private worker router. Health is bearer-free; every other route is authenticated.
    pub fn router(self) -> Router {
        Router::new()
            .route("/healthz", get(health))
            .route("/v1/worker", get(inventory))
            .route("/v1/worker/profiles", post(provision))
            .route(
                "/v1/worker/profiles/{name}/lease",
                put(claim_lease).delete(release_lease),
            )
            .route("/v1/worker/profiles/{name}/{action}", post(lifecycle))
            .route(
                "/v1/worker/profiles/{name}/browser/{*target}",
                any(proxy_browser),
            )
            .route("/v1/worker/park", post(park))
            .fallback(not_found)
            .layer(middleware::from_fn_with_state(self.clone(), authenticate))
            .with_state(self)
    }

    pub async fn reap_idle(&self) -> Result<(), SupervisorError> {
        let profiles = self.supervisor.snapshot().await?;
        let mut leased_profiles = std::collections::HashSet::new();
        for profile in profiles {
            if self
                .state
                .lease_for_async(profile.name.clone())
                .await
                .map_err(supervisor_error)?
                .is_some()
            {
                leased_profiles.insert(profile.name);
            }
        }
        let leased_profiles = Arc::new(leased_profiles);
        self.supervisor
            .reap_idle(Arc::new(move |profile| leased_profiles.contains(profile)))
            .await
    }

    /// Start the worker's 30-second idle-reap loop; abort the returned task during shutdown.
    #[must_use]
    pub fn spawn_idle_reaper(&self) -> tokio::task::JoinHandle<()> {
        let worker = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(error) = worker.reap_idle().await {
                    tracing::warn!(%error, "fleet worker idle reap failed");
                }
            }
        })
    }

    fn known_profile(&self, name: &str) -> bool {
        self.config.profiles.iter().any(|profile| profile == name)
    }

    async fn snapshot(&self, name: &str) -> Result<Option<ProfileSnapshot>, SupervisorError> {
        let Some(mut snapshot) = self
            .supervisor
            .snapshot()
            .await?
            .into_iter()
            .find(|snapshot| snapshot.name == name)
        else {
            return Ok(None);
        };
        snapshot.leased_by = self
            .state
            .leased_by_async(name.to_owned())
            .await
            .map_err(supervisor_error)?;
        Ok(Some(snapshot))
    }

    async fn release_lane(&self, profile: &str, lane: &str) -> Result<(), SupervisorError> {
        let Some(snapshot) = self
            .supervisor
            .snapshot()
            .await?
            .into_iter()
            .find(|snapshot| snapshot.name == profile)
        else {
            return Ok(());
        };
        if snapshot.state != ProfileState::Healthy {
            return Ok(());
        }
        let url = format!(
            "http://127.0.0.1:{}/api/clients/{}/release",
            snapshot.port,
            urlencoding(lane)
        );
        let _ = self
            .client
            .post(url)
            .bearer_auth(self.bridge_token.as_ref())
            .send()
            .await;
        Ok(())
    }

    fn response_error(
        &self,
        status: StatusCode,
        error: &'static str,
        detail: Option<String>,
    ) -> Response {
        let value = match detail {
            Some(message) => json!({"error": error, "message": message}),
            None => json!({"error": error}),
        };
        (status, Json(value)).into_response()
    }

    fn state_error(&self, error: WorkerStateError, fallback: &'static str) -> Response {
        let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::UNPROCESSABLE_ENTITY);
        if error.code == "operation_failed" {
            self.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                fallback,
                Some(error.message.into()),
            )
        } else {
            self.response_error(status, error.code, Some(error.message.into()))
        }
    }
}

async fn authenticate(State(worker): State<WorkerHttp>, request: Request, next: Next) -> Response {
    if request.headers().contains_key(header::ORIGIN) {
        return worker.response_error(StatusCode::FORBIDDEN, "origin_not_allowed", None);
    }
    if request.uri().path() == "/healthz" {
        return next.run(request).await;
    }
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| valid_bearer(value, &worker.config.token));
    if !authorized {
        return worker.response_error(StatusCode::UNAUTHORIZED, "unauthorized", None);
    }
    next.run(request).await
}

async fn health() -> Json<Value> {
    Json(json!({"status":"ok"}))
}

async fn not_found(State(worker): State<WorkerHttp>) -> Response {
    worker.response_error(StatusCode::NOT_FOUND, "not_found", None)
}

async fn inventory(State(worker): State<WorkerHttp>) -> Response {
    let profiles = match worker.supervisor.snapshot().await {
        Ok(profiles) => profiles,
        Err(error) => {
            return worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "operation_failed",
                Some(error.message),
            );
        }
    };
    let mut inventory = Vec::with_capacity(profiles.len());
    for mut profile in profiles {
        if !worker.known_profile(&profile.name) {
            continue;
        }
        profile.leased_by = match worker.state.leased_by_async(profile.name.clone()).await {
            Ok(leased_by) => leased_by,
            Err(error) => {
                return worker.response_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "operation_failed",
                    Some(error.to_string()),
                );
            }
        };
        inventory.push(profile);
    }
    Json(json!({"id": worker.config.id, "profiles": inventory})).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseBody {
    agent: String,
    lease_id: String,
    generation: u64,
    ttl_sec: u64,
}

async fn claim_lease(
    State(worker): State<WorkerHttp>,
    AxumPath(name): AxumPath<String>,
    body: Result<Json<LeaseBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !worker.known_profile(&name) {
        return worker.response_error(StatusCode::NOT_FOUND, "unknown_profile", None);
    }
    let Ok(Json(body)) = body else {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_lease", None);
    };
    let identity = LeaseIdentity {
        agent: body.agent,
        lease_id: body.lease_id,
        generation: body.generation,
    };
    if !valid_identity(&identity) || !(15..=900).contains(&body.ttl_sec) {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_lease", None);
    }
    if worker.parking.load(Ordering::Acquire) {
        return worker.response_error(StatusCode::CONFLICT, "profile_busy", None);
    }
    let handoff = match worker
        .state
        .reserve_handoff_async(name.clone(), identity.clone())
        .await
    {
        Ok(handoff) => handoff,
        Err(error) => return worker.state_error(error, "operation_failed"),
    };
    if let Some(handoff) = handoff {
        let lane_result = worker
            .release_lane(&name, &lane_for(&handoff.prior.lease_id))
            .await;
        let reservation_result = handoff.release().await;
        if let Err(error) = lane_result {
            return worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "operation_failed",
                Some(error.message),
            );
        }
        if let Err(error) = reservation_result {
            return worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "operation_failed",
                Some(error.to_string()),
            );
        }
    }
    match worker.state.claim_async(name, identity, body.ttl_sec).await {
        Ok(lease) => Json(lease_json(&lease)).into_response(),
        Err(error) => worker.state_error(error, "operation_failed"),
    }
}

async fn release_lease(
    State(worker): State<WorkerHttp>,
    AxumPath(name): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if !worker.known_profile(&name) {
        return worker.response_error(StatusCode::NOT_FOUND, "unknown_profile", None);
    }
    let Some(identity) = lease_headers(&headers) else {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_lease", None);
    };
    if let Err(error) = worker
        .state
        .release_async(name.clone(), identity.clone())
        .await
    {
        return worker.state_error(error, "operation_failed");
    }
    match worker
        .release_lane(&name, &lane_for(&identity.lease_id))
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => worker.response_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "operation_failed",
            Some(error.message),
        ),
    }
}

async fn lifecycle(
    State(worker): State<WorkerHttp>,
    AxumPath((name, action)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if !worker.known_profile(&name) {
        return worker.response_error(StatusCode::NOT_FOUND, "unknown_profile", None);
    }
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "recover") {
        return worker.response_error(StatusCode::NOT_FOUND, "not_found", None);
    }
    if action == "recover" {
        if headers.contains_key("x-humanchrome-lease")
            || headers.contains_key("x-humanchrome-generation")
            || headers.contains_key("x-humanchrome-agent")
        {
            return worker.response_error(StatusCode::BAD_REQUEST, "invalid_recovery", None);
        }
        let prior = match worker.state.recorded_lease_for_async(name.clone()).await {
            Ok(prior) => prior,
            Err(error) => {
                return worker.response_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "operation_failed",
                    Some(error.to_string()),
                );
            }
        };
        let guard = match worker.state.begin_recovery_async(name.clone()).await {
            Ok(guard) => guard,
            Err(error) => return worker.state_error(error, "operation_failed"),
        };
        let operation = async {
            worker.supervisor.stop_profile(name.clone()).await?;
            worker.supervisor.start_profile(name.clone()).await?;
            if let Some(prior) = prior {
                worker
                    .release_lane(&name, &lane_for(&prior.lease_id))
                    .await?;
            }
            worker
                .state
                .clear_uncertain_after_recovery_async(name.clone())
                .await
                .map_err(supervisor_error)
        }
        .await;
        let result = finish_transition(operation, guard.finish().await);
        return lifecycle_response(&worker, &name, result).await;
    }
    let Some(identity) = lease_headers(&headers) else {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_lease", None);
    };
    let recovering = action == "restart";
    let guard = match worker
        .state
        .begin_transition_async(name.clone(), identity.clone(), recovering)
        .await
    {
        Ok(guard) => guard,
        Err(error) => return worker.state_error(error, "operation_failed"),
    };
    let operation = match action.as_str() {
        "start" => worker.supervisor.start_profile(name.clone()).await,
        "stop" => worker.supervisor.stop_profile(name.clone()).await,
        "restart" => match worker.supervisor.restart_profile(name.clone()).await {
            Ok(()) => worker
                .state
                .clear_uncertain_after_restart_async(name.clone(), identity)
                .await
                .map_err(supervisor_error),
            Err(error) => Err(error),
        },
        _ => unreachable!("action was validated"),
    };
    lifecycle_response(
        &worker,
        &name,
        finish_transition(operation, guard.finish().await),
    )
    .await
}

fn finish_transition(
    operation: Result<(), SupervisorError>,
    finish: Result<(), super::state::WorkerStateStorageError>,
) -> Result<(), SupervisorError> {
    match (operation, finish.map_err(supervisor_error)) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(_), Err(error)) | (Ok(()), Err(error)) => Err(error),
        (Err(error), Ok(())) => Err(error),
    }
}

async fn lifecycle_response(
    worker: &WorkerHttp,
    name: &str,
    result: Result<(), SupervisorError>,
) -> Response {
    match result {
        Ok(()) => match worker.snapshot(name).await {
            Ok(Some(value)) => Json(value).into_response(),
            Ok(None) => worker.response_error(StatusCode::NOT_FOUND, "unknown_profile", None),
            Err(error) => worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "operation_failed",
                Some(error.message),
            ),
        },
        Err(error) => worker.response_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "operation_failed",
            Some(error.message),
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionBody {
    name: String,
    #[serde(default)]
    labels: Vec<String>,
    seed_source: String,
}

async fn provision(
    State(worker): State<WorkerHttp>,
    body: Result<Json<ProvisionBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_body", None);
    };
    if !worker.known_profile(&body.name) || !valid_name(&body.name) {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_name", None);
    }
    if body.labels.iter().any(|label| label.is_empty()) {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_labels", None);
    }
    let Some(seed_dir) = worker.config.seed_sources.get(&body.seed_source).cloned() else {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_seed_source", None);
    };
    let _configuration = worker.configuration.lock().await;
    match worker.supervisor.state(body.name.clone()).await {
        Ok(Some(_)) => return worker.response_error(StatusCode::CONFLICT, "profile_exists", None),
        Ok(None) => {}
        Err(error) => {
            return worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "provision_failed",
                Some(error.message),
            );
        }
    }
    match worker
        .provisioner
        .add_profile(body.name, body.labels, seed_dir)
        .await
    {
        Ok(result) => match worker.config_store.load().await {
            Ok(config) => match worker.supervisor.reload(config.runtime).await {
                Ok(()) => (StatusCode::CREATED, Json(result)).into_response(),
                Err(error) => worker.response_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "provision_failed",
                    Some(error.message),
                ),
            },
            Err(error) => worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "provision_failed",
                Some(error.message),
            ),
        },
        Err(error) => worker.response_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "provision_failed",
            Some(error.message),
        ),
    }
}

#[derive(Deserialize)]
struct ParkBody {
    parked: bool,
}

async fn park(
    State(worker): State<WorkerHttp>,
    body: Result<Json<ParkBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_body", None);
    };
    if worker.parking.swap(true, Ordering::AcqRel) {
        return worker.response_error(StatusCode::CONFLICT, "profile_busy", None);
    }
    let result = async {
        let _configuration = worker.configuration.lock().await;
        if worker
            .state
            .has_live_leases_async()
            .await
            .map_err(supervisor_error)?
            || worker
                .state
                .has_active_work_async()
                .await
                .map_err(supervisor_error)?
        {
            return Err(SupervisorError {
                message: "profile has active work".into(),
            });
        }
        let mut config = worker.config_store.load().await?;
        config.runtime.parked = body.parked;
        config
            .raw
            .as_object_mut()
            .ok_or_else(|| SupervisorError {
                message: "fleet config is not an object".into(),
            })?
            .insert("parked".into(), Value::Bool(body.parked));
        worker.config_store.save(config.clone()).await?;
        worker.supervisor.reload(config.runtime).await?;
        Ok::<_, SupervisorError>(body.parked)
    }
    .await;
    worker.parking.store(false, Ordering::Release);
    match result {
        Ok(parked) => Json(json!({"parked": parked})).into_response(),
        Err(error) => worker.response_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "park_failed",
            Some(error.message),
        ),
    }
}

async fn proxy_browser(
    State(worker): State<WorkerHttp>,
    AxumPath((name, target)): AxumPath<(String, String)>,
    request: Request,
) -> Response {
    if !worker.known_profile(&name) {
        return worker.response_error(StatusCode::NOT_FOUND, "unknown_profile", None);
    }
    if !allowed_browser_path(&target) {
        return worker.response_error(StatusCode::NOT_FOUND, "not_found", None);
    }
    if worker.parking.load(Ordering::Acquire) {
        return worker.response_error(StatusCode::CONFLICT, "profile_busy", None);
    }
    let Some(identity) = lease_headers(request.headers()) else {
        return worker.response_error(StatusCode::BAD_REQUEST, "invalid_lease", None);
    };
    let mut snapshot = match worker.snapshot(&name).await {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return worker.response_error(StatusCode::NOT_FOUND, "unknown_profile", None),
        Err(error) => {
            return worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "operation_failed",
                Some(error.message),
            );
        }
    };
    if snapshot.state != ProfileState::Healthy {
        let guard = match worker
            .state
            .begin_transition_async(name.clone(), identity.clone(), false)
            .await
        {
            Ok(guard) => guard,
            Err(error) => return worker.state_error(error, "operation_failed"),
        };
        let started = worker
            .supervisor
            .demand_start(
                name.clone(),
                lane_for(&identity.lease_id),
                format!("worker/{name}"),
            )
            .await;
        let finished = guard.finish().await.map_err(supervisor_error);
        match (started, finished) {
            (Ok(()), Ok(())) => {}
            (Err(error), Ok(())) => {
                return worker.response_error(
                    StatusCode::BAD_GATEWAY,
                    "outcome_unknown",
                    Some(error.message),
                );
            }
            (Ok(()), Err(error)) => {
                return worker.response_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "operation_failed",
                    Some(error.message),
                );
            }
            (Err(action), Err(cleanup)) => {
                return worker.response_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "operation_failed",
                    Some(format!(
                        "{}; transition cleanup failed: {}",
                        action.message, cleanup.message
                    )),
                );
            }
        }
        snapshot = match worker.snapshot(&name).await {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => {
                return worker.response_error(StatusCode::NOT_FOUND, "unknown_profile", None);
            }
            Err(error) => {
                return worker.response_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "operation_failed",
                    Some(error.message),
                );
            }
        };
    }
    let execution = if matches!(*request.method(), Method::GET | Method::HEAD) {
        worker
            .state
            .begin_read_async(name.clone(), identity.clone())
            .await
    } else {
        worker
            .state
            .begin_execution_async(name.clone(), identity.clone())
            .await
    };
    let execution = match execution {
        Ok(execution) => execution,
        Err(error) => return worker.state_error(error, "operation_failed"),
    };
    if snapshot.state != ProfileState::Healthy {
        if let Err(error) = execution.complete_async().await {
            return worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "operation_failed",
                Some(error.to_string()),
            );
        }
        return worker.response_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "profile_unavailable",
            Some(format!("{:?}", snapshot.state).to_lowercase()),
        );
    }
    let (parts, body) = request.into_parts();
    let head_request = parts.method == Method::HEAD;
    let query = parts
        .uri
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let url = format!("http://127.0.0.1:{}/{target}{query}", snapshot.port);
    let mut upstream = worker
        .proxy_client
        .request(parts.method, url)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()));
    for (name, value) in parts.headers.iter() {
        if forward_header(name) {
            upstream = upstream.header(name, value);
        }
    }
    upstream = upstream
        .header(header::HOST, format!("127.0.0.1:{}", snapshot.port))
        .bearer_auth(worker.bridge_token.as_ref())
        .header("x-client-id", lane_for(&identity.lease_id))
        .header("x-humanchrome-session", lane_for(&identity.lease_id));
    let response = match upstream.send().await {
        Ok(response) => response,
        Err(error) => {
            return match execution.client_closed_async().await {
                Ok(()) => worker.response_error(
                    StatusCode::BAD_GATEWAY,
                    "outcome_unknown",
                    Some(error.to_string()),
                ),
                Err(storage_error) => worker.response_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "operation_failed",
                    Some(storage_error.to_string()),
                ),
            };
        }
    };
    let status = response.status();
    let content_length = response.content_length();
    let empty_body = head_request
        || matches!(status, StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED)
        || content_length == Some(0);
    let mut builder = axum::http::Response::builder().status(status);
    for (name, value) in response.headers() {
        if forward_header(name) {
            builder = builder.header(name, value);
        }
    }
    let body = if empty_body {
        if let Err(error) = execution.complete_async().await {
            return worker.response_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "operation_failed",
                Some(error.to_string()),
            );
        }
        Body::empty()
    } else {
        Body::from_stream(ExecutionStream::new(
            Box::pin(response.bytes_stream()),
            execution,
            content_length,
        ))
    };
    builder
        .body(body)
        .unwrap_or_else(|_| worker.response_error(StatusCode::BAD_GATEWAY, "outcome_unknown", None))
}

type WorkerProxyStreamError = Box<dyn std::error::Error + Send + Sync>;
type CompletionFuture = Pin<Box<dyn Future<Output = Result<(), WorkerStateStorageError>> + Send>>;

struct ExecutionStream {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    execution: Option<AsyncWorkerExecution>,
    completion: Option<CompletionFuture>,
    remaining: Option<u64>,
    final_chunk: Option<Bytes>,
    terminal: bool,
}

impl ExecutionStream {
    fn new(
        inner: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
        execution: AsyncWorkerExecution,
        remaining: Option<u64>,
    ) -> Self {
        Self {
            inner,
            execution: Some(execution),
            completion: None,
            remaining,
            final_chunk: None,
            terminal: false,
        }
    }
}

impl Stream for ExecutionStream {
    type Item = Result<Bytes, WorkerProxyStreamError>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.terminal {
            return std::task::Poll::Ready(None);
        }
        if let Some(completion) = self.completion.as_mut() {
            let result = completion.as_mut().poll(context);
            match result {
                std::task::Poll::Ready(Ok(())) => {
                    self.completion.take();
                    self.terminal = true;
                    return std::task::Poll::Ready(self.final_chunk.take().map(Ok));
                }
                std::task::Poll::Ready(Err(error)) => {
                    self.completion.take();
                    self.terminal = true;
                    tracing::error!(%error, "worker execution completion fence update failed");
                    return std::task::Poll::Ready(Some(Err(Box::new(error))));
                }
                std::task::Poll::Pending => return std::task::Poll::Pending,
            }
        }

        match self.inner.as_mut().poll_next(context) {
            std::task::Poll::Ready(None) => {
                let execution = self
                    .execution
                    .take()
                    .expect("execution is present until upstream completion");
                self.completion = Some(Box::pin(async move { execution.complete_async().await }));
                self.poll_next(context)
            }
            std::task::Poll::Ready(Some(Err(error))) => {
                drop(self.execution.take());
                self.terminal = true;
                std::task::Poll::Ready(Some(Err(Box::new(error))))
            }
            std::task::Poll::Ready(Some(Ok(bytes))) => {
                if let Some(remaining) = self.remaining.as_mut() {
                    let length = u64::try_from(bytes.len()).expect("HTTP chunk length fits u64");
                    let Some(next) = remaining.checked_sub(length) else {
                        drop(self.execution.take());
                        self.terminal = true;
                        return std::task::Poll::Ready(Some(Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "upstream body exceeds its content length",
                        )))));
                    };
                    *remaining = next;
                    if next == 0 {
                        // Hyper may stop polling as soon as Content-Length bytes are sent.
                        // Persist completion before releasing that final chunk to the client.
                        self.final_chunk = Some(bytes);
                        let execution = self
                            .execution
                            .take()
                            .expect("response still owns execution");
                        self.completion =
                            Some(Box::pin(async move { execution.complete_async().await }));
                        return self.poll_next(context);
                    }
                }
                std::task::Poll::Ready(Some(Ok(bytes)))
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

fn lease_headers(headers: &HeaderMap) -> Option<LeaseIdentity> {
    let lease_id = headers
        .get("x-humanchrome-lease")?
        .to_str()
        .ok()?
        .to_owned();
    let agent = headers
        .get("x-humanchrome-agent")?
        .to_str()
        .ok()?
        .to_owned();
    let generation = headers
        .get("x-humanchrome-generation")?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    let identity = LeaseIdentity {
        agent,
        lease_id,
        generation,
    };
    valid_identity(&identity).then_some(identity)
}

fn valid_identity(identity: &LeaseIdentity) -> bool {
    !identity.agent.is_empty()
        && identity.agent.len() <= 256
        && (1..=MAX_SAFE_GENERATION).contains(&identity.generation)
        && Uuid::parse_str(&identity.lease_id).is_ok_and(|uuid| {
            matches!(uuid.get_variant(), Variant::RFC4122)
                && (1..=5).contains(&uuid.get_version_num())
        })
}

fn lease_json(lease: &WorkerLease) -> Value {
    let expires_at = chrono::DateTime::from_timestamp_millis(lease.expires_at)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    json!({"agent": lease.agent, "leaseId": lease.lease_id, "generation": lease.generation, "expiresAt": expires_at})
}

fn lane_for(lease_id: &str) -> String {
    format!("lease-{lease_id}")
}

fn allowed_browser_path(path: &str) -> bool {
    matches!(path, "mcp" | "ping" | "api/openapi.json" | "api/tools")
        || path.strip_prefix("api/tools/").is_some_and(|name| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn forward_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str(),
        "authorization"
            | "host"
            | "x-client-id"
            | "x-humanchrome-session"
            | "x-humanchrome-agent"
            | "x-humanchrome-lease"
            | "x-humanchrome-generation"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn valid_bearer(header_value: &str, expected: &str) -> bool {
    let Some(actual) = header_value.strip_prefix("Bearer ") else {
        return false;
    };
    let max_len = actual.len().max(expected.len());
    let mut different = actual.len() ^ expected.len();
    for index in 0..max_len {
        different |= usize::from(
            *actual.as_bytes().get(index).unwrap_or(&0)
                ^ *expected.as_bytes().get(index).unwrap_or(&0),
        );
    }
    different == 0
}

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=32).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// Validate that worker listeners cannot accidentally expose the private API publicly.
pub fn assert_tailscale_bind(host: &str) -> Result<(), WorkerConfigError> {
    if matches!(host, "0.0.0.0" | "::" | "localhost" | "127.0.0.1") {
        return Err(config_error(
            "worker host must be a Tailscale address or MagicDNS hostname",
        ));
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address))
            if address.octets()[0] == 100 && (64..=127).contains(&address.octets()[1]) =>
        {
            Ok(())
        }
        Ok(IpAddr::V4(_)) => Err(config_error(
            "worker IPv4 host must be in Tailscale 100.64.0.0/10",
        )),
        Ok(IpAddr::V6(address)) if address.to_string().starts_with("fd7a:115c:a1e0:") => Ok(()),
        Ok(IpAddr::V6(_)) => Err(config_error(
            "worker IPv6 host must be in Tailscale fd7a:115c:a1e0::/48",
        )),
        Err(_) if host.ends_with(".ts.net") && !host.contains('/') => Ok(()),
        Err(_) => Err(config_error(
            "worker hostname must be a MagicDNS .ts.net name",
        )),
    }
}

fn config_error(message: &str) -> WorkerConfigError {
    WorkerConfigError {
        message: message.to_owned(),
    }
}

fn urlencoding(value: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(char::from(byte))
            }
            _ => write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail"),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_comparison_requires_exact_token_without_short_circuiting_shape() {
        assert!(valid_bearer("Bearer abc", "abc"));
        assert!(!valid_bearer("Bearer ab", "abc"));
        assert!(!valid_bearer("Basic abc", "abc"));
    }

    #[test]
    fn proxy_path_allowlist_excludes_arbitrary_local_urls() {
        assert!(allowed_browser_path("api/tools/click.element-1"));
        assert!(allowed_browser_path("mcp"));
        assert!(!allowed_browser_path("api/clients/victim/release"));
        assert!(!allowed_browser_path("../ping"));
    }

    #[test]
    fn lease_identity_generation_matches_the_legacy_safe_integer_boundary() {
        let mut identity = LeaseIdentity {
            agent: "coordinator:agent".into(),
            lease_id: "11111111-1111-4111-8111-111111111111".into(),
            generation: MAX_SAFE_GENERATION,
        };
        assert!(valid_identity(&identity));
        identity.generation += 1;
        assert!(!valid_identity(&identity));
    }

    #[derive(Debug)]
    struct TestSupervisor;

    impl WorkerSupervisor for TestSupervisor {
        fn snapshot(&self) -> WorkerFuture<'_, Vec<ProfileSnapshot>> {
            Box::pin(async {
                Ok(vec![ProfileSnapshot {
                    name: "browser".into(),
                    port: 12_500,
                    labels: vec![],
                    enabled: true,
                    purpose: None,
                    state: ProfileState::Healthy,
                    pid: Some(1),
                    leased_by: None,
                    last_error: None,
                    started_by: None,
                }])
            })
        }

        fn state(&self, name: String) -> WorkerFuture<'_, Option<ProfileState>> {
            Box::pin(async move { Ok((name == "browser").then_some(ProfileState::Healthy)) })
        }

        fn start_profile(&self, _name: String) -> WorkerFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
        fn stop_profile(&self, _name: String) -> WorkerFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
        fn restart_profile(&self, _name: String) -> WorkerFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
        fn demand_start(
            &self,
            _name: String,
            _agent: String,
            _request: String,
        ) -> WorkerFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
        fn reap_idle(
            &self,
            _leased: Arc<dyn Fn(&str) -> bool + Send + Sync>,
        ) -> WorkerFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
        fn reload(&self, _config: FleetRuntimeConfig) -> WorkerFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    #[derive(Debug)]
    struct UnusedConfig;

    impl WorkerFleetConfig for UnusedConfig {
        fn load(&self) -> WorkerFuture<'_, WorkerRuntimeConfig> {
            Box::pin(async {
                Err(SupervisorError {
                    message: "unexpected config load".into(),
                })
            })
        }

        fn save(&self, _config: WorkerRuntimeConfig) -> WorkerFuture<'_, ()> {
            Box::pin(async {
                Err(SupervisorError {
                    message: "unexpected config save".into(),
                })
            })
        }
    }

    #[derive(Debug)]
    struct UnusedProvisioner;

    impl WorkerProvisioner for UnusedProvisioner {
        fn add_profile(
            &self,
            _name: String,
            _labels: Vec<String>,
            _seed_dir: Option<PathBuf>,
        ) -> WorkerFuture<'_, Value> {
            Box::pin(async {
                Err(SupervisorError {
                    message: "unexpected provision".into(),
                })
            })
        }
    }

    #[tokio::test]
    async fn private_worker_routes_require_bearer_and_reject_web_origins() {
        let config = WorkerConfig {
            id: "worker-a".into(),
            host: "100.64.0.1".into(),
            port: 12_320,
            token: "t".repeat(32),
            profiles: vec!["browser".into()],
            seed_sources: HashMap::new(),
        };
        let worker = WorkerHttp::new(
            config,
            WorkerState::in_memory().expect("open isolated state"),
            Arc::new(TestSupervisor),
            Arc::new(UnusedConfig),
            Arc::new(UnusedProvisioner),
            "b".repeat(32),
        )
        .expect("construct worker");
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind worker listener");
        let port = listener.local_addr().expect("worker address").port();
        let router = worker.router();
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let client = reqwest::Client::new();
        let health = client
            .get(format!("http://127.0.0.1:{port}/healthz"))
            .send()
            .await
            .expect("request health");
        assert_eq!(health.status(), StatusCode::OK);
        let unauthenticated = client
            .get(format!("http://127.0.0.1:{port}/v1/worker"))
            .send()
            .await
            .expect("request inventory");
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        let origin = client
            .get(format!("http://127.0.0.1:{port}/v1/worker"))
            .header(header::AUTHORIZATION, format!("Bearer {}", "t".repeat(32)))
            .header(header::ORIGIN, "https://attacker.invalid")
            .send()
            .await
            .expect("request with origin");
        assert_eq!(origin.status(), StatusCode::FORBIDDEN);
        let inventory = client
            .get(format!("http://127.0.0.1:{port}/v1/worker"))
            .bearer_auth("t".repeat(32))
            .send()
            .await
            .expect("request authenticated inventory");
        assert_eq!(inventory.status(), StatusCode::OK);
        assert_eq!(
            inventory.json::<Value>().await.expect("decode inventory")["profiles"][0]["name"],
            "browser"
        );
        server.abort();
    }

    #[test]
    fn worker_config_requires_private_tailscale_listener() {
        let config = WorkerConfig {
            id: "worker-a".into(),
            host: "127.0.0.1".into(),
            port: 12320,
            token: "t".repeat(32),
            profiles: vec!["browser".into()],
            seed_sources: HashMap::new(),
        };
        assert!(config.validate().is_err());
    }
}
