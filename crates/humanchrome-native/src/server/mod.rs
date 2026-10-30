//! HTTP surface and listener lifecycle for the native bridge.

pub mod lifecycle;
pub mod openapi;
pub mod security;
use axum::{
    Json, Router,
    body::Body,
    extract::{Extension, Path, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use humanchrome_contracts::CONTRACT;
use humanchrome_core::{json_document::JsonDocument, session::normalize_session_name};
use serde_json::{Value, json};

use crate::{
    ipc::{self, ClientDisconnectedEnvelopeInput},
    mcp::transport,
    native_host::{ExtensionRequest, NativeClient},
    pending::PendingError,
};

const FASTIFY_BODY_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
struct ParsedToolBody(JsonDocument);

/// Construct HTTP routes around the same extension owner used by MCP.
pub fn router(client: NativeClient, token: Option<&str>, agent: Router) -> Router {
    let api = Router::new()
        .route("/ping", get(ping))
        .route("/ask-extension", get(ask_extension))
        .route("/api/tools", get(tools))
        .route("/api/openapi.json", get(openapi_document))
        .route("/api/tools/{name}", post(call_tool))
        .route("/api/clients/{client_id}/release", post(release_client))
        .with_state(client.clone());
    api.merge(transport::router(client))
        .merge(agent)
        .layer(middleware::from_fn_with_state(
            security::SecurityPolicy::new(token),
            security::guard,
        ))
        .layer(middleware::from_fn(rest_tool_body_parser))
        .layer(middleware::from_fn(security::cors))
        .layer(middleware::from_fn(compatibility_headers))
        .layer(middleware::from_fn(mcp_delete_json_parser))
}

async fn mcp_delete_json_parser(request: Request, next: Next) -> Response {
    if request.method() != Method::DELETE
        || request.uri().path() != "/mcp"
        || !request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json_content_type)
    {
        return next.run(request).await;
    }
    let (parts, body) = request.into_parts();
    let body = match axum::body::to_bytes(body, FASTIFY_BODY_LIMIT).await {
        Ok(body) if body.is_empty() => {
            return fastify_error(
                StatusCode::BAD_REQUEST,
                "Bad Request",
                "FST_ERR_CTP_EMPTY_JSON_BODY",
                "Body cannot be empty when content-type is set to 'application/json'",
            );
        }
        Ok(body) => body,
        Err(_) => {
            return fastify_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Payload Too Large",
                "FST_ERR_CTP_BODY_TOO_LARGE",
                "Request body is too large",
            );
        }
    };
    next.run(Request::from_parts(parts, Body::from(body))).await
}

fn is_json_content_type(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

async fn rest_tool_body_parser(request: Request, next: Next) -> Response {
    if request.method() != Method::POST || !request.uri().path().starts_with("/api/tools/") {
        return next.run(request).await;
    }
    if !has_supported_rest_content_type(request.headers()) {
        return fastify_media_type_error();
    }
    if content_length_exceeds_fastify_limit(request.headers()) {
        return fastify_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Payload Too Large",
            "FST_ERR_CTP_BODY_TOO_LARGE",
            "Request body is too large",
        );
    }
    let (parts, body) = request.into_parts();
    let body = match axum::body::to_bytes(body, FASTIFY_BODY_LIMIT).await {
        Ok(body) => body,
        Err(_) => {
            return fastify_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Payload Too Large",
                "FST_ERR_CTP_BODY_TOO_LARGE",
                "Request body is too large",
            );
        }
    };
    let body = match parse_tool_body(&parts.headers, &body) {
        Ok(body) => body,
        Err(response) => return response.into_response(),
    };
    let mut request = Request::from_parts(parts, Body::empty());
    request.extensions_mut().insert(ParsedToolBody(body));
    next.run(request).await
}

fn has_supported_rest_content_type(headers: &HeaderMap) -> bool {
    let Some(content_type) = headers.get(header::CONTENT_TYPE) else {
        return true;
    };
    let Some(content_type) = content_type.to_str().ok() else {
        return false;
    };
    let media_type = content_type.split(';').next().unwrap_or("").trim();
    is_json_content_type(content_type) || media_type.eq_ignore_ascii_case("text/plain")
}

