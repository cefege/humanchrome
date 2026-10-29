//! Dispatcher output budgets and separate tool-level truncation envelopes.

use serde_json::{Map, Number, Value};

use crate::arguments::JsString;

/// Default dispatcher cap: 25 KiB of text blocks, excluding images.
pub const DEFAULT_OUTPUT_BUDGET_BYTES: usize = 25 * 1024;
const DISPATCHER_HEADROOM_BYTES: usize = 256;
const MINIMUM_DISPATCHER_BUDGET_BYTES: usize = 1024;

/// Options for dispatcher-level output enforcement.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OutputBudgetOptions {
    /// Bypasses the dispatcher cap for an explicit `raw: true` request.
    pub raw: bool,
    /// Overrides the default cap before the 1 KiB lower bound is applied.
    pub budget_bytes: Option<usize>,
}

/// Applies the MCP dispatcher output cap, consuming `result` where possible.
///
/// The policy counts text blocks only, bypasses raw and error results, never
/// cuts image data, and preserves the distinct per-tool truncation envelope.
#[must_use]
pub fn enforce_output_budget(mut result: Value, options: OutputBudgetOptions) -> Value {
    if options.raw || js_truthy(result.get("isError")) {
        return result;
    }
    let Some(content) = result.get("content").and_then(Value::as_array) else {
        return result;
    };

    let mut text_blocks = Vec::new();
    let mut total_text_bytes = 0_usize;
    for (index, block) in content.iter().enumerate() {
        let Some(object) = block.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = object.get("text").and_then(Value::as_str) else {
            continue;
        };
        let bytes = text.len();
        text_blocks.push((index, bytes));
        total_text_bytes += bytes;
    }
    if text_blocks.is_empty() {
        return result;
    }

    let budget = options
        .budget_bytes
        .unwrap_or(DEFAULT_OUTPUT_BUDGET_BYTES)
        .max(MINIMUM_DISPATCHER_BUDGET_BYTES);
    if total_text_bytes <= budget {
        return result;
    }

    let head_budget = budget
        .saturating_sub(DISPATCHER_HEADROOM_BYTES)
        .max(MINIMUM_DISPATCHER_BUDGET_BYTES);
    let truncation = dispatcher_truncation(total_text_bytes, budget);
    let is_single_text_result = text_blocks.len() == 1 && content.len() == 1;
    let result_object = result
        .as_object_mut()
        .expect("content array implies result is a JSON object");

    if is_single_text_result {
        let original = result_object
            .get("content")
            .and_then(Value::as_array)
            .and_then(|content| content.first())
            .and_then(Value::as_object)
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str)
            .expect("measured text block remains available");
        let text = format!(
            "{}\n\n[Result truncated by dispatcher: originalSize={total_text_bytes} bytes, limit={budget} bytes. Pass raw=true to bypass.]",
            truncate_utf8_replacing_partial(original, head_budget)
        );
        result_object.insert(
            "content".to_owned(),
            Value::Array(vec![Value::Object(Map::from_iter([
                ("type".to_owned(), Value::String("text".to_owned())),
                ("text".to_owned(), Value::String(text)),
            ]))]),
        );
        result_object.insert("truncation".to_owned(), truncation);
        return result;
    }

    let per_block_budget = (head_budget / text_blocks.len()).max(512);
    let content = result_object
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .expect("content array remains available");
    for (index, measured_bytes) in text_blocks {
        if measured_bytes <= per_block_budget {
            continue;
        }
        let Some(block) = content.get_mut(index).and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(text) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        let text = format!(
            "{}\n\n[Block truncated by dispatcher: per-block limit={per_block_budget} bytes.]",
            truncate_utf8_replacing_partial(text, per_block_budget)
        );
        block.insert("text".to_owned(), Value::String(text));
    }
    result_object.insert("truncation".to_owned(), truncation);
    result
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Bool(true) | Value::Array(_) | Value::Object(_)) => true,
    }
}

