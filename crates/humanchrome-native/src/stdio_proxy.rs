//! Stdio MCP proxy for an already-running HumanChrome HTTP bridge.
//!
//! The proxy deliberately owns no native actor or browser lifecycle. It implements the
//! local stdio server surface while using Streamable HTTP for the existing bridge.

use std::{
    collections::HashMap,
    env, io,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use humanchrome_core::{json_document::JsonDocument, session::normalize_session_name};
use reqwest::{Client, StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, mpsc},
    task::JoinSet,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::{mcp::protocol, paths::NativePaths, registry::InstanceRegistry};

const CLIENT_NAME: &str = "humanchrome-stdio";
const CLIENT_VERSION: &str = "1.0.0";
const SERVER_NAME: &str = "StdioHumanChromeServer";
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// Runs the stdio-to-HTTP MCP proxy until stdin closes or the process receives a shutdown signal.
///
/// The bridge URL comes from the installed `mcp/stdio-config.json`, with the same environment
/// resolution order as the existing Node proxy: `HUMANCHROME_URL`, `HUMANCHROME_PORT`, live
/// instance discovery, then the configured URL.
///
/// # Errors
/// Returns an error when proxy configuration, stdio framing, or output writing cannot continue.
pub async fn run() -> anyhow::Result<()> {
    let bridge_url = load_bridge_url().await?;
    let session_name = resolve_session_name();
    let upstream = Upstream::new(bridge_url, session_name)?;
    serve(upstream).await
}

#[derive(Clone)]
struct Upstream {
    inner: Arc<UpstreamInner>,
}

struct UpstreamInner {
    client: Client,
    url: String,
    session_name: Option<String>,
    initialize: Mutex<bool>,
    next_request_id: AtomicU64,
}

impl Upstream {
    fn new(url: String, session_name: Option<String>) -> anyhow::Result<Self> {
        // Parse once so invalid configuration fails before the stdio protocol starts. The parsed
        // URL is not logged because an explicit override may include userinfo.
        let _ = reqwest::Url::parse(&url).map_err(|_| anyhow::anyhow!("invalid bridge URL"))?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| anyhow::anyhow!("could not create bridge HTTP client"))?;
        Ok(Self {
            inner: Arc::new(UpstreamInner {
                client,
                url,
                session_name,
                initialize: Mutex::new(false),
                next_request_id: AtomicU64::new(1),
            }),
        })
    }

    fn next_request_id(&self) -> u64 {
        self.inner.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn ensure_initialized(&self) -> Result<(), UpstreamFailure> {
        let mut initialized = self.inner.initialize.lock().await;
        if *initialized {
            return Ok(());
        }

        let request_id = self.next_request_id();
        let initialize = JsonDocument::object([
            ("jsonrpc", JsonDocument::from("2.0")),
            ("id", JsonDocument::from(Value::from(request_id))),
            ("method", JsonDocument::from("initialize")),
            (
                "params",
                JsonDocument::from(json!({
                    "protocolVersion": protocol::LATEST_HANDSHAKE_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": CLIENT_NAME, "version": CLIENT_VERSION},
                })),
            ),
        ]);
        let response = self.post(initialize, false).await?;
        response_result(response)?;

        let initialized_notification = JsonDocument::object([
            ("jsonrpc", JsonDocument::from("2.0")),
            ("method", JsonDocument::from("notifications/initialized")),
        ]);
        self.post(initialized_notification, true).await?;
        *initialized = true;
        Ok(())
    }

    async fn request(
        &self,
        request_id: u64,
        method: &str,
        params: Option<JsonDocument>,
    ) -> Result<JsonDocument, UpstreamFailure> {
        self.ensure_initialized().await?;
        let mut fields = vec![
            ("jsonrpc", JsonDocument::from("2.0")),
            ("id", JsonDocument::from(Value::from(request_id))),
            ("method", JsonDocument::from(method)),
        ];
        if let Some(params) = params {
            fields.push(("params", params));
        }
        let response = self.post(JsonDocument::object(fields), true).await?;
        response_result(response)
    }

    async fn notify_cancelled(&self, request_id: u64) {
        if self.ensure_initialized().await.is_err() {
            return;
        }
        let notification = JsonDocument::object([
            ("jsonrpc", JsonDocument::from("2.0")),
            ("method", JsonDocument::from("notifications/cancelled")),
            (
                "params",
                JsonDocument::from(json!({"requestId": request_id})),
            ),
        ]);
        let _ = self.post(notification, true).await;
    }

    async fn post(
        &self,
        document: JsonDocument,
        include_protocol_header: bool,
    ) -> Result<JsonDocument, UpstreamFailure> {
        let mut request = self
            .inner
            .client
            .post(self.inner.url.as_str())
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header(header::CONTENT_TYPE, "application/json")
            .body(document.to_json_text());
        if include_protocol_header {
            request = request.header("mcp-protocol-version", protocol::LATEST_HANDSHAKE_VERSION);
        }
        if let Some(session_name) = &self.inner.session_name {
            request = request
                .header("x-humanchrome-session", session_name.as_str())
                .header("x-humanchrome-agent", session_name.as_str());
        }

        let response = request.send().await.map_err(|_| UpstreamFailure)?;
        if !response.status().is_success() {
            return Err(UpstreamFailure);
        }
        if response.status() == StatusCode::ACCEPTED {
            return Ok(JsonDocument::from(Value::Null));
        }

        let is_sse = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/event-stream"));
        let body = response.bytes().await.map_err(|_| UpstreamFailure)?;
        let text = std::str::from_utf8(&body).map_err(|_| UpstreamFailure)?;
        if is_sse {
            parse_sse_response(text)
        } else {
            JsonDocument::parse(text).map_err(|_| UpstreamFailure)
        }
    }
}

#[derive(Clone)]
struct PendingCall {
    cancel: CancellationToken,
    upstream_id: u64,
}

type PendingCalls = Arc<Mutex<HashMap<String, PendingCall>>>;

async fn serve(upstream: Upstream) -> anyhow::Result<()> {
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let (outbound, mut responses) = mpsc::unbounded_channel::<JsonDocument>();
    let writer = tokio::spawn(async move {
        let mut output = tokio::io::stdout();
        while let Some(response) = responses.recv().await {
            output.write_all(response.to_json_text().as_bytes()).await?;
            output.write_all(b"\n").await?;
            output.flush().await?;
        }
        Ok::<(), io::Error>(())
    });

    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut requests = JoinSet::new();
    let mut shutdown = tokio::spawn(wait_for_shutdown());
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            line = input.next_line() => {
                let Some(line) = line? else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match JsonDocument::parse(&line) {
                    Ok(request) => {
                        let upstream = upstream.clone();
                        let pending = Arc::clone(&pending);
                        let outbound = outbound.clone();
                        requests.spawn(async move {
                            if let Some(response) =
                                handle_request(request, upstream, pending).await
                            {
                                let _ = outbound.send(response);
                            }
                        });
                    }
                    Err(_) => {
                        let _ = outbound.send(jsonrpc_error(
                            JsonDocument::from(Value::Null),
                            -32700,
                            "Parse error",
                        ));
                    }
                }
            }
        }
    }

    shutdown.abort();
    requests.abort_all();
    while requests.join_next().await.is_some() {}
    drop(outbound);
    writer
        .await
        .map_err(|_| anyhow::anyhow!("stdio output task failed"))??;
    Ok(())
}

