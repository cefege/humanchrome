//! Sessionless Streamable HTTP framing shared by browser and fleet MCP handlers.

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use humanchrome_core::json_document::JsonDocument;
use serde_json::{Value, json};

use super::protocol;

#[derive(Clone, Copy, Debug)]
pub(crate) enum PostHeaderRejection<'a> {
    NotAcceptable,
    UnsupportedProtocol(&'a str),
    UnsupportedMediaType,
}

impl IntoResponse for PostHeaderRejection<'_> {
    fn into_response(self) -> Response {
        match self {
            Self::NotAcceptable => http_error(
                StatusCode::NOT_ACCEPTABLE,
                -32000,
                "Not Acceptable: Client must accept both application/json and text/event-stream",
            ),
            Self::UnsupportedProtocol(version) => http_error(
                StatusCode::BAD_REQUEST,
                -32000,
                format!(
                    "Bad Request: Unsupported protocol version: {version} (supported versions: {})",
                    protocol::supported_wire_versions(),
                ),
            ),
            Self::UnsupportedMediaType => http_error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                -32000,
                "Unsupported Media Type: Content-Type must be application/json",
            ),
        }
    }
}

pub(crate) fn validate_post_headers(headers: &HeaderMap) -> Result<(), PostHeaderRejection<'_>> {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return Err(PostHeaderRejection::NotAcceptable);
    }
    if let Some(version) = headers
        .get("mcp-protocol-version")
        .and_then(|value| value.to_str().ok())
        && !protocol::is_supported_wire_version(version)
    {
        return Err(PostHeaderRejection::UnsupportedProtocol(version));
    }
    if !headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return Err(PostHeaderRejection::UnsupportedMediaType);
    }
    Ok(())
}

pub(crate) fn rpc_error(id: JsonDocument, code: i32, message: impl Into<String>) -> JsonDocument {
    JsonDocument::object([
        ("jsonrpc", JsonDocument::from("2.0")),
        ("id", id),
        (
            "error",
            JsonDocument::from(
                serde_json::to_value(protocol::error_data(code, message, None))
                    .expect("standard MCP errors serialize"),
            ),
        ),
    ])
}

pub(crate) fn http_error(status: StatusCode, code: i32, message: impl Into<String>) -> Response {
    let document = rpc_error(JsonDocument::from(Value::Null), code, message);
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        document.to_json_text(),
    )
        .into_response()
}

pub(crate) fn event_response(document: JsonDocument) -> Response {
    let mut bytes = Vec::with_capacity(256);
    bytes.extend_from_slice(b"event: message\ndata: ");
    document
        .write(&mut bytes)
        .expect("writing JSON to a vector cannot fail");
    bytes.extend_from_slice(b"\n\n");
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache, no-transform"),
            (header::CONNECTION, "keep-alive"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(tokio_stream::iter([Ok::<_, std::convert::Infallible>(
            Bytes::from(bytes),
        )])),
    )
        .into_response()
}

fn finite_number(value: humanchrome_core::json_document::JsonRef<'_>) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

pub(crate) fn invalid_request(document: &JsonDocument) -> Option<Response> {
    let valid_id = |value: humanchrome_core::json_document::JsonRef<'_>| {
        value.is_string() || finite_number(value)
    };
    let id = document.get("id");
    let request = document
        .get("method")
        .is_some_and(|method| method.is_string())
        && id.is_none_or(valid_id)
        && document
            .get("params")
            .is_none_or(|params| params.is_object());
    let result = document.get("result").is_some() && id.is_some_and(valid_id);
    let error = document.get("error").is_some_and(|error| {
        error.is_object()
            && error.get("code").is_some_and(finite_number)
            && error
                .get("message")
                .is_some_and(|message| message.is_string())
    }) && id.is_some_and(|id| id.is_null() || valid_id(id));
    if document.get("jsonrpc").and_then(|value| value.as_str()) == Some("2.0")
        && (request || result || error)
    {
        return None;
    }
    let id = id
        .filter(|id| valid_id(*id))
        .map(|id| id.to_owned())
        .unwrap_or_else(|| JsonDocument::from(Value::Null));
    Some(
        (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            rpc_error(
                id,
                -32600,
                "Bad Request: the request body is not a valid JSON-RPC message",
            )
            .to_json_text(),
        )
            .into_response(),
    )
}

pub(crate) fn result(id: JsonDocument, value: Value) -> JsonDocument {
    JsonDocument::object([
        ("jsonrpc", JsonDocument::from("2.0")),
        ("id", id),
        ("result", JsonDocument::from(value)),
    ])
}

pub(crate) fn tool_params_error(params: &JsonDocument) -> Option<rmcp::ErrorData> {
    let mut issues = Vec::new();
    for (field, expected) in [("name", "string"), ("arguments", "record")] {
        let value = params.get(field);
        let valid = match value {
            Some(value) if field == "name" => value.is_string(),
            Some(value) => value.is_object(),
            None => field == "arguments",
        };
        if !valid {
            let received = value.map_or("undefined", |value| {
                if value.is_null() {
                    "null"
                } else if value.is_array() {
                    "array"
                } else if value.is_object() {
                    "object"
                } else if value.is_string() {
                    "string"
                } else if value.as_bool().is_some() {
                    "boolean"
                } else {
                    "number"
                }
            });
            issues.push(
                json!({"expected":expected,"code":"invalid_type","path":["params",field],
                "message":format!("Invalid input: expected {expected}, received {received}")}),
            );
        }
    }
    if issues.is_empty() {
        return None;
    }
    Some(protocol::error_data(
        -32602,
        format!(
            "Invalid tools/call request: {}",
            serde_json::to_string_pretty(&issues).expect("validation issues serialize")
        ),
        None,
    ))
}
