//! Validated durable fleet configuration mutations for CLI commands.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use super::fleet::FleetAgent;
use crate::{
    cli::{NativeMessagingManifest, VerifiedNativeHost},
    fleet::{
        config::{ConfigError, ConfigStore, validate_profile_name},
        runtime::{
            FleetProfile, ProfileProvisioner, find_chrome_for_profile,
            launch_profile_with_extension, probe_profile_google_session, terminate_chrome_checked,
        },
        worker::NativeWorkerFleetConfig,
    },
};
use serde_json::{Value, json};
use tokio::time;

const PROFILE_NATIVE_HOST_MANIFEST: &str = "com.humanchrome.nativehost.json";
static PROFILE_MANIFEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

/// Initializes a fresh fleet configuration at an explicit root.
///
/// # Errors
/// Returns an existing-config, port, token, randomness, or filesystem error.
pub async fn initialize(
    store: &ConfigStore,
    gateway_port: u16,
    base_port: u16,
    token: Option<&str>,
) -> Result<Value, ConfigError> {
    if gateway_port == 0 || base_port == 0 {
        return Err(ConfigError::Invalid);
    }
    if store.path().exists() {
        return Err(ConfigError::Invalid);
    }
    let mut config = store.default_config(gateway_port, base_port)?;
    if let Some(token) = token {
        if token != "none"
            && (token.len() < 32 || !token.as_bytes().iter().all(u8::is_ascii_hexdigit))
        {
            return Err(ConfigError::Invalid);
        }
        config["token"] = if token == "none" {
            Value::Null
        } else {
            Value::String(token.to_owned())
        };
    }
    store.save(&config).await?;
    Ok(config)
}

/// Lists persisted profile records without exposing any process-local runtime state.
///
/// # Errors
/// Returns validation or storage errors from [`ConfigStore`].
pub async fn profiles(store: &ConfigStore) -> Result<Vec<Value>, ConfigError> {
    let config = store.load().await?;
    Ok(config["profiles"].as_array().cloned().unwrap_or_default())
}

/// Changes the parked state through the validated atomic configuration boundary.
///
/// # Errors
/// Returns validation or storage errors from [`ConfigStore`].
pub async fn set_parked(store: &ConfigStore, parked: bool) -> Result<(), ConfigError> {
    let mut config = store.load().await?;
    config["parked"] = Value::Bool(parked);
    store.save(&config).await
}

/// Enables or disables one persisted fleet profile through the atomic configuration boundary.
///
/// # Errors
/// Returns validation, missing-profile, or storage errors from [`ConfigStore`].
pub async fn set_profile_enabled(
    store: &ConfigStore,
    name: &str,
    enabled: bool,
) -> Result<(), ConfigError> {
    validate_profile_name(name)?;
    let mut config = store.load().await?;
    let Some(profile) = config["profiles"].as_array_mut().and_then(|profiles| {
        profiles
            .iter_mut()
            .find(|profile| profile.get("name").and_then(Value::as_str) == Some(name))
    }) else {
        return Err(ConfigError::ProfileName(name.to_owned()));
    };
    profile["enabled"] = Value::Bool(enabled);
    store.save(&config).await
}

/// Adds or replaces a peer gateway after validating node identity and port.
///
/// # Errors
/// Returns invalid-node, collision, validation, or storage errors from [`ConfigStore`].
pub async fn upsert_node(
    store: &ConfigStore,
    id: &str,
    host: &str,
    port: u16,
    token: Option<&str>,
) -> Result<(), ConfigError> {
    validate_profile_name(id)?;
    if host.is_empty() || port == 0 {
        return Err(ConfigError::Invalid);
    }
    let mut config = store.load().await?;
    if config.get("nodeId").and_then(Value::as_str) == Some(id) {
        return Err(ConfigError::NodeCollision(id.to_owned()));
    }
    let nodes = config["nodes"].as_array_mut().ok_or(ConfigError::Invalid)?;
    let entry = json!({"id": id, "host": host, "port": port, "token": token.unwrap_or("")});
    if let Some(existing) = nodes
        .iter_mut()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(id))
    {
        *existing = entry;
    } else {
        nodes.push(entry);
    }
    store.save(&config).await
}

/// Removes one configured peer gateway without touching any peer process.
///
/// # Errors
/// Returns a missing-node, validation, or storage error from [`ConfigStore`].
pub async fn remove_node(store: &ConfigStore, id: &str) -> Result<(), ConfigError> {
    validate_profile_name(id)?;
    let mut config = store.load().await?;
    let nodes = config["nodes"].as_array_mut().ok_or(ConfigError::Invalid)?;
    let before = nodes.len();
    nodes.retain(|node| node.get("id").and_then(Value::as_str) != Some(id));
    if nodes.len() == before {
        return Err(ConfigError::ProfileName(id.to_owned()));
    }
    store.save(&config).await
}

