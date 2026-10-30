//! Authenticated fleet HTTP gateway for profile status, leases, demand starts, and bridge proxying.

use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::mcp::{http as mcp_http, protocol};
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, delete, get, post},
};
use humanchrome_core::json_document::JsonDocument;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::{
    AcquireLease, DemandReason, FleetLeases, FleetProfile, FleetRuntimeError, ProfileProvisioner,
    ProfileSnapshot, ProfileStartError, ProfileState, ProfileSupervisor,
};

const ALLOWED_PROXY_PREFIXES: [&str; 3] = ["api/", "mcp", "ping"];

const NODE_CACHE_TTL: Duration = Duration::from_secs(5);
const NODE_TIMEOUT: Duration = Duration::from_secs(3);

/// A trusted peer gateway participating in fleet routing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetNode {
    /// Stable peer-node identifier used in qualified route keys.
    pub id: String,
    /// Peer gateway hostname or IP address.
    pub host: String,
    /// Peer gateway HTTP port.
    pub port: u16,
    /// Optional bearer credential used both to query and forward to this peer.
    pub token: Option<String>,
}

#[derive(Clone, Debug)]
struct FleetRoute {
    key: String,
    name: String,
    port: u16,
    labels: Vec<String>,
    purpose: Option<String>,
    enabled: bool,
    state: Option<ProfileState>,
    node: Option<FleetNode>,
}

/// Network and credential configuration for [`FleetGateway`].
#[derive(Clone, Debug)]
pub struct GatewayConfig {
    /// Listener socket address.
    pub bind: SocketAddr,
    /// Optional external bearer token. `None` retains the existing trusted-LAN mode.
    pub token: Option<String>,
    /// Credential injected only for loopback profile bridges.
    pub bridge_token: String,
    /// Real profile-cloning and native-host-manifest provisioner.
    pub provisioner: ProfileProvisioner,
    /// Peer gateways queried and forwarded without retries.
    pub nodes: Vec<FleetNode>,
}

#[derive(Debug)]
struct GatewayState {
    config: GatewayConfig,
    supervisor: ProfileSupervisor,
    leases: Mutex<FleetLeases>,
    /// Serializes read-next-port/copy/save profile additions.
    adding: Mutex<()>,
    node_cache: Mutex<BTreeMap<String, (Instant, Vec<FleetRoute>)>>,
    client: reqwest::Client,
}

/// Runnable standalone fleet gateway.
#[derive(Clone, Debug)]
pub struct FleetGateway {
    state: Arc<GatewayState>,
}

