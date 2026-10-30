//! Portable builder, quick-panel, model-metadata, and screenshot-coordinate policy.

use std::cmp::Ordering;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::json_document::{JsonDocument, JsonRef};

/// Applies the screenshot host's existing strict five-minute metadata expiry boundary.
#[must_use]
pub fn screenshot_context_expired(timestamp: f64, now: f64) -> bool {
    now - timestamp > 5.0 * 60.0 * 1_000.0
}

/// Sort key collected by the JavaScript quick-panel host after provider effects complete.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SearchRank {
    /// Provider-normalized relevance score.
    pub score: f64,
    /// Provider priority used after equal scores.
    pub priority: f64,
    /// Original result position, retained for stable equal-key ordering.
    pub index: usize,
}

/// Orders quick-panel results by score then provider priority, retaining input order for ties.
#[must_use]
pub fn quick_panel_rank_order(ranks: &[SearchRank]) -> Vec<usize> {
    let mut ordered: Vec<SearchRank> = ranks.to_vec();
    ordered.sort_by(|left, right| {
        javascript_descending(right.score, left.score)
            .then_with(|| javascript_descending(right.priority, left.priority))
    });
    ordered.into_iter().map(|rank| rank.index).collect()
}

/// Scales screenshot coordinates into viewport CSS pixels with JavaScript `Math.round` semantics.
#[must_use]
pub fn scale_screenshot_coordinates(
    x: f64,
    y: f64,
    screenshot_width: f64,
    screenshot_height: f64,
    viewport_width: f64,
    viewport_height: f64,
) -> (f64, f64) {
    if javascript_falsy_number(screenshot_width)
        || javascript_falsy_number(screenshot_height)
        || javascript_falsy_number(viewport_width)
        || javascript_falsy_number(viewport_height)
    {
        return (x, y);
    }

    (
        javascript_round(x / screenshot_width * viewport_width),
        javascript_round(y / screenshot_height * viewport_height),
    )
}

/// Returns whether a model switch changes any stored model identity field.
#[must_use]
pub fn needs_model_switch(
    current: Option<ModelSelection<'_>>,
    requested: ModelSelection<'_>,
) -> bool {
    current != Some(requested)
}

/// Small serializable model metadata record used by the ONNX host and model picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelInfo {
    /// Hugging Face identifier supplied to the retained Transformers/ONNX host.
    pub model_identifier: &'static str,
    /// Embedding width expected by the retained vector host.
    pub dimension: u32,
    /// User-visible description.
    pub description: &'static str,
    /// Model language coverage label.
    pub language: &'static str,
    /// User-visible quality label.
    pub performance: &'static str,
    /// Quantized download size label.
    pub size: &'static str,
    /// User-visible latency label.
    pub latency: &'static str,
}

/// Borrowed identity of a selected embedding model.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelSelection<'a> {
    /// Model preset key.
    pub preset: &'a str,
    /// Selected artifact version.
    pub version: &'a str,
    /// Requested embedding width.
    pub dimension: Option<f64>,
}

/// Looks up the fixed browser embedding-model metadata.
#[must_use]
pub fn model_info(preset: &str) -> Option<ModelInfo> {
    match preset {
        "multilingual-e5-small" => Some(ModelInfo {
            model_identifier: "Xenova/multilingual-e5-small",
            dimension: 384,
            description: "Multilingual E5 Small - Lightweight multilingual model supporting 100+ languages",
            language: "multilingual",
            performance: "excellent",
            size: "116MB",
            latency: "20ms",
        }),
        "multilingual-e5-base" => Some(ModelInfo {
            model_identifier: "Xenova/multilingual-e5-base",
            dimension: 768,
            description: "Multilingual E5 base - Medium-scale multilingual model supporting 100+ languages",
            language: "multilingual",
            performance: "excellent",
            size: "279MB",
            latency: "30ms",
        }),
        _ => None,
    }
}