/// Lists node identity and configured peers in the established JSON shape.
///
/// # Errors
/// Returns validation or storage errors from [`ConfigStore`].
pub async fn nodes(store: &ConfigStore) -> Result<Value, ConfigError> {
    let config = store.load().await?;
    let nodes = config
        .get("nodes")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |nodes| {
            nodes
                .iter()
                .map(|node| {
                    json!({
                        "id": node.get("id").cloned().unwrap_or(Value::Null),
                        "host": node.get("host").cloned().unwrap_or(Value::Null),
                        "port": node.get("port").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        });
    Ok(json!({
        "nodeId": config.get("nodeId").cloned().unwrap_or(Value::Null),
        "nodes": nodes,
    }))
}
/// Removes a profile record and optionally its fleet-owned browser data directory.
///
/// # Errors
/// Returns validation, missing-profile, storage, or owned-data deletion errors.
pub async fn remove_profile(
    store: &ConfigStore,
    name: &str,
    delete_data: bool,
) -> Result<(), ConfigError> {
    validate_profile_name(name)?;
    let mut config = store.load().await?;
    if !config["profiles"].as_array().is_some_and(|profiles| {
        profiles
            .iter()
            .any(|profile| profile.get("name").and_then(Value::as_str) == Some(name))
    }) {
        return Err(ConfigError::ProfileName(name.to_owned()));
    }
    let profile_dir = store.root().join("profiles").join(name);
    let pid_path = store.root().join("run").join(format!("{name}.pid"));
    let recorded = read_profile_pid(&pid_path).await?;
    let chrome_path = config
        .get("chromePath")
        .and_then(Value::as_str)
        .ok_or(ConfigError::Invalid)?;
    let owned = find_chrome_for_profile(Path::new(chrome_path), &profile_dir)
        .await
        .map_err(|error| ConfigError::TypeError(error.to_string()))?;
    if recorded.is_none() && !owned.is_empty() {
        return Err(ConfigError::TypeError(format!(
            "refusing to remove profile {name}: Chrome is running without its PID file"
        )));
    }
    if let Some(pid) = recorded {
        if owned.len() != 1 || !owned.contains(&pid) {
            return Err(ConfigError::TypeError(format!(
                "refusing to delete profile {name}: pid {pid} is not the sole Chrome owner of {}",
                profile_dir.display()
            )));
        }
        terminate_chrome_checked(pid, Duration::from_secs(5))
            .await
            .map_err(|error| ConfigError::TypeError(error.to_string()))?;
        tokio::fs::remove_file(&pid_path).await?;
    }
    let profiles = config["profiles"]
        .as_array_mut()
        .ok_or(ConfigError::Invalid)?;
    profiles.retain(|entry| entry.get("name").and_then(Value::as_str) != Some(name));
    store.save(&config).await?;
    if delete_data {
        signal_gateway_reload(store)
            .await
            .map_err(ConfigError::TypeError)?;
        remove_profile_directory(&profile_dir).await?;
    }
    signal_gateway_reload(store)
        .await
        .map_err(ConfigError::TypeError)?;
    Ok(())
}

async fn read_profile_pid(path: &Path) -> Result<Option<u32>, ConfigError> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let pid = text.trim().parse::<u32>().map_err(|_| {
        ConfigError::TypeError(format!("invalid profile pid file: {}", path.display()))
    })?;
    if pid == 0 {
        return Err(ConfigError::TypeError(format!(
            "invalid profile pid file: {}",
            path.display()
        )));
    }
    Ok(Some(pid))
}

async fn remove_profile_directory(path: &Path) -> Result<(), ConfigError> {
    let mut last_error = None;
    for _ in 0..10 {
        match tokio::fs::remove_dir_all(path).await {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
    Err(last_error.expect("profile removal attempted").into())
}

/// Binds a purpose to exactly one local profile through the validated configuration boundary.
///
/// # Errors
/// Returns an invalid name, missing profile, duplicate purpose, or storage error.
pub async fn add_purpose(
    store: &ConfigStore,
    purpose: &str,
    profile_name: &str,
) -> Result<(), ConfigError> {
    validate_profile_name(purpose)?;
    validate_profile_name(profile_name)?;
    let mut config = store.load().await?;
    let profiles = config["profiles"]
        .as_array_mut()
        .ok_or(ConfigError::Invalid)?;
    if profiles.iter().any(|profile| {
        profile.get("name").and_then(Value::as_str) != Some(profile_name)
            && profile.get("purpose").and_then(Value::as_str) == Some(purpose)
    }) {
        return Err(ConfigError::DuplicatePurpose {
            purpose: purpose.to_owned(),
            first: "existing".to_owned(),
            second: profile_name.to_owned(),
        });
    }
    let Some(profile) = profiles
        .iter_mut()
        .find(|profile| profile.get("name").and_then(Value::as_str) == Some(profile_name))
    else {
        return Err(ConfigError::ProfileName(profile_name.to_owned()));
    };
    if profile.get("purpose").and_then(Value::as_str).is_some() {
        return Err(ConfigError::PurposeName(purpose.to_owned()));
    }
    profile["purpose"] = Value::String(purpose.to_owned());
    store.save(&config).await
}

/// Releases a local purpose binding without touching its profile data.
///
/// # Errors
/// Returns an invalid name, missing purpose, or storage error.
pub async fn remove_purpose(store: &ConfigStore, purpose: &str) -> Result<(), ConfigError> {
    validate_profile_name(purpose)?;
    let mut config = store.load().await?;
    let profiles = config["profiles"]
        .as_array_mut()
        .ok_or(ConfigError::Invalid)?;
    let Some(profile) = profiles
        .iter_mut()
        .find(|profile| profile.get("purpose").and_then(Value::as_str) == Some(purpose))
    else {
        return Err(ConfigError::PurposeName(purpose.to_owned()));
    };
    profile
        .as_object_mut()
        .ok_or(ConfigError::Invalid)?
        .remove("purpose");
    store.save(&config).await
}

/// Lists local purpose bindings in the stable agent-readable shape.
///
/// # Errors
/// Returns validation or storage errors from [`ConfigStore`].
pub async fn purposes(store: &ConfigStore) -> Result<Vec<Value>, ConfigError> {
    let config = store.load().await?;
    let node_id = config.get("nodeId").cloned().unwrap_or(Value::Null);
    let mut local_states = std::collections::HashMap::new();
    if live_serve_pid(store)
        .await
        .map_err(ConfigError::TypeError)?
        .is_some()
        && let Ok(gateway) = GatewayControl::from_store(store).await
        && let Ok(status) = gateway.status().await
        && let Some(profiles) = status.get("profiles").and_then(Value::as_array)
    {
        for profile in profiles {
            if let (Some(name), Some(state)) = (
                profile.get("name").and_then(Value::as_str),
                profile.get("state").and_then(Value::as_str),
            ) {
                local_states.insert(name.to_owned(), state.to_owned());
            }
        }
    }

    let mut bindings = config["profiles"].as_array().map_or_else(Vec::new, |profiles| {
        profiles
            .iter()
            .filter_map(|profile| {
                let purpose = profile.get("purpose")?.as_str()?;
                let name = profile.get("name")?.as_str()?;
                Some(json!({
                    "purpose": purpose,
                    "profile": name,
                    "node": node_id.clone(),
                    "state": local_states.get(name).cloned().unwrap_or_else(|| "unknown".to_owned()),
                    "labels": profile.get("labels").cloned().unwrap_or_else(|| json!([])),
                }))
            })
            .collect::<Vec<_>>()
    });

    let nodes = config
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for node in nodes {
        let Some(id) = node.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(host) = node.get("host").and_then(Value::as_str) else {
            continue;
        };
        let Some(port) = node.get("port").and_then(Value::as_u64) else {
            continue;
        };
        let Some(port) = u16::try_from(port).ok().filter(|port| *port != 0) else {
            continue;
        };
        let token = node
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty());
        let request = reqwest::Client::new().get(format!("http://{host}:{port}/v1/profiles"));
        let response = authorized(request, token).send().await;
        let Ok(response) = response else {
            continue;
        };
        let Ok(remote) = response.json::<Value>().await else {
            continue;
        };
        let Some(remote) = remote.as_array() else {
            continue;
        };
        for profile in remote {
            let (Some(purpose), Some(name)) = (
                profile.get("purpose").and_then(Value::as_str),
                profile.get("name").and_then(Value::as_str),
            ) else {
                continue;
            };
            bindings.push(json!({
                "purpose": purpose,
                "profile": name,
                "node": id,
                "state": profile.get("state").cloned().unwrap_or(Value::String("unknown".to_owned())),
                "labels": profile.get("labels").cloned().unwrap_or_else(|| json!([])),
            }));
        }
    }
    Ok(bindings)
}

/// Provisions a profile through the same clone, native-manifest, readiness, and persistence
/// gates used by the gateway. The host is verified before its path reaches a profile manifest.
///
/// # Errors
/// Returns every provisioning failure without creating a partial configuration record.
pub async fn add_profile(
    store: ConfigStore,
    verified_host: &VerifiedNativeHost,
    name: &str,
    labels: Vec<String>,
    seed: Option<&Path>,
) -> Result<Value, String> {
    validate_profile_name(name).map_err(|error| error.to_string())?;
    if live_serve_pid(&store).await?.is_some() {
        return GatewayControl::from_store(&store)
            .await?
            .add_profile(name, labels, seed)
            .await;
    }
    let worker_config = NativeWorkerFleetConfig::new(store.clone());
    let runtime = worker_config
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let provisioner = ProfileProvisioner::new(
        store,
        runtime.runtime().launch.clone(),
        serde_json::to_value(verified_host.manifest()).map_err(|error| error.to_string())?,
        verified_host.path().to_owned(),
    )
    .map_err(|error| error.to_string())?;
    let added = provisioner
        .add(name, labels, seed)
        .await
        .map_err(|error| error.to_string())?;
    Ok(crate::fleet::worker::server::added_profile_json(added))
}

/// Refreshes native-host descriptors for profiles declared by an exclusively owned fleet root.
///
/// # Errors
/// Refuses malformed, foreign, unsafe, or symlinked profile descriptors without touching profiles.
pub(super) async fn refresh_profile_native_host_descriptors(
    root: &Path,
    profiles: &[FleetProfile],
    verified_host: &VerifiedNativeHost,
) -> Result<(), String> {
    let root = tokio::fs::canonicalize(root)
        .await
        .map_err(|error| format!("cannot resolve fleet root {}: {error}", root.display()))?;
    let profiles_root =
        managed_profile_directory(&root.join("profiles"), &root, "profiles").await?;

    for profile in profiles {
        validate_profile_name(&profile.name).map_err(|error| error.to_string())?;
        let profile_dir = managed_profile_directory(
            &profiles_root.join(&profile.name),
            &profiles_root,
            "profile",
        )
        .await?;
        let manifest_dir = managed_profile_directory(
            &profile_dir.join("NativeMessagingHosts"),
            &profile_dir,
            "native host directory",
        )
        .await?;
        refresh_profile_native_host_descriptor(
            &manifest_dir.join(PROFILE_NATIVE_HOST_MANIFEST),
            verified_host,
        )
        .await?;
    }
    Ok(())
}

async fn managed_profile_directory(
    path: &Path,
    root: &Path,
    kind: &str,
) -> Result<PathBuf, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "refusing symlinked fleet {kind}: {}",
                path.display()
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!(
                "fleet {kind} is not a directory: {}",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(path).await.map_err(|error| {
                format!("cannot create fleet {kind} {}: {error}", path.display())
            })?;
        }
        Err(error) => {
            return Err(format!(
                "cannot inspect fleet {kind} {}: {error}",
                path.display()
            ));
        }
    }
    let resolved = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| format!("cannot resolve fleet {kind} {}: {error}", path.display()))?;
    if !resolved.starts_with(root) {
        return Err(format!(
            "refusing fleet {kind} outside owned root: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
}

async fn refresh_profile_native_host_descriptor(
    path: &Path,
    verified_host: &VerifiedNativeHost,
) -> Result<(), String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "refusing symlinked profile native host descriptor: {}",
            path.display()
        )),
        Ok(metadata) if !metadata.is_file() => Err(format!(
            "profile native host descriptor is not a regular file: {}",
            path.display()
        )),
        Ok(_) => {
            let bytes = tokio::fs::read(path).await.map_err(|error| {
                format!(
                    "cannot read profile native host descriptor {}: {error}",
                    path.display()
                )
            })?;
            let mut manifest =
                serde_json::from_slice::<NativeMessagingManifest>(&bytes).map_err(|error| {
                    format!(
                        "refusing to replace invalid profile native host descriptor {}: {error}",
                        path.display()
                    )
                })?;
            if !manifest.path.is_absolute() {
                return Err(format!(
                    "refusing profile native host descriptor with relative executable path: {}",
                    path.display()
                ));
            }
            manifest
                .validate_owned_by(&manifest.path)
                .map_err(|error| {
                    format!(
                        "refusing to replace profile native host descriptor {}: {error}",
                        path.display()
                    )
                })?;
            if manifest.path == verified_host.path() {
                return Ok(());
            }
            verified_host.path().clone_into(&mut manifest.path);
            manifest
                .description
                .clone_from(&verified_host.manifest().description);
            write_profile_native_host_descriptor(path, &manifest).await
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            write_profile_native_host_descriptor(path, verified_host.manifest()).await
        }
        Err(error) => Err(format!(
            "cannot inspect profile native host descriptor {}: {error}",
            path.display()
        )),
    }
}