impl FleetGateway {
    /// Construct an HTTP gateway without binding its configured address.
    ///
    /// # Errors
    /// Returns an error when the outbound profile proxy client cannot be built.
    pub fn new(
        config: GatewayConfig,
        supervisor: ProfileSupervisor,
        leases: FleetLeases,
    ) -> Result<Self, FleetRuntimeError> {
        let client = reqwest::Client::builder()
            // A federation failure is observed by callers; this gateway never retries or follows
            // a redirect into another authority on their behalf.
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|error| {
                FleetRuntimeError::Process(format!("could not create gateway client: {error}"))
            })?;
        Ok(Self {
            state: Arc::new(GatewayState {
                config,
                supervisor,
                leases: Mutex::new(leases),
                adding: Mutex::new(()),
                node_cache: Mutex::new(BTreeMap::new()),
                client,
            }),
        })
    }

    /// Build routes without binding, for embedding under another native server.
    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/profiles", get(list_profiles).post(profile_add))
            .route("/v1/profiles/{name}/start", post(start_profile))
            .route("/v1/profiles/{name}/stop", post(stop_profile))
            .route("/v1/profiles/{name}/restart", post(restart_profile))
            .route("/v1/park", post(park))
            .route("/v1/profiles/{name}/{*path}", any(proxy_named))
            .route("/v1/pool/{label}/{*path}", any(proxy_pool))
            .route("/v1/leases", get(list_leases))
            .route("/v1/leases/{agent}", delete(release_leases))
            .route("/v1/node/{name}/{*path}", any(forward_from_node))
            .route("/v1/fleet/mcp", any(fleet_mcp))
            .with_state(Arc::clone(&self.state))
    }

    /// Bind and serve until the returned future is cancelled or the listener fails.
    ///
    /// # Errors
    /// Returns listener or server errors.
    pub async fn serve(&self) -> Result<(), FleetRuntimeError> {
        let listener = tokio::net::TcpListener::bind(self.state.config.bind)
            .await
            .map_err(|error| {
                FleetRuntimeError::Process(format!("could not bind fleet gateway: {error}"))
            })?;
        axum::serve(listener, self.router())
            .await
            .map_err(|error| FleetRuntimeError::Process(format!("fleet gateway failed: {error}")))
    }

    /// Sweep expired leases, release their browser client lanes, and reap idle demand starts.
    pub async fn sweep(&self) {
        let expired = self.state.leases.lock().await.sweep();
        for lease in expired {
            self.release_bridge(&lease.agent, &lease.profile).await;
        }
        let held = self
            .state
            .leases
            .lock()
            .await
            .list()
            .into_iter()
            .map(|lease| lease.profile)
            .collect::<std::collections::BTreeSet<_>>();
        let _ = self
            .state
            .supervisor
            .reap_idle(|profile| held.contains(profile))
            .await;
    }

    async fn release_bridge(&self, agent: &str, profile: &str) {
        let Some(route) = self
            .routes()
            .await
            .into_iter()
            .find(|route| route.key == profile)
        else {
            return;
        };
        let path = format!("api/clients/{}/release", url_encode(agent));
        let (target, token) = match route.node {
            Some(node) => (
                format!(
                    "http://{}:{}/v1/node/{}/{}",
                    node.host,
                    node.port,
                    url_encode(&route.name),
                    path
                ),
                node.token,
            ),
            None => (
                format!("http://127.0.0.1:{}/{}", route.port, path),
                Some(self.state.config.bridge_token.clone()),
            ),
        };
        let request = self.state.client.post(target);
        let request = match token {
            Some(token) => request.bearer_auth(token),
            None => request,
        };
        let _ = request.send().await;
    }

    async fn routes(&self) -> Vec<FleetRoute> {
        let mut routes = self
            .state
            .supervisor
            .snapshot_unleased()
            .await
            .into_iter()
            .map(|profile| FleetRoute {
                key: profile.name.clone(),
                name: profile.name,
                port: profile.port,
                labels: profile.labels,
                purpose: profile.purpose,
                enabled: profile.enabled,
                state: Some(profile.state),
                node: None,
            })
            .collect::<Vec<_>>();
        for node in &self.state.config.nodes {
            routes.extend(self.fetch_node_routes(node).await);
        }
        routes
    }

    async fn fetch_node_routes(&self, node: &FleetNode) -> Vec<FleetRoute> {
        if let Some((at, routes)) = self.state.node_cache.lock().await.get(&node.id).cloned()
            && at.elapsed() < NODE_CACHE_TTL
        {
            return routes;
        }
        let mut request = self
            .state
            .client
            .get(format!("http://{}:{}/v1/profiles", node.host, node.port))
            .timeout(NODE_TIMEOUT);
        if let Some(token) = &node.token {
            request = request.bearer_auth(token);
        }
        let routes = match request.send().await {
            Ok(response) if response.status().is_success() => {
                match response.json::<Vec<Value>>().await {
                    Ok(profiles) => profiles
                        .into_iter()
                        .filter_map(|profile| remote_route(node, profile))
                        .collect(),
                    Err(_) => unreachable_route(node),
                }
            }
            _ => unreachable_route(node),
        };
        self.state
            .node_cache
            .lock()
            .await
            .insert(node.id.clone(), (Instant::now(), routes.clone()));
        routes
    }
}

fn remote_route(node: &FleetNode, profile: Value) -> Option<FleetRoute> {
    let name = profile.get("name")?.as_str()?.to_owned();
    let port = u16::try_from(profile.get("port")?.as_u64()?).ok()?;
    let labels = profile
        .get("labels")?
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(ToOwned::to_owned))
        .collect::<Option<Vec<_>>>()?;
    let state = match profile.get("state")?.as_str()? {
        "stopped" => ProfileState::Stopped,
        "starting" => ProfileState::Starting,
        "running" => ProfileState::Running,
        "healthy" => ProfileState::Healthy,
        "backoff" => ProfileState::Backoff,
        _ => return None,
    };
    Some(FleetRoute {
        key: format!("{}:{name}", node.id),
        name,
        port,
        labels,
        purpose: profile
            .get("purpose")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        enabled: profile
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        state: Some(state),
        node: Some(node.clone()),
    })
}