async fn handle_request(
    request: JsonDocument,
    upstream: Upstream,
    pending: PendingCalls,
) -> Option<JsonDocument> {
    if request.get("jsonrpc").and_then(|value| value.as_str()) != Some("2.0") {
        return Some(jsonrpc_error(
            JsonDocument::from(Value::Null),
            -32600,
            "Invalid Request",
        ));
    }
    let Some(method) = request.get("method").and_then(|value| value.as_str()) else {
        return Some(jsonrpc_error(
            JsonDocument::from(Value::Null),
            -32600,
            "Invalid Request",
        ));
    };
    let request_id = request.get("id").map(|value| value.to_owned());
    let params = request
        .get("params")
        .map(|value| value.to_owned())
        .unwrap_or_else(|| JsonDocument::from(json!({})));

    match method {
        "initialize" => request_id.map(|id| initialize_response(id, &params)),
        "notifications/initialized" => None,
        "notifications/cancelled" => {
            cancel_request(params, pending, upstream).await;
            None
        }
        "ping" => request_id.map(|id| jsonrpc_result(id, JsonDocument::from(json!({})))),
        "tools/list" => {
            let id = request_id?;
            let upstream_id = upstream.next_request_id();
            match upstream.request(upstream_id, "tools/list", None).await {
                Ok(result) => Some(jsonrpc_result(id, result)),
                Err(_) => Some(jsonrpc_error(id, -32603, "Failed to connect to MCP server")),
            }
        }
        "tools/call" => {
            let id = request_id?;
            let name = params.get("name").and_then(|value| value.as_str());
            let Some(name) = name else {
                return Some(jsonrpc_error(id, -32602, "Invalid params"));
            };
            let args = params
                .get("arguments")
                .map(|value| value.to_owned())
                .unwrap_or_else(|| JsonDocument::from(json!({})));
            let upstream_id = upstream.next_request_id();
            let key = id.to_json_text();
            let cancellation = CancellationToken::new();
            pending.lock().await.insert(
                key.clone(),
                PendingCall {
                    cancel: cancellation.clone(),
                    upstream_id,
                },
            );
            let forwarded =
                JsonDocument::object([("name", JsonDocument::from(name)), ("arguments", args)]);
            let response = tokio::select! {
                _ = cancellation.cancelled() => None,
                result = timeout(
                    CALL_TIMEOUT,
                    upstream.request(upstream_id, "tools/call", Some(forwarded)),
                ) => {
                    match result {
                        Ok(Ok(result)) => Some(jsonrpc_result(id, result)),
                        Ok(Err(_)) | Err(_) => Some(jsonrpc_result(id, tool_call_error())),
                    }
                }
            };
            pending.lock().await.remove(&key);
            response
        }
        _ if request_id.is_none() => None,
        _ => Some(jsonrpc_error(
            request_id.unwrap_or_else(|| JsonDocument::from(Value::Null)),
            -32601,
            "Method not found",
        )),
    }
}

