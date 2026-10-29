//! Standalone browserless fleet coordinator; no browser runs in this process.

use clap::Parser;
use humanchrome_native::fleet::coordinator::{CoordinatorConfig, FleetCoordinator};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "humanchrome-coordinator",
    version,
    about = "Serve the browserless fleet coordinator"
)]
struct Options {
    /// Private coordinator configuration JSON.
    #[arg(long)]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let options = Options::parse();
    let bytes = tokio::fs::read(&options.config)
        .await
        .map_err(|_| anyhow::anyhow!("unable to load valid coordinator configuration"))?;
    let mut raw: Value = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("unable to load valid coordinator configuration"))?;
    if let Ok(database_url) = std::env::var("HC_COORDINATOR_DATABASE_URL") {
        let Some(object) = raw.as_object_mut() else {
            anyhow::bail!("unable to load valid coordinator configuration")
        };
        object.insert("databaseUrl".into(), Value::String(database_url));
    }
    let config: CoordinatorConfig = serde_json::from_value(raw)
        .map_err(|_| anyhow::anyhow!("unable to load valid coordinator configuration"))?;
    let host = config.host.clone();
    let port = config.port;
    let coordinator = FleetCoordinator::try_new(config)
        .map_err(|_| anyhow::anyhow!("unable to load valid coordinator configuration"))?;
    coordinator.open().await?;
    let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
        Ok(listener) => listener,
        Err(error) => {
            coordinator.close().await;
            return Err(error.into());
        }
    };
    println!(
        "fleet: coordinator: listening on http://{}",
        listener.local_addr()?
    );
    let result = coordinator.serve_until(listener, shutdown_signal()).await;
    coordinator.close().await;
    result?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
