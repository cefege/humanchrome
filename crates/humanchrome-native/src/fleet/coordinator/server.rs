//! Authenticated HTTP coordinator and non-replaying worker stream proxy.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use crate::mcp::{http as mcp_http, protocol};
use axum::{
    Json, Router,
    body::Body,
    extract::{Extension, Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, Response, StatusCode, header},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{any, delete, get, post},
};
use futures_core::Stream;
use humanchrome_core::json_document::JsonDocument;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use serde_json::{Map, Value, json};
use tokio::{io::AsyncWriteExt, sync::Mutex, time};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use unicode_normalization::UnicodeNormalization;

use super::{
    config::{CoordinatorClient, CoordinatorConfig, CoordinatorWorker, WorkerInventory},
    store::{CoordinatorError, CoordinatorLease, CoordinatorProfile, CoordinatorStore},
};

const WORKER_TIMEOUT: Duration = Duration::from_secs(10);
const WORKER_ACTION_TIMEOUT: Duration = Duration::from_secs(180);

/// Authenticated identity attached to every protected coordinator request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientIdentity {
    /// Durable client identity.
    pub id: String,
    /// Whether this client may run administrative operations.
    pub admin: bool,
}

struct Inner {
    config: CoordinatorConfig,
    store: CoordinatorStore,
    http: reqwest::Client,
    worker_health: Mutex<HashMap<String, WorkerHealth>>,
    refresh: Mutex<RefreshState>,
    refresh_cancel: CancellationToken,
    refresh_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    active: Mutex<HashMap<String, usize>>,
}

#[derive(Clone, Debug)]
struct WorkerHealth {
    available: bool,
    error: Option<&'static str>,
}

struct RefreshState {
    last_completed: Option<i64>,
    result: Result<(), CoordinatorError>,
}

/// A running coordinator's reusable operation surface for MCP and binary integration.
#[derive(Clone)]
pub struct CoordinatorControl {
    inner: Arc<Inner>,
}

/// HTTP entry point and durable fleet coordinator.
#[derive(Clone)]
pub struct FleetCoordinator {
    inner: Arc<Inner>,
}

impl FleetCoordinator {
    /// Validates configuration and creates a coordinator that is not yet connected to PostgreSQL.
    ///
    /// # Errors
    /// Returns a credential-safe validation error without opening network connections.
    pub fn try_new(config: CoordinatorConfig) -> Result<Self, super::config::ConfigError> {
        let config = config.validate()?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| super::config::ConfigError)?;
        let store = CoordinatorStore::new(
            Arc::<str>::from(config.id.as_str()),
            Arc::<str>::from(config.database_url.as_str()),
        );
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                store,
                http,
                worker_health: Mutex::new(HashMap::new()),
                refresh: Mutex::new(RefreshState {
                    last_completed: None,
                    result: Ok(()),
                }),
                refresh_cancel: CancellationToken::new(),
                refresh_task: Mutex::new(None),
                active: Mutex::new(HashMap::new()),
            }),
        })
    }

    /// Opens PostgreSQL, acquires the coordinator singleton lock, and observes all workers.
    ///
    /// # Errors
    /// Fails closed when the singleton lock, database, or initial inventory cannot be established.
    pub async fn open(&self) -> Result<(), CoordinatorError> {
        self.inner.store.open().await?;
        if let Err(error) = refresh(&self.inner, true).await {
            self.inner.store.close().await;
            return Err(error);
        }
        let mut task = self.inner.refresh_task.lock().await;
        if task.is_none() {
            let inner = self.inner.clone();
            let cancel = inner.refresh_cancel.clone();
            *task = Some(tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = time::sleep(Duration::from_secs(10)) => {
                            let _ = refresh(&inner, true).await;
                        }
                    }
                }
            }));
        }
        Ok(())
    }

    /// Releases the singleton lock and stops all coordinator-owned background work.
    pub async fn close(&self) {
        self.inner.refresh_cancel.cancel();
        if let Some(task) = self.inner.refresh_task.lock().await.take() {
            task.abort();
        }
        self.inner.store.close().await;
    }

    /// Returns the reusable authenticated operation interface used by fleet MCP integration.
    #[must_use]
    pub fn control(&self) -> CoordinatorControl {
        CoordinatorControl {
            inner: self.inner.clone(),
        }
    }

    /// Builds the complete coordinator HTTP router.
    pub fn router(&self) -> Router {
        let protected = Router::new()
            .route("/v1/profiles", get(list_profiles).post(provision_profile))
            .route("/v1/workers", get(list_workers))
            .route("/v1/leases", get(list_leases))
            .route("/v1/leases/{agent}", delete(release_agent))
            .route("/v1/profiles/{name}/start", post(start_profile))
            .route("/v1/profiles/{name}/stop", post(stop_profile))
            .route("/v1/profiles/{name}/restart", post(restart_profile))
            .route("/v1/profiles/{name}/recover", post(recover_profile))
            .route("/v1/park", post(park))
            .route("/v1/fleet/mcp", any(fleet_mcp))
            .route("/v1/profiles/{name}/{*path}", any(named_proxy))
            .route("/v1/pool/{label}/{*path}", any(pool_proxy));
        Router::new()
            .route("/healthz", get(health))
            .route("/readyz", get(ready))
            .merge(protected)
            .with_state(self.inner.clone())
            .layer(middleware::from_fn(parse_body))
            .layer(middleware::from_fn_with_state(
                self.inner.clone(),
                authenticate,
            ))
            .layer(middleware::from_fn(compatibility_headers))
    }

    /// Serves the coordinator router on a caller-owned listener.
    ///
    /// Call [`Self::open`] before this method so serving never starts without the singleton
    /// PostgreSQL lock.
    ///
    /// # Errors
    /// Propagates listener and HTTP serving errors.
    pub async fn serve(self, listener: tokio::net::TcpListener) -> std::io::Result<()> {
        self.serve_until(listener, std::future::pending::<()>())
            .await
    }

    /// Serves until shutdown, closing owned connections before releasing durable authority.
    ///
    /// Matches the Node coordinator's `forceCloseConnections` policy: active streams must not
    /// prevent signal-driven shutdown or keep proxy work alive across a configuration reload.
    ///
    /// # Errors
    /// Propagates listener errors after closing all accepted connections.
    pub async fn serve_until<F, S>(
        &self,
        listener: tokio::net::TcpListener,
        shutdown: F,
    ) -> std::io::Result<S>
    where
        F: Future<Output = S>,
    {
        let router = self.router();
        let mut connections = tokio::task::JoinSet::new();
        tokio::pin!(shutdown);
        let result = loop {
            tokio::select! {
                signal = &mut shutdown => break Ok(signal),
                accepted = listener.accept() => {
                    let (socket, _) = match accepted {
                        Ok(accepted) => accepted,
                        Err(error) => break Err(error),
                    };
                    let service = TowerToHyperService::new(router.clone());
                    connections.spawn(async move {
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(socket), service).await;
                    });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        };
        drop(listener);
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        result
    }
}