fn content_length_exceeds_fastify_limit(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|value| value > FASTIFY_BODY_LIMIT)
}
async fn compatibility_headers(request: Request, next: Next) -> Response {
    let is_mcp = request.uri().path() == "/mcp";
    let mut response = next.run(request).await;
    if is_mcp {
        return response;
    }
    let is_sse = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    if is_sse {
        return response;
    }
    let headers = response.headers_mut();
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
    {
        headers.insert(
            header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    if !headers.contains_key(header::CONNECTION) {
        headers.insert(
            header::CONNECTION,
            axum::http::HeaderValue::from_static("keep-alive"),
        );
        headers.insert(
            axum::http::HeaderName::from_static("keep-alive"),
            axum::http::HeaderValue::from_static("timeout=72"),
        );
    }
    response
}

async fn ping() -> Json<Value> {
    Json(json!({"status": "ok", "message": "pong"}))
}

fn catalog() -> Vec<Value> {
    CONTRACT["catalog"]["toolSchemas"]
        .as_array()
        .expect("generated tool schemas must be an array")
        .clone()
}

async fn tools(State(client): State<NativeClient>) -> Json<Value> {
    let mut tools = catalog();
    tools.extend(transport::list_dynamic_flow_tools(None, &client).await);
    Json(json!({"tools": tools}))
}

async fn openapi_document(State(client): State<NativeClient>) -> Json<Value> {
    let mut tools = catalog();
    tools.extend(transport::list_dynamic_flow_tools(None, &client).await);
    Json(openapi::build(&tools))
}

async fn call_tool(
    State(client): State<NativeClient>,
    Path(name): Path<String>,
    headers: HeaderMap,
    Extension(ParsedToolBody(body)): Extension<ParsedToolBody>,
) -> Response {
    let body = if body.as_ref().is_null() {
        JsonDocument::from(json!({"args":{}}))
    } else {
        body
    };
    if let Err(error) = ipc::validate_schema("ToolCallBodySchema", &body.validation_value()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"isError":true,"content":[{"type":"text","text":format!("Invalid request body: {}",error.first_message())}]})),
        ).into_response();
    }
    let args = body
        .get("args")
        .filter(|value| !value.is_null())
        .map(|value| value.to_owned())
        .unwrap_or_else(|| JsonDocument::from(json!({})));
    let client_id = headers
        .get("x-client-id")
        .and_then(|header| header.to_str().ok());
    let result = transport::dispatch_document(&name, args, client_id, &client).await;
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        result.to_json_text(),
    )
        .into_response()
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ToolBodyRejection {
    UnsupportedMediaType,
    EmptyJson,
    InvalidJson,
}

impl IntoResponse for ToolBodyRejection {
    fn into_response(self) -> Response {
        match self {
            Self::UnsupportedMediaType => fastify_media_type_error(),
            Self::EmptyJson => fastify_error(
                StatusCode::BAD_REQUEST,
                "Bad Request",
                "FST_ERR_CTP_EMPTY_JSON_BODY",
                "Body cannot be empty when content-type is set to 'application/json'",
            ),
            Self::InvalidJson => fastify_error(
                StatusCode::BAD_REQUEST,
                "Bad Request",
                "FST_ERR_CTP_INVALID_JSON_BODY",
                "Body is not valid JSON but content-type is set to 'application/json'",
            ),
        }
    }
}

