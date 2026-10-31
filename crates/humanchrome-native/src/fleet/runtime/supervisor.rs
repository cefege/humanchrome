//! Supervise persistent Chrome profiles without launching two browsers on one directory.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio::{sync::Mutex, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::label::{apply_window_label, close_onboarding_tabs, label_for};
use super::{
    FleetRuntimeError, LaunchConfig, LaunchedProfile, capture_session, find_chrome_for_profile,
    launch_profile_with_extension, terminate_chrome_checked,
};

const MONITOR_INTERVAL: Duration = Duration::from_secs(5);
const HEALTH_INTERVAL: Duration = Duration::from_secs(10);
const SESSION_INTERVAL: Duration = Duration::from_secs(60);
const DEMAND_POLL: Duration = Duration::from_millis(250);
const PING_FAILURES_BEFORE_REPLACE: u8 = 6;
const BACKOFF_MAX: Duration = Duration::from_secs(60);
const DEFAULT_IDLE_STOP: Duration = Duration::from_secs(30 * 60);

/// One profile's declarative fleet configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetProfile {
    /// Stable profile name and directory name.
    pub name: String,
    /// Loopback bridge HTTP port.
    pub port: u16,
    /// Human-facing routing labels.
    pub labels: Vec<String>,
    /// Optional exclusive business purpose.
    pub purpose: Option<String>,
    /// Disabled profiles are never launched or demand-started.
    pub enabled: bool,
    /// Demand-start idle stop override; zero disables reaping.
    pub idle_stop: Option<Duration>,
}

/// Settings consumed by the process/profile supervisor.
#[derive(Clone, Debug)]
pub struct FleetRuntimeConfig {
    /// Fleet-owned root; no default ever points at a daily Chrome profile.
    pub root: PathBuf,
    /// Browser executable, extension build, and bridge environment settings.
    pub launch: LaunchConfig,
    /// Configured profiles.
    pub profiles: Vec<FleetProfile>,
    /// Parked fleets launch only profiles demanded by a live gateway request.
    pub parked: bool,
    /// Maximum time a demand request may wait for `/ping`.
    pub demand_start_timeout: Duration,
    /// Lease TTL owned by the gateway; retained here for configuration completeness.
    pub lease_idle_ttl: Duration,
}

/// Runtime health state visible to gateway callers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileState {
    /// Browser intentionally absent.
    Stopped,
    /// A browser process is being launched.
    Starting,
    /// Browser exists but its bridge has not yet proven healthy.
    Running,
    /// Browser and bridge answered the health probe.
    Healthy,
    /// Last start/health repair failed and will be retried.
    Backoff,
}

/// Why a parked profile was started on demand.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DemandReason {
    /// Gateway client/agent that needs the browser.
    pub agent: String,
    /// Optional MCP session identity associated with that request.
    pub session: Option<String>,
    /// Route or operation which made the request.
    pub operation: String,
    /// RFC3339 timestamp recorded by the caller.
    pub at: String,
}

/// Gateway-safe summary of one profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileSnapshot {
    /// Profile name.
    pub name: String,
    /// Bridge port.
    pub port: u16,
    /// Routing labels.
    pub labels: Vec<String>,
    /// Optional purpose.
    pub purpose: Option<String>,
    /// Whether config allows it to run.
    pub enabled: bool,
    /// Current supervisor state.
    pub state: ProfileState,
    /// Browser group leader while known.
    pub pid: Option<u32>,
    /// Current gateway lease holder, supplied at snapshot time.
    pub leased_by: Option<String>,
    /// Last distinct launch/repair error.
    pub last_error: Option<String>,
    /// Demand-start provenance while parked.
    pub started_by: Option<DemandReason>,
}

/// Demand startup failed in a way a gateway should expose as a 503, not a generic 500.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {profile}: {message}")]
pub struct ProfileStartError {
    /// Stable machine-readable error category.
    pub code: &'static str,
    /// Requested profile.
    pub profile: String,
    /// Last launch or health error.
    pub message: String,
    /// Timeout used for a timed-out demand.
    pub timeout: Option<Duration>,
}