async fn write_profile_native_host_descriptor(
    path: &Path,
    manifest: &NativeMessagingManifest,
) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "profile native host descriptor has no parent: {}",
            path.display()
        )
    })?;
    let sequence = PROFILE_MANIFEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{PROFILE_NATIVE_HOST_MANIFEST}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    let encoded = serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
    tokio::fs::write(&temporary, encoded)
        .await
        .map_err(|error| format!("cannot write profile native host descriptor: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if let Err(error) =
            tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o644)).await
        {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(format!(
                "cannot set profile native host descriptor permissions: {error}"
            ));
        }
    }
    if let Err(error) = tokio::fs::rename(&temporary, path).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(format!(
            "cannot replace profile native host descriptor {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

/// Starts, stops, or restarts a profile without creating a competing supervisor.
///
/// # Errors
/// Returns the live gateway refusal when one owns the root, otherwise the local runtime error.
pub async fn profile_control(store: &ConfigStore, name: &str, action: &str) -> Result<(), String> {
    validate_profile_name(name).map_err(|error| error.to_string())?;
    if !matches!(action, "start" | "stop" | "restart") {
        return Err(format!(
            "unsupported fleet profile lifecycle action: {action}"
        ));
    }
    if live_serve_pid(store).await?.is_some() {
        return GatewayControl::from_store(store)
            .await?
            .profile_control(name, action)
            .await;
    }
    let runtime = NativeWorkerFleetConfig::new(store.clone())
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let supervisor = crate::fleet::runtime::ProfileSupervisor::new(runtime.runtime().clone())
        .map_err(|error| error.to_string())?;
    match action {
        "start" => supervisor.start_profile(name).await,
        "stop" => supervisor.stop_profile(name).await,
        "restart" => supervisor.restart_profile(name).await,
        _ => unreachable!("validated lifecycle action"),
    }
    .map_err(|error| error.to_string())
}

/// Probes a profile's own bridge for Google's current signed-in session state.
///
/// # Errors
/// Returns bridge tool, response-shape, or ListAccounts classification errors.
pub async fn verify_profile(store: &ConfigStore, name: &str) -> Result<Value, String> {
    validate_profile_name(name).map_err(|error| error.to_string())?;
    let config = store.load().await.map_err(|error| error.to_string())?;
    let profile = config["profiles"]
        .as_array()
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("name").and_then(Value::as_str) == Some(name))
        })
        .ok_or_else(|| format!("unknown profile: {name}"))?;
    let port = profile
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| format!("invalid profile port: {name}"))?;
    let token = config
        .get("bridgeToken")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid fleet configuration: bridgeToken".to_owned())?;

    let google = probe_profile_google_session(port, token)
        .await
        .map_err(|error| error.to_string())?;
    let state = match google.state {
        crate::fleet::runtime::GoogleSessionState::Session => "session",
        crate::fleet::runtime::GoogleSessionState::Remembered => "remembered",
        crate::fleet::runtime::GoogleSessionState::None => "none",
    };
    Ok(
        json!({"name":name,"google":{"state":state,"accounts":google.accounts,"signedIn":google.signed_in}}),
    )
}