impl CoordinatorControl {
    /// Lists profiles while concealing other clients' agent identities from non-administrators.
    pub async fn profiles(&self, client: &ClientIdentity) -> Result<Vec<Value>, CoordinatorError> {
        profiles(&self.inner, client).await
    }

    /// Lists leases visible to this client.
    pub async fn leases(&self, client: &ClientIdentity) -> Result<Vec<Value>, CoordinatorError> {
        leases(&self.inner, client).await
    }

    /// Explicitly releases all leases and route bindings belonging to one caller agent.
    pub async fn release_agent(
        &self,
        client: &ClientIdentity,
        agent: &str,
    ) -> Result<Vec<String>, CoordinatorError> {
        release_agent_inner(&self.inner, client, agent).await
    }

    /// Performs an administrator-only start, stop, or restart under a temporary fence.
    pub async fn profile_action(
        &self,
        client: &ClientIdentity,
        agent: &str,
        name: &str,
        action: &str,
    ) -> Result<Value, CoordinatorError> {
        control_profile(&self.inner, client, agent, name, action).await
    }

    /// Sets all workers' parked state after proving the fleet has no live leases.
    pub async fn park(
        &self,
        client: &ClientIdentity,
        parked: bool,
    ) -> Result<Value, CoordinatorError> {
        park_inner(&self.inner, client, parked).await
    }

    /// Lists fixed-purpose profiles for fleet MCP clients.
    pub async fn purposes(&self, client: &ClientIdentity) -> Result<Vec<Value>, CoordinatorError> {
        Ok(self
            .profiles(client)
            .await?
            .into_iter()
            .filter_map(|profile| {
                let purpose = profile.get("purpose")?.as_str()?;
                Some(json!({
                    "purpose": purpose,
                    "profile": profile.get("name"),
                    "node": profile.get("worker"),
                    "state": profile.get("state"),
                    "labels": profile.get("labels"),
                }))
            })
            .collect())
    }
}

async fn health(State(inner): State<Arc<Inner>>) -> Response<Body> {
    let healthy = inner.store.ready().await;
    (
        if healthy {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({ "healthy": healthy })),
    )
        .into_response()
}

async fn ready(State(inner): State<Arc<Inner>>) -> Response<Body> {
    let ready = inner.store.ready().await;
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({ "ready": ready })),
    )
        .into_response()
}

async fn authenticate(
    State(inner): State<Arc<Inner>>,
    mut request: Request,
    next: Next,
) -> Response<Body> {
    if request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.is_empty())
    {
        return framework_error(StatusCode::FORBIDDEN, "origin_not_allowed");
    }
    if matches!(request.uri().path(), "/healthz" | "/readyz") {
        return next.run(request).await;
    }
    let identity = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok())
        .and_then(|authorization| authenticate_client(&inner.config.clients, authorization));
    let Some(identity) = identity else {
        return framework_error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    if !inner.store.ready().await {
        return framework_error(StatusCode::SERVICE_UNAVAILABLE, "coordinator_unavailable");
    }
    request.extensions_mut().insert(identity);
    next.run(request).await
}

#[derive(Clone)]
struct ParsedBody(JsonDocument);

fn browser_proxy_path(path: &str) -> bool {
    path.starts_with("/v1/pool/")
        || path
            .strip_prefix("/v1/profiles/")
            .and_then(|path| path.split_once('/'))
            .is_some_and(|(_, suffix)| !matches!(suffix, "start" | "stop" | "restart" | "recover"))
}

async fn parse_body(request: Request, next: Next) -> Response<Body> {
    // Browser proxy routes use a scoped streaming parser in the TypeScript server.
    if browser_proxy_path(request.uri().path()) {
        return next.run(request).await;
    }
    if !matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return next.run(request).await;
    }
    let (mut parts, body) = request.into_parts();
    let bytes = match axum::body::to_bytes(body, 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return framework_error(StatusCode::SERVICE_UNAVAILABLE, "coordinator_unavailable");
        }
    };
    let parsed = if bytes.is_empty() && !parts.headers.contains_key(header::CONTENT_TYPE) {
        JsonDocument::from(Value::Null)
    } else {
        match crate::server::parse_tool_body(&parts.headers, &bytes) {
            Ok(document) => document,
            Err(_) => {
                return framework_error(StatusCode::SERVICE_UNAVAILABLE, "coordinator_unavailable");
            }
        }
    };
    let handled_body = matches!(
        parts.uri.path(),
        "/v1/fleet/mcp" | "/v1/profiles" | "/v1/park"
    );
    let body = if handled_body {
        parts.extensions.insert(ParsedBody(parsed));
        Body::empty()
    } else {
        Body::from(bytes)
    };
    next.run(Request::from_parts(parts, body)).await
}

