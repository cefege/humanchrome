//! MCP protocol structures shared by the stateless HTTP and stdio server surfaces.
//!
//! HumanChrome keeps request envelopes in `JsonDocument` so malformed UTF-16 JSON can travel
//! losslessly. This module limits rmcp serialization to server-authored standard structures.

use rmcp::{
    ErrorData,
    model::{ErrorCode, Implementation, InitializeResult, ProtocolVersion, ServerCapabilities},
};
use serde_json::Value;

/// The newest handshake revision supported by the TypeScript SDK compatibility oracle.
pub const LATEST_HANDSHAKE_VERSION: &str = "2025-11-25";

const LEGACY_2024_10_07: &str = "2024-10-07";

/// Returns whether a wire protocol version remains supported by the compatibility surface.
#[must_use]
pub fn is_supported_wire_version(version: &str) -> bool {
    supported_protocol_version(version).is_some()
}

/// Renders the ordered SDK-compatible protocol versions for public error responses.
#[must_use]
pub fn supported_wire_versions() -> &'static str {
    "2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07"
}

/// Builds the standard MCP initialize result with rmcp's protocol and metadata structures.
///
/// Unsupported or missing versions intentionally use the TypeScript SDK's latest-version
/// fallback rather than emitting rmcp's newer unsupported-version error.
#[must_use]
pub fn initialize_result(
    requested_version: Option<&str>,
    server_name: &str,
    server_version: &str,
) -> Value {
    let protocol_version = requested_version
        .and_then(supported_protocol_version)
        .unwrap_or(ProtocolVersion::LATEST_WITH_INITIALIZE);
    let result = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
        .with_protocol_version(protocol_version)
        .with_server_info(Implementation::new(server_name, server_version));
    serde_json::to_value(result).expect("rmcp initialize result must serialize")
}

/// Constructs a standards-based JSON-RPC error payload without touching an opaque envelope.
#[must_use]
pub fn error_data(code: i32, message: impl Into<String>, data: Option<Value>) -> ErrorData {
    ErrorData::new(ErrorCode(code), message.into(), data)
}

fn supported_protocol_version(version: &str) -> Option<ProtocolVersion> {
    let version = if version == LEGACY_2024_10_07 {
        protocol_version_from_wire(version)
    } else {
        ProtocolVersion::KNOWN_VERSIONS
            .iter()
            .find(|known| known.as_str() == version)
            .cloned()?
    };
    // The TypeScript compatibility oracle is an initialize-handshake server, so its
    // ceiling is rmcp's newest handshake revision rather than draft protocol revisions.
    version.has_initialize().then_some(version)
}

fn protocol_version_from_wire(version: &str) -> ProtocolVersion {
    // ProtocolVersion deliberately retains unknown textual revisions. `version` is the one
    // legacy compatibility revision that predates rmcp's typed historical list.
    serde_json::from_value(Value::String(version.to_owned()))
        .expect("wire protocol version is always a JSON string")
}
