//! Long-lived fleet worker and coordinator command handlers.

use std::{
    collections::HashMap,
    future::IntoFuture,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;
use tokio::{net::TcpListener, sync::oneshot};

use crate::{
    cli::RegistrationContext,
    fleet::{
        config::{ConfigStore, validate_profile_name},
        coordinator::{CoordinatorConfig, FleetCoordinator},
        runtime::{
            FleetGateway, FleetLeases, FleetNode, GatewayConfig, ProfileProvisioner,
            ProfileSupervisor,
        },
        worker::{
            NativeWorkerFleetConfig, NativeWorkerProvisioner, NativeWorkerSupervisor, WorkerConfig,
            WorkerHttp, WorkerState, worker_config_path, worker_fences_path,
        },
    },
};

/// Launchd-owned server role selected by an agent command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetAgent {
    /// The legacy local gateway and profile supervisor.
    Gateway,
    /// The dedicated authenticated coordinator worker.
    Worker,
}

/// Profile lifecycle action requested by the CLI.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileAction {
    /// Start one configured profile.
    Start,
    /// Stop one configured profile.
    Stop,
    /// Stop and then start one configured profile.
    Restart,
}

impl ProfileAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

/// Fleet command selected by the native CLI.
#[derive(Clone, Debug)]
pub enum FleetCommand {
    /// Serve an authenticated worker using an explicit fleet root and verified native host.
    WorkerServe {
        /// Fleet-owned profile and configuration root.
        root: PathBuf,
        /// User home used only for the configured daily-profile boundary.
        home: PathBuf,
        /// Native host executable to verify before profile provisioning is enabled.
        host_path: PathBuf,
    },
    /// Serve the standalone fleet gateway using the persisted fleet configuration.
    GatewayServe {
        /// Fleet-owned profile and configuration root.
        root: PathBuf,
        /// User home used only for the configured daily-profile boundary.
        home: PathBuf,
        /// Native host executable to verify before profile provisioning is enabled.
        host_path: PathBuf,
    },
    /// Serve the PostgreSQL-backed coordinator configured by an explicit JSON file.
    CoordinatorServe {
        /// Private coordinator configuration JSON.
        config_path: PathBuf,
    },
    /// Initialize a durable fleet configuration.
    Init {
        /// Fleet root to initialize.
        root: PathBuf,
        /// Home used by the default configuration.
        home: PathBuf,
        /// LAN gateway listener port.
        gateway_port: u16,
        /// First profile allocation port.
        base_port: u16,
        /// Optional explicit LAN bearer token.
        token: Option<String>,
        /// Print the existing or newly configured LAN token.
        print_token: bool,
        /// Rotate both LAN and local bridge credentials.
        force_new_token: bool,
    },
    /// Prepare the Chrome extension template profile.
    TemplateInit {
        root: PathBuf,
        home: PathBuf,
        host_path: PathBuf,
    },
    /// Provision a profile from a seed or an empty template.
    ProfileAdd {
        root: PathBuf,
        home: PathBuf,
        host_path: PathBuf,
        name: String,
        labels: Vec<String>,
        seed: Option<PathBuf>,
        no_seed: bool,
    },
    /// Ask a running profile bridge whether Google reports a live session.
    ProfileVerify {
        root: PathBuf,
        home: PathBuf,
        name: String,
    },
    /// Start, stop, or restart one profile through the owning gateway when present.
    ProfileControl {
        root: PathBuf,
        home: PathBuf,
        name: String,
        action: ProfileAction,
    },
    /// Create a dedicated worker root, its credentials, template, and first browser.
    WorkerInit {
        root: PathBuf,
        home: PathBuf,
        host_path: PathBuf,
        id: String,
        host: String,
        port: u16,
        base_port: u16,
        token: Option<String>,
        profiles: Vec<String>,
        seed_sources: Vec<String>,
        /// Optional explicit browser executable; installed-path default is unchanged.
        chrome_path: Option<PathBuf>,
        /// Optional explicit keyed extension build; installed-path default is unchanged.
        extension_dir: Option<PathBuf>,
    },
    /// Install a launchd agent only after the operator explicitly opts in.
    AgentInstall {
        root: PathBuf,
        home: PathBuf,
        host_path: PathBuf,
        agent: FleetAgent,
        allow_agent_install: bool,
    },
    /// Remove a launchd agent only after the operator explicitly opts in.
    AgentUninstall {
        root: PathBuf,
        home: PathBuf,
        agent: FleetAgent,
        allow_agent_install: bool,
    },
    /// Query fleet status through the live gateway or persisted configuration.
    Status { root: PathBuf, home: PathBuf },
    /// List persisted fleet profiles.
    ProfileList { root: PathBuf, home: PathBuf },
    /// Remove a profile and optionally its owned data.
    ProfileRemove {
        root: PathBuf,
        home: PathBuf,
        name: String,
        delete_data: bool,
    },
    /// Enable or disable a persisted profile.
    ProfileEnable {
        root: PathBuf,
        home: PathBuf,
        name: String,
        enabled: bool,
    },
    /// Park or unpark the fleet.
    Park {
        root: PathBuf,
        home: PathBuf,
        parked: bool,
    },
    /// List configured fleet peers.
    NodeList { root: PathBuf, home: PathBuf },
    /// Add or update a peer.
    NodeAdd {
        root: PathBuf,
        home: PathBuf,
        id: String,
        host: String,
        port: u16,
        token: Option<String>,
    },
    /// Remove a peer.
    NodeRemove {
        root: PathBuf,
        home: PathBuf,
        id: String,
    },
    /// Bind a purpose to a profile.
    PurposeAdd {
        root: PathBuf,
        home: PathBuf,
        purpose: String,
        profile: String,
    },
    /// Remove a purpose binding.
    PurposeRemove {
        root: PathBuf,
        home: PathBuf,
        purpose: String,
    },
    /// List all purpose bindings.
    PurposeList { root: PathBuf, home: PathBuf },
}

