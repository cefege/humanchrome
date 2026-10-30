//! Typed WASM bindings for portable builder and quick-panel policy.

use humanchrome_core::builder_policy::{self, ModelSelection, SearchRank};
use js_sys::{Object, Reflect};
use serde::Deserialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

fn parse_document(input: &str) -> Result<humanchrome_core::json_document::JsonDocument, JsValue> {
    crate::parse_json(input)
}

fn parse_value(input: &str) -> Result<Value, JsValue> {
    serde_json::from_str(input).map_err(crate::error)
}

fn encode<T: serde::Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(crate::error)
}

/// Decides screenshot metadata expiry while the host retains the original opaque context object.
#[wasm_bindgen]
pub fn builder_screenshot_context_expired(timestamp: f64, now: f64) -> bool {
    builder_policy::screenshot_context_expired(timestamp, now)
}

/// Returns the ordered result indexes after Rust-owned score and provider-priority ranking.
#[wasm_bindgen]
pub fn builder_quick_panel_rank_order(ranks_json: &str) -> Result<String, JsValue> {
    #[derive(Deserialize)]
    struct RankInput {
        score: f64,
        priority: f64,
        index: usize,
    }

    let ranks: Vec<RankInput> = serde_json::from_str(ranks_json).map_err(crate::error)?;
    let ranks: Vec<SearchRank> = ranks
        .into_iter()
        .map(|rank| SearchRank {
            score: rank.score,
            priority: rank.priority,
            index: rank.index,
        })
        .collect();
    encode(&builder_policy::quick_panel_rank_order(&ranks))
}

/// Applies portable screenshot-to-viewport coordinate scaling.
#[wasm_bindgen]
pub fn builder_scale_screenshot_coordinates(
    x: f64,
    y: f64,
    screenshot_width: f64,
    screenshot_height: f64,
    viewport_width: f64,
    viewport_height: f64,
) -> JsValue {
    let (x, y) = builder_policy::scale_screenshot_coordinates(
        x,
        y,
        screenshot_width,
        screenshot_height,
        viewport_width,
        viewport_height,
    );
    let coordinates = Object::new();
    Reflect::set(&coordinates, &JsValue::from_str("x"), &JsValue::from_f64(x))
        .expect("plain object accepts coordinate x");
    Reflect::set(&coordinates, &JsValue::from_str("y"), &JsValue::from_f64(y))
        .expect("plain object accepts coordinate y");
    coordinates.into()
}

/// Tests model identity changes before retained Chrome/offscreen effects begin.
#[wasm_bindgen]
pub fn builder_needs_model_switch(
    current_preset: Option<String>,
    current_version: Option<String>,
    current_dimension: Option<f64>,
    requested_preset: String,
    requested_version: String,
    requested_dimension: Option<f64>,
) -> bool {
    let requested = ModelSelection {
        preset: &requested_preset,
        version: &requested_version,
        dimension: requested_dimension,
    };
    match (current_preset, current_version) {
        (Some(preset), Some(version)) => builder_policy::needs_model_switch(
            Some(ModelSelection {
                preset: &preset,
                version: &version,
                dimension: current_dimension,
            }),
            requested,
        ),
        _ => builder_policy::needs_model_switch(None, requested),
    }
}

/// Returns a model metadata object for the retained third-party inference host.
#[wasm_bindgen]
pub fn builder_model_info(preset: &str) -> Result<String, JsValue> {
    encode(&builder_policy::model_info(preset))
}

/// Lists fixed model metadata in legacy registry insertion order.
#[wasm_bindgen]
pub fn builder_list_models() -> Result<String, JsValue> {
    let models: Vec<Value> = builder_policy::model_presets()
        .iter()
        .filter_map(|preset| {
            builder_policy::model_info(preset).map(|info| {
                serde_json::json!({
                    "preset": preset,
                    "modelIdentifier": info.model_identifier,
                    "dimension": info.dimension,
                    "description": info.description,
                    "language": info.language,
                    "performance": info.performance,
                    "size": info.size,
                    "latency": info.latency,
                    "multilingualFeatures": {
                        "languageSupport": "100+",
                        "crossLanguageRetrieval": if *preset == "multilingual-e5-small" { "good" } else { "excellent" },
                        "chineseEnglishMixed": if *preset == "multilingual-e5-small" { "good" } else { "excellent" },
                    },
                    "modelSpecificConfig": { "requiresTokenTypeIds": false },
                })
            })
        })
        .collect();
    encode(&models)
}

/// Selects the existing language scenario recommendation.
#[wasm_bindgen]
pub fn builder_recommend_model_for_language(scenario: &str) -> String {
    builder_policy::recommend_model_for_language(scenario).into()
}

/// Selects the existing device scenario recommendation.
#[wasm_bindgen]
pub fn builder_recommend_model_for_device(
    device_memory: f64,
    network_speed: &str,
    prioritize_speed: bool,
) -> String {
    builder_policy::recommend_model_for_device(device_memory, network_speed, prioritize_speed)
        .into()
}

/// Returns Rust-owned default configuration while the host retains random id generation.
#[wasm_bindgen]
pub fn builder_default_config(node_type: &str, branch_id: &str) -> Result<String, JsValue> {
    encode(&builder_policy::default_config(node_type, branch_id))
}

/// Validates a serialized declarative builder node configuration.
#[wasm_bindgen]
pub fn builder_validate_node(node_type: &str, config_json: &str) -> Result<String, JsValue> {
    let config = parse_value(config_json)?;
    encode(&builder_policy::validate_node(node_type, &config))
}

/// Detects a JSON-shaped V3 flow before the caller selects a conversion path.
#[wasm_bindgen]
pub fn builder_is_flow_v3(value_json: &str) -> Result<bool, JsValue> {
    Ok(builder_policy::is_flow_v3(&parse_document(value_json)?))
}

/// Detects a JSON-shaped legacy V2 flow before the caller selects a conversion path.
#[wasm_bindgen]
pub fn builder_is_flow_v2(value_json: &str) -> Result<bool, JsValue> {
    Ok(builder_policy::is_flow_v2(&parse_document(value_json)?))
}

/// Extracts candidate flow values from a parsed import payload.
#[wasm_bindgen]
pub fn builder_extract_flow_candidates(value_json: &str) -> Result<String, JsValue> {
    let candidates = builder_policy::extract_flow_candidates(&parse_document(value_json)?);
    let mut output = String::from("[");
    for (index, candidate) in candidates.iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        output.push_str(&candidate.to_json_text());
    }
    output.push(']');
    Ok(output)
}