/// Returns preset keys in the same insertion order as the former JavaScript registry.
#[must_use]
pub fn model_presets() -> [&'static str; 2] {
    ["multilingual-e5-small", "multilingual-e5-base"]
}

/// Chooses the existing language-scenario recommendation.
#[must_use]
pub fn recommend_model_for_language(scenario: &str) -> &'static str {
    if scenario == "quality" {
        "multilingual-e5-base"
    } else {
        "multilingual-e5-small"
    }
}

/// Chooses the existing device-scenario recommendation without reading browser state.
#[must_use]
pub fn recommend_model_for_device(
    device_memory: f64,
    network_speed: &str,
    prioritize_speed: bool,
) -> &'static str {
    if device_memory < 4.0 || network_speed == "slow" || prioritize_speed {
        "multilingual-e5-small"
    } else if device_memory >= 8.0 && !prioritize_speed {
        "multilingual-e5-base"
    } else {
        "multilingual-e5-small"
    }
}

/// Builds one builder default config; caller-owned random branch identifiers remain host supplied.
#[must_use]
pub fn default_config(node_type: &str, branch_id: &str) -> Value {
    match node_type {
        "trigger" => json!({ "type": "manual", "description": "" }),
        "click" => json!({ "target": { "candidates": [] } }),
        "fill" => json!({ "target": { "candidates": [] }, "value": "" }),
        "if" => json!({ "branches": [{ "id": branch_id, "name": "", "expr": "" }], "else": true }),
        "navigate" => json!({ "url": "" }),
        "wait" => json!({ "condition": { "text": "", "appear": true } }),
        "assert" => json!({ "assert": { "exists": "" } }),
        "key" => json!({ "keys": "" }),
        "delay" => json!({ "ms": 1000 }),
        "http" => json!({ "method": "GET", "url": "", "headers": {}, "body": null, "saveAs": "" }),
        "extract" => json!({ "selector": "", "attr": "text", "js": "", "saveAs": "" }),
        "screenshot" => json!({ "selector": "", "fullPage": false, "saveAs": "shot" }),
        "drag" => json!({ "start": { "candidates": [] }, "end": { "candidates": [] }, "path": [] }),
        "scroll" => {
            json!({ "mode": "offset", "offset": { "x": 0, "y": 300 }, "target": { "candidates": [] } })
        }
        "trigger_event" => {
            json!({ "target": { "candidates": [] }, "event": "input", "bubbles": true, "cancelable": false })
        }
        "set_attribute" => json!({ "target": { "candidates": [] }, "name": "", "value": "" }),
        "loop_elements" => {
            json!({ "selector": "", "saveAs": "elements", "itemVar": "item", "subflowId": "" })
        }
        "switch_frame" => json!({ "frame": { "index": 0, "urlContains": "" } }),
        "handle_download" => {
            json!({ "filenameContains": "", "waitForComplete": true, "timeoutMs": 60000, "saveAs": "download" })
        }
        "execute_flow" => json!({ "flowId": "", "inline": true, "args": {} }),
        "open_tab" => json!({ "url": "", "newWindow": false }),
        "switch_tab" => json!({ "tabId": null, "urlContains": "", "titleContains": "" }),
        "close_tab" => json!({ "tabIds": [], "url": "" }),
        "script" => json!({ "world": "ISOLATED", "code": "", "saveAs": "", "assign": {} }),
        _ => json!({}),
    }
}