fn unreachable_route(node: &FleetNode) -> Vec<FleetRoute> {
    vec![FleetRoute {
        key: node.id.clone(),
        name: node.id.clone(),
        port: node.port,
        labels: Vec::new(),
        purpose: None,
        enabled: false,
        state: None,
        node: Some(node.clone()),
    }]
}

async fn list_profiles(State(state): State<Arc<GatewayState>>, headers: HeaderMap) -> Response {
    if let Err(error) = authorize(&headers, &state.config) {
        return error.into_response();
    }
    let leases = state.leases.lock().await.list();
    let local = state
        .supervisor
        .snapshot(|name| {
            leases
                .iter()
                .find(|lease| lease.profile == name)
                .map(|lease| lease.agent.clone())
        })
        .await;
    let mut payload = profiles_to_json(local);
    let gateway = FleetGateway {
        state: Arc::clone(&state),
    };
    for node in &state.config.nodes {
        payload.extend(
            gateway
                .fetch_node_routes(node)
                .await
                .into_iter()
                .map(|route| {
                    let leased_by = leases
                        .iter()
                        .find(|lease| lease.profile == route.key)
                        .map(|lease| lease.agent.clone());
                    route_to_json(route, leased_by)
                }),
        );
    }
    json_response(StatusCode::OK, Value::Array(payload))
}

async fn list_leases(State(state): State<Arc<GatewayState>>, headers: HeaderMap) -> Response {
    if let Err(error) = authorize(&headers, &state.config) {
        return error.into_response();
    }
    let leases = state.leases.lock().await.list();
    let payload = leases
        .into_iter()
        .map(|lease| json!({ "agent": lease.agent, "profile": lease.profile, "lastSeen": lease.last_seen_ms }))
        .collect::<Vec<_>>();
    json_response(StatusCode::OK, Value::Array(payload))
}

async fn release_leases(
    State(state): State<Arc<GatewayState>>,
    Path(agent): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize(&headers, &state.config) {
        return error.into_response();
    }
    let Some(agent) = normalize_agent(&agent) else {
        return error(StatusCode::BAD_REQUEST, "invalid_agent");
    };
    if headers
        .get("x-humanchrome-agent")
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_agent)
        .as_deref()
        != Some(&agent)
    {
        return error(StatusCode::FORBIDDEN, "agent_mismatch");
    }
    let released = state.leases.lock().await.release(&agent);
    let gateway = FleetGateway {
        state: Arc::clone(&state),
    };
    for profile in &released {
        gateway.release_bridge(&agent, profile).await;
    }
    json_response(StatusCode::OK, json!({ "released": released }))
}

async fn start_profile(
    State(state): State<Arc<GatewayState>>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    profile_verb(state, name, headers, "starting").await
}

async fn stop_profile(
    State(state): State<Arc<GatewayState>>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    profile_verb(state, name, headers, "stopping").await
}

async fn restart_profile(
    State(state): State<Arc<GatewayState>>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    profile_verb(state, name, headers, "restarting").await
}

async fn profile_verb(
    state: Arc<GatewayState>,
    name: String,
    headers: HeaderMap,
    pending: &str,
) -> Response {
    if let Err(error) = authorize(&headers, &state.config) {
        return error.into_response();
    }
    let exists = state
        .supervisor
        .snapshot_unleased()
        .await
        .iter()
        .any(|profile| profile.name == name);
    if !exists {
        return error(StatusCode::NOT_FOUND, "unknown_profile");
    }
    if let Some(holder) = state
        .leases
        .lock()
        .await
        .holder(&name)
        .map(ToOwned::to_owned)
    {
        return json_response(
            StatusCode::CONFLICT,
            json!({ "error": "profile_busy", "heldBy": holder }),
        );
    }
    let supervisor = state.supervisor.clone();
    let action_name = name.clone();
    let verb = pending.to_owned();
    tokio::spawn(async move {
        let result = match verb.as_str() {
            "starting" => supervisor.start_profile(&action_name).await,
            "stopping" => supervisor.stop_profile(&action_name).await,
            "restarting" => supervisor.restart_profile(&action_name).await,
            _ => unreachable!("only fleet profile verbs call profile_verb"),
        };
        if let Err(error) = result {
            tracing::warn!(profile = %action_name, action = %verb, %error, "fleet lifecycle operation failed");
        }
    });
    json_response(StatusCode::ACCEPTED, json!({ pending: name }))
}