fn take_body(request: &mut Request) -> JsonDocument {
    request
        .extensions_mut()
        .remove::<ParsedBody>()
        .expect("coordinator body parser precedes routes")
        .0
}

async fn compatibility_headers(request: Request, next: Next) -> Response<Body> {
    let mcp = request.uri().path() == "/v1/fleet/mcp" || browser_proxy_path(request.uri().path());
    let mut response = next.run(request).await;
    if !mcp
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| value == "application/json")
    {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    response
}

fn framework_error(status: StatusCode, code: &str) -> Response<Body> {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({"error":code})),
    )
        .into_response()
}

async fn list_profiles(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
) -> Result<Json<Value>, CoordinatorError> {
    Ok(Json(json!(profiles(&inner, &client).await?)))
}

async fn list_workers(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
) -> Result<Json<Value>, CoordinatorError> {
    require_admin(&client)?;
    refresh(&inner, false).await?;
    let health = inner.worker_health.lock().await;
    Ok(Json(json!(
        inner
            .config
            .workers
            .iter()
            .map(|worker| {
                let state = health.get(&worker.id).cloned().unwrap_or(WorkerHealth {
                    available: false,
                    error: Some("worker_unavailable"),
                });
                json!({ "id": worker.id, "available": state.available, "error": state.error })
            })
            .collect::<Vec<_>>()
    )))
}

async fn list_leases(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
) -> Result<Json<Value>, CoordinatorError> {
    Ok(Json(json!(leases(&inner, &client).await?)))
}

async fn release_agent(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    Path(agent): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, CoordinatorError> {
    let caller =
        agent_name(&headers, None).ok_or_else(|| CoordinatorError::new(400, "missing_agent"))?;
    if caller != agent {
        return Err(CoordinatorError::new(403, "agent_mismatch"));
    }
    Ok(Json(
        json!({ "released": release_agent_inner(&inner, &client, &agent).await? }),
    ))
}

async fn provision_profile(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    mut request: Request,
) -> Result<Json<Value>, CoordinatorError> {
    require_admin(&client)?;
    let body = take_body(&mut request);
    let body = body
        .into_value()
        .unwrap_or_else(|document| document.validation_value().into_owned());
    let object = body
        .as_object()
        .ok_or_else(|| CoordinatorError::new(400, "invalid_body"))?;
    let worker_id = object
        .get("worker")
        .and_then(Value::as_str)
        .ok_or_else(|| CoordinatorError::new(400, "invalid_args"))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| CoordinatorError::new(400, "invalid_args"))?;
    let seed_source = object
        .get("seedSource")
        .and_then(Value::as_str)
        .ok_or_else(|| CoordinatorError::new(400, "invalid_args"))?;
    let mut outgoing = Map::new();
    outgoing.insert("name".into(), Value::String(name.into()));
    outgoing.insert("seedSource".into(), Value::String(seed_source.into()));
    outgoing.insert(
        "labels".into(),
        object.get("labels").cloned().unwrap_or_else(|| json!([])),
    );
    let result = worker_json(
        &inner,
        worker(&inner, worker_id)?,
        "/profiles",
        Method::POST,
        Some(Value::Object(outgoing)),
        HeaderMap::new(),
        WORKER_ACTION_TIMEOUT,
    )
    .await?;
    refresh(&inner, true).await?;
    Ok(Json(result))
}