fn dispatcher_truncation(original_size: usize, limit: usize) -> Value {
    Value::Object(Map::from_iter([
        ("truncated".to_owned(), Value::Bool(true)),
        (
            "originalSize".to_owned(),
            Value::Number(Number::from(
                u64::try_from(original_size).expect("usize fits u64"),
            )),
        ),
        (
            "limit".to_owned(),
            Value::Number(Number::from(u64::try_from(limit).expect("usize fits u64"))),
        ),
        ("unit".to_owned(), Value::String("bytes".to_owned())),
        (
            "hint".to_owned(),
            Value::String("set raw=true to opt out".to_owned()),
        ),
    ]))
}

fn truncate_utf8_replacing_partial(value: &str, max_bytes: usize) -> String {
    let bytes = value.as_bytes();
    if bytes.len() <= max_bytes {
        return value.to_owned();
    }
    String::from_utf8_lossy(&bytes[..max_bytes]).into_owned()
}

/// Unit labels used by tool-specific truncation callers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TruncateUnit {
    /// UTF-8 byte count.
    Bytes,
    /// Array entry count.
    Items,
    /// Message count.
    Messages,
    /// DOM element count.
    Elements,
}

/// Controls the separate tool-level truncation envelope.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TruncateMode {
    /// Return a bounded preview and advertise a raw retry.
    #[default]
    Preview,
    /// Return the full value without advertising a raw retry.
    Raw,
}

/// Stable per-tool truncation envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TruncateEnvelope<T> {
    /// Bounded or original data.
    pub data: T,
    /// Whether data was shortened.
    pub truncated: bool,
    /// Original byte or item count.
    pub original_size: usize,
    /// Byte or item cap supplied by the caller.
    pub limit: usize,
    /// Whether retrying with raw mode can return more data.
    pub raw_available: bool,
}

/// Caps a string using JavaScript UTF-16 slicing and TextEncoder byte accounting.
///
/// The returned [`JsString`] can retain a lone surrogate when the largest
/// fitting JavaScript prefix ends halfway through a surrogate pair.
#[must_use]
pub fn truncate_string(
    text: &str,
    max_bytes: usize,
    mode: TruncateMode,
) -> TruncateEnvelope<JsString> {
    let original_size = text.len();
    if mode == TruncateMode::Raw || original_size <= max_bytes {
        return TruncateEnvelope {
            data: JsString::from_string(text),
            truncated: false,
            original_size,
            limit: max_bytes,
            raw_available: false,
        };
    }

    TruncateEnvelope {
        data: JsString::text_encoder_prefix(text, max_bytes),
        truncated: true,
        original_size,
        limit: max_bytes,
        raw_available: true,
    }
}

/// Caps an array by item count, consuming it in raw and already-small cases.
#[must_use]
pub fn truncate_array<T>(
    mut values: Vec<T>,
    max_items: usize,
    mode: TruncateMode,
) -> TruncateEnvelope<Vec<T>> {
    let original_size = values.len();
    let truncated = mode == TruncateMode::Preview && original_size > max_items;
    if truncated {
        values.truncate(max_items);
    }
    TruncateEnvelope {
        data: values,
        truncated,
        original_size,
        limit: max_items,
        raw_available: truncated,
    }
}

/// Serializes JSON once, then applies the separate tool-level string cap.
#[must_use]
pub fn truncate_json(
    value: &Value,
    max_bytes: usize,
    mode: TruncateMode,
) -> TruncateEnvelope<JsString> {
    let text = crate::json::stringify(value);
    truncate_string(&text, max_bytes, mode)
}