/// Applies builder validation after the JavaScript host has serialized declarative node data.
#[must_use]
pub fn validate_node(node_type: &str, config: &Value) -> Vec<String> {
    let empty = Map::new();
    let config = config.as_object().unwrap_or(&empty);
    let mut errors = Vec::new();
    match node_type {
        "click" | "dblclick" | "fill" => {
            if !has_target_candidates(config) {
                errors.push("Missing target selector candidates".into());
            }
            if node_type == "fill" && !config.contains_key("value") {
                errors.push("Missing input value".into());
            }
        }
        "wait" if !truthy_value(config.get("condition")) => {
            errors.push("Missing wait condition".into())
        }
        "assert" if !truthy_value(config.get("assert")) => {
            errors.push("Missing assertion condition".into())
        }
        "navigate" if !truthy_value(config.get("url")) => errors.push("Missing URL".into()),
        "http" => {
            if !truthy_value(config.get("url")) {
                errors.push("HTTP: missing URL".into());
            }
            validate_assign(config.get("assign"), &mut errors);
        }
        "extract" => {
            if !truthy_value(config.get("saveAs")) {
                errors.push("Extract: variable name to save into is required".into());
            }
            if !truthy_value(config.get("selector")) && !truthy_value(config.get("js")) {
                errors.push("Extract: provide either a selector or js".into());
            }
        }
        "switch_tab"
            if !truthy_value(config.get("tabId"))
                && !truthy_value(config.get("urlContains"))
                && !truthy_value(config.get("titleContains")) =>
        {
            errors.push("SwitchTab: provide tabId or URL/title contains".into())
        }
        "trigger_event" => {
            if !has_target_candidates(config) {
                errors.push("Missing target selector candidates".into());
            }
            if !trimmed_string(config.get("event")) {
                errors.push("Event type is required".into());
            }
        }
        "if" => {
            let branches = config
                .get("branches")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            if branches.is_empty() {
                errors.push("Add at least one condition branch".into());
            }
            for (index, branch) in branches.iter().enumerate() {
                if !trimmed_string(branch.get("expr")) {
                    errors.push(format!(
                        "Branch {}: condition expression is required",
                        index + 1
                    ));
                }
            }
        }
        "set_attribute" => {
            if !has_target_candidates(config) {
                errors.push("Missing target selector candidates".into());
            }
            if !trimmed_string(config.get("name")) {
                errors.push("Attribute name is required".into());
            }
        }
        "loop_elements" => {
            if !trimmed_string(config.get("selector")) {
                errors.push("Element selector is required".into());
            }
            if !trimmed_string(config.get("subflowId")) {
                errors.push("Subflow ID is required".into());
            }
        }
        "execute_flow" if !trimmed_string(config.get("flowId")) => {
            errors.push("Select a workflow to execute".into())
        }
        "script" => {
            let has_assign = config
                .get("assign")
                .and_then(Value::as_object)
                .is_some_and(|values| !values.is_empty());
            if (truthy_value(config.get("saveAs")) || has_assign)
                && !trimmed_string(config.get("code"))
            {
                errors.push("Script: save/assign configured but code is missing".into());
            }
            if has_assign {
                validate_assign(config.get("assign"), &mut errors);
            }
        }
        _ => {}
    }
    errors
}

/// Detects the V3 builder flow shape without converting the caller-owned object.
#[must_use]
pub fn is_flow_v3(value: &JsonDocument) -> bool {
    value.get("schemaVersion").and_then(|field| field.as_f64()) == Some(3.0)
        && value.get("id").is_some_and(|field| field.is_string())
        && value.get("name").is_some_and(|field| field.is_string())
        && value
            .get("entryNodeId")
            .is_some_and(|field| field.is_string())
        && value.get("nodes").is_some_and(|field| field.is_array())
}

/// Detects the legacy V2 builder flow shape while preserving its omitted-schema distinction.
#[must_use]
pub fn is_flow_v2(value: &JsonDocument) -> bool {
    value.get("id").is_some_and(|field| field.is_string())
        && value.get("name").is_some_and(|field| field.is_string())
        && value
            .get("version")
            .is_some_and(|field| field.as_f64().is_some())
        && value.get("schemaVersion").is_none()
        && (value.get("steps").is_some_and(|field| field.is_array())
            || value.get("nodes").is_some_and(|field| field.is_array()))
}