async fn start_profile(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, CoordinatorError> {
    Ok(Json(
        control_profile(
            &inner,
            &client,
            &agent_name(&headers, Some("control"))
                .ok_or_else(|| CoordinatorError::new(400, "missing_agent"))?,
            &name,
            "start",
        )
        .await?,
    ))
}

async fn stop_profile(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, CoordinatorError> {
    Ok(Json(
        control_profile(
            &inner,
            &client,
            &agent_name(&headers, Some("control"))
                .ok_or_else(|| CoordinatorError::new(400, "missing_agent"))?,
            &name,
            "stop",
        )
        .await?,
    ))
}

async fn restart_profile(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, CoordinatorError> {
    Ok(Json(
        control_profile(
            &inner,
            &client,
            &agent_name(&headers, Some("control"))
                .ok_or_else(|| CoordinatorError::new(400, "missing_agent"))?,
            &name,
            "restart",
        )
        .await?,
    ))
}

async fn recover_profile(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    Path(name): Path<String>,
) -> Result<Json<Value>, CoordinatorError> {
    require_admin(&client)?;
    let profile = inventory(&inner)
        .await?
        .into_iter()
        .find(|profile| profile.name == name)
        .ok_or_else(|| CoordinatorError::new(404, "unknown_profile"))?;
    if inner
        .store
        .leases(None, None, false)
        .await?
        .iter()
        .any(|lease| lease.profile == name)
    {
        return Err(CoordinatorError::new(409, "profile_busy"));
    }
    let result = worker_json(
        &inner,
        worker(&inner, &profile.worker)?,
        &format!("/profiles/{}/recover", encode_path(&profile.profile)),
        Method::POST,
        Some(json!({})),
        HeaderMap::new(),
        WORKER_ACTION_TIMEOUT,
    )
    .await?;
    refresh(&inner, true).await?;
    Ok(Json(result))
}

async fn park(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    mut request: Request,
) -> Result<Json<Value>, CoordinatorError> {
    let body = take_body(&mut request);
    if !body.is_object() {
        return Err(CoordinatorError::new(400, "invalid_body"));
    }
    let parked = body
        .get("parked")
        .and_then(|value| value.as_bool())
        .ok_or_else(|| CoordinatorError::new(400, "invalid_args"))?;
    Ok(Json(park_inner(&inner, &client, parked).await?))
}

async fn named_proxy(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    Path((name, path)): Path<(String, String)>,
    headers: HeaderMap,
    request: Request,
) -> Response<Body> {
    proxy(
        &inner,
        &client,
        agent_name(&headers, None),
        Some(name),
        None,
        path,
        request,
    )
    .await
}

async fn pool_proxy(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    Path((label, path)): Path<(String, String)>,
    headers: HeaderMap,
    request: Request,
) -> Response<Body> {
    proxy(
        &inner,
        &client,
        agent_name(&headers, None),
        None,
        Some(label),
        path,
        request,
    )
    .await
}

async fn proxy(
    inner: &Arc<Inner>,
    client: &ClientIdentity,
    agent: Option<String>,
    named: Option<String>,
    label: Option<String>,
    path: String,
    request: Request,
) -> Response<Body> {
    let Some(agent) = agent else {
        return error_response(CoordinatorError::new(400, "missing_agent"));
    };
    if !allowed_browser_path(&path) {
        return error_response(CoordinatorError::new(404, "not_found"));
    }
    let reserved = reserve(inner, client, &agent, named.as_deref(), label.as_deref()).await;
    let (lease, profile, worker_config) = match reserved {
        Ok(value) => value,
        Err(error) => return error_response(error),
    };
    if let Err(error) = increment_active(inner, &lease.lease_id).await {
        return error_response(error);
    }
    let cancellation = CancellationToken::new();
    let result =
        worker_proxy_request(inner, &worker_config, &profile, &lease, &path, request).await;
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            decrement_active(inner, &lease.lease_id).await;
            return error_response(error);
        }
    };
    let mut output = Response::builder().status(response.status());
    for (name, value) in response.headers() {
        if !hop_by_hop(name) {
            output = output.header(name, value);
        }
    }
    output = output.header("x-humanchrome-profile", &profile.name);
    let (writer, reader) = tokio::io::duplex(64 * 1024);
    let body = Body::from_stream(ProxyStream {
        reader: ReaderStream::new(reader),
        cancellation: cancellation.clone(),
    });
    let heartbeat_inner = inner.clone();
    let heartbeat_lease = lease.clone();
    let heartbeat_profile = profile.clone();
    let heartbeat_worker = worker_config.clone();
    let heartbeat_cancel = cancellation.clone();
    tokio::spawn(async move {
        let every = Duration::from_millis(
            (u64::from(heartbeat_inner.config.lease_ttl_sec) * 1000 / 3).max(1000),
        );
        loop {
            tokio::select! {
                _ = heartbeat_cancel.cancelled() => break,
                _ = time::sleep(every) => {
                    if assert_worker_lease(&heartbeat_inner, &heartbeat_worker, &heartbeat_profile.profile, &heartbeat_lease).await.is_err() {
                        heartbeat_cancel.cancel();
                        break;
                    }
                }
            }
        }
    });
    let writer_inner = inner.clone();
    let writer_lease_id = lease.lease_id.clone();
    tokio::spawn(async move {
        let mut response = response;
        let mut writer = writer;
        loop {
            let next = tokio::select! {
                _ = cancellation.cancelled() => break,
                value = response.chunk() => value,
            };
            match next {
                Ok(Some(chunk)) => {
                    let write = writer.write_all(&chunk);
                    if tokio::select! { _ = cancellation.cancelled() => true, result = write => result.is_err() }
                    {
                        break;
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
        cancellation.cancel();
        decrement_active(&writer_inner, &writer_lease_id).await;
    });
    output
        .body(body)
        .unwrap_or_else(|_| error_response(CoordinatorError::new(502, "outcome_unknown")))
}

struct ProxyStream {
    reader: ReaderStream<tokio::io::DuplexStream>,
    cancellation: CancellationToken,
}

impl Stream for ProxyStream {
    type Item = Result<axum::body::Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.reader).poll_next(context)
    }
}

impl Drop for ProxyStream {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

async fn fleet_mcp(
    State(inner): State<Arc<Inner>>,
    Extension(client): Extension<ClientIdentity>,
    mut request: Request,
) -> Response<Body> {
    let method = request.method();
    if method != Method::POST {
        return mcp_http::http_error(
            StatusCode::METHOD_NOT_ALLOWED,
            -32000,
            "Method not allowed.",
        );
    }
    let headers = request.headers();
    if let Err(error) = mcp_http::validate_post_headers(headers) {
        return error.into_response();
    }
    let mut parsed = take_body(&mut request);
    if let Some(response) = mcp_http::invalid_request(&parsed) {
        return response;
    }
    let Some(id) = parsed.remove("id") else {
        return StatusCode::ACCEPTED.into_response();
    };
    let Some(method) = parsed.remove("method") else {
        return StatusCode::ACCEPTED.into_response();
    };
    let method = method.as_ref().as_str();
    let params = parsed
        .remove("params")
        .unwrap_or_else(|| JsonDocument::from(json!({})));
    let outcome = match method {
        Some("initialize") => Ok(protocol::initialize_result(
            params
                .get("protocolVersion")
                .and_then(|value| value.as_str()),
            "HumanChromeFleet",
            "1.0.0",
        )),
        Some("ping") => Ok(json!({})),
        Some("tools/list") => Ok(json!({ "tools": fleet_tools() })),
        Some("tools/call") => {
            if let Some(error) = mcp_http::tool_params_error(&params) {
                return mcp_http::event_response(JsonDocument::object([
                    ("jsonrpc", JsonDocument::from("2.0")),
                    ("id", id),
                    (
                        "error",
                        JsonDocument::from(
                            serde_json::to_value(error).expect("standard MCP error serializes"),
                        ),
                    ),
                ]));
            }
            let control = CoordinatorControl { inner };
            let agent = agent_name(request.headers(), None);
            let params = params
                .into_value()
                .unwrap_or_else(|document| document.validation_value().into_owned());
            mcp_tool_call(&control, &client, agent.as_deref(), params).await
        }
        _ => return mcp_http::event_response(mcp_http::rpc_error(id, -32601, "Method not found")),
    };
    let result = match outcome {
        Ok(result) => result,
        Err(error) => {
            json!({ "isError": true, "content": [{ "type": "text", "text": error.code }] })
        }
    };
    mcp_http::event_response(mcp_http::result(id, result))
}

async fn mcp_tool_call(
    control: &CoordinatorControl,
    client: &ClientIdentity,
    agent: Option<&str>,
    params: Value,
) -> Result<Value, CoordinatorError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| CoordinatorError::new(400, "invalid_args"))?;
    let args = params
        .get("arguments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let result = match name {
        "fleet_profiles" => json!(control.profiles(client).await?),
        "fleet_profile" => {
            let name = args
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| CoordinatorError::new(400, "invalid_args"))?;
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .ok_or_else(|| CoordinatorError::new(400, "invalid_args"))?;
            let agent = agent
                .or(Some("control"))
                .ok_or_else(|| CoordinatorError::new(400, "missing_agent"))?;
            control.profile_action(client, agent, name, action).await?
        }
        "fleet_leases" => {
            if args.get("action").and_then(Value::as_str).unwrap_or("list") == "list" {
                json!({ "leases": control.leases(client).await? })
            } else if args.get("action").and_then(Value::as_str) == Some("release") {
                let requested = args
                    .get("agent")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoordinatorError::new(403, "agent_mismatch"))?;
                let agent = agent.ok_or_else(|| CoordinatorError::new(400, "missing_agent"))?;
                if agent != requested {
                    return Err(CoordinatorError::new(403, "agent_mismatch"));
                }
                json!({ "released": control.release_agent(client, requested).await? })
            } else {
                return Err(CoordinatorError::new(403, "agent_mismatch"));
            }
        }
        "fleet_purposes" => json!({ "purposes": control.purposes(client).await? }),
        "fleet_park" => {
            let parked = args
                .get("parked")
                .and_then(Value::as_bool)
                .ok_or_else(|| CoordinatorError::new(400, "invalid_args"))?;
            control.park(client, parked).await?
        }
        _ => return Err(CoordinatorError::new(404, "unknown_tool")),
    };
    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string(&result).map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))? }] }),
    )
}