/// Executes a fleet command, returning user-visible output after completion.
///
/// # Errors
/// Returns startup, configuration, listener, or serving errors with their concrete cause.
pub async fn serve_fleet(
    registration: &RegistrationContext,
    command: &FleetCommand,
) -> Result<super::CliOutput, String> {
    use super::fleet_ops;
    let finished =
        |result: Result<(), String>| result.map(|()| "fleet server stopped\n".to_owned());
    let rendered = |value: &Value| {
        serde_json::to_string_pretty(value)
            .map(|value| format!("{value}\n"))
            .map_err(|error| error.to_string())
    };
    let stdout = match command {
        FleetCommand::WorkerServe {
            root,
            home,
            host_path,
        } => finished(serve_worker(registration, root, home, host_path).await),
        FleetCommand::GatewayServe {
            root,
            home,
            host_path,
        } => finished(serve_gateway(registration, root, home, host_path).await),
        FleetCommand::CoordinatorServe { config_path } => {
            finished(serve_coordinator(config_path).await)
        }
        FleetCommand::Init {
            root,
            home,
            gateway_port,
            base_port,
            token,
            print_token,
            force_new_token,
        } => {
            let store = ConfigStore::new(root.clone(), home.clone());
            let printing_only = !force_new_token && *print_token && token.is_none();
            let setting_token = !force_new_token && token.is_some();
            let mut config = if printing_only || setting_token {
                store.load().await.map_err(|error| error.to_string())?
            } else if store.path().exists() {
                if !force_new_token {
                    return Err(
                        "fleet already initialized — use --force-new-token to rotate credentials"
                            .into(),
                    );
                }
                let mut existing = store.load().await.map_err(|error| error.to_string())?;
                let fresh = store
                    .default_config(*gateway_port, *base_port)
                    .map_err(|error| error.to_string())?;
                existing["bridgeToken"] = fresh["bridgeToken"].clone();
                existing["token"] = store
                    .default_config(*gateway_port, *base_port)
                    .map_err(|error| error.to_string())?["bridgeToken"]
                    .clone();
                existing
            } else {
                store
                    .default_config(*gateway_port, *base_port)
                    .map_err(|error| error.to_string())?
            };
            if printing_only {
                return Ok(super::CliOutput::success(format!(
                    "LAN token: {}\n",
                    config
                        .get("token")
                        .and_then(Value::as_str)
                        .unwrap_or("(client auth off)")
                )));
            }
            if let Some(token) = token {
                if token != "none"
                    && (token.len() < 32 || !token.as_bytes().iter().all(u8::is_ascii_hexdigit))
                {
                    return Err("--token must be 32 or more hex characters, or \"none\"".into());
                }
                config["token"] = if token == "none" {
                    Value::Null
                } else {
                    Value::String(token.clone())
                };
            }
            store
                .save(&config)
                .await
                .map_err(|error| error.to_string())?;
            let mut headers = serde_json::Map::new();
            headers.insert(
                "X-Humanchrome-Agent".into(),
                Value::String("<agent-name>".into()),
            );
            if let Some(token) = config.get("token").and_then(Value::as_str) {
                headers.insert(
                    "Authorization".into(),
                    Value::String(format!("Bearer {token}")),
                );
            }
            let port = config["gateway"]["port"]
                .as_u64()
                .ok_or("invalid gateway port")?;
            let snippet = rendered(&serde_json::json!({"mcpServers":{
                "humanchrome":{"type":"http","url":format!("http://<mac-host>:{port}/v1/pool/any/mcp"),"headers":headers},
                "humanchromeFleet":{"type":"http","url":format!("http://<mac-host>:{port}/v1/fleet/mcp"),"headers":headers}
            }}))?;
            Ok(if *print_token {
                format!(
                    "LAN token: {}\n{snippet}",
                    config
                        .get("token")
                        .and_then(Value::as_str)
                        .unwrap_or("(client auth off)")
                )
            } else {
                snippet
            })
        }
        FleetCommand::TemplateInit {
            root,
            home,
            host_path,
        } => {
            let verified = registration
                .verify_native_host(host_path)
                .await
                .map_err(|error| error.to_string())?;
            fleet_ops::initialize_template(ConfigStore::new(root.clone(), home.clone()), &verified)
                .await?;
            Ok("fleet template initialized\n".into())
        }
        FleetCommand::ProfileAdd {
            root,
            home,
            host_path,
            name,
            labels,
            seed,
            no_seed,
        } => {
            let store = ConfigStore::new(root.clone(), home.clone());
            let config = store.load().await.map_err(|error| error.to_string())?;
            let seed = if *no_seed {
                None
            } else {
                match seed {
                    Some(path) if path != std::path::Path::new("daily") => Some(path.clone()),
                    _ => Some(
                        config
                            .get("dailyProfileDir")
                            .and_then(Value::as_str)
                            .map(PathBuf::from)
                            .unwrap_or_else(|| store.default_daily_profile_dir()),
                    ),
                }
            };
            let verified = registration
                .verify_native_host(host_path)
                .await
                .map_err(|error| error.to_string())?;
            let added =
                fleet_ops::add_profile(store, &verified, name, labels.clone(), seed.as_deref())
                    .await?;
            Ok(format!(
                "added {}\n",
                serde_json::to_string(&added).map_err(|error| error.to_string())?
            ))
        }
        FleetCommand::ProfileVerify { root, home, name } => {
            let store = ConfigStore::new(root.clone(), home.clone());
            let result = fleet_ops::verify_profile(&store, name).await?;
            let state = result
                .pointer("/google/state")
                .and_then(Value::as_str)
                .ok_or_else(|| "Google verification returned no state".to_owned())?;
            return Ok(super::CliOutput {
                exit_code: u8::from(state != "session"),
                stdout: rendered(&result)?,
                stderr: if state == "session" {
                    String::new()
                } else {
                    format!(
                        "{name} is not signed in to Google ({state}): sign in once in its window; the session then persists in the profile\n"
                    )
                },
            });
        }
        FleetCommand::ProfileControl {
            root,
            home,
            name,
            action,
        } => {
            let store = ConfigStore::new(root.clone(), home.clone());
            fleet_ops::profile_control(&store, name, action.as_str()).await?;
            Ok(format!("{} {name}\n", action.as_str()))
        }
        FleetCommand::WorkerInit {
            root,
            home,
            host_path,
            id,
            host,
            port,
            base_port,
            token,
            profiles,
            seed_sources,
            chrome_path,
            extension_dir,
        } => rendered(
            &initialize_worker(WorkerInitialization {
                registration,
                root,
                home,
                host_path,
                id,
                host,
                port: *port,
                base_port: *base_port,
                token: token.as_deref(),
                extra_profiles: profiles,
                seed_source_entries: seed_sources,
                chrome_path: chrome_path.as_deref(),
                extension_dir: extension_dir.as_deref(),
            })
            .await?,
        ),
        FleetCommand::AgentInstall {
            root,
            home,
            host_path,
            agent,
            allow_agent_install,
        } => fleet_ops::install_agent(root, home, host_path, *agent, *allow_agent_install).await,
        FleetCommand::AgentUninstall {
            root,
            home,
            agent,
            allow_agent_install,
        } => fleet_ops::uninstall_agent(root, home, *agent, *allow_agent_install).await,
        FleetCommand::Status { root, home } => {
            let store = ConfigStore::new(root.clone(), home.clone());
            let config = store.load().await.map_err(|error| error.to_string())?;
            let parked = config.get("parked").cloned().unwrap_or(Value::Bool(false));
            if fleet_ops::live_serve_pid(&store).await?.is_some() {
                let status = fleet_ops::GatewayControl::from_store(&store)
                    .await?
                    .status()
                    .await?;
                rendered(
                    &serde_json::json!({"serve":"up","parked":parked,"profiles":status["profiles"],"leases":status["leases"]}),
                )
            } else {
                let runtime = NativeWorkerFleetConfig::new(store)
                    .load()
                    .await
                    .map_err(|error| error.to_string())?;
                let supervisor = ProfileSupervisor::new(runtime.runtime().clone())
                    .map_err(|error| error.to_string())?;
                let profiles =
                    crate::fleet::runtime::profiles_to_json(supervisor.snapshot_unleased().await);
                rendered(&serde_json::json!({"serve":"down","parked":parked,"profiles":profiles}))
            }
        }
        FleetCommand::ProfileList { root, home } => rendered(&Value::Array(
            fleet_ops::profiles(&ConfigStore::new(root.clone(), home.clone()))
                .await
                .map_err(|error| error.to_string())?,
        )),
        FleetCommand::ProfileRemove {
            root,
            home,
            name,
            delete_data,
        } => {
            fleet_ops::remove_profile(
                &ConfigStore::new(root.clone(), home.clone()),
                name,
                *delete_data,
            )
            .await
            .map_err(|error| error.to_string())?;
            Ok(format!("{name} removed\n"))
        }
        FleetCommand::ProfileEnable {
            root,
            home,
            name,
            enabled,
        } => {
            let store = ConfigStore::new(root.clone(), home.clone());
            let config = store.load().await.map_err(|error| error.to_string())?;
            let profile = config["profiles"]
                .as_array()
                .and_then(|profiles| {
                    profiles
                        .iter()
                        .find(|profile| profile.get("name").and_then(Value::as_str) == Some(name))
                })
                .ok_or_else(|| format!("unknown profile: {name}"))?;
            let current = profile
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if current == *enabled {
                return Ok(super::CliOutput::success(format!(
                    "{name} already {}\n",
                    if *enabled { "enabled" } else { "disabled" }
                )));
            }
            fleet_ops::set_profile_enabled(&store, name, *enabled)
                .await
                .map_err(|error| error.to_string())?;
            fleet_ops::signal_gateway_reload(&store).await?;
            Ok(format!(
                "{name} {}\n",
                if *enabled { "enabled" } else { "disabled" }
            ))
        }
        FleetCommand::Park { root, home, parked } => {
            let store = ConfigStore::new(root.clone(), home.clone());
            let config = store.load().await.map_err(|error| error.to_string())?;
            let current = config
                .get("parked")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if current == *parked {
                return Ok(super::CliOutput::success(format!(
                    "fleet already {}\n",
                    if *parked { "parked" } else { "running" }
                )));
            }
            if fleet_ops::live_serve_pid(&store).await?.is_some() {
                fleet_ops::GatewayControl::from_store(&store)
                    .await?
                    .park(*parked)
                    .await?;
            } else {
                fleet_ops::set_parked(&store, *parked)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(format!(
                "fleet {}\n",
                if *parked { "parked" } else { "running" }
            ))
        }
        FleetCommand::NodeList { root, home } => rendered(
            &fleet_ops::nodes(&ConfigStore::new(root.clone(), home.clone()))
                .await
                .map_err(|error| error.to_string())?,
        ),
        FleetCommand::NodeAdd {
            root,
            home,
            id,
            host,
            port,
            token,
        } => {
            fleet_ops::upsert_node(
                &ConfigStore::new(root.clone(), home.clone()),
                id,
                host,
                *port,
                token.as_deref(),
            )
            .await
            .map_err(|error| error.to_string())?;
            Ok(format!("node {id} added\n"))
        }
        FleetCommand::NodeRemove { root, home, id } => {
            fleet_ops::remove_node(&ConfigStore::new(root.clone(), home.clone()), id)
                .await
                .map_err(|error| error.to_string())?;
            Ok(format!("node {id} removed\n"))
        }
        FleetCommand::PurposeAdd {
            root,
            home,
            purpose,
            profile,
        } => {
            fleet_ops::add_purpose(
                &ConfigStore::new(root.clone(), home.clone()),
                purpose,
                profile,
            )
            .await
            .map_err(|error| error.to_string())?;
            Ok(format!("purpose {purpose} bound to {profile}\n"))
        }
        FleetCommand::PurposeRemove {
            root,
            home,
            purpose,
        } => {
            fleet_ops::remove_purpose(&ConfigStore::new(root.clone(), home.clone()), purpose)
                .await
                .map_err(|error| error.to_string())?;
            Ok(format!("purpose {purpose} removed\n"))
        }
        FleetCommand::PurposeList { root, home } => rendered(&Value::Array(
            fleet_ops::purposes(&ConfigStore::new(root.clone(), home.clone()))
                .await
                .map_err(|error| error.to_string())?,
        )),
    }?;
    Ok(super::CliOutput::success(stdout))
}

struct WorkerInitialization<'a> {
    registration: &'a RegistrationContext,
    root: &'a Path,
    home: &'a Path,
    host_path: &'a Path,
    id: &'a str,
    host: &'a str,
    port: u16,
    base_port: u16,
    token: Option<&'a str>,
    extra_profiles: &'a [String],
    seed_source_entries: &'a [String],
    chrome_path: Option<&'a Path>,
    extension_dir: Option<&'a Path>,
}