#[derive(Debug)]
struct RuntimeProfile {
    config: FleetProfile,
    state: ProfileState,
    pid: Option<u32>,
    backoff: Duration,
    next_restart: Instant,
    healthy_since: Option<Instant>,
    launched: Option<LaunchedProfile>,
    ping_failures: u8,
    last_error: Option<String>,
    started_by: Option<DemandReason>,
    idle_since: Option<Instant>,
    stop_requested: bool,
}

impl RuntimeProfile {
    fn stopped(config: FleetProfile) -> Self {
        Self {
            config,
            state: ProfileState::Stopped,
            pid: None,
            backoff: MONITOR_INTERVAL,
            next_restart: Instant::now(),
            healthy_since: None,
            launched: None,
            ping_failures: 0,
            last_error: None,
            started_by: None,
            idle_since: None,
            stop_requested: false,
        }
    }
}

#[derive(Debug)]
struct Inner {
    profiles: BTreeMap<String, RuntimeProfile>,
    launching: BTreeSet<String>,
    stopping: bool,
}

/// Owns launch, repair, snapshot, and termination operations for a fleet root.
#[derive(Clone, Debug)]
pub struct ProfileSupervisor {
    config: Arc<Mutex<FleetRuntimeConfig>>,
    inner: Arc<Mutex<Inner>>,
    http: reqwest::Client,
    cancellation: CancellationToken,
    timer_tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl ProfileSupervisor {
    /// Construct a supervisor without starting a process or touching the filesystem.
    ///
    /// # Errors
    /// Returns an error when the fixed loopback probe client cannot be configured.
    pub fn new(config: FleetRuntimeConfig) -> Result<Self, FleetRuntimeError> {
        let profiles = config
            .profiles
            .iter()
            .cloned()
            .map(|profile| (profile.name.clone(), RuntimeProfile::stopped(profile)))
            .collect();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|error| {
                FleetRuntimeError::Process(format!("could not create fleet HTTP client: {error}"))
            })?;
        Ok(Self {
            config: Arc::new(Mutex::new(config)),
            inner: Arc::new(Mutex::new(Inner {
                profiles,
                launching: BTreeSet::new(),
                stopping: false,
            })),
            http,
            cancellation: CancellationToken::new(),
            timer_tasks: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// Start enabled eager profiles and periodic health/session supervision.
    ///
    /// # Errors
    /// Individual profile failures enter backoff and are reflected in snapshots; only setup errors
    /// are returned directly.
    pub async fn start(&self) -> Result<(), FleetRuntimeError> {
        self.clear_own_shutdown().await?;
        self.inner.lock().await.stopping = false;
        let config = self.config.lock().await.clone();
        if !config.parked {
            for profile in config.profiles.iter().filter(|profile| profile.enabled) {
                self.adopt_or_launch(&profile.name).await?;
            }
        }
        self.spawn_timers().await;
        Ok(())
    }

    /// Stop timers, persist session cookies, and terminate only browsers this supervisor launched.
    ///
    /// # Errors
    /// Refuses to signal owned browsers if their restart marker cannot be made durable and reports
    /// any browser that remains alive. Adopted browsers are deliberately never terminated here.
    pub async fn stop(&self) -> Result<(), FleetRuntimeError> {
        self.inner.lock().await.stopping = true;
        self.cancellation.cancel();
        let timer_tasks = std::mem::take(&mut *self.timer_tasks.lock().await);
        for task in timer_tasks {
            let _ = task.await;
        }
        while !self.inner.lock().await.launching.is_empty() {
            time_sleep(DEMAND_POLL).await;
        }
        let (root, owned) = {
            let config = self.config.lock().await;
            let inner = self.inner.lock().await;
            (
                config.root.clone(),
                inner
                    .profiles
                    .iter()
                    .filter_map(|(name, runtime)| {
                        runtime
                            .launched
                            .as_ref()
                            .map(|launched| (name.clone(), launched.process.pid))
                    })
                    .collect::<BTreeMap<_, _>>(),
            )
        };
        if owned.is_empty() {
            return Ok(());
        }
        self.write_restart_marker(&root, &owned).await?;
        let mut first_error = None;
        for name in owned.keys() {
            if let Err(error) = self.stop_profile(name).await {
                first_error.get_or_insert(error);
            }
        }
        self.disarm_restart_marker(&root).await?;
        first_error.map_or(Ok(()), Err)
    }

    async fn disarm_restart_marker(&self, root: &std::path::Path) -> Result<(), FleetRuntimeError> {
        let marker = root.join("run").join("supervisor-restart.marker");
        match tokio::fs::remove_file(&marker).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(FleetRuntimeError::io(&marker, error)),
        }
    }

    async fn write_restart_marker(
        &self,
        root: &std::path::Path,
        owned: &BTreeMap<String, u32>,
    ) -> Result<(), FleetRuntimeError> {
        let run = root.join("run");
        tokio::fs::create_dir_all(&run)
            .await
            .map_err(|error| FleetRuntimeError::io(&run, error))?;
        let marker = run.join("supervisor-restart.marker");
        let temporary = run.join(format!(
            "supervisor-restart.marker.{}.tmp",
            std::process::id()
        ));
        let bytes = serde_json::to_vec(owned).expect("restart marker serializes");
        tokio::fs::write(&temporary, bytes)
            .await
            .map_err(|error| FleetRuntimeError::io(&temporary, error))?;
        tokio::fs::rename(&temporary, &marker)
            .await
            .map_err(|error| FleetRuntimeError::io(&marker, error))
    }

    async fn clear_own_shutdown(&self) -> Result<(), FleetRuntimeError> {
        let config = self.config.lock().await.clone();
        let marker = config.root.join("run").join("supervisor-restart.marker");
        let raw = match tokio::fs::read(&marker).await {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(FleetRuntimeError::io(&marker, error)),
        };
        // Old TypeScript markers contain no process identity. They cannot safely distinguish a
        // browser adopted after a prior shutdown, so discard them without signalling Chrome.
        if raw.iter().all(u8::is_ascii_whitespace) {
            return tokio::fs::remove_file(&marker)
                .await
                .map_err(|error| FleetRuntimeError::io(&marker, error));
        }
        let owned = serde_json::from_slice::<BTreeMap<String, u32>>(&raw).map_err(|error| {
            FleetRuntimeError::Profile(format!("invalid supervisor restart marker: {error}"))
        })?;
        let configured = config
            .profiles
            .iter()
            .map(|profile| profile.name.as_str())
            .collect::<BTreeSet<_>>();
        if owned.keys().any(|name| !configured.contains(name.as_str())) {
            return Err(FleetRuntimeError::Profile(
                "supervisor restart marker names an unknown profile".to_owned(),
            ));
        }
        for (name, pid) in &owned {
            let directory = config.root.join("profiles").join(name);
            if find_chrome_for_profile(&config.launch.chrome_path, &directory)
                .await?
                .contains(pid)
            {
                terminate_chrome_checked(*pid, Duration::from_secs(5)).await?;
            }
        }
        for name in owned.keys() {
            let pid_path = config.root.join("run").join(format!("{name}.pid"));
            let _ = tokio::fs::remove_file(pid_path).await;
        }
        tokio::fs::remove_file(&marker)
            .await
            .map_err(|error| FleetRuntimeError::io(&marker, error))
    }

    /// Reconcile a fresh config without orphaning a browser or starting disabled profiles.
    ///
    /// # Errors
    /// Propagates process lifecycle errors while continuing independently reachable profile work.
    pub async fn reload(&self, next: FleetRuntimeConfig) -> Result<(), FleetRuntimeError> {
        let was_parked = {
            let mut config = self.config.lock().await;
            let was_parked = config.parked;
            // Publish parking before termination so the monitor cannot revive a browser while it
            // is being intentionally stopped.
            *config = next.clone();
            was_parked
        };
        let existing = self
            .inner
            .lock()
            .await
            .profiles
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let wanted = next
            .profiles
            .iter()
            .map(|profile| profile.name.clone())
            .collect::<BTreeSet<_>>();
        if next.parked {
            for name in &existing {
                self.stop_profile(name).await?;
            }
        } else {
            for name in existing.iter().filter(|name| !wanted.contains(*name)) {
                self.stop_profile(name).await?;
            }
            for profile in &next.profiles {
                if !profile.enabled {
                    self.stop_profile(&profile.name).await?;
                }
            }
        }
        {
            let mut inner = self.inner.lock().await;
            inner.profiles.retain(|name, _| wanted.contains(name));
            for profile in &next.profiles {
                inner
                    .profiles
                    .entry(profile.name.clone())
                    .and_modify(|runtime| runtime.config = profile.clone())
                    .or_insert_with(|| RuntimeProfile::stopped(profile.clone()));
            }
        }
        if was_parked && !next.parked {
            let mut inner = self.inner.lock().await;
            for runtime in inner.profiles.values_mut() {
                runtime.started_by = None;
                runtime.idle_since = None;
            }
        }
        if !next.parked {
            for profile in next.profiles.iter().filter(|profile| profile.enabled) {
                self.adopt_or_launch(&profile.name).await?;
            }
        }
        Ok(())
    }

    /// Insert a profile that was durably saved by the provisioner, then launch it when unparked.
    ///
    /// # Errors
    /// Refuses a duplicate name and reports any launch failure.
    pub async fn register_profile(&self, profile: FleetProfile) -> Result<(), FleetRuntimeError> {
        {
            let mut config = self.config.lock().await;
            if config
                .profiles
                .iter()
                .any(|existing| existing.name == profile.name)
            {
                return Err(FleetRuntimeError::Profile(format!(
                    "profile already exists: {}",
                    profile.name
                )));
            }
            config.profiles.push(profile.clone());
        }
        {
            let mut inner = self.inner.lock().await;
            if inner
                .profiles
                .insert(
                    profile.name.clone(),
                    RuntimeProfile::stopped(profile.clone()),
                )
                .is_some()
            {
                return Err(FleetRuntimeError::Profile(format!(
                    "profile already exists: {}",
                    profile.name
                )));
            }
        }
        if profile.enabled && !self.config.lock().await.parked {
            self.adopt_or_launch(&profile.name).await?;
        }
        Ok(())
    }

    /// Apply the already-persisted parked state to running profile ownership.
    pub async fn set_parked(&self, parked: bool) -> Result<(), FleetRuntimeError> {
        let mut next = self.config.lock().await.clone();
        if next.parked == parked {
            return Ok(());
        }
        next.parked = parked;
        self.reload(next).await
    }

    /// Start or adopt one configured enabled profile.
    pub async fn start_profile(&self, name: &str) -> Result<(), FleetRuntimeError> {
        let enabled = {
            let mut inner = self.inner.lock().await;
            let runtime = inner
                .profiles
                .get_mut(name)
                .ok_or_else(|| FleetRuntimeError::Profile(format!("unknown profile: {name}")))?;
            runtime.stop_requested = false;
            runtime.config.enabled
        };
        if !enabled {
            return Err(FleetRuntimeError::Profile(format!(
                "profile {name} is not enabled"
            )));
        }
        self.adopt_or_launch(name).await
    }

    /// Snapshot cookies, close CDP, and terminate the known browser group.
    ///
    /// # Errors
    /// Returns an error without removing the PID record or dropping ownership when Chrome survives
    /// termination. An explicit stop may terminate an adopted profile only after revalidating its
    /// command line against the configured user-data directory.
    pub async fn stop_profile(&self, name: &str) -> Result<(), FleetRuntimeError> {
        loop {
            let launching = {
                let mut inner = self.inner.lock().await;
                let launching = inner.launching.contains(name);
                let runtime = inner.profiles.get_mut(name).ok_or_else(|| {
                    FleetRuntimeError::Profile(format!("unknown profile: {name}"))
                })?;
                runtime.stop_requested = true;
                runtime.started_by = None;
                runtime.idle_since = None;
                launching
            };
            if !launching {
                break;
            }
            time_sleep(DEMAND_POLL).await;
        }
        let (launched, pid, root, launch) = {
            let config = self.config.lock().await;
            let mut inner = self.inner.lock().await;
            let runtime = inner
                .profiles
                .get_mut(name)
                .ok_or_else(|| FleetRuntimeError::Profile(format!("unknown profile: {name}")))?;
            (
                runtime.launched.take(),
                runtime.pid.take(),
                config.root.clone(),
                config.launch.clone(),
            )
        };
        let adopted_pids = if launched.is_none() {
            match pid {
                Some(pid) if crate::platform::process_is_alive(pid) => vec![pid],
                _ => {
                    find_chrome_for_profile(&launch.chrome_path, &root.join("profiles").join(name))
                        .await?
                }
            }
        } else {
            Vec::new()
        };
        if let Some(launched) = launched {
            if let Err(error) =
                capture_session(&launched.process.cdp, &root.join("profiles").join(name)).await
            {
                let mut inner = self.inner.lock().await;
                if let Some(runtime) = inner.profiles.get_mut(name) {
                    runtime.pid = Some(launched.process.pid);
                    runtime.launched = Some(launched);
                    runtime.state = ProfileState::Running;
                    runtime.last_error = Some(error.to_string());
                }
                return Err(error);
            }
            if let Err(error) = launched
                .process
                .terminate_checked(Duration::from_secs(5))
                .await
            {
                let mut inner = self.inner.lock().await;
                if let Some(runtime) = inner.profiles.get_mut(name) {
                    runtime.pid = Some(launched.process.pid);
                    runtime.launched = Some(launched);
                    runtime.state = ProfileState::Running;
                    runtime.last_error = Some(error.to_string());
                }
                return Err(error);
            }
        } else {
            let profile_dir = root.join("profiles").join(name);
            for pid in adopted_pids {
                if !crate::platform::process_is_alive(pid) {
                    continue;
                }
                if !find_chrome_for_profile(&launch.chrome_path, &profile_dir)
                    .await?
                    .contains(&pid)
                {
                    // Chrome can exit while the asynchronous process inspection is running.
                    // Only a still-live mismatched PID is evidence of lost ownership.
                    if !crate::platform::process_is_alive(pid) {
                        continue;
                    }
                    let error = FleetRuntimeError::Process(format!(
                        "refusing to terminate pid {pid}: it no longer owns profile {name}"
                    ));
                    if let Some(runtime) = self.inner.lock().await.profiles.get_mut(name) {
                        runtime.pid = Some(pid);
                        runtime.state = ProfileState::Running;
                        runtime.last_error = Some(error.to_string());
                    }
                    return Err(error);
                }
                if let Err(error) = terminate_chrome_checked(pid, Duration::from_secs(5)).await {
                    if let Some(runtime) = self.inner.lock().await.profiles.get_mut(name) {
                        runtime.pid = Some(pid);
                        runtime.state = ProfileState::Running;
                        runtime.last_error = Some(error.to_string());
                    }
                    return Err(error);
                }
            }
        }
        let pid_path = root.join("run").join(format!("{name}.pid"));
        let _ = tokio::fs::remove_file(pid_path).await;
        if let Some(runtime) = self.inner.lock().await.profiles.get_mut(name) {
            runtime.launched = None;
            runtime.pid = None;
            runtime.healthy_since = None;
            runtime.ping_failures = 0;
            runtime.state = ProfileState::Stopped;
        }
        Ok(())
    }

    /// Replace a profile while retaining demand provenance for a parked lease.
    pub async fn restart_profile(&self, name: &str) -> Result<(), FleetRuntimeError> {
        let started_by = self
            .inner
            .lock()
            .await
            .profiles
            .get(name)
            .and_then(|runtime| runtime.started_by.clone());
        self.stop_profile(name).await?;
        self.start_profile(name).await?;
        if let Some(started_by) = started_by
            && let Some(runtime) = self.inner.lock().await.profiles.get_mut(name)
        {
            runtime.started_by = Some(started_by);
        }
        Ok(())
    }

    /// Demand a parked browser and wait until its bridge answers loopback `/ping`.
    pub async fn demand_start(
        &self,
        name: &str,
        reason: DemandReason,
    ) -> Result<(), ProfileStartError> {
        let config = self.config.lock().await.clone();
        {
            let mut inner = self.inner.lock().await;
            let Some(runtime) = inner.profiles.get_mut(name) else {
                return Err(ProfileStartError {
                    code: "profile_start_failed",
                    profile: name.to_owned(),
                    message: "unknown profile".to_owned(),
                    timeout: None,
                });
            };
            if !runtime.config.enabled {
                return Err(ProfileStartError {
                    code: "profile_start_failed",
                    profile: name.to_owned(),
                    message: format!("profile {name} is not enabled"),
                    timeout: None,
                });
            }
            runtime.stop_requested = false;
            if config.parked {
                runtime.started_by = Some(reason);
            }
            runtime.idle_since = None;
        }
        self.adopt_or_launch(name)
            .await
            .map_err(|error| ProfileStartError {
                code: "profile_start_failed",
                profile: name.to_owned(),
                message: error.to_string(),
                timeout: None,
            })?;
        let deadline = Instant::now() + config.demand_start_timeout;
        loop {
            let (port, error) = {
                let inner = self.inner.lock().await;
                let runtime = inner
                    .profiles
                    .get(name)
                    .expect("profile remains during demand");
                (runtime.config.port, runtime.last_error.clone())
            };
            if self.probe_bridge(port).await {
                self.mark_healthy(name).await;
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(ProfileStartError {
                    code: "profile_start_timeout",
                    profile: name.to_owned(),
                    message: error.unwrap_or_else(|| "browser did not start".to_owned()),
                    timeout: Some(config.demand_start_timeout),
                });
            }
            time_sleep(DEMAND_POLL).await;
        }
    }

    /// Stop parked browsers whose demand lease has remained absent for their configured idle TTL.
    pub async fn reap_idle(&self, is_leased: impl Fn(&str) -> bool) -> Vec<String> {
        let now = Instant::now();
        let candidates = {
            let mut inner = self.inner.lock().await;
            inner
                .profiles
                .iter_mut()
                .filter_map(|(name, runtime)| {
                    if runtime.started_by.is_none() || is_leased(name) {
                        runtime.idle_since = None;
                        return None;
                    }
                    let idle_since = *runtime.idle_since.get_or_insert(now);
                    let idle = runtime.config.idle_stop.unwrap_or(DEFAULT_IDLE_STOP);
                    (idle > Duration::ZERO && now.duration_since(idle_since) >= idle)
                        .then(|| name.clone())
                })
                .collect::<Vec<_>>()
        };
        let mut reaped = Vec::new();
        for name in candidates {
            if self.stop_profile(&name).await.is_ok() {
                reaped.push(name);
            }
        }
        reaped
    }

    /// Return snapshots ordered by profile name, attaching lease ownership supplied by the gateway.
    pub async fn snapshot(
        &self,
        leased_by: impl Fn(&str) -> Option<String>,
    ) -> Vec<ProfileSnapshot> {
        self.inner
            .lock()
            .await
            .profiles
            .values()
            .map(|runtime| ProfileSnapshot {
                name: runtime.config.name.clone(),
                port: runtime.config.port,
                labels: runtime.config.labels.clone(),
                purpose: runtime.config.purpose.clone(),
                enabled: runtime.config.enabled,
                state: runtime.state,
                pid: runtime.pid,
                leased_by: leased_by(&runtime.config.name),
                last_error: runtime.last_error.clone(),
                started_by: runtime.started_by.clone(),
            })
            .collect()
    }

    /// Return snapshots without a gateway lease overlay.
    pub async fn snapshot_unleased(&self) -> Vec<ProfileSnapshot> {
        self.snapshot(|_| None).await
    }

    async fn spawn_timers(&self) {
        let mut timer_tasks = self.timer_tasks.lock().await;
        if !timer_tasks.is_empty() {
            return;
        }
        let supervisor = self.clone();
        let cancellation = self.cancellation.child_token();
        timer_tasks.push(tokio::spawn(async move {
            let mut monitor = tokio::time::interval(MONITOR_INTERVAL);
            let mut health = tokio::time::interval(HEALTH_INTERVAL);
            let mut sessions = tokio::time::interval(SESSION_INTERVAL);
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => return,
                    _ = monitor.tick() => supervisor.monitor_once().await,
                    _ = health.tick() => supervisor.check_health_once().await,
                    _ = sessions.tick() => supervisor.capture_sessions().await,
                }
            }
        }));
    }