async fn proxy_named(
    State(state): State<Arc<GatewayState>>,
    Path((name, path)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    proxy(
        state,
        ProxyRequest {
            requested: Some(name),
            label: "any".to_owned(),
            path,
            method,
            uri,
            headers,
            body,
        },
    )
    .await
}

async fn proxy_pool(
    State(state): State<Arc<GatewayState>>,
    Path((label, path)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    proxy(
        state,
        ProxyRequest {
            requested: None,
            label,
            path,
            method,
            uri,
            headers,
            body,
        },
    )
    .await
}

/// Serve the standalone fleet-management MCP catalog; browser MCP remains under profile/pool routes.
async fn fleet_mcp(State(state): State<Arc<GatewayState>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    if let Err(error) = authorize(&parts.headers, &state.config) {
        return error.into_response();
    }
    let mut parsed = if matches!(parts.method, Method::POST | Method::DELETE) {
        let bytes = match axum::body::to_bytes(body, 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return crate::server::fastify_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Payload Too Large",
                    "FST_ERR_CTP_BODY_TOO_LARGE",
                    "Request body is too large",
                );
            }
        };
        if bytes.is_empty() && !parts.headers.contains_key("content-type") {
            JsonDocument::from(Value::Null)
        } else {
            match crate::server::parse_tool_body(&parts.headers, &bytes) {
                Ok(document) => document,
                Err(error) => return error.into_response(),
            }
        }
    } else {
        JsonDocument::from(Value::Null)
    };
    if parts.method != Method::POST {
        return mcp_http::http_error(
            StatusCode::METHOD_NOT_ALLOWED,
            -32000,
            "Method not allowed.",
        );
    }
    if let Err(error) = mcp_http::validate_post_headers(&parts.headers) {
        return error.into_response();
    }
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
    let result = match method {
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
                let error = JsonDocument::object([
                    ("jsonrpc", JsonDocument::from("2.0")),
                    ("id", id),
                    (
                        "error",
                        JsonDocument::from(
                            serde_json::to_value(error).expect("standard MCP error serializes"),
                        ),
                    ),
                ]);
                return mcp_http::event_response(error);
            }
            let params = params
                .into_value()
                .unwrap_or_else(|document| document.validation_value().into_owned());
            fleet_tool_call(Arc::clone(&state), params).await
        }
        _ => return mcp_http::event_response(mcp_http::rpc_error(id, -32601, "Method not found")),
    };
    let result = match result {
        Ok(result) => result,
        Err(message) => {
            json!({ "content": [{ "type": "text", "text": message }], "isError": true })
        }
    };
    mcp_http::event_response(mcp_http::result(id, result))
}

async fn fleet_tool_call(state: Arc<GatewayState>, params: Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "tool name is required".to_owned())?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let content = match name {
        "fleet_profiles" => {
            let leases = state.leases.lock().await.list();
            let profiles = state
                .supervisor
                .snapshot(|profile| {
                    leases
                        .iter()
                        .find(|lease| lease.profile == profile)
                        .map(|lease| lease.agent.clone())
                })
                .await;
            serde_json::to_string(&profiles_to_json(profiles)).expect("profile JSON")
        }
        "fleet_profile" => {
            let action = args.get("action").and_then(Value::as_str);
            let name = args
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "`name` is required (string)".to_owned())?;
            if !state
                .supervisor
                .snapshot_unleased()
                .await
                .iter()
                .any(|profile| profile.name == name)
            {
                return Err(format!("unknown profile: {name}"));
            }
            match action {
                Some("start") => state
                    .supervisor
                    .start_profile(name)
                    .await
                    .map_err(|error| error.to_string())?,
                Some("stop") => state
                    .supervisor
                    .stop_profile(name)
                    .await
                    .map_err(|error| error.to_string())?,
                Some("restart") => state
                    .supervisor
                    .restart_profile(name)
                    .await
                    .map_err(|error| error.to_string())?,
                Some(action) => {
                    return Err(format!(
                        "unknown action: {action} — use start, stop or restart"
                    ));
                }
                None => {
                    return Err("unknown action: undefined — use start, stop or restart".to_owned());
                }
            }
            serde_json::to_string(&json!({ "action": action, "name": name })).expect("tool JSON")
        }
        "fleet_leases" => {
            let action = args.get("action").and_then(Value::as_str).unwrap_or("list");
            if action == "list" {
                let leases = state.leases.lock().await.list().into_iter().map(|lease| json!({ "agent": lease.agent, "profile": lease.profile, "lastSeen": lease.last_seen_ms })).collect::<Vec<_>>();
                serde_json::to_string(&json!({ "leases": leases })).expect("tool JSON")
            } else if action == "release" {
                let agent = args
                    .get("agent")
                    .and_then(Value::as_str)
                    .filter(|agent| !agent.is_empty())
                    .ok_or_else(|| "`agent` is required for release".to_owned())?;
                let released = state.leases.lock().await.release(agent);
                let gateway = FleetGateway {
                    state: Arc::clone(&state),
                };
                for profile in &released {
                    gateway.release_bridge(agent, profile).await;
                }
                serde_json::to_string(&json!({ "agent": agent, "released": released }))
                    .expect("tool JSON")
            } else {
                return Err(format!("unknown action: {action} — use list or release"));
            }
        }
        "fleet_purposes" => {
            let purposes = state.supervisor.snapshot_unleased().await.into_iter().filter_map(|profile| profile.purpose.map(|purpose| json!({ "purpose": purpose, "profile": profile.name, "node": null, "state": state_text(profile.state), "labels": profile.labels }))).collect::<Vec<_>>();
            serde_json::to_string(&json!({ "purposes": purposes })).expect("tool JSON")
        }
        "fleet_park" => {
            let parked = args
                .get("parked")
                .and_then(Value::as_bool)
                .ok_or_else(|| "`parked` is required (boolean)".to_owned())?;
            let changed = state
                .config
                .provisioner
                .set_parked(parked)
                .await
                .map_err(|error| error.to_string())?;
            if changed {
                state
                    .supervisor
                    .set_parked(parked)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            serde_json::to_string(&json!({ "parked": parked, "changed": changed }))
                .expect("tool JSON")
        }
        unknown => return Err(format!("unknown tool: {unknown}")),
    };
    Ok(json!({ "content": [{ "type": "text", "text": content }] }))
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

