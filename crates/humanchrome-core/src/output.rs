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

/// One text replacement in a dispatcher result. Other fields remain owned by the host.
#[derive(Debug, serde::Serialize)]
pub struct OutputTextPatch {
    pub index: usize,
    pub text: String,
}

/// Dispatcher metadata retains JavaScript numeric limits, including non-finite values.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatcherTruncation {
    pub truncated: bool,
    pub original_size: usize,
    pub limit: f64,
    pub unit: &'static str,
    pub hint: &'static str,
}

/// A pure mutation plan: images and opaque result metadata never cross the WASM boundary.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputBudgetPlan {
    pub single_text: bool,
    pub patches: Vec<OutputTextPatch>,
    pub truncation: DispatcherTruncation,
}

/// Plans dispatcher truncation from TextEncoder-compatible UTF-8 text.
///
/// The iterator is borrowed and replayable; ordinary under-budget results allocate nothing.
#[must_use]
pub fn plan_output_budget<'a>(
    content_length: usize,
    text_blocks: impl Iterator<Item = (usize, &'a str)> + Clone,
    budget_bytes: Option<f64>,
) -> Option<OutputBudgetPlan> {
    let (count, original_size) = text_blocks
        .clone()
        .fold((0_usize, 0_usize), |(count, bytes), (_, text)| {
            (count + 1, bytes + text.len())
        });
    let budget = javascript_max(
        MINIMUM_DISPATCHER_BUDGET_BYTES as f64,
        budget_bytes.unwrap_or(DEFAULT_OUTPUT_BUDGET_BYTES as f64),
    );
    if count == 0 || original_size as f64 <= budget {
        return None;
    }
    let head_budget = javascript_max(
        MINIMUM_DISPATCHER_BUDGET_BYTES as f64,
        budget - DISPATCHER_HEADROOM_BYTES as f64,
    );
    let single_text = count == 1 && content_length == 1;
    let patches = if single_text {
        let (index, text) = text_blocks
            .into_iter()
            .next()
            .expect("one text block exists");
        let head = truncate_utf8_replacing_partial(text, head_budget as usize);
        let limit = crate::json::number_to_string(budget);
        vec![OutputTextPatch {
            index,
            text: format!(
                "{head}\n\n[Result truncated by dispatcher: originalSize={original_size} bytes, limit={limit} bytes. Pass raw=true to bypass.]"
            ),
        }]
    } else {
        let per_block_budget = javascript_max(512.0, (head_budget / count as f64).floor());
        let limit = crate::json::number_to_string(per_block_budget);
        text_blocks
            .filter_map(|(index, text)| {
                if text.len() as f64 <= per_block_budget {
                    return None;
                }
                let head = truncate_utf8_replacing_partial(text, per_block_budget as usize);
                Some(OutputTextPatch {
                    index,
                    text: format!(
                        "{head}\n\n[Block truncated by dispatcher: per-block limit={limit} bytes.]"
                    ),
                })
            })
            .collect()
    };
    Some(OutputBudgetPlan {
        single_text,
        patches,
        truncation: DispatcherTruncation {
            truncated: true,
            original_size,
            limit: budget,
            unit: "bytes",
            hint: "set raw=true to opt out",
        },
    })
}

fn javascript_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

