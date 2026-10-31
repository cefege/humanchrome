//! Structured tool-error envelopes encoded in MCP text content.

use std::fmt;

use humanchrome_contracts::CONTRACT;
use serde_json::{Map, Value};

/// JSON text that can be embedded in a structured error without reparsing.
///
/// This supports JavaScript strings that end in an unpaired surrogate after a
/// UTF-16 slice. Such a string is valid JSON text when escaped as `\uXXXX`, but
/// cannot be represented by [`serde_json::Value`] without replacement.
pub trait JsonText {
    /// Appends one complete JSON value to `output`.
    fn append_json_text(&self, output: &mut String);
}

impl JsonText for Map<String, Value> {
    fn append_json_text(&self, output: &mut String) {
        output.push_str(&crate::json::stringify_object(self));
    }
}

impl JsonText for crate::json_document::JsonDocument {
    fn append_json_text(&self, output: &mut String) {
        output.push_str(&self.to_json_text());
    }
}

/// Error carried by tool internals before conversion to MCP text content.
///
/// `code` intentionally remains an opaque string: TypeScript's enum constrains
/// callers at compile time but its runtime serializer does not reject future
/// code literals.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolError {
    /// Structured machine-readable code.
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
    /// Optional structured context, omitted rather than serialized as null.
    pub details: Option<Map<String, Value>>,
}

impl ToolError {
    /// Creates a structured tool error.
    #[must_use]
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Map<String, Value>>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details,
        }
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ToolError {}

/// Identifies errors created by this module, mirroring the TypeScript tag check.
#[must_use]
pub fn is_tool_error(error: &(dyn std::error::Error + 'static)) -> bool {
    error.downcast_ref::<ToolError>().is_some()
}

/// Returns whether a code appears in the generated declarative contract.
///
/// This is informational only. Serialization deliberately accepts unknown
/// future literals because the TypeScript runtime does too.
#[must_use]
pub fn is_known_tool_error_code(code: &str) -> bool {
    CONTRACT
        .pointer("/errors/toolErrorCodes")
        .and_then(Value::as_array)
        .is_some_and(|codes| {
            codes
                .iter()
                .any(|candidate| candidate.as_str() == Some(code))
        })
}

/// Serializes a standard structured tool error into the JSON text MCP clients receive.
#[must_use]
pub fn serialize_tool_error(
    code: &str,
    message: &str,
    details: Option<&Map<String, Value>>,
) -> String {
    serialize_tool_error_with_json_details(
        code,
        message,
        details.map(|value| value as &dyn JsonText),
    )
}

/// Serializes a structured error with an exact JSON fragment for `details`.
///
/// Unlike serializing a [`Value`] wrapper, this composes raw escaped JSON from
/// INVALID_ARGS truncation into the complete envelope without replacing an
/// unpaired UTF-16 surrogate.
#[must_use]
pub fn serialize_tool_error_with_json_details(
    code: &str,
    message: &str,
    details: Option<&dyn JsonText>,
) -> String {
    serialize_tool_error_with_serialized_message(code, crate::json::quote(message), details)
}

/// Serializes a tool error whose message may retain JavaScript-only UTF-16 code units.
#[must_use]
pub fn serialize_tool_error_with_lossless_message(
    code: &str,
    message: &crate::arguments::JsString,
    details: Option<&dyn JsonText>,
) -> String {
    serialize_tool_error_with_serialized_message(code, message.json_string_literal(), details)
}

fn serialize_tool_error_with_serialized_message(
    code: &str,
    message: String,
    details: Option<&dyn JsonText>,
) -> String {
    let code = crate::json::quote(code);
    let mut envelope = format!(r#"{{"error":{{"code":{code},"message":{message}"#);
    if let Some(details) = details {
        envelope.push_str(",\"details\":");
        details.append_json_text(&mut envelope);
    }
    envelope.push_str("}}");
    envelope
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, json};

    use crate::arguments::{BuildInvalidArgsOptions, build_invalid_args_details};

    use super::{
        ToolError, is_known_tool_error_code, is_tool_error, serialize_tool_error,
        serialize_tool_error_with_json_details,
    };

    #[test]
    fn serializes_omitted_details_without_null() {
        assert_eq!(
            serialize_tool_error("INVALID_ARGS", "bad input", None),
            r#"{"error":{"code":"INVALID_ARGS","message":"bad input"}}"#
        );
    }

    #[test]
    fn preserves_invalid_args_lone_surrogate_inside_complete_error_text() {
        let received = json!(format!("{}😀", "x".repeat(199)));
        let details = build_invalid_args_details(BuildInvalidArgsOptions {
            arg: "value",
            received: Some(&received),
            expected: None,
            hint: None,
            candidates: &[],
            extra: None,
        });
        let serialized =
            serialize_tool_error_with_json_details("INVALID_ARGS", "bad input", Some(&details));
        assert_eq!(
            serialized,
            format!(
                r#"{{"error":{{"code":"INVALID_ARGS","message":"bad input","details":{{"arg":"value","received":"{}\ud83d…"}}}}}}"#,
                "x".repeat(199)
            )
        );
    }

    #[test]
    fn accepts_opaque_future_codes_while_contract_lookup_is_informational() {
        let details = Map::from_iter([("arg".to_owned(), json!("mode"))]);
        assert!(is_known_tool_error_code("INVALID_ARGS"));
        assert!(!is_known_tool_error_code("FUTURE_CODE"));
        assert_eq!(
            serialize_tool_error("FUTURE_CODE", "future", Some(&details)),
            r#"{"error":{"code":"FUTURE_CODE","message":"future","details":{"arg":"mode"}}}"#
        );
    }

    #[test]
    fn recognizes_only_the_tagged_error_type() {
        let error = ToolError::new("INVALID_ARGS", "bad input", None);
        assert!(is_tool_error(&error));
        let plain = std::io::Error::other("bad input");
        assert!(!is_tool_error(&plain));
    }
}