/// Accept one authenticated peer-gateway request and resolve only a local profile.
async fn forward_from_node(
    State(state): State<Arc<GatewayState>>,
    Path((name, path)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !peer_authorized(&headers, &state.config.nodes) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let mut profile = state
        .supervisor
        .snapshot_unleased()
        .await
        .into_iter()
        .find(|profile| profile.name == name);
    let Some(current) = &profile else {
        return error(StatusCode::NOT_FOUND, "unknown_profile");
    };
    if current.enabled && current.state != ProfileState::Healthy {
        let agent = headers
            .get("x-humanchrome-agent")
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_agent)
            .unwrap_or_else(|| "peer".to_owned());
        let reason = DemandReason {
            agent,
            session: None,
            operation: format!("node/{name}"),
            at: chrono::Utc::now().to_rfc3339(),
        };
        if let Err(error) = state.supervisor.demand_start(&name, reason).await {
            return start_error(error);
        }
        profile = state
            .supervisor
            .snapshot_unleased()
            .await
            .into_iter()
            .find(|profile| profile.name == name);
    }
    let Some(profile) = profile else {
        return error(StatusCode::NOT_FOUND, "unknown_profile");
    };
    if profile.state != ProfileState::Healthy {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "error": "profile_unavailable", "state": state_text(profile.state),
            }),
        );
    }
    let route = FleetRoute {
        key: profile.name.clone(),
        name: profile.name,
        port: profile.port,
        labels: profile.labels,
        purpose: profile.purpose,
        enabled: profile.enabled,
        state: Some(profile.state),
        node: None,
    };
    forward_route(ForwardRequest {
        state: &state,
        route: &route,
        agent: "peer",
        path: &path,
        method,
        uri,
        headers,
        body,
    })
    .await
}

struct ProxyRequest {
    requested: Option<String>,
    label: String,
    path: String,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
}

