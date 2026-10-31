//! Holds a real fleet Chrome profile outside the gateway for adoption testing.

use std::{env, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail};
use humanchrome_native::{
    fleet::runtime::{
        LaunchConfig, find_chrome_for_profile, launch_profile_with_extension,
        terminate_chrome_checked,
    },
    platform::process_is_alive,
};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FleetConfig {
    chrome_path: PathBuf,
    extension_dir: PathBuf,
    bridge_token: String,
    profiles: Vec<Profile>,
}

#[derive(Debug, Deserialize)]
struct Profile {
    name: String,
    port: u16,
}

#[tokio::main]
async fn main() -> Result<()> {
    let [config_path, profile_name, previous_pid] = arguments()?;
    let config_path = PathBuf::from(config_path);
    let root = config_path
        .parent()
        .context("fleet configuration must have a parent directory")?;
    let config: FleetConfig = serde_json::from_slice(
        &tokio::fs::read(&config_path)
            .await
            .with_context(|| format!("reading {}", config_path.display()))?,
    )
    .with_context(|| format!("parsing {}", config_path.display()))?;
    let profile = config
        .profiles
        .iter()
        .find(|profile| profile.name == profile_name)
        .with_context(|| format!("unknown fixture profile {profile_name}"))?;
    let directory = root.join("profiles").join(&profile.name);
    let previous_pid: u32 = previous_pid
        .parse()
        .with_context(|| format!("parsing prior Chrome PID {previous_pid}"))?;

    let owners = find_chrome_for_profile(&config.chrome_path, &directory).await?;
    if owners.contains(&previous_pid) {
        terminate_chrome_checked(previous_pid, Duration::from_secs(5)).await?;
    } else if process_is_alive(previous_pid) {
        bail!("refusing to terminate unrelated pid {previous_pid}");
    }

    let launched = launch_profile_with_extension(
        &LaunchConfig {
            fleet_root: root.to_owned(),
            chrome_path: config.chrome_path,
            extension_dir: config.extension_dir,
            bridge_token: config.bridge_token,
        },
        &profile.name,
        &directory,
        profile.port,
    )
    .await?;
    let pid = launched.process.pid;
    tokio::fs::create_dir_all(root.join("run")).await?;
    tokio::fs::write(
        root.join("run").join(format!("{}.pid", profile.name)),
        pid.to_string(),
    )
    .await?;
    println!("EXTERNAL_BROWSER_READY {pid}");
    tokio::io::stdout().flush().await?;

    #[cfg(unix)]
    let exited = tokio::select! {
        result = launched.process.wait_for_exit() => {
            result?;
            true
        },
        result = wait_for_shutdown() => {
            result?;
            false
        },
    };
    #[cfg(not(unix))]
    let exited = {
        wait_for_shutdown().await?;
        false
    };
    if !exited {
        launched
            .process
            .terminate_checked(Duration::from_secs(5))
            .await?;
    }
    Ok(())
}

fn arguments() -> Result<[String; 3]> {
    let values: Vec<_> = env::args().skip(1).collect();
    values.try_into().map_err(|_| {
        anyhow::anyhow!("usage: fleet-external-browser <fleet.json> <profile-name> <previous-pid>")
    })
}

#[cfg(unix)]
async fn wait_for_shutdown() -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate()).context("installing SIGTERM handler")?;
    let mut interrupt = signal(SignalKind::interrupt()).context("installing SIGINT handler")?;
    tokio::select! {
        _ = terminate.recv() => Ok(()),
        _ = interrupt.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown() -> Result<()> {
    tokio::signal::ctrl_c()
        .await
        .context("waiting for shutdown signal")
}