pub(crate) fn parse_tool_body(
    headers: &HeaderMap,
    body: &[u8],
) -> Result<JsonDocument, ToolBodyRejection> {
    let Some(content_type) = headers.get(header::CONTENT_TYPE) else {
        return if body.is_empty() {
            Ok(JsonDocument::from(json!({"args":{}})))
        } else {
            Err(ToolBodyRejection::UnsupportedMediaType)
        };
    };
    let Some(content_type) = content_type.to_str().ok() else {
        return Err(ToolBodyRejection::UnsupportedMediaType);
    };
    if is_json_content_type(content_type) {
        if body.is_empty() {
            return Err(ToolBodyRejection::EmptyJson);
        }
        let text = String::from_utf8_lossy(body);
        let document = JsonDocument::parse(&text).map_err(|_| ToolBodyRejection::InvalidJson)?;
        if contains_rejected_json_key(&text) {
            return Err(ToolBodyRejection::InvalidJson);
        }
        return Ok(document);
    }
    let media_type = content_type.split(';').next().unwrap_or("").trim();
    if media_type.eq_ignore_ascii_case("text/plain") {
        return Ok(JsonDocument::from(
            String::from_utf8_lossy(body).into_owned(),
        ));
    }
    Err(ToolBodyRejection::UnsupportedMediaType)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum JsonObjectKey {
    Other,
    Prototype,
    Constructor,
    Proto,
}

fn contains_rejected_json_key(input: &str) -> bool {
    enum Container {
        Array,
        Object {
            expecting_key: bool,
            constructor_value_pending: bool,
            constructor_value: bool,
        },
    }

    let bytes = input.as_bytes();
    let mut containers = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                let constructor_value = match containers.last_mut() {
                    Some(Container::Object {
                        constructor_value_pending,
                        ..
                    }) => std::mem::take(constructor_value_pending),
                    _ => false,
                };
                containers.push(Container::Object {
                    expecting_key: true,
                    constructor_value_pending: false,
                    constructor_value,
                });
                index += 1;
            }
            b'[' => {
                if let Some(Container::Object {
                    constructor_value_pending,
                    ..
                }) = containers.last_mut()
                {
                    *constructor_value_pending = false;
                }
                containers.push(Container::Array);
                index += 1;
            }
            b'}' | b']' => {
                containers.pop();
                index += 1;
            }
            b',' => {
                if let Some(Container::Object {
                    expecting_key,
                    constructor_value_pending,
                    ..
                }) = containers.last_mut()
                {
                    *expecting_key = true;
                    *constructor_value_pending = false;
                }
                index += 1;
            }
            b'"' => {
                let (next, key) = scan_json_string(&bytes[index + 1..]);
                let Some(Container::Object {
                    expecting_key,
                    constructor_value_pending,
                    constructor_value,
                }) = containers.last_mut()
                else {
                    index += next + 1;
                    continue;
                };
                if *expecting_key {
                    if key == JsonObjectKey::Proto
                        || (*constructor_value && key == JsonObjectKey::Prototype)
                    {
                        return true;
                    }
                    *constructor_value_pending = key == JsonObjectKey::Constructor;
                    *expecting_key = false;
                } else {
                    *constructor_value_pending = false;
                }
                index += next + 1;
            }
            b':' | b' ' | b'\n' | b'\r' | b'\t' => index += 1,
            _ => {
                if let Some(Container::Object {
                    constructor_value_pending,
                    ..
                }) = containers.last_mut()
                {
                    *constructor_value_pending = false;
                }
                index += 1;
            }
        }
    }
    false
}

fn scan_json_string(bytes: &[u8]) -> (usize, JsonObjectKey) {
    const PROTO: &[u8] = b"__proto__";
    const CONSTRUCTOR: &[u8] = b"constructor";
    const PROTOTYPE: &[u8] = b"prototype";

    let mut proto_possible = true;
    let mut constructor_possible = true;
    let mut prototype_possible = true;
    let mut length = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            let key = if proto_possible && length == PROTO.len() {
                JsonObjectKey::Proto
            } else if constructor_possible && length == CONSTRUCTOR.len() {
                JsonObjectKey::Constructor
            } else if prototype_possible && length == PROTOTYPE.len() {
                JsonObjectKey::Prototype
            } else {
                JsonObjectKey::Other
            };
            return (index + 1, key);
        }
        let unit = if bytes[index] == b'\\' {
            index += 1;
            let Some(&escape) = bytes.get(index) else {
                return (bytes.len(), JsonObjectKey::Other);
            };
            match escape {
                b'"' | b'\\' | b'/' => {
                    index += 1;
                    u16::from(escape)
                }
                b'b' | b'f' | b'n' | b'r' | b't' => {
                    index += 1;
                    u16::MAX
                }
                b'u' => {
                    let Some(value) = bytes.get(index + 1..index + 5).and_then(hex_code_unit)
                    else {
                        return (bytes.len(), JsonObjectKey::Other);
                    };
                    index += 5;
                    value
                }
                _ => return (bytes.len(), JsonObjectKey::Other),
            }
        } else {
            let unit = u16::from(bytes[index]);
            index += 1;
            unit
        };
        proto_possible &= length < PROTO.len() && u16::from(PROTO[length]) == unit;
        constructor_possible &=
            length < CONSTRUCTOR.len() && u16::from(CONSTRUCTOR[length]) == unit;
        prototype_possible &= length < PROTOTYPE.len() && u16::from(PROTOTYPE[length]) == unit;
        length += 1;
    }
    (bytes.len(), JsonObjectKey::Other)
}