/// Applies the same dispatcher plan to native JSON values, consuming untouched data.
#[must_use]
pub fn enforce_output_budget(mut result: Value, options: OutputBudgetOptions) -> Value {
    if options.raw || js_truthy(result.get("isError")) {
        return result;
    }
    let Some(content) = result.get("content").and_then(Value::as_array) else {
        return result;
    };
    let text_blocks = content.iter().enumerate().filter_map(|(index, block)| {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        block
            .get("text")
            .and_then(Value::as_str)
            .map(|text| (index, text))
    });
    let Some(plan) = plan_output_budget(
        content.len(),
        text_blocks,
        options.budget_bytes.map(|budget| budget as f64),
    ) else {
        return result;
    };
    let truncation = dispatcher_truncation(
        plan.truncation.original_size,
        plan.truncation.limit as usize,
    );
    let result_object = result
        .as_object_mut()
        .expect("content belongs to an object");
    if plan.single_text {
        let text = plan
            .patches
            .into_iter()
            .next()
            .expect("single text patch exists")
            .text;
        result_object.insert(
            "content".to_owned(),
            Value::Array(vec![Value::Object(Map::from_iter([
                ("type".to_owned(), Value::String("text".to_owned())),
                ("text".to_owned(), Value::String(text)),
            ]))]),
        );
    } else {
        let content = result_object
            .get_mut("content")
            .and_then(Value::as_array_mut)
            .expect("content array remains available");
        for patch in plan.patches {
            content[patch.index]
                .as_object_mut()
                .expect("text block is an object")
                .insert("text".to_owned(), Value::String(patch.text));
        }
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
    let mut decoded = String::from_utf8_lossy(&bytes[..max_bytes]).into_owned();
    if decoded.starts_with('\u{feff}') {
        decoded.drain(..'\u{feff}'.len_utf8());
    }
    decoded
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

impl TruncateMode {
    /// Decodes the tool envelope's existing mode spelling.
    #[must_use]
    pub fn from_name(name: &str) -> Self {
        match name {
            "raw" => Self::Raw,
            _ => Self::Preview,
        }
    }
}

/// Stable per-tool truncation envelope.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateEnvelope<T, Limit = usize> {
    /// Bounded or original data.
    pub data: T,
    /// Whether data was shortened.
    pub truncated: bool,
    /// Original byte or item count.
    pub original_size: usize,
    /// Byte or item cap supplied by the caller.
    pub limit: Limit,
    /// Whether retrying with raw mode can return more data.
    pub raw_available: bool,
}

/// Consumes lossless JavaScript text and preserves fractional/non-finite tool limits.
#[must_use]
pub fn truncate_owned_string(
    text: JsString,
    max_bytes: f64,
    mode: TruncateMode,
) -> TruncateEnvelope<JsString, f64> {
    let original_size = text.text_encoder_len();
    let truncated = !(mode == TruncateMode::Raw || original_size as f64 <= max_bytes);
    let data = if truncated {
        text.into_text_encoder_prefix(max_bytes as usize)
    } else {
        text
    };
    TruncateEnvelope {
        data,
        truncated,
        original_size,
        limit: max_bytes,
        raw_available: truncated,
    }
}

/// Plans JavaScript array slicing without transferring or cloning array resources.
#[must_use]
pub fn truncate_array_plan(
    original_size: usize,
    max_items: f64,
    mode: TruncateMode,
) -> TruncateEnvelope<usize, f64> {
    let truncated = !(mode == TruncateMode::Raw || original_size as f64 <= max_items);
    let retained = if !truncated {
        original_size
    } else {
        let relative = max_items.trunc();
        if relative.is_nan() {
            0
        } else if relative < 0.0 {
            (original_size as f64 + relative).max(0.0) as usize
        } else {
            relative.min(original_size as f64) as usize
        }
    };
    TruncateEnvelope {
        data: retained,
        truncated,
        original_size,
        limit: max_items,
        raw_available: truncated,
    }
}

fn native_string_envelope(
    text: JsString,
    max_bytes: usize,
    mode: TruncateMode,
) -> TruncateEnvelope<JsString> {
    let envelope = truncate_owned_string(text, max_bytes as f64, mode);
    TruncateEnvelope {
        data: envelope.data,
        truncated: envelope.truncated,
        original_size: envelope.original_size,
        limit: max_bytes,
        raw_available: envelope.raw_available,
    }
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
    native_string_envelope(JsString::from_string(text), max_bytes, mode)
}

/// Caps an array by item count, consuming it in raw and already-small cases.
#[must_use]
pub fn truncate_array<T>(
    mut values: Vec<T>,
    max_items: usize,
    mode: TruncateMode,
) -> TruncateEnvelope<Vec<T>> {
    let plan = truncate_array_plan(values.len(), max_items as f64, mode);
    let original_size = plan.original_size;
    let truncated = plan.truncated;
    if truncated {
        values.truncate(plan.data);
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
    native_string_envelope(
        JsString::from_owned_string(crate::json::stringify(value)),
        max_bytes,
        mode,
    )
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
    #[test]
    fn dispatcher_decodes_a_truncated_leading_bom_like_text_decoder() {
        let output = enforce_output_budget(
            json!({"content":[{"type":"text","text":format!("\u{feff}{}", "x".repeat(2000))}]}),
            OutputBudgetOptions {
                raw: false,
                budget_bytes: Some(1024),
            },
        );
        let expected_head = "x".repeat(1021);
        assert_eq!(
            output["content"][0]["text"]
                .as_str()
                .expect("text")
                .split("\n\n")
                .next(),
            Some(expected_head.as_str()),
        );
        assert_eq!(output["truncation"]["originalSize"], json!(2003));
    }

    #[test]
    fn browser_dispatcher_plan_preserves_fractional_and_nan_limits() {
        let text = "x".repeat(4000);
        let plan = super::plan_output_budget(1, std::iter::once((0, text.as_str())), Some(2048.5))
            .expect("oversized text");
        assert_eq!(plan.truncation.limit, 2048.5);
        let expected_head = "x".repeat(1792);
        assert_eq!(
            plan.patches[0].text.split("\n\n").next(),
            Some(expected_head.as_str())
        );
        let plan =
            super::plan_output_budget(1, std::iter::once((0, text.as_str())), Some(f64::NAN))
                .expect("NaN does not satisfy the under-budget comparison");
        assert!(plan.truncation.limit.is_nan());
        assert_eq!(plan.patches[0].text.split("\n\n").next(), Some(""));
    }

    #[test]
    fn tool_string_prefix_preserves_existing_and_new_lone_surrogates() {
        let text = crate::arguments::JsString::from_utf16_units(vec![0xd800, 0x78, 0xd83d, 0xde00]);
        for (limit, expected) in [
            (2.0, vec![]),
            (3.0, vec![0xd800]),
            (4.0, vec![0xd800, 0x78]),
            (7.0, vec![0xd800, 0x78, 0xd83d]),
            (8.0, vec![0xd800, 0x78, 0xd83d, 0xde00]),
        ] {
            let envelope = super::truncate_owned_string(text.clone(), limit, TruncateMode::Preview);
            assert_eq!(envelope.data.utf16_units().collect::<Vec<_>>(), expected);
            assert_eq!(envelope.original_size, 8);
            assert_eq!(envelope.truncated, limit < 8.0);
        }
    }

    #[test]
    fn tool_array_plan_uses_javascript_relative_end_and_nan_comparisons() {
        for (limit, retained) in [(-0.25, 0), (-1.25, 2), (2.5, 2), (f64::NAN, 0)] {
            let plan = super::truncate_array_plan(3, limit, TruncateMode::Preview);
            assert_eq!(plan.data, retained);
            assert!(plan.truncated);
        }
        let raw = super::truncate_array_plan(3, f64::NAN, TruncateMode::Raw);
        assert_eq!(raw.data, 3);
        assert!(!raw.truncated);
        assert!(super::truncate_array_plan(0, f64::NAN, TruncateMode::Preview).truncated);
    }
}