fn fleet_tools() -> Vec<Value> {
    vec![
        json!({ "name": "fleet_profiles", "description": "List every browser in the fleet with its state, lease holder and last failure. Start here.", "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } }),
        json!({ "name": "fleet_profile", "description": "Start, stop or restart one browser. Restart loses its tabs and cookies stay on disk.", "inputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["start", "stop", "restart"] }, "name": { "type": "string", "description": "Profile name, or nodeId:profile on a peer" } }, "required": ["action", "name"], "additionalProperties": false } }),
        json!({ "name": "fleet_leases", "description": "List which agent holds which browser, or release one agent's holds.", "inputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["list", "release"], "default": "list" }, "agent": { "type": "string", "description": "Required for release" } }, "additionalProperties": false } }),
        json!({ "name": "fleet_purposes", "description": "Map each purpose tag to the browser serving it.", "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } }),
        json!({ "name": "fleet_park", "description": "Park: stop every browser; a request can still start one on demand. Unpark: start every enabled browser.", "inputSchema": { "type": "object", "properties": { "parked": { "type": "boolean" } }, "required": ["parked"], "additionalProperties": false } }),
    ]
}

async fn profiles(
    inner: &Arc<Inner>,
    client: &ClientIdentity,
) -> Result<Vec<Value>, CoordinatorError> {
    let profiles = inventory(inner).await?;
    let leases = inner.store.leases(None, None, false).await?;
    profiles
        .iter()
        .map(|profile| public_profile(profile, &leases, client))
        .collect()
}

async fn inventory(inner: &Arc<Inner>) -> Result<Vec<CoordinatorProfile>, CoordinatorError> {
    refresh(inner, false).await?;
    let ids = inner
        .config
        .workers
        .iter()
        .map(|worker| worker.id.clone())
        .collect::<Vec<_>>();
    inner.store.profiles(&ids).await
}

fn public_profile(
    profile: &CoordinatorProfile,
    leases: &[CoordinatorLease],
    client: &ClientIdentity,
) -> Result<Value, CoordinatorError> {
    let mut object = serde_json::to_value(&profile.snapshot)
        .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?
        .as_object()
        .cloned()
        .ok_or_else(|| CoordinatorError::new(503, "coordinator_unavailable"))?;
    let holder = leases.iter().find(|lease| lease.profile == profile.name);
    object.insert("name".into(), Value::String(profile.name.clone()));
    object.insert("worker".into(), Value::String(profile.worker.clone()));
    object.insert("profile".into(), Value::String(profile.profile.clone()));
    object.insert("available".into(), Value::Bool(profile.available));
    object.insert(
        "state".into(),
        serde_json::to_value(profile.state())
            .map_err(|_| CoordinatorError::new(503, "coordinator_unavailable"))?,
    );
    object.insert(
        "leasedBy".into(),
        holder.map_or(Value::Null, |lease| {
            Value::String(if lease.client == client.id || client.admin {
                lease.agent.clone()
            } else {
                "busy".into()
            })
        }),
    );
    Ok(Value::Object(object))
}

async fn leases(
    inner: &Arc<Inner>,
    client: &ClientIdentity,
) -> Result<Vec<Value>, CoordinatorError> {
    inner
        .store
        .leases((!client.admin).then_some(client.id.as_str()), None, false)
        .await
        .map(|leases| leases.into_iter().map(visible_lease).collect())
}

fn visible_lease(lease: CoordinatorLease) -> Value {
    json!({ "profile": lease.profile, "client": lease.client, "agent": lease.agent, "expiresAt": lease.expires_at })
}

async fn refresh(inner: &Arc<Inner>, force: bool) -> Result<(), CoordinatorError> {
    let mut state = match inner.refresh.try_lock() {
        Ok(state) => state,
        Err(_) => return inner.refresh.lock().await.result.clone(),
    };
    let now = chrono::Utc::now().timestamp_millis();
    if !force && state.last_completed.is_some_and(|last| now - last < 3000) {
        state.result = Ok(());
        return Ok(());
    }
    let results =
        futures_util::future::join_all(inner.config.workers.iter().map(|configured| async move {
            let inventory = worker_json(
                inner,
                configured,
                "",
                Method::GET,
                None,
                HeaderMap::new(),
                Duration::from_secs(3),
            )
            .await
            .ok()
            .and_then(|value| serde_json::from_value::<WorkerInventory>(value).ok())
            .and_then(|inventory| inventory.validate().ok())
            .filter(|inventory| inventory.id == configured.id);
            let available = inventory.is_some();
            inner.worker_health.lock().await.insert(
                configured.id.clone(),
                WorkerHealth {
                    available,
                    error: (!available).then_some("worker_unavailable"),
                },
            );
            inner
                .store
                .observe(
                    &configured.id,
                    inventory.as_ref().map(|value| value.profiles.as_slice()),
                )
                .await
        }))
        .await;
    let result = results
        .into_iter()
        .find_map(Result::err)
        .map_or(Ok(()), Err);
    if result.is_ok() {
        state.last_completed = Some(chrono::Utc::now().timestamp_millis());
    }
    state.result = result.clone();
    result
}

async fn reserve(
    inner: &Arc<Inner>,
    client: &ClientIdentity,
    agent: &str,
    named: Option<&str>,
    label: Option<&str>,
) -> Result<(CoordinatorLease, CoordinatorProfile, CoordinatorWorker), CoordinatorError> {
    let profiles = inventory(inner).await?;
    if named.is_some_and(|name| !profiles.iter().any(|profile| profile.name == name)) {
        return Err(CoordinatorError::new(404, "unknown_profile"));
    }
    let lease = inner
        .store
        .acquire(
            &client.id,
            agent,
            &profiles,
            inner.config.lease_ttl_sec,
            named,
            label.unwrap_or("any"),
        )
        .await?;
    let profile = profiles
        .into_iter()
        .find(|profile| profile.name == lease.profile)
        .ok_or_else(|| CoordinatorError::new(503, "profile_unavailable"))?;
    let configured = worker(inner, &profile.worker)?.clone();
    assert_worker_lease(inner, &configured, &profile.profile, &lease).await?;
    Ok((lease, profile, configured))
}

async fn assert_worker_lease(
    inner: &Arc<Inner>,
    worker: &CoordinatorWorker,
    profile: &str,
    lease: &CoordinatorLease,
) -> Result<(), CoordinatorError> {
    let deadline = inner
        .store
        .renewal_deadline(inner.config.lease_ttl_sec)
        .await?;
    worker_json(
        inner,
        worker,
        &format!("/profiles/{}/lease", encode_path(profile)),
        Method::PUT,
        Some(json!({
            "agent": format!("{}:{}", lease.client, lease.agent),
            "leaseId": lease.lease_id,
            "generation": lease.generation,
            "ttlSec": inner.config.lease_ttl_sec,
        })),
        lease_headers(lease),
        WORKER_TIMEOUT,
    )
    .await?;
    inner.store.renew(lease, &deadline).await
}

async fn release_agent_inner(
    inner: &Arc<Inner>,
    client: &ClientIdentity,
    agent: &str,
) -> Result<Vec<String>, CoordinatorError> {
    let leases = inner
        .store
        .leases(Some(&client.id), Some(agent), true)
        .await?;
    let mut released = Vec::with_capacity(leases.len());
    for lease in leases {
        release_lease(inner, &lease).await?;
        released.push(lease.profile);
    }
    inner.store.clear_bindings(&client.id, agent).await?;
    Ok(released)
}

async fn release_lease(
    inner: &Arc<Inner>,
    lease: &CoordinatorLease,
) -> Result<(), CoordinatorError> {
    if inner.active.lock().await.contains_key(&lease.lease_id) {
        return Err(CoordinatorError::new(409, "profile_busy"));
    }
    let (worker_id, profile) = lease
        .profile
        .split_once(':')
        .ok_or_else(|| CoordinatorError::new(503, "coordinator_unavailable"))?;
    match worker_json(
        inner,
        worker(inner, worker_id)?,
        &format!("/profiles/{}/lease", encode_path(profile)),
        Method::DELETE,
        None,
        lease_headers(lease),
        WORKER_TIMEOUT,
    )
    .await
    {
        Ok(_) => {}
        Err(error) if error.code == "stale_lease" => {}
        Err(error) => return Err(error),
    }
    inner.store.release(lease).await
}

async fn control_profile(
    inner: &Arc<Inner>,
    client: &ClientIdentity,
    agent: &str,
    name: &str,
    action: &str,
) -> Result<Value, CoordinatorError> {
    require_admin(client)?;
    if !matches!(action, "start" | "stop" | "restart") {
        return Err(CoordinatorError::new(400, "invalid_action"));
    }
    let existing = inner
        .store
        .leases(Some(&client.id), Some(agent), false)
        .await?
        .iter()
        .any(|lease| lease.profile == name);
    let (lease, profile, worker) = reserve(inner, client, agent, Some(name), None).await?;
    let result = worker_json(
        inner,
        &worker,
        &format!("/profiles/{}/{}", encode_path(&profile.profile), action),
        Method::POST,
        Some(json!({})),
        lease_headers(&lease),
        WORKER_ACTION_TIMEOUT,
    )
    .await;
    if !existing {
        release_lease(inner, &lease).await?;
    }
    result
}

async fn park_inner(
    inner: &Arc<Inner>,
    client: &ClientIdentity,
    parked: bool,
) -> Result<Value, CoordinatorError> {
    require_admin(client)?;
    if !inner.store.leases(None, None, false).await?.is_empty() {
        return Err(CoordinatorError::new(409, "profile_busy"));
    }
    let mut failed = Vec::new();
    for worker in &inner.config.workers {
        if worker_json(
            inner,
            worker,
            "/park",
            Method::POST,
            Some(json!({ "parked": parked })),
            HeaderMap::new(),
            WORKER_ACTION_TIMEOUT,
        )
        .await
        .is_err()
        {
            failed.push(worker.id.clone());
        }
    }
    if !failed.is_empty() {
        return Err(CoordinatorError::with_message(
            503,
            "park_incomplete",
            format!("workers not confirmed: {}", failed.join(", ")),
        ));
    }
    refresh(inner, true).await?;
    Ok(json!({ "parked": parked }))
}

fn worker<'a>(inner: &'a Arc<Inner>, id: &str) -> Result<&'a CoordinatorWorker, CoordinatorError> {
    inner
        .config
        .workers
        .iter()
        .find(|worker| worker.id == id)
        .ok_or_else(|| CoordinatorError::new(404, "unknown_worker"))
}

async fn worker_json(
    inner: &Arc<Inner>,
    worker: &CoordinatorWorker,
    path: &str,
    method: Method,
    body: Option<Value>,
    headers: HeaderMap,
    timeout: Duration,
) -> Result<Value, CoordinatorError> {
    let url = format!("{}/v1/worker{path}", worker.url.trim_end_matches('/'));
    let mut request = inner
        .http
        .request(method, url)
        .bearer_auth(&worker.token)
        .headers(headers)
        .timeout(timeout);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| CoordinatorError::new(503, "worker_unavailable"))?;
    if response.status() == StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| CoordinatorError::new(502, "invalid_worker_response"))?;
    if !status.is_success() {
        return Err(CoordinatorError::new(
            status.as_u16(),
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("worker_error"),
        ));
    }
    Ok(value)
}

async fn worker_proxy_request(
    inner: &Arc<Inner>,
    worker: &CoordinatorWorker,
    profile: &CoordinatorProfile,
    lease: &CoordinatorLease,
    path: &str,
    request: Request,
) -> Result<reqwest::Response, CoordinatorError> {
    let (parts, body) = request.into_parts();
    let mut outgoing = inner
        .http
        .request(
            parts.method,
            format!(
                "{}/v1/worker/profiles/{}/browser/{}{}",
                worker.url.trim_end_matches('/'),
                encode_path(&profile.profile),
                path,
                parts
                    .uri
                    .query()
                    .map_or_else(String::new, |query| format!("?{query}"))
            ),
        )
        .bearer_auth(&worker.token)
        .timeout(WORKER_ACTION_TIMEOUT)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()));
    for name in [
        header::ACCEPT,
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        HeaderName::from_static("mcp-session-id"),
        HeaderName::from_static("mcp-protocol-version"),
        HeaderName::from_static("last-event-id"),
    ] {
        if let Some(value) = parts.headers.get(&name) {
            outgoing = outgoing.header(name, value);
        }
    }
    for (name, value) in &lease_headers(lease) {
        outgoing = outgoing.header(name, value);
    }
    outgoing.send().await.map_err(|_| CoordinatorError::with_message(502, "outcome_unknown", "The worker connection failed; the browser action may have executed. It was not retried."))
}

fn lease_headers(lease: &CoordinatorLease) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-humanchrome-lease"),
        HeaderValue::from_str(&lease.lease_id).expect("generated UUID is a header value"),
    );
    headers.insert(
        HeaderName::from_static("x-humanchrome-generation"),
        HeaderValue::from_str(&lease.generation.to_string()).expect("lease generation is decimal"),
    );
    headers.insert(
        HeaderName::from_static("x-humanchrome-agent"),
        HeaderValue::from_str(&format!("{}:{}", lease.client, lease.agent))
            .map_err(|_| ())
            .expect("validated identities form a header value"),
    );
    headers
}