async fn cancel_request(params: JsonDocument, pending: PendingCalls, upstream: Upstream) {
    let Some(request_id) = params.get("requestId").map(|value| value.to_owned()) else {
        return;
    };
    let entry = pending
        .lock()
        .await
        .get(&request_id.to_json_text())
        .cloned();
    let Some(entry) = entry else {
        return;
    };
    entry.cancel.cancel();
    tokio::spawn(async move {
        upstream.notify_cancelled(entry.upstream_id).await;
    });
}

fn initialize_response(id: JsonDocument, params: &JsonDocument) -> JsonDocument {
    jsonrpc_result(
        id,
        JsonDocument::from(protocol::initialize_result(
            params
                .get("protocolVersion")
                .and_then(|value| value.as_str()),
            SERVER_NAME,
            CLIENT_VERSION,
        )),
    )
}

fn jsonrpc_result(id: JsonDocument, result: JsonDocument) -> JsonDocument {
    JsonDocument::object([
        ("jsonrpc", JsonDocument::from("2.0")),
        ("id", id),
        ("result", result),
    ])
}

fn jsonrpc_error(id: JsonDocument, code: i32, message: &str) -> JsonDocument {
    // `id` stays lossless; only the server-authored error payload uses rmcp serialization.
    let error = serde_json::to_value(protocol::error_data(code, message, None))
        .expect("rmcp error data must serialize");
    JsonDocument::object([
        ("jsonrpc", JsonDocument::from("2.0")),
        ("id", id),
        ("error", JsonDocument::from(error)),
    ])
}

fn tool_call_error() -> JsonDocument {
    JsonDocument::from(json!({
        "content": [{
            "type": "text",
            "text": "Error calling tool: Failed to connect to MCP server",
        }],
        "isError": true,
    }))
}

fn response_result(response: JsonDocument) -> Result<JsonDocument, UpstreamFailure> {
    if response.get("error").is_some() {
        return Err(UpstreamFailure);
    }
    response
        .get("result")
        .map(|value| value.to_owned())
        .ok_or(UpstreamFailure)
}