async fn initialize_worker(request: WorkerInitialization<'_>) -> Result<Value, String> {
    let WorkerInitialization {
        registration,
        root,
        home,
        host_path,
        id,
        host,
        port,
        base_port,
        token,
        extra_profiles,
        seed_source_entries,
        chrome_path,
        extension_dir,
    } = request;
    let default_root = home.join("Library/Application Support/humanchrome-fleet");
    if root == default_root {
        return Err("worker requires a dedicated non-default --root".to_owned());
    }
    if port == 0 {
        return Err("invalid worker port".to_owned());
    }
    if base_port < 1025 || base_port == port {
        return Err("invalid worker base port".to_owned());
    }

    let store = ConfigStore::new(root.to_path_buf(), home.to_path_buf());
    let worker_path = worker_config_path(root);
    if tokio::fs::try_exists(&worker_path)
        .await
        .map_err(|error| error.to_string())?
    {
        return Err(format!("worker already initialized at {}", root.display()));
    }
    if tokio::fs::try_exists(store.path())
        .await
        .map_err(|error| error.to_string())?
    {
        return Err(format!(
            "refusing to replace existing fleet root {}",
            root.display()
        ));
    }

    let mut profiles = Vec::with_capacity(extra_profiles.len() + 1);
    profiles.push("browser".to_owned());
    profiles.extend(extra_profiles.iter().cloned());
    let seed_sources = parse_seed_sources(seed_source_entries, &store)?;
    let config = WorkerConfig {
        id: id.to_owned(),
        host: host.to_owned(),
        port,
        token: match token {
            Some(token) => token.to_owned(),
            None => random_token()?,
        },
        profiles,
        seed_sources,
    };
    config.validate().map_err(|error| error.to_string())?;

    let mut fleet_config = store
        .default_config(12300, base_port)
        .map_err(|error| error.to_string())?;
    for (field, flag, path) in [
        ("chromePath", "--chrome-path", chrome_path),
        ("extensionDir", "--extension-dir", extension_dir),
    ] {
        if let Some(path) = path {
            let path = tokio::fs::canonicalize(path)
                .await
                .map_err(|error| format!("cannot resolve {flag}: {error}"))?;
            let path = path
                .to_str()
                .ok_or_else(|| format!("{flag} must be a UTF-8 path"))?;
            fleet_config[field] = Value::String(path.to_owned());
        }
    }
    config
        .save(&worker_path)
        .await
        .map_err(|error| error.to_string())?;
    store
        .save(&fleet_config)
        .await
        .map_err(|error| error.to_string())?;

    let verified = registration
        .verify_native_host(host_path)
        .await
        .map_err(|error| error.to_string())?;
    super::fleet_ops::initialize_template(store.clone(), &verified).await?;
    let seed = config.seed_sources.get("daily").and_then(Option::as_deref);
    super::fleet_ops::add_profile(store, &verified, "browser", Vec::new(), seed).await?;

    Ok(serde_json::json!({
        "id": config.id,
        "host": config.host,
        "port": config.port,
        "token": config.token,
    }))
}