async fn increment_active(inner: &Arc<Inner>, lease_id: &str) -> Result<(), CoordinatorError> {
    let mut active = inner.active.lock().await;
    *active.entry(lease_id.into()).or_default() += 1;
    Ok(())
}
async fn decrement_active(inner: &Arc<Inner>, lease_id: &str) {
    let mut active = inner.active.lock().await;
    if let Some(count) = active.get_mut(lease_id) {
        *count -= 1;
        if *count == 0 {
            active.remove(lease_id);
        }
    }
}

fn require_admin(client: &ClientIdentity) -> Result<(), CoordinatorError> {
    if client.admin {
        Ok(())
    } else {
        Err(CoordinatorError::new(403, "admin_required"))
    }
}

fn authenticate_client(
    clients: &[CoordinatorClient],
    authorization: &str,
) -> Option<ClientIdentity> {
    let token = authorization.strip_prefix("Bearer ")?;
    clients
        .iter()
        .find(|client| constant_time_eq(token.as_bytes(), client.token.as_bytes()))
        .map(|client| ClientIdentity {
            id: client.id.clone(),
            admin: client.admin,
        })
}

fn constant_time_eq(actual: &[u8], expected: &[u8]) -> bool {
    let mut difference = actual.len() ^ expected.len();
    for index in 0..actual.len().max(expected.len()) {
        difference |=
            usize::from(*actual.get(index).unwrap_or(&0) ^ *expected.get(index).unwrap_or(&0));
    }
    difference == 0
}

