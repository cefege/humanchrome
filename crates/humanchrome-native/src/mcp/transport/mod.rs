//! MCP stdio and Streamable HTTP transport backed by the native messaging actor.
//!
//! The transport is deliberately sessionless at the HTTP layer: HumanChrome's authority
//! boundary is the normalized `clientId` forwarded with every extension call, rather than
//! an MCP session token. This matches the existing bridge and permits concurrent clients.

use std::{
    env,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

use axum::{
    Router,
    body::Bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use humanchrome_contracts::CONTRACT;
use humanchrome_core::{
    arguments::JsString, catalog::Catalog, errors::serialize_tool_error,
    json_document::JsonDocument,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, watch};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::{
    mcp::{
        idem_cache::{IdemCache, make_key},
        protocol,
    },
    native_host::{ExtensionRequest, NativeClient, epoch_millis},
};

const MCP_PATH: &str = "/mcp";
const TOOL_TIMEOUT_MS: u64 = 120_000;
const FLOW_LIST_TIMEOUT_MS: u64 = 20_000;
const FLOW_TOOLS_CACHE_TTL_MS: u64 = 60_000;
const DEFAULT_CLIENT_ID: &str = "default";
const DISPATCHER_TOOL_NAME: &str = "humanchrome";
const FLOW_PREFIX: &str = "flow.";
const FLOW_RESERVED_KEYS: [&str; 6] = [
    "tabTarget",
    "refresh",
    "captureNetwork",
    "returnLogs",
    "timeoutMs",
    "startUrl",
];

static FLOW_CACHE: LazyLock<Mutex<Option<FlowCache>>> = LazyLock::new(|| Mutex::new(None));
static FLOW_FETCH_STATE: LazyLock<AsyncMutex<FlowFetchState>> =
    LazyLock::new(|| AsyncMutex::new(FlowFetchState::default()));
static FLOW_FETCH_COMPLETIONS: LazyLock<watch::Sender<u64>> = LazyLock::new(|| {
    let (sender, _receiver) = watch::channel(0);
    sender
});
type ToolReplayCache = IdemCache<fn() -> u64>;

static IDEMPOTENCY_CACHE: LazyLock<Mutex<ToolReplayCache>> =
    LazyLock::new(|| Mutex::new(IdemCache::new(epoch_millis as fn() -> u64)));

/// An MCP tool result, including extension-defined metadata retained without alteration.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CallToolResult {
    /// MCP content blocks supplied by the extension or native error mapper.
    pub content: Vec<Value>,
    /// Marks tool-level failures without converting them into JSON-RPC protocol failures.
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Extension metadata such as `_meta` is retained verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl CallToolResult {
    fn error(code: &str, message: impl Into<String>, details: Option<Value>) -> Self {
        let details = details.and_then(|value| value.as_object().cloned());
        Self {
            content: vec![
                json!({"type": "text", "text": serialize_tool_error(code, &message.into(), details.as_ref())}),
            ],
            is_error: Some(true),
            extra: Map::new(),
        }
    }
}

#[derive(Clone)]
struct TransportState {
    client: NativeClient,
}

#[derive(Clone, Debug)]
struct FlowCache {
    tools: Vec<Value>,
    items: Vec<Value>,
    fetched_at_ms: u64,
}

#[derive(Default)]
struct FlowFetchState {
    in_flight: bool,
    last_completed: Option<FlowCache>,
}

/// Builds the sessionless MCP endpoint at `/mcp`.
///
/// The router neither starts nor stops the native actor. Its caller retains lifecycle ownership.
pub fn router(client: NativeClient) -> Router {
    Router::new()
        .route(MCP_PATH, get(get_mcp).post(post_mcp).delete(delete_mcp))
        .with_state(TransportState { client })
}

/// Dispatches a tool without projecting its arguments or extension result through UTF-8 JSON.
///
/// Alias rewriting, metadata, native errors, and filesystem sinks retain UTF-16 strings.
pub async fn dispatch_document(
    name: &str,
    args: JsonDocument,
    client_id: Option<&str>,
    client: &NativeClient,
) -> JsonDocument {
    let (name, args) = match resolve_lossless_target(name, args, client).await {
        Ok(value) => value,
        Err(error) => return error,
    };
    let mut args = args;
    let write_target = if name == javascript_tool_name() {
        match args.get("writeResultTo").and_then(|value| value.as_str()) {
            Some(target) => {
                let path = PathBuf::from(target);
                if target.is_empty() || !path.is_absolute() {
                    return JsonDocument::from(invalid_args(
                        "`writeResultTo` must be a non-empty absolute file path.",
                        json!({"arg":"writeResultTo","received":target,"expected":{"type":"string","description":"Absolute file path."}}),
                    ).into_value());
                }
                args.remove("writeResultTo");
                Some(path)
            }
            None => None,
        }
    } else {
        None
    };
    forward_request(
        JsonDocument::from(name),
        args,
        write_target,
        client_id,
        client,
    )
    .await
}

async fn forward_request(
    name: JsonDocument,
    args: JsonDocument,
    write_target: Option<PathBuf>,
    client_id: Option<&str>,
    client: &NativeClient,
) -> JsonDocument {
    let mut request = ExtensionRequest::new(
        "call_tool",
        Some(JsonDocument::object([("name", name), ("args", args)])),
    );
    request.client_id = client_id.map(str::to_owned);
    request.timeout_ms = Some(TOOL_TIMEOUT_MS);
    request.request_id = Some(Uuid::new_v4());
    match client.request(request).await {
        Ok(Some(mut response))
            if response.get("status").and_then(|value| value.as_str()) == Some("success") =>
        {
            let result = response.remove("data").unwrap_or_else(|| {
                tool_error_document("UNKNOWN", "Extension returned an invalid tool result")
            });
            match write_target {
                Some(path) => sink_document_result(result, &path).await,
                None => result,
            }
        }
        Ok(Some(response)) => native_error_document(
            response
                .get("error")
                .map(|value| value.to_js_string())
                .unwrap_or_else(|| JsString::from("Unknown error")),
        ),
        Ok(None) => tool_error_document("UNKNOWN", "Extension returned no tool result"),
        Err(error) => native_error_document(error.into_js_message()),
    }
}

fn tool_error_document(code: &str, message: &str) -> JsonDocument {
    JsonDocument::from(json!({
        "content": [{
            "type": "text",
            "text": serialize_tool_error(code, message, None)
        }],
        "isError": true,
    }))
}

fn native_error_document(message: JsString) -> JsonDocument {
    let text = message
        .as_utf8()
        .map(error_envelope_text)
        .unwrap_or_else(|| {
            JsonDocument::object([(
                "error",
                JsonDocument::object([
                    ("code", JsonDocument::from("UNKNOWN")),
                    ("message", JsonDocument::string(message.clone())),
                ]),
            )])
            .to_json_text()
        });
    JsonDocument::from(json!({"content":[{"type":"text","text":text}],"isError":true}))
}

async fn dispatch_lazy_document(
    args: JsonDocument,
    client_id: Option<&str>,
    client: &NativeClient,
) -> JsonDocument {
    let name = args
        .get("name")
        .filter(|value| value.is_string())
        .map(|value| value.to_js_string())
        .filter(|name| name.utf16_len() != 0);
    let Some(name) = name else {
        let received = args
            .get("name")
            .map(|value| value.to_owned())
            .unwrap_or_else(|| JsonDocument::from(Value::Null));
        let details = JsonDocument::object([
            ("arg", JsonDocument::from("name")),
            ("received", received),
            (
                "expected",
                JsonDocument::from(
                    json!({"type":"string","description":"Tool name from humanchrome catalog."}),
                ),
            ),
        ]);
        let envelope = JsonDocument::object([("error", JsonDocument::object([
            ("code", JsonDocument::from("INVALID_ARGS")),
            ("message", JsonDocument::from("`name` is required (string) — pick a tool from the catalog in the dispatcher description.")),
            ("details", details),
        ]))]).to_json_text();
        return JsonDocument::from(
            json!({"content":[{"type":"text","text":envelope}],"isError":true}),
        );
    };
    let mut inner_args = args
        .get("args")
        .map(|value| value.to_owned())
        .unwrap_or_else(|| JsonDocument::from(json!({})));
    let normal_name = name.as_utf8();
    if normal_name == Some(help_tool_name()) {
        return help_document(inner_args);
    }
    let dynamic = if normal_name.is_some_and(|name| Catalog::embedded().is_known_tool_name(name)) {
        Vec::new()
    } else {
        list_dynamic_flow_tools(client_id, client).await
    };
    let dynamic_names: Vec<&str> = dynamic
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect();
    let Some(resolved) = normal_name.and_then(|name| resolve_known_name(name, &dynamic_names))
    else {
        return JsonDocument::from(Catalog::embedded().unknown_tool_result(&name, &dynamic_names));
    };
    if args.get("raw").and_then(|value| value.as_bool()) == Some(true) {
        inner_args = lossless_spread(inner_args, Some(("raw", JsonDocument::from(true))));
    }
    let idem_key = args
        .get("idemKey")
        .filter(|value| value.is_string())
        .map(|value| value.to_js_string());
    let client_id = normalized_or_default(client_id);
    let cache_key = make_key(Some(&client_id), &resolved, idem_key.as_ref());
    let replay = cache_key.as_ref().and_then(|key| {
        IDEMPOTENCY_CACHE
            .lock()
            .expect("idempotency cache lock poisoned")
            .lookup(key)
    });
    if let Some(result) = replay {
        return result;
    }
    let result = dispatch_document(&resolved, inner_args, Some(&client_id), client).await;
    if let Some(key) = cache_key {
        IDEMPOTENCY_CACHE
            .lock()
            .expect("idempotency cache lock poisoned")
            .record(key, result.clone());
    }
    result
}

async fn process_jsonrpc_document(
    mut request: JsonDocument,
    client_id: String,
    client: &NativeClient,
) -> Option<JsonDocument> {
    let method = request.remove("method")?;
    let method = method.as_ref().as_str();
    // Request handlers must never execute for JSON-RPC notifications.
    let id = request.remove("id")?;
    let mut params = request
        .remove("params")
        .unwrap_or_else(|| JsonDocument::from(json!({})));
    if method == Some("tools/call") {
        if let Some(error) = crate::mcp::http::tool_params_error(&params) {
            return Some(JsonDocument::object([
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
        let name = params.remove("name")?;
        let args = params
            .remove("arguments")
            .filter(|args| {
                !(tool_mode() == ToolMode::Legacy && args.as_value().is_some_and(javascript_falsy))
            })
            .unwrap_or_else(|| JsonDocument::from(json!({})));
        let result = match name.as_ref().as_str() {
            Some(name) if tool_mode() == ToolMode::Lazy && name == dispatcher_name() => {
                dispatch_lazy_document(args, Some(&client_id), client).await
            }
            Some(name) if name == help_tool_name() => help_document(args),
            Some(name) => dispatch_document(name, args, Some(&client_id), client).await,
            // Keep an unpaired UTF-16 name on the literal extension error path.
            None => forward_request(name, args, None, Some(&client_id), client).await,
        };
        return Some(JsonDocument::object([
            ("jsonrpc", JsonDocument::from("2.0")),
            ("id", id),
            ("result", result),
        ]));
    }
    let result = match method {
        Some("initialize") => initialize_result(&params),
        Some("ping") => json!({}),
        Some("tools/list") => json!({"tools":tools_for_mode(&client_id, client).await}),
        _ => {
            return Some(JsonDocument::object([
                ("jsonrpc", JsonDocument::from("2.0")),
                ("id", id),
                (
                    "error",
                    JsonDocument::from(json!({"code":-32601,"message":"Method not found"})),
                ),
            ]));
        }
    };
    Some(JsonDocument::object([
        ("jsonrpc", JsonDocument::from("2.0")),
        ("id", id),
        ("result", JsonDocument::from(result)),
    ]))
}

async fn resolve_lossless_target(
    name: &str,
    args: JsonDocument,
    client: &NativeClient,
) -> Result<(String, JsonDocument), JsonDocument> {
    if let Some(replacement) = CONTRACT["catalog"]["sunsetReplacements"].get(name) {
        let action = replacement.get("action").cloned();
        return Ok((
            replacement["name"]
                .as_str()
                .expect("generated replacement name is a string")
                .to_owned(),
            lossless_spread(
                args,
                action.map(|value| ("action", JsonDocument::from(value))),
            ),
        ));
    }
    let canonical = resolve_known_name(name, &[]).unwrap_or_else(|| name.to_owned());
    let (canonical, args) = lossless_legacy_alias(&canonical, args);
    if !canonical.starts_with(FLOW_PREFIX) {
        return Ok((canonical, args));
    }
    let slug = canonical
        .strip_prefix(FLOW_PREFIX)
        .expect("flow prefix was checked");
    let mut cache = flow_cache(None, client).await;
    if !cache
        .items
        .iter()
        .any(|item| item.get("slug").and_then(Value::as_str) == Some(slug))
    {
        invalidate_dynamic_flow_tools();
        cache = flow_cache(None, client).await;
    }
    let item = cache
        .items
        .iter()
        .find(|item| item.get("slug").and_then(Value::as_str) == Some(slug))
        .ok_or_else(|| {
            tool_error_document("UNKNOWN", &format!("Flow not found for tool {canonical}"))
        })?;
    let flow_id = item.get("id").and_then(Value::as_str).ok_or_else(|| {
        tool_error_document("UNKNOWN", &format!("Flow not found for tool {canonical}"))
    })?;
    Ok((
        "record_replay_flow_run".to_owned(),
        lossless_flow_args(flow_id, args),
    ))
}

fn lossless_legacy_alias(name: &str, args: JsonDocument) -> (String, JsonDocument) {
    let Some(alias) = CONTRACT["catalog"]["legacyToolAliases"]
        .get(name)
        .and_then(Value::as_object)
    else {
        return (name.to_owned(), args);
    };
    let target = alias["tool"].as_str().unwrap_or(name).to_owned();
    let base = alias
        .get("args")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut fields: Vec<(JsString, JsonDocument)> = base
        .into_iter()
        .map(|(key, value)| (JsString::from_owned_string(key), JsonDocument::from(value)))
        .collect();
    for (key, value) in args.into_spread_fields() {
        if let Some((_, existing)) = fields.iter_mut().find(|(existing, _)| existing == &key) {
            *existing = value;
        } else {
            fields.push((key, value));
        }
    }
    (target, JsonDocument::object_lossless(fields))
}

fn lossless_spread(args: JsonDocument, extra: Option<(&str, JsonDocument)>) -> JsonDocument {
    let mut fields = args.into_spread_fields();
    if let Some((key, value)) = extra {
        fields.retain(|(existing, _)| existing.as_utf8() != Some(key));
        fields.push((JsString::from_owned_string(key.to_owned()), value));
    }
    JsonDocument::object_lossless(fields)
}

fn lossless_flow_args(flow_id: &str, args: JsonDocument) -> JsonDocument {
    let mut runner = Vec::new();
    let mut variables = Vec::new();
    for (key, value) in args.into_object_fields().unwrap_or_default() {
        if key
            .as_utf8()
            .is_some_and(|key| FLOW_RESERVED_KEYS.contains(&key))
        {
            runner.push((key, value));
        } else {
            variables.push((key, value));
        }
    }
    let mut fields = vec![
        (
            JsString::from_owned_string("flowId".to_owned()),
            JsonDocument::from(flow_id.to_owned()),
        ),
        (
            JsString::from_owned_string("args".to_owned()),
            JsonDocument::object_lossless(variables),
        ),
    ];
    fields.extend(runner);
    JsonDocument::object_lossless(fields)
}
/// Returns extension-published flows as MCP tool descriptors.
///
/// Listing failures leave the cache empty so the next request can retry.
pub async fn list_dynamic_flow_tools(client_id: Option<&str>, client: &NativeClient) -> Vec<Value> {
    flow_cache(client_id, client).await.tools
}

/// Discards the shared published-flow catalog after a publish or unpublish event.
pub fn invalidate_dynamic_flow_tools() {
    *FLOW_CACHE.lock().expect("flow cache lock poisoned") = None;
}

async fn post_mcp(State(state): State<TransportState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    if let Err(response) = crate::mcp::http::validate_post_headers(&parts.headers) {
        return response.into_response();
    }
    let client_id = client_id_from_request(&parts.headers, parts.uri.query());
    let body = match axum::body::to_bytes(body, 2 * 1024 * 1024).await {
        Ok(body) => body,
        Err(error) => {
            return jsonrpc_http_error(
                StatusCode::BAD_REQUEST,
                -32700,
                "Parse error",
                Some(json!(error.to_string())),
            );
        }
    };
    post_jsonrpc(body, client_id, &state.client).await
}

async fn post_jsonrpc(body: Bytes, client_id: String, client: &NativeClient) -> Response {
    let text = match std::str::from_utf8(&body) {
        Ok(text) => text,
        Err(error) => {
            return jsonrpc_http_error(
                StatusCode::BAD_REQUEST,
                -32700,
                "Parse error",
                Some(json!(error.to_string())),
            );
        }
    };
    let value = match JsonDocument::parse(text) {
        Ok(value) => value,
        Err(error) => {
            return jsonrpc_http_error(
                StatusCode::BAD_REQUEST,
                -32700,
                "Parse error",
                Some(json!(error.to_string())),
            );
        }
    };
    if let Some(response) = crate::mcp::http::invalid_request(&value) {
        return response;
    }
    match process_jsonrpc_document(value, client_id, client).await {
        Some(response) => crate::mcp::http::event_response(response),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn get_mcp() -> Response {
    method_not_allowed()
}

async fn delete_mcp() -> Response {
    method_not_allowed()
}

fn method_not_allowed() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::CONTENT_TYPE, "application/json")],
        axum::Json(jsonrpc_error(
            Value::Null,
            -32_000,
            "Method not allowed.",
            None,
        )),
    )
        .into_response()
}

fn initialize_result(params: &JsonDocument) -> Value {
    protocol::initialize_result(
        params
            .get("protocolVersion")
            .and_then(|value| value.as_str()),
        "HumanChromeServer",
        "1.0.0",
    )
}

async fn tools_for_mode(client_id: &str, client: &NativeClient) -> Vec<Value> {
    let dynamic = list_dynamic_flow_tools(Some(client_id), client).await;
    if tool_mode() == ToolMode::Legacy {
        let mut tools = static_tools();
        tools.extend(dynamic);
        return tools;
    }
    let mut tools = Vec::with_capacity(dynamic.len() + 1);
    tools.push(dispatcher_tool());
    tools.extend(dynamic);
    tools
}

fn javascript_falsy(value: &Value) -> bool {
    matches!(value, Value::Null | Value::Bool(false))
        || value.as_str().is_some_and(str::is_empty)
        || value.as_f64() == Some(0.0)
}

async fn flow_cache(_client_id: Option<&str>, client: &NativeClient) -> FlowCache {
    let now = epoch_millis();
    if let Some(cache) = fresh_flow_cache(now) {
        return cache;
    }

    let mut completion = FLOW_FETCH_COMPLETIONS.subscribe();
    {
        let mut state = FLOW_FETCH_STATE.lock().await;
        if !state.in_flight {
            state.in_flight = true;
            let client = client.clone();
            tokio::spawn(async move {
                let cache = fetch_flow_cache(&client).await;
                {
                    let mut state = FLOW_FETCH_STATE.lock().await;
                    state.in_flight = false;
                    state.last_completed = Some(cache);
                }
                let next = (*FLOW_FETCH_COMPLETIONS.borrow()).wrapping_add(1);
                FLOW_FETCH_COMPLETIONS.send_replace(next);
            });
        }
    }
    let _ = completion.changed().await;
    FLOW_FETCH_STATE
        .lock()
        .await
        .last_completed
        .clone()
        .unwrap_or_else(empty_flow_cache)
}

fn fresh_flow_cache(now: u64) -> Option<FlowCache> {
    FLOW_CACHE
        .lock()
        .expect("flow cache lock poisoned")
        .as_ref()
        .filter(|cache| now.saturating_sub(cache.fetched_at_ms) < FLOW_TOOLS_CACHE_TTL_MS)
        .cloned()
}

async fn fetch_flow_cache(client: &NativeClient) -> FlowCache {
    let mut request = ExtensionRequest::new(
        "rr_list_published_flows",
        Some(JsonDocument::from(json!({}))),
    );
    request.timeout_ms = Some(FLOW_LIST_TIMEOUT_MS);
    let (items, cacheable) = match client.request(request).await {
        Ok(Some(document)) => document
            .into_value()
            .ok()
            .and_then(|value| {
                (value.get("status").and_then(Value::as_str) == Some("success"))
                    .then(|| value.get("items").and_then(Value::as_array).cloned())
                    .flatten()
            })
            .map_or_else(|| (Vec::new(), false), |items| (items, true)),
        Ok(None) | Err(_) => (Vec::new(), false),
    };
    let cache = FlowCache {
        tools: build_flow_tools(&items),
        items,
        fetched_at_ms: epoch_millis(),
    };
    if cacheable {
        *FLOW_CACHE.lock().expect("flow cache lock poisoned") = Some(cache.clone());
    }
    cache
}

fn empty_flow_cache() -> FlowCache {
    FlowCache {
        tools: Vec::new(),
        items: Vec::new(),
        fetched_at_ms: 0,
    }
}

async fn sink_document_result(mut result: JsonDocument, target: &Path) -> JsonDocument {
    let content = result
        .get("content")
        .map(|value| value.to_owned())
        .and_then(JsonDocument::into_array_values)
        .unwrap_or_default();
    let text = content.iter().find_map(|block| {
        (block.get("type").and_then(|value| value.as_str()) == Some("text"))
            .then(|| {
                block
                    .get("text")
                    .filter(|value| value.is_string())
                    .map(|value| value.to_js_string())
            })
            .flatten()
            .filter(|text| text.utf16_len() != 0)
    });
    let payload = match text {
        Some(text) => text
            .as_utf8()
            .and_then(|text| JsonDocument::parse(text).ok())
            .map(|parsed| {
                parsed
                    .get("result")
                    .map(|value| value.to_owned())
                    .unwrap_or(parsed)
            })
            .unwrap_or_else(|| JsonDocument::string(text)),
        None => result.clone(),
    };
    let body = if payload.as_ref().is_string() {
        // Node's UTF-8 file writer replaces unpaired UTF-16 code units in raw strings.
        payload.to_js_string().to_string_lossy().into_bytes()
    } else {
        payload.to_vec_pretty()
    };
    let write = async {
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(target, &body).await
    }
    .await;
    if let Err(error) = write {
        return JsonDocument::from(write_result_error(target, error.to_string()).into_value());
    }
    result.remove("content");
    let mut fields = result.into_object_fields().unwrap_or_default();
    fields.push((
        JsString::from("content"),
        JsonDocument::from(json!([{
            "type":"text",
            "text":humanchrome_core::json::stringify(&json!({
                "success":true,"writtenTo":target.to_string_lossy(),"bytes":body.len(),
                "sha256":format!("{:x}",Sha256::digest(&body)),"omitted":"result"
            }))
        }])),
    ));
    JsonDocument::object_lossless(fields)
}

fn write_result_error(target: &Path, message: String) -> CallToolResult {
    CallToolResult::error(
        "UNKNOWN",
        format!("writeResultTo failed: {message}"),
        Some(json!({
            "code": "WRITE_FAILED",
            "writtenTo": target.to_string_lossy(),
        })),
    )
}

fn build_flow_tools(items: &[Value]) -> Vec<Value> {
    items.iter().filter_map(|item| {
        let slug = item.get("slug")?.as_str()?;
        let mut properties = Map::new();
        let mut required = Vec::new();
        for variable in item.get("variables").and_then(Value::as_array).into_iter().flatten() {
            let key = variable.get("key").and_then(Value::as_str)?;
            if FLOW_RESERVED_KEYS.contains(&key) { continue; }
            let kind = variable.get("type").and_then(Value::as_str).unwrap_or("string").to_ascii_lowercase();
            let mut property = Map::new();
            property.insert("description".to_owned(), variable.get("label").cloned().unwrap_or_else(|| Value::String(key.to_owned())));
            match kind.as_str() {
                "boolean" => { property.insert("type".to_owned(), Value::String("boolean".to_owned())); }
                "number" => { property.insert("type".to_owned(), Value::String("number".to_owned())); }
                "array" => { property.insert("type".to_owned(), Value::String("array".to_owned())); property.insert("items".to_owned(), json!({"type": "string"})); }
                "enum" => { property.insert("type".to_owned(), Value::String("string".to_owned())); if let Some(values) = variable.pointer("/rules/enum").filter(|values| values.is_array()).cloned() { property.insert("enum".to_owned(), values); } }
                _ => { property.insert("type".to_owned(), Value::String("string".to_owned())); }
            }
            if let Some(default) = variable.get("default").cloned() { property.insert("default".to_owned(), default); }
            if variable.pointer("/rules/required").and_then(Value::as_bool) == Some(true) { required.push(Value::String(key.to_owned())); }
            properties.insert(key.to_owned(), Value::Object(property));
        }
        properties.insert("tabTarget".to_owned(), json!({"type": "string", "enum": ["current", "new"], "default": "current"}));
        properties.insert("refresh".to_owned(), json!({"type": "boolean", "default": false}));
        properties.insert("captureNetwork".to_owned(), json!({"type": "boolean", "default": false}));
        properties.insert("returnLogs".to_owned(), json!({"type": "boolean", "default": false}));
        properties.insert("timeoutMs".to_owned(), json!({"type": "number", "minimum": 0}));
        Some(json!({"name": format!("{FLOW_PREFIX}{slug}"), "description": item.pointer("/meta/tool/description").or_else(|| item.get("description")).and_then(Value::as_str).unwrap_or("Recorded flow"), "inputSchema": {"type": "object", "properties": properties, "required": required}}))
    }).collect()
}

fn static_tools() -> Vec<Value> {
    CONTRACT["catalog"]["toolSchemas"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
fn dispatcher_name() -> &'static str {
    CONTRACT["catalog"]["dispatcherToolName"]
        .as_str()
        .unwrap_or(DISPATCHER_TOOL_NAME)
}
fn help_tool_name() -> &'static str {
    CONTRACT["catalog"]["toolNames"]["BROWSER"]["HELP"]
        .as_str()
        .unwrap_or("chrome_help")
}
fn javascript_tool_name() -> &'static str {
    CONTRACT["catalog"]["toolNames"]["BROWSER"]["JAVASCRIPT"]
        .as_str()
        .unwrap_or("chrome_javascript")
}
fn dispatcher_tool() -> Value {
    json!({"name": dispatcher_name(), "description": CONTRACT["descriptor"]["description"], "inputSchema": CONTRACT["catalog"]["dispatcherInputSchema"]})
}

fn help_document(args: JsonDocument) -> JsonDocument {
    let args = match args.into_value() {
        Ok(args) => return JsonDocument::from(help_result(args).into_value()),
        Err(args) => args,
    };
    let payload = if let Some(query) = args
        .get("query")
        .filter(|query| query.is_string())
        .map(|query| query.to_js_string())
        .filter(|query| !query.to_string_lossy().trim().is_empty())
    {
        let limit = args
            .get("limit")
            .and_then(|limit| limit.to_owned().into_value().ok());
        let payload = Catalog::embedded().build_tool_help(Some(
            &json!({"query":query.to_string_lossy(),"limit":limit}),
        ));
        JsonDocument::object([
            ("query", JsonDocument::string(query)),
            ("matches", JsonDocument::from(payload["matches"].clone())),
        ])
    } else if let Some(name) = args
        .get("name")
        .filter(|name| name.is_string())
        .map(|name| name.to_owned())
        .or_else(|| args.as_ref().is_string().then(|| args.clone()))
    {
        match name.as_ref().as_str() {
            Some(name) => {
                JsonDocument::from(Catalog::embedded().build_tool_help(Some(&json!(name))))
            }
            None => JsonDocument::object([("name", name), ("found", JsonDocument::from(false))]),
        }
    } else {
        JsonDocument::from(Catalog::embedded().build_tool_help(None))
    };
    JsonDocument::from(json!({"content":[{"type":"text","text":payload.to_json_text()}]}))
}

fn help_result(args: Value) -> CallToolResult {
    let payload = Catalog::embedded().build_tool_help(Some(&args));
    CallToolResult {
        content: vec![json!({"type": "text", "text": payload.to_string()})],
        is_error: None,
        extra: Map::new(),
    }
}

fn resolve_known_name(name: &str, extras: &[&str]) -> Option<String> {
    if Catalog::embedded().is_known_tool_name(name) || extras.contains(&name) {
        return Some(name.to_owned());
    }
    ["chrome_", "browser_"]
        .into_iter()
        .map(|prefix| format!("{prefix}{name}"))
        .find(|candidate| {
            Catalog::embedded().is_known_tool_name(candidate)
                || extras.contains(&candidate.as_str())
        })
}

fn invalid_args(message: impl Into<String>, details: Value) -> CallToolResult {
    CallToolResult::error("INVALID_ARGS", message, Some(details))
}

fn error_envelope_text(message: &str) -> String {
    if message.starts_with('{')
        && let Ok(value) = JsonDocument::parse(message)
        && value
            .get("error")
            .and_then(|error| error.get("code"))
            .is_some_and(|code| code.as_str().is_some_and(|code| !code.is_empty()))
    {
        return message.to_owned();
    }
    serialize_tool_error("UNKNOWN", message, None)
}

fn normalized_or_default(client_id: Option<&str>) -> String {
    client_id
        .and_then(normalize_client_id)
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_owned())
}

fn client_id_from_request(headers: &HeaderMap, query: Option<&str>) -> String {
    let header = headers
        .get("x-humanchrome-session")
        .and_then(|value| value.to_str().ok());
    let query_session = query.and_then(|query| {
        query.split('&').find_map(|field| {
            let (key, value) = field.split_once('=').unwrap_or((field, ""));
            (decode_query_component(key) == "session").then(|| decode_query_component(value))
        })
    });
    header
        .and_then(normalize_client_id)
        .or_else(|| query_session.as_deref().and_then(normalize_client_id))
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_owned())
}

fn decode_query_component(component: &str) -> String {
    let bytes = component.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let high = hex_value(bytes[index + 1]);
                let low = hex_value(bytes[index + 2]);
                if let (Some(high), Some(low)) = (high, low) {
                    decoded.push(high << 4 | low);
                    index += 3;
                } else {
                    decoded.push(b'%');
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

const fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn normalize_client_id(raw: &str) -> Option<String> {
    let mut normalized = raw.nfc().collect::<String>().trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    normalized = normalized
        .chars()
        .map(|character| {
            if character.is_whitespace()
                || character == '\u{feff}'
                || matches!(character, '/' | '\\' | ':')
            {
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
    normalized = collapse_runs(&normalized, '-');
    normalized = collapse_runs(&normalized, '_');
    normalized = collapse_runs(&normalized, '.');
    normalized = normalized
        .trim_matches(['-', '_', '.'])
        .chars()
        .take(64)
        .collect::<String>();
    normalized = normalized.trim_end_matches(['-', '_', '.']).to_owned();
    (!normalized.is_empty() && !matches!(normalized.as_str(), "default" | "null" | "undefined"))
        .then_some(normalized)
}

fn collapse_runs(value: &str, character: char) -> String {
    let mut output = String::with_capacity(value.len());
    let mut previous = false;
    for current in value.chars() {
        if current != character || !previous {
            output.push(current);
        }
        previous = current == character;
    }
    output
}

fn jsonrpc_error(id: Value, code: i32, message: impl Into<String>, data: Option<Value>) -> Value {
    // Keep the outer envelope hand-built: `id` may contain JSON that serde_json would normalize.
    json!({"jsonrpc": "2.0", "id": id, "error": protocol::error_data(code, message, data)})
}

fn jsonrpc_http_error(
    status: StatusCode,
    code: i32,
    message: impl Into<String>,
    data: Option<Value>,
) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        axum::Json(jsonrpc_error(Value::Null, code, message, data)),
    )
        .into_response()
}

impl CallToolResult {
    fn into_value(self) -> Value {
        serde_json::to_value(self).expect("CallToolResult must serialize")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolMode {
    Legacy,
    Lazy,
}

fn tool_mode() -> ToolMode {
    matches!(
        env::var("HUMANCHROME_TOOL_MODE")
            .ok()
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("legacy")
    )
    .then_some(ToolMode::Legacy)
    .unwrap_or(ToolMode::Lazy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_name_matches_typescript_normalization_rules() {
        assert_eq!(
            normalize_client_id(" Acme-API "),
            Some("acme-api".to_owned())
        );
        assert_eq!(normalize_client_id("__ui:popup"), None);
        assert_eq!(normalize_client_id("default"), None);
        assert_eq!(normalize_client_id("a///b...c"), Some("a-b.c".to_owned()));
        assert_eq!(normalize_client_id("e\u{301}"), None);
    }

    #[test]
    fn error_envelope_preserves_structured_extension_error() {
        let envelope = r#"{"error":{"code":"TAB_CLOSED","message":"closed"}}"#;
        assert_eq!(error_envelope_text(envelope), envelope);
        assert_eq!(
            serde_json::from_str::<Value>(&error_envelope_text("timeout"))
                .expect("generated envelope parses")["error"]["code"],
            "UNKNOWN"
        );
    }

    #[test]
    fn flow_arguments_hoist_runner_options() {
        assert_eq!(
            lossless_flow_args(
                "flow_abc",
                JsonDocument::from(json!({"query":"hello","timeoutMs": 30_000,"refresh":true}))
            )
            .into_value()
            .expect("ordinary JSON"),
            json!({"flowId":"flow_abc","args":{"query":"hello"},"timeoutMs":30_000,"refresh":true})
        );
    }

    #[test]
    fn help_catalog_is_sorted_and_uses_first_sentences() {
        let result = help_result(json!({})).into_value();
        let payload: Value = serde_json::from_str(
            result["content"][0]["text"]
                .as_str()
                .expect("help result contains text"),
        )
        .expect("help payload is JSON");
        let names: Vec<&str> = payload["tools"]
            .as_array()
            .expect("full help has tools")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
        assert!(
            !payload["tools"][0]["summary"]
                .as_str()
                .expect("summary is text")
                .is_empty()
        );
    }

    #[test]
    fn help_named_lookup_and_unknown_match_shared_contract() {
        let found = help_result(json!({"name": "chrome_navigate"})).into_value();
        let found: Value = serde_json::from_str(
            found["content"][0]["text"]
                .as_str()
                .expect("help result contains text"),
        )
        .expect("help payload is JSON");
        assert_eq!(found["name"], "chrome_navigate");
        assert!(
            found["description"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
        );

        let missing = help_result(json!({"name": "not_a_real_tool"})).into_value();
        let missing: Value = serde_json::from_str(
            missing["content"][0]["text"]
                .as_str()
                .expect("help result contains text"),
        )
        .expect("help payload is JSON");
        assert_eq!(missing, json!({"name": "not_a_real_tool", "found": false}));
    }

    #[test]
    fn help_query_ranks_the_click_tool_before_description_only_hits() {
        let hits = Catalog::embedded().search("click");
        assert_eq!(
            hits.first().map(|hit| hit.name.as_str()),
            Some("chrome_click_element")
        );
    }

    #[test]
    fn dynamic_flow_schema_hides_runner_option_variables() {
        let tools = build_flow_tools(&[json!({
            "slug": "checkout",
            "description": "Checkout flow",
            "variables": [
                {"key": "email", "type": "string", "rules": {"required": true}},
                {"key": "timeoutMs", "type": "string"}
            ]
        })]);
        let properties = &tools[0]["inputSchema"]["properties"];
        assert!(properties.get("email").is_some());
        assert_eq!(properties["timeoutMs"]["type"], "number");
        assert_eq!(tools[0]["inputSchema"]["required"], json!(["email"]));
    }
}