    async fn monitor_once(&self) {
        if self.inner.lock().await.stopping {
            return;
        }
        let parked = self.config.lock().await.parked;
        let candidates = {
            let inner = self.inner.lock().await;
            inner
                .profiles
                .iter()
                .filter(|(name, runtime)| {
                    runtime.config.enabled
                        && !runtime.stop_requested
                        && (!parked || runtime.started_by.is_some())
                        && !inner.launching.contains(*name)
                        && runtime.next_restart <= Instant::now()
                        && runtime
                            .pid
                            .is_none_or(|pid| !crate::platform::process_is_alive(pid))
                })
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>()
        };
        for name in candidates {
            let _ = self.adopt_or_launch(&name).await;
        }
    }

    async fn check_health_once(&self) {
        let active = self
            .inner
            .lock()
            .await
            .profiles
            .iter()
            .filter_map(|(name, runtime)| runtime.pid.map(|_| (name.clone(), runtime.config.port)))
            .collect::<Vec<_>>();
        for (name, port) in active {
            if self.probe_bridge(port).await {
                self.mark_healthy(&name).await;
                continue;
            }
            let replace = {
                let mut inner = self.inner.lock().await;
                let Some(runtime) = inner.profiles.get_mut(&name) else {
                    continue;
                };
                if runtime.state == ProfileState::Stopped || runtime.stop_requested {
                    continue;
                }
                runtime.state = ProfileState::Running;
                runtime.ping_failures = runtime.ping_failures.saturating_add(1);
                runtime.ping_failures >= PING_FAILURES_BEFORE_REPLACE
            };
            if replace {
                let _ = self.replace_unreachable(&name).await;
            }
        }
    }