fn hex_code_unit(bytes: &[u8]) -> Option<u16> {
    bytes.iter().try_fold(0_u16, |value, byte| {
        let digit = match *byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return None,
        };
        Some(value * 16 + u16::from(digit))
    })
}
pub(crate) fn fastify_error(
    status: StatusCode,
    error: &'static str,
    code: &'static str,
    message: &'static str,
) -> Response {
    fastify_error_response(status, error, code, message, true)
}

fn fastify_media_type_error() -> Response {
    fastify_error_response(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "Unsupported Media Type",
        "FST_ERR_CTP_INVALID_MEDIA_TYPE",
        "Unsupported Media Type",
        false,
    )
}

fn fastify_error_response(
    status: StatusCode,
    error: &'static str,
    code: &'static str,
    message: &'static str,
    close_connection: bool,
) -> Response {
    let mut response = (
        status,
        Json(json!({
            "error": error,
            "code": code,
            "message": message,
            "statusCode": status.as_u16(),
        })),
    )
        .into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    if close_connection {
        response.headers_mut().insert(
            header::CONNECTION,
            axum::http::HeaderValue::from_static("close"),
        );
    }
    response
}

async fn release_client(
    State(client): State<NativeClient>,
    Path(client_id): Path<String>,
) -> (StatusCode, Json<Value>) {
    let Some(client_id) = normalize_session_name(&Value::String(client_id)) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_client_id"})),
        );
    };
    match ipc::build_client_disconnected_envelope(ClientDisconnectedEnvelopeInput {
        client_id: client_id.clone(),
    }) {
        Ok(envelope) => {
            client.notify(JsonDocument::from(envelope));
            (StatusCode::OK, Json(json!({"released":client_id})))
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":error.to_string()})),
        ),
    }
}

async fn ask_extension(
    State(client): State<NativeClient>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let mut request = ExtensionRequest::new("process_data", Some(JsonDocument::from(json!(query))));
    request.timeout_ms = Some(20_000);
    let (status, document) = match client.request(request).await {
        Ok(value) => (
            StatusCode::OK,
            JsonDocument::object(
                std::iter::once(("status", JsonDocument::from("success")))
                    .chain(value.map(|value| ("data", value))),
            ),
        ),
        Err(PendingError::TimedOut { .. }) => (
            StatusCode::GATEWAY_TIMEOUT,
            JsonDocument::from(
                json!({"status":"error","message":"Request to extension timed out."}),
            ),
        ),
        Err(error) => {
            let mut message = humanchrome_core::arguments::JsString::from(
                "Failed to get response from extension: ",
            );
            message.push_js_string(&error.into_js_message());
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                JsonDocument::object([
                    ("status", JsonDocument::from("error")),
                    ("message", JsonDocument::string(message)),
                ]),
            )
        }
    };
    let mut bytes = Vec::new();
    document
        .write(&mut bytes)
        .expect("writing JSON to a vector cannot fail");
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        bytes,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::contains_rejected_json_key;

    #[test]
    fn detects_nested_and_escaped_secure_json_keys() {
        assert!(contains_rejected_json_key(r#"{"nested":{"__proto__":{}}}"#));
        assert!(contains_rejected_json_key(
            r#"{"\u0063onstructor":{"prototype":{"polluted":true}}}"#
        ));
        assert!(!contains_rejected_json_key(
            r#"{"constructor":{"safe":true}}"#
        ));
        assert!(!contains_rejected_json_key(
            r#"["__proto__", {"safe":true}]"#
        ));
    }
}