fn parse_seed_sources(
    entries: &[String],
    store: &ConfigStore,
) -> Result<HashMap<String, Option<PathBuf>>, String> {
    let mut sources = HashMap::from([
        ("daily".to_owned(), Some(store.default_daily_profile_dir())),
        ("empty".to_owned(), None),
    ]);
    for entry in entries {
        let Some((name, source)) = entry.split_once('=') else {
            return Err("--seed-source must be name=/absolute/path or name=null".to_owned());
        };
        if name.is_empty() {
            return Err("--seed-source must be name=/absolute/path or name=null".to_owned());
        }
        validate_profile_name(name)
            .map_err(|error| format!("invalid seed source {name}: {error}"))?;
        let path = if source == "null" {
            None
        } else {
            let source = PathBuf::from(source);
            if !source.is_absolute() {
                return Err(format!("seed source {name} must be an absolute path"));
            }
            Some(source)
        };
        sources.insert(name.to_owned(), path);
    }
    Ok(sources)
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

async fn serve_worker(
    registration: &RegistrationContext,
    root: &Path,
    home: &Path,
    host_path: &Path,
) -> Result<(), String> {
    let worker_config = WorkerConfig::load(worker_config_path(root))
        .await
        .map_err(|error| error.to_string())?;
    let store = ConfigStore::new(root.to_path_buf(), home.to_path_buf());
    let root_lock = crate::fleet::root_lock::FleetRootLock::acquire(root).await?;
    let pid_guard = super::fleet_ops::WorkerPidGuard::acquire(&store).await?;
    let fleet_config = Arc::new(NativeWorkerFleetConfig::new(store.clone()));
    let runtime = fleet_config
        .load()
        .await
        .map_err(|error| error.to_string())?;
    if let Some(profile) = runtime
        .runtime()
        .profiles
        .iter()
        .find(|profile| !worker_config.profiles.contains(&profile.name))
    {
        return Err(format!(
            "worker root contains non-allowlisted profile {}",
            profile.name
        ));
    }
    let supervisor =
        ProfileSupervisor::new(runtime.runtime().clone()).map_err(|error| error.to_string())?;
    let verified = registration
        .verify_native_host(host_path)
        .await
        .map_err(|error| error.to_string())?;
    super::fleet_ops::refresh_profile_native_host_descriptors(
        &runtime.runtime().root,
        &runtime.runtime().profiles,
        &verified,
    )
    .await?;
    let provisioner = NativeWorkerProvisioner::from_verified_host(
        store,
        runtime.runtime().launch.clone(),
        &verified,
    )
    .map_err(|error| error.to_string())?;
    let state = WorkerState::open_async(worker_fences_path(root))
        .await
        .map_err(|error| error.to_string())?;
    let http = WorkerHttp::new(
        worker_config.clone(),
        state,
        Arc::new(NativeWorkerSupervisor::new(supervisor.clone())),
        Arc::<NativeWorkerFleetConfig>::clone(&fleet_config),
        Arc::new(provisioner),
        runtime.runtime().launch.bridge_token.clone(),
    )
    .map_err(|error| error.to_string())?;
    let listener = TcpListener::bind((worker_config.host.as_str(), worker_config.port))
        .await
        .map_err(|error| error.to_string())?;
    supervisor
        .start()
        .await
        .map_err(|error| error.to_string())?;
    let reaper = http.spawn_idle_reaper();
    let result =
        run_worker_until_shutdown(listener, http.router(), &supervisor, fleet_config.as_ref())
            .await;
    reaper.abort();
    let _ = reaper.await;
    let stopped = supervisor.stop().await.map_err(|error| error.to_string());
    let released = pid_guard.release().await;
    let root_released = root_lock.release().await;
    result.and(stopped).and(released).and(root_released)
}

#[cfg(unix)]
async fn run_worker_until_shutdown(
    listener: TcpListener,
    router: axum::Router,
    supervisor: &ProfileSupervisor,
    config: &NativeWorkerFleetConfig,
) -> Result<(), String> {
    let mut reload = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        .map_err(|error| error.to_string())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let serving = async {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .into_future()
            .await
    };
    tokio::pin!(serving);
    let mut shutdown_tx = Some(shutdown_tx);
    loop {
        tokio::select! {
            result = &mut serving => return result.map_err(|error| error.to_string()),
            result = tokio::signal::ctrl_c() => {
                result.map_err(|error| error.to_string())?;
                if let Some(shutdown) = shutdown_tx.take() {
                    let _ = shutdown.send(());
                }
                return serving.await.map_err(|error| error.to_string());
            }
            _ = terminate.recv() => {
                if let Some(shutdown) = shutdown_tx.take() {
                    let _ = shutdown.send(());
                }
                return serving.await.map_err(|error| error.to_string());
            }
            _ = reload.recv() => {
                if let Err(error) = reload_supervisor(supervisor, config).await {
                    eprintln!("fleet configuration reload failed: {error}");
                }
            }
        }
    }
}

#[cfg(not(unix))]
async fn run_worker_until_shutdown(
    listener: TcpListener,
    router: axum::Router,
    _supervisor: &ProfileSupervisor,
    _config: &NativeWorkerFleetConfig,
) -> Result<(), String> {
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let serving = async {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .into_future()
            .await
    };
    tokio::pin!(serving);
    tokio::select! {
        result = &mut serving => result.map_err(|error| error.to_string()),
        result = tokio::signal::ctrl_c() => {
            result.map_err(|error| error.to_string())?;
            let _ = shutdown_tx.send(());
            serving.await.map_err(|error| error.to_string())
        }
    }
}

async fn serve_gateway(
    registration: &RegistrationContext,
    root: &Path,
    home: &Path,
    host_path: &Path,
) -> Result<(), String> {
    let store = ConfigStore::new(root.to_path_buf(), home.to_path_buf());
    let root_lock = crate::fleet::root_lock::FleetRootLock::acquire(root).await?;
    let pid_guard = super::fleet_ops::ServePidGuard::acquire(&store).await?;
    let raw = store.load().await.map_err(|error| error.to_string())?;
    let fleet_config = NativeWorkerFleetConfig::new(store.clone());
    let runtime = fleet_config
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let verified = registration
        .verify_native_host(host_path)
        .await
        .map_err(|error| error.to_string())?;
    super::fleet_ops::refresh_profile_native_host_descriptors(
        &runtime.runtime().root,
        &runtime.runtime().profiles,
        &verified,
    )
    .await?;
    let provisioner = ProfileProvisioner::new(
        store.clone(),
        runtime.runtime().launch.clone(),
        serde_json::to_value(verified.manifest()).map_err(|error| error.to_string())?,
        verified.path().to_path_buf(),
    )
    .map_err(|error| error.to_string())?;
    let gateway = raw
        .get("gateway")
        .and_then(Value::as_object)
        .ok_or_else(|| "invalid fleet configuration: gateway".to_owned())?;
    let host = gateway
        .get("host")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid fleet configuration: gateway.host".to_owned())?;
    let port = gateway
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| "invalid fleet configuration: gateway.port".to_owned())?;
    let bind = format!("{host}:{port}")
        .parse::<SocketAddr>()
        .map_err(|error| format!("invalid fleet gateway bind: {error}"))?;
    let nodes = raw
        .get("nodes")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |nodes| {
            nodes.iter().filter_map(fleet_node).collect()
        });
    let config = GatewayConfig {
        bind,
        token: raw
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_owned),
        bridge_token: runtime.runtime().launch.bridge_token.clone(),
        provisioner,
        nodes,
    };
    let supervisor =
        ProfileSupervisor::new(runtime.runtime().clone()).map_err(|error| error.to_string())?;
    let gateway = FleetGateway::new(
        config,
        supervisor.clone(),
        FleetLeases::new(runtime.runtime().lease_idle_ttl),
    )
    .map_err(|error| error.to_string())?;
    supervisor
        .start()
        .await
        .map_err(|error| error.to_string())?;
    let result = run_gateway_until_shutdown(&gateway, &supervisor, &fleet_config).await;
    let stopped = supervisor.stop().await.map_err(|error| error.to_string());
    let released = pid_guard.release().await;
    let root_released = root_lock.release().await;
    result.and(stopped).and(released).and(root_released)
}