async fn proxy(state: Arc<GatewayState>, request: ProxyRequest) -> Response {
    let ProxyRequest {
        requested,
        label,
        path,
        method,
        uri,
        headers,
        body,
    } = request;
    if let Err(error) = authorize(&headers, &state.config) {
        return error.into_response();
    }
    let Some(agent) = headers
        .get("x-humanchrome-agent")
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_agent)
    else {
        return error(StatusCode::BAD_REQUEST, "missing_agent");
    };
    if !ALLOWED_PROXY_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
    {
        return error(StatusCode::NOT_FOUND, "not_found");
    }
    let routes = FleetGateway {
        state: Arc::clone(&state),
    }
    .routes()
    .await;
    let selected = if let Some(key) = requested {
        let Some(route) = routes.into_iter().find(|route| route.key == key) else {
            return error(StatusCode::NOT_FOUND, "unknown_profile");
        };
        if route.state != Some(ProfileState::Healthy) {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "error": "profile_unavailable",
                    "state": route.state.map(state_text).unwrap_or("unreachable"),
                }),
            );
        }
        match state.leases.lock().await.acquire(&agent, route.key.clone()) {
            AcquireLease::Held { held_by } => {
                return json_response(
                    StatusCode::CONFLICT,
                    json!({ "error": "profile_busy", "heldBy": held_by }),
                );
            }
            AcquireLease::Acquired { displaced } => {
                if let Some(displaced) = displaced {
                    FleetGateway {
                        state: Arc::clone(&state),
                    }
                    .release_bridge(&displaced, &route.key)
                    .await;
                }
            }
        }
        route
    } else {
        let candidates = routes
            .iter()
            .filter(|route| {
                route.state == Some(ProfileState::Healthy) && matches_route_label(route, &label)
            })
            .map(|route| route.key.clone())
            .collect::<Vec<_>>();
        let selected_key = if let Some(key) = state
            .leases
            .lock()
            .await
            .acquire_from_pool(&agent, &candidates)
        {
            key
        } else {
            let Some(demand) = routes
                .iter()
                .filter(|route| {
                    route.enabled
                        && route
                            .state
                            .is_some_and(|current| current != ProfileState::Healthy)
                        && matches_route_label(route, &label)
                })
                .min_by_key(|route| {
                    (
                        route.node.is_some(),
                        route.purpose.as_deref() != Some(&label),
                        route.key.clone(),
                    )
                })
            else {
                return json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({ "error": "no_free_profile", "label": label }),
                );
            };
            if demand.node.is_none() {
                let reason = DemandReason {
                    agent: agent.clone(),
                    session: None,
                    operation: format!("pool/{label}"),
                    at: chrono::Utc::now().to_rfc3339(),
                };
                if let Err(start) = state.supervisor.demand_start(&demand.name, reason).await {
                    return start_error(start);
                }
            }
            let Some(key) = state
                .leases
                .lock()
                .await
                .acquire_from_pool(&agent, std::slice::from_ref(&demand.key))
            else {
                return json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({ "error": "no_free_profile", "label": label }),
                );
            };
            key
        };
        let fresh = FleetGateway {
            state: Arc::clone(&state),
        }
        .routes()
        .await;
        let Some(route) = fresh.into_iter().find(|route| route.key == selected_key) else {
            return error(StatusCode::NOT_FOUND, "unknown_profile");
        };
        route
    };
    state.leases.lock().await.touch(&agent, &selected.key);
    forward_route(ForwardRequest {
        state: &state,
        route: &selected,
        agent: &agent,
        path: &path,
        method,
        uri,
        headers,
        body,
    })
    .await
}

struct ForwardRequest<'a> {
    state: &'a GatewayState,
    route: &'a FleetRoute,
    agent: &'a str,
    path: &'a str,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
}

async fn forward_route(request: ForwardRequest<'_>) -> Response {
    let ForwardRequest {
        state,
        route,
        agent,
        path,
        method,
        uri,
        headers,
        body,
    } = request;
    let query = uri
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let (target, token) = match &route.node {
        Some(node) => (
            format!(
                "http://{}:{}/v1/node/{}/{}{}",
                node.host,
                node.port,
                url_encode(&route.name),
                path,
                query
            ),
            node.token.clone(),
        ),
        None => (
            format!("http://127.0.0.1:{}/{}{}", route.port, path, query),
            Some(state.config.bridge_token.clone()),
        ),
    };
    let mut request = state.client.request(method, target);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    for (name, value) in &headers {
        if name.as_str().eq_ignore_ascii_case("host")
            || name.as_str().eq_ignore_ascii_case("authorization")
            || name.as_str().eq_ignore_ascii_case("content-length")
        {
            continue;
        }
        request = request.header(name, value);
    }
    if !headers.contains_key("x-humanchrome-session") {
        request = request.header("x-humanchrome-session", agent);
    }
    if !headers.contains_key("x-client-id") {
        request = request.header("x-client-id", agent);
    }
    let upstream = match request
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "bridge_unreachable"),
    };
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in &upstream_headers {
        if name.as_str().eq_ignore_ascii_case("connection")
            || name.as_str().eq_ignore_ascii_case("transfer-encoding")
        {
            continue;
        }
        response = response.header(name, value);
    }
    response = response.header("x-humanchrome-profile", &route.key);
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| error(StatusCode::BAD_GATEWAY, "bridge_unreachable"))
}