fn agent_name(headers: &HeaderMap, fallback: Option<&str>) -> Option<String> {
    headers
        .get("x-humanchrome-agent")
        .and_then(|value| value.to_str().ok())
        .or(fallback)
        .and_then(normalize_agent)
}

fn normalize_agent(raw: &str) -> Option<String> {
    let mut normalized = raw.nfc().collect::<String>().trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    normalized = normalized
        .chars()
        .map(|character| {
            if character.is_whitespace() || matches!(character, '/' | '\\' | ':') {
                '-'
            } else {
                character
            }
        })
        .filter(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '.' | '-')
        })
        .collect();
    if normalized.starts_with("__") {
        return None;
    }
    normalized = collapse_agent(&normalized, '-');
    normalized = collapse_agent(&normalized, '_');
    normalized = collapse_agent(&normalized, '.');
    normalized = normalized
        .trim_matches(['-', '_', '.'])
        .chars()
        .take(64)
        .collect::<String>()
        .trim_end_matches(['-', '_', '.'])
        .into();
    (!normalized.is_empty() && !matches!(normalized.as_str(), "default" | "null" | "undefined"))
        .then_some(normalized)
}

fn collapse_agent(value: &str, repeated: char) -> String {
    let mut result = String::with_capacity(value.len());
    let mut prior = false;
    for character in value.chars() {
        if character == repeated {
            if !prior {
                result.push(character);
            }
            prior = true;
        } else {
            prior = false;
            result.push(character);
        }
    }
    result
}