/// Resolves a tool's `raw?: boolean` argument into a truncation mode.
#[must_use]
pub fn mode_from_raw(raw: &Value) -> TruncateMode {
    if raw == &Value::Bool(true) {
        TruncateMode::Raw
    } else {
        TruncateMode::Preview
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        OutputBudgetOptions, TruncateMode, enforce_output_budget, mode_from_raw, truncate_array,
        truncate_json, truncate_string,
    };

    #[test]
    fn dispatcher_bypasses_raw_errors_and_image_only_results_without_copying_shape() {
        let raw = json!({"content":[{"type":"text","text":"x".repeat(50_000)}]});
        assert_eq!(
            enforce_output_budget(
                raw.clone(),
                OutputBudgetOptions {
                    raw: true,
                    budget_bytes: None
                }
            ),
            raw
        );
        let error = json!({"isError":true,"content":[{"type":"text","text":"x".repeat(50_000)}]});
        assert_eq!(
            enforce_output_budget(error.clone(), OutputBudgetOptions::default()),
            error
        );
        let image = json!({"content":[{"type":"image","data":"x".repeat(50_000)}]});
        assert_eq!(
            enforce_output_budget(image.clone(), OutputBudgetOptions::default()),
            image
        );
    }

    #[test]
    fn dispatcher_uses_utf8_bytes_and_replacement_for_a_partial_character() {
        let result = json!({"content":[{"type":"text","text":format!("a{}", "é".repeat(600))}]});
        let output = enforce_output_budget(
            result,
            OutputBudgetOptions {
                raw: false,
                budget_bytes: Some(1024),
            },
        );
        assert_eq!(output["truncation"]["originalSize"], json!(1201));
        let text = output["content"][0]["text"].as_str().expect("text output");
        assert!(text.starts_with(&format!("a{}", "é".repeat(383))));
        assert!(text.contains('�'));
    }

    #[test]
    fn dispatcher_preserves_images_and_caps_each_oversized_text_block() {
        let result = json!({
            "content":[
                {"type":"text","text":"a".repeat(10_000)},
                {"type":"image","data":"base64-unmodified"},
                {"type":"text","text":"b".repeat(10_000)}
            ]
        });
        let output = enforce_output_budget(
            result,
            OutputBudgetOptions {
                raw: false,
                budget_bytes: Some(2048),
            },
        );
        assert_eq!(output["content"][1]["data"], json!("base64-unmodified"));
        assert!(
            output["content"][0]["text"]
                .as_str()
                .expect("text")
                .contains("per-block limit=896")
        );
        assert_eq!(output["truncation"]["limit"], json!(2048));
    }

    #[test]
    fn native_truncate_can_end_at_a_lone_surrogate() {
        let envelope = truncate_string("😀", 3, TruncateMode::Preview);
        assert!(envelope.truncated);
        assert_eq!(envelope.data.json_string_literal(), r#""\ud83d""#);
        assert_eq!(envelope.original_size, 4);
        assert!(envelope.raw_available);
    }

    #[test]
    fn native_truncate_retains_array_policy_and_raw_mode() {
        let preview = truncate_array(vec![1, 2, 3], 2, TruncateMode::Preview);
        assert_eq!(preview.data, vec![1, 2]);
        assert!(preview.truncated);
        assert!(preview.raw_available);
        let raw = truncate_array(vec![1, 2, 3], 2, TruncateMode::Raw);
        assert_eq!(raw.data, vec![1, 2, 3]);
        assert!(!raw.truncated);
        assert!(!raw.raw_available);
        assert_eq!(mode_from_raw(&json!(true)), TruncateMode::Raw);
        assert_eq!(mode_from_raw(&json!(1)), TruncateMode::Preview);
    }

    #[test]
    fn dispatcher_clamps_custom_budget_without_merging_tool_level_truncation() {
        let result = json!({"content":[{"type":"text","text":"x".repeat(2_000)}],"truncation":{"tool":"inner"}});
        let output = enforce_output_budget(
            result,
            OutputBudgetOptions {
                raw: false,
                budget_bytes: Some(1),
            },
        );
        assert_eq!(output["truncation"]["limit"], json!(1024));

        let json_preview = truncate_json(&json!({"payload":"abcdef"}), 8, TruncateMode::Preview);
        assert!(json_preview.truncated);
        assert!(json_preview.raw_available);
        let json_raw = truncate_json(&json!({"payload":"abcdef"}), 8, TruncateMode::Raw);
        assert!(!json_raw.truncated);
        assert!(!json_raw.raw_available);
    }
}