fn parse_sse_response(body: &str) -> Result<JsonDocument, UpstreamFailure> {
    let mut data = String::new();
    let mut response = None;
    for line in body.lines() {
        if line.is_empty() || line == "\r" {
            if !data.is_empty() {
                response = Some(JsonDocument::parse(data.trim_end()).map_err(|_| UpstreamFailure)?);
                data.clear();
            }
            continue;
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(value) = line.strip_prefix("data:") {
            let value = value.strip_prefix(' ').unwrap_or(value);
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value);
        }
    }
    if !data.is_empty() {
        response = Some(JsonDocument::parse(data.trim_end()).map_err(|_| UpstreamFailure)?);
    }
    response.ok_or(UpstreamFailure)
}

#[derive(Debug)]
struct UpstreamFailure;

async fn load_bridge_url() -> anyhow::Result<String> {
    let config_path = stdio_config_path()?;
    let contents = std::fs::read_to_string(config_path)
        .map_err(|_| anyhow::anyhow!("configuration stdio-config.json not found or invalid"))?;
    let config: StdioConfig = serde_json::from_str(&contents)
        .map_err(|_| anyhow::anyhow!("configuration stdio-config.json not found or invalid"))?;
    resolve_bridge_url(&config.url).await
}

#[derive(Deserialize)]
struct StdioConfig {
    url: String,
}

fn stdio_config_path() -> anyhow::Result<PathBuf> {
    let executable =
        env::current_exe().map_err(|_| anyhow::anyhow!("could not resolve stdio configuration"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| anyhow::anyhow!("could not resolve stdio configuration"))?;
    Ok(directory.join("mcp").join("stdio-config.json"))
}

async fn resolve_bridge_url(default_url: &str) -> anyhow::Result<String> {
    if let Some(url) = env::var_os("HUMANCHROME_URL").filter(|value| !value.is_empty()) {
        return url
            .into_string()
            .map_err(|_| anyhow::anyhow!("invalid bridge URL"));
    }

    let mut base =
        reqwest::Url::parse(default_url).map_err(|_| anyhow::anyhow!("invalid bridge URL"))?;
    if let Some(port) = env::var_os("HUMANCHROME_PORT").filter(|value| !value.is_empty()) {
        let port = port
            .into_string()
            .map_err(|_| anyhow::anyhow!("invalid bridge port"))?;
        let port = port
            .parse::<u16>()
            .map_err(|_| anyhow::anyhow!("invalid bridge port"))?;
        base.set_port(Some(port))
            .map_err(|_| anyhow::anyhow!("invalid bridge port"))?;
        return Ok(base.to_string());
    }
    let now: u64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| anyhow::anyhow!("could not resolve current time"))?
        .as_millis()
        .try_into()
        .map_err(|_| anyhow::anyhow!("could not resolve current time"))?;

    let records: Vec<u16> = match NativePaths::from_environment() {
        Ok(paths) => {
            let registry = InstanceRegistry::new(paths.registry);
            registry
                .list(now)
                .await
                .into_iter()
                .filter_map(|record| record.get("port").and_then(Value::as_u64))
                .filter_map(|port| u16::try_from(port).ok())
                .collect()
        }
        Err(_) => Vec::new(),
    };
    let default_port = base.port().unwrap_or(0);
    if records.contains(&default_port) {
        return Ok(default_url.to_owned());
    }
    if let [port] = records.as_slice() {
        base.set_port(Some(*port))
            .map_err(|_| anyhow::anyhow!("invalid bridge port"))?;
        return Ok(base.to_string());
    }
    Ok(default_url.to_owned())
}

fn resolve_session_name() -> Option<String> {
    if let Some(name) = env::var_os("HUMANCHROME_SESSION")
        && let Ok(name) = name.into_string()
        && let Some(normalized) = normalize_session_name(&Value::String(name))
    {
        return Some(normalized);
    }
    let directory = env::current_dir().ok()?;
    let name = directory.file_name()?.to_str()?;
    normalize_session_name(&Value::String(name.to_owned()))
}

async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            let _ = tokio::signal::ctrl_c().await;
            return;
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