/// Persist and apply the fleet parking state through the authenticated gateway owner.
async fn park(State(state): State<Arc<GatewayState>>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(error) = authorize(&headers, &state.config) {
        return error.into_response();
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_body");
    };
    let Some(parked) = body.get("parked").and_then(Value::as_bool) else {
        return error(StatusCode::BAD_REQUEST, "invalid_parked");
    };
    let changed = match state.config.provisioner.set_parked(parked).await {
        Ok(changed) => changed,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({ "error": "park_failed", "message": error.to_string() }),
            );
        }
    };
    if changed && let Err(error) = state.supervisor.set_parked(parked).await {
        return json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "park_failed", "message": error.to_string() }),
        );
    }
    json_response(
        StatusCode::OK,
        json!({ "parked": parked, "changed": changed }),
    )
}

async fn profile_add(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = authorize(&headers, &state.config) {
        return error.into_response();
    }
    let _addition = state.adding.lock().await;
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_body");
    };
    let Some(object) = body.as_object() else {
        return error(StatusCode::BAD_REQUEST, "invalid_body");
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return error(StatusCode::BAD_REQUEST, "invalid_name");
    };
    let labels = match object.get("labels") {
        None => Vec::new(),
        Some(Value::Array(labels)) => {
            let labels = labels
                .iter()
                .map(|label| label.as_str().map(ToOwned::to_owned))
                .collect::<Option<Vec<_>>>();
            let Some(labels) = labels else {
                return error(StatusCode::BAD_REQUEST, "invalid_labels");
            };
            labels
        }
        Some(_) => return error(StatusCode::BAD_REQUEST, "invalid_labels"),
    };
    let mut seen_labels = BTreeSet::new();
    let labels = labels
        .into_iter()
        .filter(|label| seen_labels.insert(label.clone()))
        .collect::<Vec<_>>();
    let seed = match object.get("seed") {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) if std::path::Path::new(path).is_absolute() => {
            Some(std::path::PathBuf::from(path))
        }
        _ => return error(StatusCode::BAD_REQUEST, "invalid_seed"),
    };
    let added = match state
        .config
        .provisioner
        .add(name, labels.clone(), seed.as_deref())
        .await
    {
        Ok(added) => added,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({ "error": "add_failed", "message": error.to_string() }),
            );
        }
    };
    let profile = FleetProfile {
        name: added.name.clone(),
        port: added.port,
        labels,
        purpose: None,
        enabled: true,
        idle_stop: None,
    };
    if let Err(error) = state.supervisor.register_profile(profile).await {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "supervisor_registration_failed", "message": error.to_string() }),
        );
    }
    json_response(
        StatusCode::CREATED,
        json!({
            "name": added.name, "port": added.port,
            "copied": { "persistent": added.copied.persistent, "google": added.copied.google },
            "kept": { "persistent": added.kept.persistent, "google": added.kept.google },
            "google": added.google.map(|google| json!({
                "state": match google.state {
                    super::GoogleSessionState::Session => "session",
                    super::GoogleSessionState::Remembered => "remembered",
                    super::GoogleSessionState::None => "none",
                },
                "accounts": google.accounts, "signedIn": google.signed_in,
            })),
        }),
    )
}

#[derive(Clone, Copy)]
enum GatewayAuthorizationError {
    OriginNotAllowed,
    Unauthorized,
}

impl GatewayAuthorizationError {
    fn into_response(self) -> Response {
        match self {
            Self::OriginNotAllowed => error(StatusCode::FORBIDDEN, "origin_not_allowed"),
            Self::Unauthorized => error(StatusCode::UNAUTHORIZED, "unauthorized"),
        }
    }
}

fn authorize(headers: &HeaderMap, config: &GatewayConfig) -> Result<(), GatewayAuthorizationError> {
    if headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.is_empty())
    {
        return Err(GatewayAuthorizationError::OriginNotAllowed);
    }
    let Some(expected) = &config.token else {
        return Ok(());
    };
    let Some(actual) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return Err(GatewayAuthorizationError::Unauthorized);
    };
    if !constant_time_eq(actual.as_bytes(), expected.as_bytes()) {
        return Err(GatewayAuthorizationError::Unauthorized);
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(*left.get(index).unwrap_or(&0) ^ *right.get(index).unwrap_or(&0));
    }
    difference == 0
}