    async fn capture_sessions(&self) {
        let root = self.config.lock().await.root.clone();
        let mut inner = self.inner.lock().await;
        if inner.stopping {
            return;
        }
        for (name, runtime) in &mut inner.profiles {
            if let Some(launched) = &runtime.launched {
                let _ =
                    capture_session(&launched.process.cdp, &root.join("profiles").join(name)).await;
            }
        }
    }

    async fn mark_healthy(&self, name: &str) {
        if let Some(runtime) = self.inner.lock().await.profiles.get_mut(name) {
            let was_healthy = runtime.state == ProfileState::Healthy;
            runtime.state = ProfileState::Healthy;
            runtime.ping_failures = 0;
            if !was_healthy {
                runtime.healthy_since = Some(Instant::now());
            }
            if runtime
                .healthy_since
                .is_some_and(|since| since.elapsed() > Duration::from_secs(300))
            {
                runtime.backoff = MONITOR_INTERVAL;
            }
        }
    }

    async fn replace_unreachable(&self, name: &str) -> Result<(), FleetRuntimeError> {
        {
            let mut inner = self.inner.lock().await;
            let runtime = inner
                .profiles
                .get_mut(name)
                .ok_or_else(|| FleetRuntimeError::Profile(format!("unknown profile: {name}")))?;
            runtime.ping_failures = 0;
            runtime.healthy_since = None;
            runtime.last_error = Some("bridge unreachable; browser replaced".to_owned());
        }
        self.restart_profile(name).await
    }