/// Installs a launchd agent for an explicitly selected isolated fleet root.
///
/// # Errors
/// Refuses without explicit consent, on unsupported platforms, or if launchd rejects registration.
pub async fn install_agent(
    root: &Path,
    home: &Path,
    host_path: &Path,
    agent: FleetAgent,
    allow_agent_install: bool,
) -> Result<String, String> {
    if !allow_agent_install {
        return Err("refusing launchd agent installation without --allow-agent-install".to_owned());
    }
    #[cfg(target_os = "macos")]
    {
        let (label, role, log_name) = agent_details(agent);
        let launch_agents = home.join("Library/LaunchAgents");
        let logs = root.join("logs");
        tokio::fs::create_dir_all(&launch_agents)
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::create_dir_all(&logs)
            .await
            .map_err(|error| error.to_string())?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let plist = launch_agents.join(format!("{label}.plist"));
        let xml = launch_agent_xml(
            label,
            &executable,
            root,
            home,
            host_path,
            role,
            &logs.join(log_name),
        );
        tokio::fs::write(&plist, xml)
            .await
            .map_err(|error| error.to_string())?;
        let domain = format!("gui/{}", current_uid());
        let service = format!("{domain}/{label}");
        let _ = tokio::process::Command::new("launchctl")
            .args(["bootout", &service])
            .status()
            .await;
        let output = tokio::process::Command::new("launchctl")
            .args(["bootstrap", &domain])
            .arg(&plist)
            .output()
            .await
            .map_err(|error| format!("cannot invoke launchctl bootstrap: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "launchctl bootstrap failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(format!("installed {label}\n"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, home, host_path, agent);
        Err("launchd agent installation is supported only on macOS".to_owned())
    }
}

/// Uninstalls an explicitly selected launchd agent without touching profile data.
///
/// # Errors
/// Refuses without explicit consent or when removal cannot complete.
pub async fn uninstall_agent(
    root: &Path,
    home: &Path,
    agent: FleetAgent,
    allow_agent_install: bool,
) -> Result<String, String> {
    if !allow_agent_install {
        return Err("refusing launchd agent removal without --allow-agent-install".to_owned());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = root;
        let (label, _, _) = agent_details(agent);
        let domain = format!("gui/{}", current_uid());
        let service = format!("{domain}/{label}");
        let output = tokio::process::Command::new("launchctl")
            .args(["bootout", &service])
            .output()
            .await
            .map_err(|error| format!("cannot invoke launchctl bootout: {error}"))?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() && !stderr.contains("Could not find service") {
            return Err(format!("launchctl bootout failed: {}", stderr.trim()));
        }
        let plist = home
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist"));
        match tokio::fs::remove_file(&plist).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        Ok(format!("uninstalled {label}\n"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, home, agent);
        Err("launchd agent removal is supported only on macOS".to_owned())
    }
}

#[cfg(target_os = "macos")]
fn agent_details(agent: FleetAgent) -> (&'static str, &'static str, &'static str) {
    match agent {
        FleetAgent::Gateway => ("com.humanchrome.fleet", "serve", "serve.log"),
        FleetAgent::Worker => ("com.humanchrome.fleet-worker", "worker serve", "worker.log"),
    }
}

#[cfg(target_os = "macos")]
fn launch_agent_xml(
    label: &str,
    executable: &Path,
    root: &Path,
    home: &Path,
    host_path: &Path,
    role: &str,
    log_path: &Path,
) -> String {
    let escaped = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut arguments = format!(
        "<string>{}</string><string>fleet</string>",
        escaped(&executable.to_string_lossy())
    );
    for part in role.split_whitespace() {
        arguments.push_str(&format!("<string>{}</string>", escaped(part)));
    }
    arguments.push_str(&format!(
        "<string>--root</string><string>{}</string><string>--home</string><string>{}</string><string>--host-path</string><string>{}</string>",
        escaped(&root.to_string_lossy()),
        escaped(&home.to_string_lossy()),
        escaped(&host_path.to_string_lossy()),
    ));
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array>{arguments}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string><key>EnvironmentVariables</key><dict><key>HC_FLEET_ROOT</key><string>{}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict></dict></plist>",
        escaped(label),
        escaped(&log_path.to_string_lossy()),
        escaped(&log_path.to_string_lossy()),
        escaped(&root.to_string_lossy()),
    )
}

#[cfg(target_os = "macos")]
fn current_uid() -> u32 {
    // SAFETY: getuid takes no arguments and has no memory safety preconditions.
    unsafe { libc::getuid() }
}
/// Creates the reusable template profile by launching it with the verified native manifest.
///
/// # Errors
/// Returns configuration, manifest, extension launch, or readiness errors.
pub async fn initialize_template(
    store: ConfigStore,
    verified_host: &VerifiedNativeHost,
) -> Result<(), String> {
    let template = store.root().join("profiles/_template");
    if tokio::fs::try_exists(&template)
        .await
        .map_err(|error| error.to_string())?
    {
        return Err(format!(
            "template profile already exists: {}",
            template.display()
        ));
    }
    let worker_config = NativeWorkerFleetConfig::new(store.clone());
    let runtime = worker_config
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let config = store.load().await.map_err(|error| error.to_string())?;
    let port = config
        .get("basePort")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .and_then(|port| port.checked_sub(1))
        .ok_or_else(|| "fleet basePort cannot reserve a template bridge port".to_owned())?;
    tokio::fs::create_dir_all(template.join("NativeMessagingHosts"))
        .await
        .map_err(|error| error.to_string())?;
    let manifest =
        serde_json::to_vec_pretty(verified_host.manifest()).map_err(|error| error.to_string())?;
    tokio::fs::write(
        template.join("NativeMessagingHosts/com.humanchrome.nativehost.json"),
        manifest,
    )
    .await
    .map_err(|error| error.to_string())?;
    let launched =
        launch_profile_with_extension(&runtime.runtime().launch, "_template", &template, port)
            .await
            .map_err(|error| error.to_string())?;
    let ready = wait_for_bridge(port).await;
    launched.process.terminate(Duration::from_secs(5)).await;
    if let Err(error) = ready {
        let _ = tokio::fs::remove_dir_all(&template).await;
        return Err(error);
    }
    Ok(())
}

async fn wait_for_bridge(port: u16) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("http://127.0.0.1:{port}/ping");
    let deadline = time::Instant::now() + Duration::from_secs(60);
    loop {
        if client.get(&url).send().await.is_ok() {
            return Ok(());
        }
        if time::Instant::now() >= deadline {
            return Err(format!(
                "template extension did not connect on 127.0.0.1:{port}"
            ));
        }
        time::sleep(Duration::from_millis(500)).await;
    }
}

/// Authenticated local gateway endpoint derived from a validated fleet configuration.
#[derive(Clone, Debug)]
pub struct GatewayControl {
    base_url: String,
    token: Option<String>,
}

impl GatewayControl {
    /// Reads the local connectable gateway address and its bearer token.
    ///
    /// # Errors
    /// Returns an error when the configuration has no gateway token or endpoint.
    pub async fn from_store(store: &ConfigStore) -> Result<Self, String> {
        let config = store.load().await.map_err(|error| error.to_string())?;
        let gateway = config
            .get("gateway")
            .and_then(Value::as_object)
            .ok_or_else(|| "fleet configuration has no gateway endpoint".to_owned())?;
        let host = gateway
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("127.0.0.1");
        let host = if host == "0.0.0.0" { "127.0.0.1" } else { host };
        let port = gateway
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| "fleet configuration has an invalid gateway port".to_owned())?;
        let token = match config.get("token") {
            None | Some(Value::Null) => None,
            Some(Value::String(token)) if !token.is_empty() => Some(token.to_owned()),
            Some(_) => {
                return Err("fleet gateway token must be a non-empty string or null".to_owned());
            }
        };
        Ok(Self {
            base_url: format!("http://{host}:{port}"),
            token,
        })
    }

    /// Provisions through an already-running gateway, avoiding a second local supervisor.
    ///
    /// # Errors
    /// Returns the gateway's concrete refusal text or transport failure.
    pub async fn add_profile(
        &self,
        name: &str,
        labels: Vec<String>,
        seed: Option<&Path>,
    ) -> Result<Value, String> {
        validate_profile_name(name).map_err(|error| error.to_string())?;
        let body = json!({
            "name": name,
            "labels": labels,
            "seed": seed.map(|path| path.to_string_lossy().into_owned()),
        });
        let request = reqwest::Client::new()
            .post(format!("{}/v1/profiles", self.base_url))
            .json(&body);
        let response = authorized(request, self.token.as_deref())
            .send()
            .await
            .map_err(|error| format!("gateway profile provisioning request failed: {error}"))?;
        if response.status().is_success() {
            return response
                .json::<Value>()
                .await
                .map_err(|error| error.to_string());
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("gateway refused profile {name}: {status} {body}"))
    }

    /// Sends a lifecycle operation to the already-running, authenticated gateway.
    ///
    /// # Errors
    /// Returns the gateway's concrete refusal text or transport failure.
    pub async fn profile_control(&self, profile: &str, action: &str) -> Result<(), String> {
        validate_profile_name(profile).map_err(|error| error.to_string())?;
        if !matches!(action, "start" | "stop" | "restart") {
            return Err(format!(
                "unsupported fleet profile lifecycle action: {action}"
            ));
        }
        let request = reqwest::Client::new()
            .post(format!("{}/v1/profiles/{profile}/{action}", self.base_url));
        let response = authorized(request, self.token.as_deref())
            .send()
            .await
            .map_err(|error| format!("gateway control request failed: {error}"))?;
        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!(
            "gateway refused {action} {profile}: {status} {body}"
        ))
    }

    /// Applies park or unpark through the live authenticated owner.
    ///
    /// # Errors
    /// Returns the gateway's concrete refusal text or transport failure.
    pub async fn park(&self, parked: bool) -> Result<bool, String> {
        let request = reqwest::Client::new()
            .post(format!("{}/v1/park", self.base_url))
            .json(&json!({"parked": parked}));
        let response = authorized(request, self.token.as_deref())
            .send()
            .await
            .map_err(|error| format!("gateway park request failed: {error}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("gateway refused park: {status} {body}"));
        }
        response
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?
            .get("changed")
            .and_then(Value::as_bool)
            .ok_or_else(|| "gateway park response was missing changed".to_owned())
    }

    /// Retrieves live profile and lease measurements from the running gateway.
    ///
    /// # Errors
    /// Returns the concrete gateway transport or response error.
    pub async fn status(&self) -> Result<Value, String> {
        let client = reqwest::Client::new();
        let profiles = authorized(
            client.get(format!("{}/v1/profiles", self.base_url)),
            self.token.as_deref(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
        if !profiles.status().is_success() {
            return Err(format!(
                "gateway profile status failed: {}",
                profiles.status()
            ));
        }
        let profiles = profiles
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?;
        let leases = authorized(
            client.get(format!("{}/v1/leases", self.base_url)),
            self.token.as_deref(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
        if !leases.status().is_success() {
            return Err(format!("gateway lease status failed: {}", leases.status()));
        }
        let leases = leases
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?;
        Ok(json!({ "profiles": profiles, "leases": leases }))
    }
}

fn authorized(request: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token {
        Some(token) => request.bearer_auth(token),
        None => request,
    }
}

/// Reads a live, self-owned fleet gateway PID from its root-scoped pid file.
///
/// A stale pid file is removed. A live non-HumanChrome process is never signalled.
///
pub async fn live_serve_pid(store: &ConfigStore) -> Result<Option<u32>, String> {
    let path = store.root().join("run/serve.pid");
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let pid = text
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("invalid serve pid file: {}", path.display()))?;
    if pid == 0 {
        return Err(format!("invalid serve pid file: {}", path.display()));
    }
    match process_identity(pid).await? {
        None => {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|error| format!("cannot remove stale {}: {error}", path.display()))?;
            Ok(None)
        }
        Some(true) => Ok(Some(pid)),
        Some(false) => Err(format!(
            "refusing to use {}: pid {pid} belongs to a different live executable",
            path.display()
        )),
    }
}

/// Exclusive ownership of a fleet root's serve PID file.
///
/// The guard's cleanup is PID-bound, so it cannot delete a replacement gateway's pid file.
#[derive(Debug)]
pub struct ServePidGuard {
    path: PathBuf,
    pid: u32,
}

impl ServePidGuard {
    /// Acquires the root-local serve PID file without replacing a live process owner.
    ///
    /// # Errors
    /// Returns a concrete collision, permission, or pid ownership error.
    pub async fn acquire(store: &ConfigStore) -> Result<Self, String> {
        let path = store.root().join("run/serve.pid");
        tokio::fs::create_dir_all(path.parent().expect("serve PID parent"))
            .await
            .map_err(|error| format!("cannot create fleet run directory: {error}"))?;
        let pid = std::process::id();
        match write_new_pid(&path, pid) {
            Ok(()) => Ok(Self { path, pid }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                match live_serve_pid(store).await? {
                    Some(owner) => {
                        Err(format!("fleet gateway is already serving with pid {owner}"))
                    }
                    None => {
                        write_new_pid(&path, pid).map_err(|error| {
                            format!("cannot acquire {}: {error}", path.display())
                        })?;
                        Ok(Self { path, pid })
                    }
                }
            }
            Err(error) => Err(format!("cannot acquire {}: {error}", path.display())),
        }
    }

    /// Removes the pid file only if it still contains this process's PID.
    ///
    /// # Errors
    /// Returns a filesystem error while retaining ownership safety.
    pub async fn release(self) -> Result<(), String> {
        remove_own_pid(&self.path, self.pid).await
    }
}

impl Drop for ServePidGuard {
    fn drop(&mut self) {
        let Ok(contents) = fs::read_to_string(&self.path) else {
            return;
        };
        if contents.trim() == self.pid.to_string() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Exclusive ownership of a dedicated worker root's PID file.
///
/// The guard refuses a root already owned by a live gateway or worker and only removes its own PID.
#[derive(Debug)]
pub struct WorkerPidGuard {
    path: PathBuf,
    pid: u32,
}

impl WorkerPidGuard {
    /// Acquires the worker PID after proving no legacy gateway owns the same root.
    ///
    /// # Errors
    /// Returns ownership, collision, or filesystem errors without replacing a live owner.
    pub async fn acquire(store: &ConfigStore) -> Result<Self, String> {
        if let Some(owner) = live_serve_pid(store).await? {
            return Err(format!(
                "fleet gateway is already serving in this worker root with pid {owner}"
            ));
        }
        let path = store.root().join("run/worker.pid");
        tokio::fs::create_dir_all(path.parent().expect("worker PID parent"))
            .await
            .map_err(|error| format!("cannot create fleet run directory: {error}"))?;
        let pid = std::process::id();
        match write_new_pid(&path, pid) {
            Ok(()) => Ok(Self { path, pid }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                match live_pid_at(&path).await? {
                    Some(owner) => Err(format!("fleet worker is already serving with pid {owner}")),
                    None => {
                        write_new_pid(&path, pid).map_err(|error| {
                            format!("cannot acquire {}: {error}", path.display())
                        })?;
                        Ok(Self { path, pid })
                    }
                }
            }
            Err(error) => Err(format!("cannot acquire {}: {error}", path.display())),
        }
    }

    /// Removes the worker PID only while it still names this process.
    ///
    /// # Errors
    /// Returns a filesystem error while retaining PID ownership safety.
    pub async fn release(self) -> Result<(), String> {
        remove_own_pid(&self.path, self.pid).await
    }
}

impl Drop for WorkerPidGuard {
    fn drop(&mut self) {
        let Ok(contents) = fs::read_to_string(&self.path) else {
            return;
        };
        if contents.trim() == self.pid.to_string() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

async fn live_pid_at(path: &Path) -> Result<Option<u32>, String> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let pid = text
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("invalid worker pid file: {}", path.display()))?;
    if pid == 0 {
        return Err(format!("invalid worker pid file: {}", path.display()));
    }
    match process_identity(pid).await? {
        None => {
            tokio::fs::remove_file(path)
                .await
                .map_err(|error| format!("cannot remove stale {}: {error}", path.display()))?;
            Ok(None)
        }
        Some(true) => Ok(Some(pid)),
        Some(false) => Err(format!(
            "refusing to use {}: pid {pid} belongs to a different live executable",
            path.display()
        )),
    }
}

fn write_new_pid(path: &Path, pid: u32) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(pid.to_string().as_bytes())?;
    file.sync_all()
}

async fn remove_own_pid(path: &Path, pid: u32) -> Result<(), String> {
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    if contents.trim() == pid.to_string() {
        tokio::fs::remove_file(path)
            .await
            .map_err(|error| format!("cannot remove {}: {error}", path.display()))?;
    }
    Ok(())
}

/// Signals the live self-owned gateway to reload its configuration.
///
/// # Errors
/// Returns a concrete unsupported-platform or process ownership failure.
pub async fn signal_gateway_reload(store: &ConfigStore) -> Result<bool, String> {
    let Some(pid) = live_serve_pid(store).await? else {
        return Ok(false);
    };
    #[cfg(unix)]
    {
        let pid_text = pid.to_string();
        let status = tokio::process::Command::new("kill")
            .args(["-HUP", pid_text.as_str()])
            .status()
            .await
            .map_err(|error| format!("cannot signal fleet gateway: {error}"))?;
        if status.success() {
            Ok(true)
        } else {
            Err(format!("fleet gateway reload signal failed for pid {pid}"))
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("fleet reload signalling is unsupported on this platform".to_owned())
    }
}

async fn process_identity(pid: u32) -> Result<Option<bool>, String> {
    #[cfg(unix)]
    {
        let pid_text = pid.to_string();
        let output = tokio::process::Command::new("ps")
            .args(["-p", pid_text.as_str(), "-o", "command="])
            .output()
            .await
            .map_err(|error| format!("cannot inspect fleet pid {pid}: {error}"))?;
        if !output.status.success() {
            return Ok(None);
        }
        let command = String::from_utf8_lossy(&output.stdout);
        let executable = command.split_whitespace().next().unwrap_or_default();
        let own_path = std::env::current_exe().map_err(|error| error.to_string())?;
        let own_path = own_path.to_string_lossy();
        Ok(Some(
            executable == own_path
                || executable.ends_with("/humanchrome-bridge")
                || executable == "humanchrome-bridge",
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("fleet pid ownership checks are unsupported on this platform".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use tempfile::tempdir;

    use super::{FleetProfile, refresh_profile_native_host_descriptors};
    use crate::cli::{
        HostPlatform, NativeMessagingManifest, NativeMessagingPaths, RegistrationContext,
        SystemInstallAuthorization,
    };

    fn context(root: &Path) -> RegistrationContext {
        RegistrationContext::new(
            NativeMessagingPaths::new(
                HostPlatform::Linux,
                root.join("home"),
                root.join("appdata"),
                root.join("system"),
            ),
            SystemInstallAuthorization::Verified,
        )
    }

    fn native_host(root: &Path) -> std::path::PathBuf {
        let host = root.join("native-host");
        fs::write(&host, "#!/bin/sh\nexit 0\n").expect("write host");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&host, fs::Permissions::from_mode(0o755))
                .expect("make host executable");
        }
        host
    }

    fn browser_profile() -> FleetProfile {
        FleetProfile {
            name: "browser".to_owned(),
            port: 12_306,
            labels: Vec::new(),
            purpose: None,
            enabled: true,
            idle_stop: None,
        }
    }

    #[test]
    fn refresh_retargets_owned_stale_descriptor_and_preserves_origins() {
        let directory = tempdir().expect("temporary root");
        let root = directory.path().join("fleet");
        let descriptor = root
            .join("profiles/browser/NativeMessagingHosts")
            .join("com.humanchrome.nativehost.json");
        fs::create_dir_all(descriptor.parent().expect("descriptor parent"))
            .expect("create profile descriptor parent");
        let retired = directory
            .path()
            .join("source-checkout/app/native-server/dist/run_host.sh");
        let mut stale = NativeMessagingManifest::new(retired).expect("stale manifest");
        stale
            .allowed_origins
            .push("chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_owned());
        fs::write(
            &descriptor,
            serde_json::to_vec_pretty(&stale).expect("serialize stale descriptor"),
        )
        .expect("write stale descriptor");

        let unmanaged = root
            .join("profiles/unmanaged/NativeMessagingHosts")
            .join("com.humanchrome.nativehost.json");
        fs::create_dir_all(unmanaged.parent().expect("unmanaged parent"))
            .expect("create unmanaged descriptor parent");
        fs::write(&unmanaged, b"unmanaged descriptor").expect("write unmanaged descriptor");

        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let registration = context(directory.path());
        let host = native_host(directory.path());
        let verified = runtime
            .block_on(registration.verify_native_host(&host))
            .expect("verify replacement host");
        runtime
            .block_on(refresh_profile_native_host_descriptors(
                &root,
                &[browser_profile()],
                &verified,
            ))
            .expect("refresh stale descriptor");

        let refreshed: NativeMessagingManifest =
            serde_json::from_slice(&fs::read(&descriptor).expect("read refreshed descriptor"))
                .expect("parse refreshed descriptor");
        assert_eq!(refreshed.path, verified.path());
        assert_eq!(refreshed.allowed_origins, stale.allowed_origins);
        assert_eq!(
            fs::read(&unmanaged).expect("read unmanaged descriptor"),
            b"unmanaged descriptor"
        );
    }

    #[test]
    fn refresh_leaves_current_valid_descriptor_byte_stable() {
        let directory = tempdir().expect("temporary root");
        let root = directory.path().join("fleet");
        let descriptor = root
            .join("profiles/browser/NativeMessagingHosts")
            .join("com.humanchrome.nativehost.json");
        fs::create_dir_all(descriptor.parent().expect("descriptor parent"))
            .expect("create profile descriptor parent");

        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let registration = context(directory.path());
        let host = native_host(directory.path());
        let verified = runtime
            .block_on(registration.verify_native_host(&host))
            .expect("verify current host");
        let bytes = serde_json::to_vec(verified.manifest()).expect("serialize descriptor");
        fs::write(&descriptor, &bytes).expect("write current descriptor");
        runtime
            .block_on(refresh_profile_native_host_descriptors(
                &root,
                &[browser_profile()],
                &verified,
            ))
            .expect("refresh current descriptor");

        assert_eq!(fs::read(descriptor).expect("read descriptor"), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn refresh_refuses_profile_directory_symlinked_outside_fleet_root() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().expect("temporary root");
        let root = directory.path().join("fleet");
        let outside = directory.path().join("outside");
        let outside_descriptor = outside
            .join("NativeMessagingHosts")
            .join("com.humanchrome.nativehost.json");
        fs::create_dir_all(outside_descriptor.parent().expect("outside parent"))
            .expect("create outside descriptor parent");
        fs::write(&outside_descriptor, b"outside descriptor").expect("write outside descriptor");
        fs::create_dir_all(root.join("profiles")).expect("create profiles root");
        symlink(&outside, root.join("profiles/browser")).expect("link outside profile");

        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let registration = context(directory.path());
        let host = native_host(directory.path());
        let verified = runtime
            .block_on(registration.verify_native_host(&host))
            .expect("verify replacement host");
        let error = runtime
            .block_on(refresh_profile_native_host_descriptors(
                &root,
                &[browser_profile()],
                &verified,
            ))
            .expect_err("outside profile must be refused");

        assert!(error.contains("symlinked fleet profile"));
        assert_eq!(
            fs::read(outside_descriptor).expect("read outside descriptor"),
            b"outside descriptor"
        );
    }
}