fn normalize_agent(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        }))
    .then(|| value.to_owned())
}

fn peer_authorized(headers: &HeaderMap, nodes: &[FleetNode]) -> bool {
    let tokens = nodes
        .iter()
        .filter_map(|node| node.token.as_deref())
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return true;
    }
    let Some(actual) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    tokens
        .into_iter()
        .any(|token| constant_time_eq(actual.as_bytes(), token.as_bytes()))
}

fn matches_route_label(route: &FleetRoute, label: &str) -> bool {
    label == "any"
        || route.labels.iter().any(|entry| entry == label)
        || route.purpose.as_deref() == Some(label)
}

fn route_to_json(route: FleetRoute, leased_by: Option<String>) -> Value {
    json!({
        "name": route.key, "port": route.port, "labels": route.labels,
        "purpose": route.purpose, "enabled": route.enabled,
        "state": route.state.map(state_text).unwrap_or("unreachable"),
        "pid": Value::Null,
        "lastError": Value::Null, "startedBy": Value::Null, "leasedBy": leased_by,
    })
}

fn state_text(state: ProfileState) -> &'static str {
    match state {
        ProfileState::Stopped => "stopped",
        ProfileState::Starting => "starting",
        ProfileState::Running => "running",
        ProfileState::Healthy => "healthy",
        ProfileState::Backoff => "backoff",
    }
}

pub(crate) fn profiles_to_json(profiles: Vec<ProfileSnapshot>) -> Vec<Value> {
    profiles
        .into_iter()
        .map(|profile| json!({
            "name": profile.name, "port": profile.port, "labels": profile.labels,
            "purpose": profile.purpose, "enabled": profile.enabled, "state": state_text(profile.state),
            "pid": profile.pid, "leasedBy": profile.leased_by, "lastError": profile.last_error,
            "startedBy": profile.started_by.map(|reason| json!({ "agent": reason.agent, "session": reason.session, "request": reason.operation, "at": reason.at })),
        }))
        .collect()
}

fn start_error(error: ProfileStartError) -> Response {
    json_response(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({
            "error": error.code, "profile": error.profile, "lastError": error.message,
            "timeoutSec": error.timeout.map(|duration| duration.as_secs()),
        }),
    )
}

fn error(status: StatusCode, code: &str) -> Response {
    json_response(status, json!({ "error": code }))
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = (status, axum::Json(value)).into_response();
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

fn url_encode(value: &str) -> String {
    value.bytes().fold(String::new(), |mut encoded, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
        encoded
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_agents_that_cannot_be_safely_used_as_bridge_client_ids() {
        assert_eq!(
            normalize_agent("agent-1.session"),
            Some("agent-1.session".to_owned())
        );
        assert_eq!(normalize_agent("../other"), None);
        assert_eq!(normalize_agent(""), None);
    }

    #[test]
    fn bearer_comparison_requires_equal_lengths_and_bytes() {
        assert!(constant_time_eq(b"token", b"token"));
        assert!(!constant_time_eq(b"token", b"tokens"));
        assert!(!constant_time_eq(b"token", b"taken"));
    }

    #[test]
    fn qualifies_valid_peer_profiles_and_marks_unknown_state_unreachable() {
        let node = FleetNode {
            id: "peer-a".to_owned(),
            host: "peer.example".to_owned(),
            port: 12_300,
            token: Some("peer-token".to_owned()),
        };
        let route = remote_route(
            &node,
            json!({
                "name": "p01", "port": 12500, "labels": ["pool"],
                "purpose": "research", "enabled": true, "state": "healthy",
            }),
        )
        .expect("valid remote profile");
        assert_eq!(route.key, "peer-a:p01");
        assert_eq!(route.state, Some(ProfileState::Healthy));
        assert!(remote_route(&node, json!({ "name": "p02", "state": "unknown" })).is_none());
    }

    #[test]
    fn peer_auth_requires_one_configured_peer_token() {
        let nodes = [FleetNode {
            id: "peer-a".to_owned(),
            host: "peer.example".to_owned(),
            port: 12_300,
            token: Some("shared".to_owned()),
        }];
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer shared"));
        assert!(peer_authorized(&headers, &nodes));
        headers.insert("authorization", HeaderValue::from_static("Bearer wrong"));
        assert!(!peer_authorized(&headers, &nodes));
    }
}