/// Extracts candidate imported flows using the legacy container-order rules.
#[must_use]
pub fn extract_flow_candidates(value: &JsonDocument) -> Vec<JsonDocument> {
    if let Some(candidates) = value.clone().into_array_values() {
        return candidates;
    }
    if let Some(candidates) = value
        .get("flows")
        .and_then(|flows| flows.to_owned().into_array_values())
    {
        return candidates;
    }
    if truthy_json_ref(value.get("id"))
        && (value.get("steps").is_some_and(|field| field.is_array())
            || value.get("nodes").is_some_and(|field| field.is_array()))
    {
        return vec![value.clone()];
    }
    Vec::new()
}

fn javascript_descending(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

fn javascript_falsy_number(value: f64) -> bool {
    value == 0.0 || value.is_nan()
}

fn javascript_round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() || value == 0.0 {
        return value;
    }
    let rounded = (value + 0.5).floor();
    if rounded == 0.0 && value < 0.0 {
        -0.0
    } else {
        rounded
    }
}

fn truthy_value(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn truthy_json_ref(value: Option<JsonRef<'_>>) -> bool {
    let Some(value) = value else {
        return false;
    };
    if value.is_null() {
        return false;
    }
    if let Some(value) = value.as_bool() {
        return value;
    }
    if let Some(value) = value.as_f64() {
        return value != 0.0 && !value.is_nan();
    }
    if value.is_string() {
        return value.as_str().is_none_or(|value| !value.is_empty());
    }
    value.is_array() || value.is_object()
}

fn trimmed_string(value: Option<&Value>) -> bool {
    value
        .filter(|value| truthy_value(Some(value)))
        .is_some_and(|value| !javascript_string(value).trim().is_empty())
}

fn has_target_candidates(config: &Map<String, Value>) -> bool {
    config
        .get("target")
        .and_then(Value::as_object)
        .and_then(|target| target.get("candidates"))
        .and_then(Value::as_array)
        .is_some_and(|values| !values.is_empty())
}

fn validate_assign(value: Option<&Value>, errors: &mut Vec<String>) {
    let Some(assign) = value.and_then(Value::as_object) else {
        return;
    };
    for value in assign.values() {
        let path = javascript_string(value);
        if !is_assign_path(&path) {
            errors.push(format!("Assign: invalid path {path}"));
        }
    }
}

fn javascript_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(_) => String::new(),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn is_assign_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut position = consume_identifier(bytes, 0);
    if position == 0 {
        return false;
    }
    while position < bytes.len() {
        match bytes[position] {
            b'.' => {
                position = consume_identifier(bytes, position + 1);
                if position == 0 {
                    return false;
                }
            }
            b'[' => {
                position += 1;
                let digits_start = position;
                while position < bytes.len() && bytes[position].is_ascii_digit() {
                    position += 1;
                }
                if position == digits_start || bytes.get(position) != Some(&b']') {
                    return false;
                }
                position += 1;
            }
            _ => return false,
        }
    }
    true
}

fn consume_identifier(bytes: &[u8], mut position: usize) -> usize {
    let start = position;
    while position < bytes.len()
        && (bytes[position].is_ascii_alphanumeric() || bytes[position] == b'_')
    {
        position += 1;
    }
    if position == start { 0 } else { position }
}

#[cfg(test)]
mod tests {
    use super::{SearchRank, quick_panel_rank_order, scale_screenshot_coordinates};

    #[test]
    fn screenshot_scaling_retains_javascript_negative_zero_rounding() {
        let (x, y) = scale_screenshot_coordinates(-1.0, 1.0, 2.0, 2.0, 1.0, 1.0);
        assert_eq!(x, 0.0);
        assert!(x.is_sign_negative());
        assert_eq!(y, 1.0);
    }

    #[test]
    fn search_ranking_is_stable_after_equal_numeric_keys() {
        let order = quick_panel_rank_order(&[
            SearchRank {
                score: 2.0,
                priority: 1.0,
                index: 0,
            },
            SearchRank {
                score: 2.0,
                priority: 1.0,
                index: 1,
            },
            SearchRank {
                score: 1.0,
                priority: 9.0,
                index: 2,
            },
        ]);
        assert_eq!(order, [0, 1, 2]);
    }
}
