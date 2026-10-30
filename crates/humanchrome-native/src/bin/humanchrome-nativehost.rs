//! Chrome Native Messaging entrypoint; isolated by the existing path environment contract.

use humanchrome_core::json_document::JsonDocument;
use humanchrome_native::{
    agent::{AgentHttp, AgentHttpConfig, CodexProvider, ProviderRegistry},
    daemon::{self, DaemonMode},
    file_ops::{FileOperations, trace::DevtoolsTraceAnalyzer},
    native_host::{NativeClient, NativeHost},
    paths::NativePaths,
    providers::{OptionalEnginePaths, claude::ClaudeProvider, engine_paths},
    server::{self, lifecycle::ServerLifecycle},
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let paths = NativePaths::from_environment()?;
    let detached_primary = daemon::is_detached_primary();
    if !detached_primary
        && let Err(error) =
            daemon::ensure_detached_primary(&paths.daemon_socket, DaemonMode::from_environment())
                .await
    {
        // Retain the direct-primary path when the host executable cannot be
        // re-executed; this is the existing availability behavior.
        tracing::warn!(%error, "unable to launch detached native daemon");
    }
    let engines = engine_paths()?;
    let node =
        std::env::var_os("HC_TRACE_NODE").map_or_else(|| engines.node.clone(), PathBuf::from);
    let analyzer = match std::env::var_os("HC_TRACE_ANALYZER") {
        Some(path) => PathBuf::from(path),
        None => humanchrome_native::providers::adapter_path()?,
    };
    let files = Arc::new(
        FileOperations::new(
            std::env::temp_dir().join("humanchrome-uploads"),
            DevtoolsTraceAnalyzer::new(node, analyzer),
        )
        .await?,
    );
    {
        let files = Arc::clone(&files);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
            loop {
                interval.tick().await;
                if let Err(error) = files.cleanup_old(std::time::SystemTime::now()).await {
                    tracing::warn!(%error, "error cleaning up old uploads");
                }
            }
        });
    }
    let (host, client, mut directives) = NativeHost::new(paths.clone());
    let mut server = ServerLifecycle::new(paths.registry.clone());
    #[cfg(unix)]
    let mut host_task = tokio::spawn(async move {
        if detached_primary {
            host.run_detached_primary().await
        } else {
            host.run().await
        }
    });
    #[cfg(not(unix))]
    let mut host_task = tokio::spawn(host.run());
    loop {
        tokio::select! {
            result = &mut host_task => {
                if server.port().is_some() { server.stop().await?; }
                result??;
                return Ok(());
            }
            message = directives.recv() => {
                let Some(message) = message else { break };
                let value = message.validation_value();
                match value.get("type").and_then(Value::as_str) {
                    Some("start") => start_server(&client, &mut server, &paths, &engines, &value).await,
                    Some("stop") => stop_server(&client, &mut server).await,
                    Some("file_operation") => {
                        let value = value.into_owned();
                        let client = client.clone();
                        let files = Arc::clone(&files);
                        tokio::spawn(async move {
                            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                            let result = files.handle(&payload).await;
                            let request_id = value.get("requestId").filter(|value| value.as_str().is_some_and(|id| !id.is_empty()));
                            let mut response = if let Some(request_id) = request_id {
                                json!({"type":"file_operation_response","responseToRequestId":request_id})
                            } else { json!({"type":"file_operation_result"}) };
                            if let Some(result) = result { response["payload"] = result; }
                            client.notify(JsonDocument::from(response));
                        });
                    }
                    _ => {},
                }
            }
        }
    }
    client.shutdown();
    if server.port().is_some() {
        server.stop().await?;
    }
    host_task.await??;
    Ok(())
}

async fn start_server(
    client: &NativeClient,
    server: &mut ServerLifecycle,
    paths: &NativePaths,
    engines: &OptionalEnginePaths,
    message: &Value,
) {
    if server.port().is_some() {
        notify_error(client, "Server is already running");
        return;
    }
    let pinned = std::env::var("HC_BRIDGE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0);
    let requested = pinned
        .or_else(|| {
            message
                .get("payload")
                .and_then(|payload| payload.get("port"))
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .filter(|port| *port > 0)
        })
        .unwrap_or(12306);
    let token = std::env::var("HUMANCHROME_TOKEN").ok();
    let agent_config = AgentHttpConfig::from_native_paths(paths);
    match server
        .start(
            requested,
            if pinned.is_some() { 0 } else { 100 },
            |port| {
                let agent = AgentHttp::with_bound_port(agent_config, port, |bridge_url| {
                    let mut providers = ProviderRegistry::default();
                    providers.register(Arc::new(CodexProvider::new(
                        engines.codex.clone(),
                        Some(bridge_url.clone()),
                    )));
                    let mut claude = ClaudeProvider::new(engines.node.clone(), Some(bridge_url));
                    if let Some(root) = std::env::var_os("HC_AGENT_SDK_ROOT") {
                        claude = claude.with_sdk_root(root);
                    }
                    providers.register(Arc::new(claude));
                    providers
                })
                .map_err(std::io::Error::other)?;
                Ok(server::router(
                    client.clone(),
                    token.as_deref(),
                    agent.router(),
                ))
            },
            client.remote_identity(),
        )
        .await
    {
        Ok(port) => {
            client.notify(JsonDocument::from(
                json!({"type":"server_started","payload":{"port":port,"requestedPort":requested}}),
            ));
        }
        Err(error) => notify_error(client, &format!("Failed to start server: {error}")),
    }
}

async fn stop_server(client: &NativeClient, server: &mut ServerLifecycle) {
    if server.port().is_none() {
        notify_error(client, "Server is not running");
        return;
    }
    match server.stop().await {
        Ok(()) => {
            client.notify(JsonDocument::from(json!({"type":"server_stopped"})));
        }
        Err(error) => notify_error(client, &format!("Failed to stop server: {error}")),
    }
}

fn notify_error(client: &NativeClient, message: &str) {
    client.notify(JsonDocument::from(
        json!({"type":"error","payload":{"message":message}}),
    ));
}
