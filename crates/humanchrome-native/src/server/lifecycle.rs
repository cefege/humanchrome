//! Own the HTTP listener and its instance record for one native host process.

use std::{
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use axum::Router;
use chrono::{SecondsFormat, Utc};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

use crate::{
    native_host::RemoteIdentity,
    registry::{InstanceRecord, InstanceRegistry},
};

/// A running server's bound port and owned shutdown task.
#[derive(Debug)]
struct Running {
    port: u16,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<io::Result<()>>,
}

/// Starts and stops only the listener and registry entry owned by this process.
#[derive(Debug)]
pub struct ServerLifecycle {
    registry: InstanceRegistry,
    running: Option<Running>,
}

impl ServerLifecycle {
    /// Associate this service with its configured instance registry.
    #[must_use]
    pub fn new(registry_directory: PathBuf) -> Self {
        Self {
            registry: InstanceRegistry::new(registry_directory),
            running: None,
        }
    }

    /// Bind the requested loopback port, optionally walking occupied ports.
    ///
    /// # Errors
    /// Returns an error if already running or no port is available. Registry
    /// publication is best effort, matching the installed bridge.
    pub async fn start(
        &mut self,
        requested: u16,
        max_walk: u16,
        make_router: impl FnOnce(u16) -> io::Result<Router>,
        identity: RemoteIdentity,
    ) -> io::Result<u16> {
        if self.running.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Server is already running",
            ));
        }
        let mut last_error = None;
        for offset in 0..=max_walk {
            let Some(port) = requested.checked_add(offset) else {
                break;
            };
            let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
            let listener = match TcpListener::bind(address).await {
                Ok(listener) => listener,
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                    last_error = Some(error);
                    continue;
                }
                Err(error) => return Err(error),
            };
            let bound = listener.local_addr()?.port();
            let router = make_router(bound)?;
            let record = InstanceRecord {
                pid: std::process::id(),
                port: bound,
                extension_id: identity.extension_id.unwrap_or_else(|| "unknown".into()),
                instance_id: identity.instance_id,
                chrome_binary: std::env::var("HC_CHROME_BINARY").ok(),
                started_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            };
            if let Err(error) = self.registry.write(&record).await {
                tracing::error!(%error, "instance registry write failed");
            }
            let (shutdown, receiver) = oneshot::channel();
            let task = tokio::spawn(async move {
                axum::serve(listener, router)
                    .with_graceful_shutdown(async {
                        let _ = receiver.await;
                    })
                    .await
            });
            self.running = Some(Running {
                port: bound,
                shutdown,
                task,
            });
            return Ok(bound);
        }
        Err(last_error.unwrap_or_else(|| {
            io::Error::new(io::ErrorKind::AddrNotAvailable, "no available port")
        }))
    }

    /// Stop the listener, wait for in-flight requests, and remove our record.
    ///
    /// # Errors
    /// Returns an error if the service was not running or the server task failed.
    pub async fn stop(&mut self) -> io::Result<()> {
        let running = self
            .running
            .take()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Server is not running"))?;
        let _ = running.shutdown.send(());
        let result = running
            .task
            .await
            .map_err(io::Error::other)
            .and_then(|result| result);
        self.registry.remove(std::process::id()).await;
        result
    }

    /// Return the current bound port, if this service owns a listener.
    #[must_use]
    pub fn port(&self) -> Option<u16> {
        self.running.as_ref().map(|running| running.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::get};

    #[tokio::test]
    async fn listener_registers_serves_and_releases_its_record() {
        let directory = tempfile::tempdir().expect("temporary registry directory");
        let mut lifecycle = ServerLifecycle::new(directory.path().to_path_buf());
        let router = Router::new().route("/ping", get(|| async { "pong" }));
        let identity = RemoteIdentity {
            extension_id: Some("extension".into()),
            instance_id: Some("instance".into()),
        };
        let port = lifecycle
            .start(0, 0, |_| Ok(router), identity)
            .await
            .expect("bind HTTP server");
        assert_eq!(lifecycle.port(), Some(port));
        let response = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
            .await
            .expect("request local listener")
            .text()
            .await
            .expect("read response");
        assert_eq!(response, "pong");
        let record = directory
            .path()
            .join(format!("{}.json", std::process::id()));
        let bytes = tokio::fs::read(&record)
            .await
            .expect("instance record exists");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("valid registry JSON");
        assert_eq!(value["port"], port);
        assert_eq!(value["extensionId"], "extension");
        assert_eq!(value["instanceId"], "instance");
        lifecycle.stop().await.expect("stop HTTP server");
        assert!(!record.exists());
        assert_eq!(lifecycle.port(), None);
        assert_eq!(
            lifecycle
                .stop()
                .await
                .expect_err("double stop fails")
                .kind(),
            io::ErrorKind::NotFound
        );
    }

    #[tokio::test]
    async fn occupied_exact_port_is_not_silently_changed() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("occupy port");
        let port = occupied.local_addr().expect("port").port();
        let directory = tempfile::tempdir().expect("temporary registry directory");
        let mut lifecycle = ServerLifecycle::new(directory.path().to_path_buf());
        let error = lifecycle
            .start(port, 0, |_| Ok(Router::new()), RemoteIdentity::default())
            .await
            .expect_err("occupied pinned port");
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        assert_eq!(lifecycle.port(), None);
    }
}