#[cfg(unix)]
async fn run_gateway_until_shutdown(
    gateway: &FleetGateway,
    supervisor: &ProfileSupervisor,
    config: &NativeWorkerFleetConfig,
) -> Result<(), String> {
    let mut reload = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        .map_err(|error| error.to_string())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    let serving = gateway.serve();
    tokio::pin!(serving);
    loop {
        tokio::select! {
            result = &mut serving => return result.map_err(|error| error.to_string()),
            result = tokio::signal::ctrl_c() => return result.map_err(|error| error.to_string()),
            _ = terminate.recv() => return Ok(()),
            _ = reload.recv() => {
                if let Err(error) = reload_supervisor(supervisor, config).await {
                    eprintln!("fleet configuration reload failed: {error}");
                }
            }
        }
    }
}

#[cfg(not(unix))]
async fn run_gateway_until_shutdown(
    gateway: &FleetGateway,
    _supervisor: &ProfileSupervisor,
    _config: &NativeWorkerFleetConfig,
) -> Result<(), String> {
    tokio::select! {
        result = gateway.serve() => result.map_err(|error| error.to_string()),
        result = tokio::signal::ctrl_c() => result.map_err(|error| error.to_string()),
    }
}

fn fleet_node(value: &Value) -> Option<FleetNode> {
    let object = value.as_object()?;
    let id = object.get("id")?.as_str()?.to_owned();
    let host = object.get("host")?.as_str()?.to_owned();
    let port = u16::try_from(object.get("port")?.as_u64()?).ok()?;
    if port == 0 {
        return None;
    }
    let token = object
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned);
    Some(FleetNode {
        id,
        host,
        port,
        token,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServeSignal {
    Reload,
    Shutdown,
}

async fn serve_coordinator(config_path: &Path) -> Result<(), String> {
    loop {
        let invalid = || "unable to load valid coordinator configuration".to_owned();
        let bytes = tokio::fs::read(config_path).await.map_err(|_| invalid())?;
        let mut raw: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if let Some(url) = std::env::var_os("HC_COORDINATOR_DATABASE_URL") {
            let url = url
                .into_string()
                .unwrap_or_else(|value| value.to_string_lossy().into_owned());
            raw.as_object_mut()
                .ok_or_else(invalid)?
                .insert("databaseUrl".to_owned(), Value::String(url));
        }
        let config: CoordinatorConfig = serde_json::from_value(raw).map_err(|_| invalid())?;
        let bind_host = config.host.clone();
        let bind_port = config.port;
        let coordinator = FleetCoordinator::try_new(config).map_err(|_| invalid())?;
        coordinator
            .open()
            .await
            .map_err(|error| error.to_string())?;
        let listener = match TcpListener::bind((bind_host.as_str(), bind_port)).await {
            Ok(listener) => listener,
            Err(error) => {
                coordinator.close().await;
                return Err(error.to_string());
            }
        };
        let served = coordinator
            .serve_until(listener, wait_for_serve_signal())
            .await
            .map_err(|error| error.to_string());
        coordinator.close().await;
        let signal = served??;
        if signal == ServeSignal::Shutdown {
            return Ok(());
        }
    }
}

#[cfg(unix)]
async fn wait_for_serve_signal() -> Result<ServeSignal, String> {
    let mut reload = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        .map_err(|error| error.to_string())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            result.map(|()| ServeSignal::Shutdown).map_err(|error| error.to_string())
        }
        _ = terminate.recv() => Ok(ServeSignal::Shutdown),
        _ = reload.recv() => Ok(ServeSignal::Reload),
    }
}

#[cfg(not(unix))]
async fn wait_for_serve_signal() -> Result<ServeSignal, String> {
    tokio::signal::ctrl_c()
        .await
        .map(|()| ServeSignal::Shutdown)
        .map_err(|error| error.to_string())
}

#[cfg(unix)]
async fn reload_supervisor(
    supervisor: &ProfileSupervisor,
    config: &NativeWorkerFleetConfig,
) -> Result<(), String> {
    let loaded = config.load().await.map_err(|error| error.to_string())?;
    supervisor
        .reload(loaded.runtime().clone())
        .await
        .map_err(|error| error.to_string())
}
