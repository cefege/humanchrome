//! Launch a profile with its bridge environment and HumanChrome extension.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

use super::cdp::spawn_with_cdp_pipe;
use super::{
    ChromeProcess, FleetRuntimeError, assert_keychain_readable, chrome_args,
    disable_foreign_extensions, read_extension_manifest, restore_session,
};

/// Immutable settings needed to launch a Chrome profile.
#[derive(Clone, Debug)]
pub struct LaunchConfig {
    /// Fleet-owned root containing `run/` and `registry/instances/`.
    pub fleet_root: PathBuf,
    /// Chrome browser executable, not a helper executable.
    pub chrome_path: PathBuf,
    /// Built unpacked HumanChrome MV3 extension directory.
    pub extension_dir: PathBuf,
    /// Per-fleet bridge authentication token.
    pub bridge_token: String,
}

/// Process and extension result for one successful profile launch.
#[derive(Debug)]
pub struct LaunchedProfile {
    /// Started browser, including the retained CDP connection.
    pub process: ChromeProcess,
    /// Stable unpacked HumanChrome extension identifier.
    pub extension_id: String,
}

/// The exact environment visible to the extension bridge for a profile.
#[must_use]
pub fn profile_environment(
    config: &LaunchConfig,
    name: &str,
    port: u16,
) -> BTreeMap<String, String> {
    let mut environment = std::env::vars().collect::<BTreeMap<_, _>>();
    environment.insert("HC_BRIDGE_PORT".to_owned(), port.to_string());
    environment.insert(
        "HC_INSTANCE_REGISTRY_DIR".to_owned(),
        config
            .fleet_root
            .join("registry/instances")
            .to_string_lossy()
            .into_owned(),
    );
    environment.insert(
        "HC_BRIDGE_DAEMON_SOCKET".to_owned(),
        config
            .fleet_root
            .join("run")
            .join(format!("{name}.sock"))
            .to_string_lossy()
            .into_owned(),
    );
    environment.insert("HUMANCHROME_TOKEN".to_owned(), config.bridge_token.clone());
    environment.insert("HC_FLEET_PROFILE".to_owned(), name.to_owned());
    environment
}

/// Launch Chrome, restore web session cookies, load HumanChrome, and remove foreign extensions.
///
/// The function deliberately has no network-debug-port fallback. The returned [`ChromeProcess`]
/// owns both pipe endpoints and must be retained until profile shutdown.
///
/// # Errors
/// Any extension, Keychain, CDP, or process failure tears down the fresh Chrome process before
/// returning, leaving no browser holding the profile lock.
pub async fn launch_profile_with_extension(
    config: &LaunchConfig,
    name: &str,
    user_data_dir: &Path,
    port: u16,
) -> Result<LaunchedProfile, FleetRuntimeError> {
    let manifest_key = read_extension_manifest(&config.extension_dir).await?;
    if manifest_key.is_none() {
        return Err(FleetRuntimeError::Profile(
            "extension build is keyless; rebuild with CHROME_EXTENSION_KEY set".to_owned(),
        ));
    }
    assert_keychain_readable().await?;
    for directory in [
        "OptGuideOnDeviceModel",
        "OptGuideManifestModel",
        "OptimizationGuideModelsManifest",
    ] {
        let _ = tokio::fs::remove_dir_all(user_data_dir.join(directory)).await;
    }
    let environment = profile_environment(config, name, port)
        .into_iter()
        .collect::<Vec<_>>();
    let process = spawn_with_cdp_pipe(
        &config.chrome_path,
        &chrome_args(user_data_dir),
        &environment,
    )?;
    let launch = async {
        let _ = restore_session(&process.cdp, user_data_dir).await;
        let extension_id = process.cdp.load_unpacked(&config.extension_dir).await?;
        disable_foreign_extensions(&process.cdp, &extension_id, Duration::from_secs(15)).await?;
        Ok::<_, FleetRuntimeError>(extension_id)
    }
    .await;
    match launch {
        Ok(extension_id) => Ok(LaunchedProfile {
            process,
            extension_id,
        }),
        Err(error) => {
            process.terminate_checked(Duration::ZERO).await?;
            Err(error)
        }
    }
}