    async fn adopt_or_launch(&self, name: &str) -> Result<(), FleetRuntimeError> {
        {
            let inner = self.inner.lock().await;
            let runtime = inner
                .profiles
                .get(name)
                .ok_or_else(|| FleetRuntimeError::Profile(format!("unknown profile: {name}")))?;
            if inner.stopping
                || runtime.stop_requested
                || runtime.pid.is_some_and(crate::platform::process_is_alive)
            {
                return Ok(());
            }
        }
        if self.try_adopt(name).await? {
            return Ok(());
        }
        let profile = {
            let mut inner = self.inner.lock().await;
            if inner.launching.contains(name) {
                return Ok(());
            }
            let stopping = inner.stopping;
            let runtime = inner
                .profiles
                .get_mut(name)
                .ok_or_else(|| FleetRuntimeError::Profile(format!("unknown profile: {name}")))?;
            if stopping
                || runtime.stop_requested
                || runtime.pid.is_some_and(crate::platform::process_is_alive)
            {
                return Ok(());
            }
            runtime.state = ProfileState::Starting;
            let profile = runtime.config.clone();
            inner.launching.insert(name.to_owned());
            profile
        };
        let config = self.config.lock().await.clone();
        let directory = config.root.join("profiles").join(name);
        let outcome: Result<_, FleetRuntimeError> = async {
            tokio::fs::create_dir_all(&directory)
                .await
                .map_err(|error| FleetRuntimeError::io(&directory, error))?;
            let launched =
                launch_profile_with_extension(&config.launch, name, &directory, profile.port)
                    .await?;
            let label = label_for(&profile.name, profile.purpose.as_deref());
            let _ = apply_window_label(&launched.process.cdp, &directory, &label).await;
            let _ = close_onboarding_tabs(&launched.process.cdp, &launched.extension_id).await;
            Ok(launched)
        }
        .await;
        let mut inner = self.inner.lock().await;
        inner.launching.remove(name);
        let Some(runtime) = inner.profiles.get_mut(name) else {
            if let Ok(launched) = outcome {
                drop(inner);
                let _ = launched.process.terminate_checked(Duration::ZERO).await;
            }
            return Ok(());
        };
        match outcome {
            Ok(launched) => {
                runtime.pid = Some(launched.process.pid);
                runtime.launched = Some(launched);
                runtime.state = ProfileState::Running;
                runtime.healthy_since = None;
                runtime.ping_failures = 0;
                runtime.last_error = None;
                runtime.backoff = MONITOR_INTERVAL;
                runtime.next_restart = Instant::now();
                let pid_path = config.root.join("run").join(format!("{name}.pid"));
                let pid = runtime.pid.expect("launch returned a pid").to_string();
                drop(inner);
                let _ = tokio::fs::create_dir_all(config.root.join("run")).await;
                let _ = tokio::fs::write(pid_path, pid).await;
                Ok(())
            }
            Err(error) => {
                runtime.pid = None;
                runtime.launched = None;
                runtime.state = ProfileState::Backoff;
                runtime.last_error = Some(error.to_string());
                runtime.next_restart = Instant::now() + runtime.backoff;
                runtime.backoff = (runtime.backoff * 2).min(BACKOFF_MAX);
                Err(error)
            }
        }
    }