fn allowed_browser_path(path: &str) -> bool {
    matches!(path, "mcp" | "ping" | "api/tools" | "api/openapi.json")
        || path.strip_prefix("api/tools/").is_some_and(|name| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
}
fn hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}
fn encode_path(value: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            encoded.push(char::from(byte));
        } else {
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

impl IntoResponse for CoordinatorError {
    fn into_response(self) -> Response<Body> {
        error_response(self)
    }
}
fn error_response(error: CoordinatorError) -> Response<Body> {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
    (
        status,
        Json(json!({ "error": error.code, "message": error.message })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration() -> CoordinatorConfig {
        CoordinatorConfig {
            id: "cloud".into(),
            host: "127.0.0.1".into(),
            port: 12300,
            database_url: "postgresql://localhost/humanchrome".into(),
            lease_ttl_sec: 900,
            clients: vec![CoordinatorClient {
                id: "operator".into(),
                token: "a".repeat(32),
                admin: true,
            }],
            workers: vec![CoordinatorWorker {
                id: "mac".into(),
                url: "http://mac.example.test/".into(),
                token: "b".repeat(32),
            }],
        }
    }

    #[test]
    fn normalizes_agent_names_like_the_typescript_coordinator() {
        assert_eq!(
            normalize_agent("  Acme API/foo:bar  ").as_deref(),
            Some("acme-api-foo-bar")
        );
        assert_eq!(normalize_agent("__ui:popup"), None);
        assert_eq!(normalize_agent("default"), None);
    }

    #[test]
    fn constant_time_comparison_rejects_prefixes_and_accepts_same_length_values() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abc", b"abd"));
    }

    #[test]
    fn browser_proxy_allowlist_does_not_expose_arbitrary_worker_routes() {
        assert!(allowed_browser_path("api/tools/chrome_click"));
        assert!(allowed_browser_path("mcp"));
        assert!(!allowed_browser_path("api/admin"));
        assert!(!allowed_browser_path("api/tools/../../lease"));
    }

    #[tokio::test]
    async fn stateless_mcp_rejects_get_and_delete_without_a_session() {
        let coordinator =
            FleetCoordinator::try_new(configuration()).expect("test configuration is valid");
        let client = ClientIdentity {
            id: "operator".into(),
            admin: true,
        };
        for method in [Method::GET, Method::DELETE] {
            let response = fleet_mcp(
                State(coordinator.inner.clone()),
                Extension(client.clone()),
                Request::builder()
                    .method(method)
                    .uri("/mcp")
                    .body(Body::empty())
                    .expect("valid MCP request"),
            )
            .await;
            assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        }
    }
}