    async fn try_adopt(&self, name: &str) -> Result<bool, FleetRuntimeError> {
        let config = self.config.lock().await.clone();
        let profile_dir = config.root.join("profiles").join(name);
        let mut pids = find_chrome_for_profile(&config.launch.chrome_path, &profile_dir).await?;
        let Some(keep) = pids.first().copied() else {
            return Ok(false);
        };
        for duplicate in pids.drain(1..) {
            terminate_chrome_checked(duplicate, Duration::from_secs(5)).await?;
        }
        let port = self
            .inner
            .lock()
            .await
            .profiles
            .get(name)
            .ok_or_else(|| FleetRuntimeError::Profile(format!("unknown profile: {name}")))?
            .config
            .port;
        if !self.probe_bridge(port).await {
            terminate_chrome_checked(keep, Duration::from_secs(5)).await?;
            return Ok(false);
        }
        let mut inner = self.inner.lock().await;
        let stopping = inner.stopping;
        let runtime = inner.profiles.get_mut(name).expect("profile checked above");
        if stopping || runtime.stop_requested {
            return Ok(false);
        }
        runtime.pid = Some(keep);
        runtime.launched = None;
        runtime.state = ProfileState::Running;
        runtime.last_error = None;
        drop(inner);
        let run = config.root.join("run");
        let _ = tokio::fs::create_dir_all(&run).await;
        let _ = tokio::fs::write(run.join(format!("{name}.pid")), keep.to_string()).await;
        Ok(true)
    }

    async fn probe_bridge(&self, port: u16) -> bool {
        let Ok(response) = self
            .http
            .get(format!("http://127.0.0.1:{port}/ping"))
            .send()
            .await
        else {
            return false;
        };
        let Ok(body) = response.json::<Value>().await else {
            return false;
        };
        body.get("status").and_then(Value::as_str) == Some("ok")
    }
}

async fn time_sleep(duration: Duration) {
    tokio::time::sleep(duration).await;
}
