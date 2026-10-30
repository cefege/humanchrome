//! WASM boundary for portable web-editor policy.
//!
//! DOM, CSSOM, Canvas, and browser-native color resolution stay in TypeScript. This module only
//! transports complete, JSON-serializable batches to the Rust policy once per operation.

use wasm_bindgen::prelude::*;

use humanchrome_core::editor_policy::{
    self, CssCompareInput, DistanceLabelsInput, FingerprintRankInput, SnapAnchors, SnapFrameInput,
    SnapInput, SnapState,
};

use crate::{error, parse_json, parse_string};

fn snap_result_to_js(result: &editor_policy::SnapResult) -> Result<JsValue, JsValue> {
    let output = js_sys::Object::new();
    let lock_x = result.lock_x.as_ref().map_or(Ok(JsValue::NULL), |lock| {
        serde_wasm_bindgen::to_value(lock).map_err(error)
    })?;
    let lock_y = result.lock_y.as_ref().map_or(Ok(JsValue::NULL), |lock| {
        serde_wasm_bindgen::to_value(lock).map_err(error)
    })?;
    for (key, value) in [
        (
            "snappedRect",
            serde_wasm_bindgen::to_value(&result.snapped_rect).map_err(error)?,
        ),
        (
            "guideLines",
            serde_wasm_bindgen::to_value(&result.guide_lines).map_err(error)?,
        ),
        ("lockX", lock_x),
        ("lockY", lock_y),
    ] {
        js_sys::Reflect::set(&output, &JsValue::from_str(key), &value)?;
    }
    Ok(output.into())
}

/// Stateful snap policy retaining one DOM-collected anchor batch for a resize gesture.
#[wasm_bindgen]
pub struct RustEditorSnapState {
    state: SnapState,
}

#[wasm_bindgen]
impl RustEditorSnapState {
    /// Creates an empty gesture state.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: SnapState::default(),
        }
    }

    /// Stores one DOM-collected anchor batch and clears the previous gesture locks.
    pub fn set_targets(&mut self, anchors: JsValue) -> Result<(), JsValue> {
        let anchors: SnapAnchors = serde_wasm_bindgen::from_value(anchors).map_err(error)?;
        self.state.set_targets(anchors);
        Ok(())
    }

    /// Computes one frame using retained anchors and locks without a JSON round trip.
    pub fn compute(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
        let input: SnapFrameInput = serde_wasm_bindgen::from_value(input).map_err(error)?;
        snap_result_to_js(&self.state.compute(input))
    }

    /// Computes labels from the retained locks without copying the anchor collection.
    pub fn distance_labels(&self, input: JsValue) -> Result<JsValue, JsValue> {
        let input: DistanceLabelsInput = serde_wasm_bindgen::from_value(input).map_err(error)?;
        serde_wasm_bindgen::to_value(&self.state.distance_labels(
            input.rect,
            input.viewport,
            input.min_gap_px,
        ))
        .map_err(error)
    }
}

/// Normalizes one browser-read property name for inheritance and shorthand lookup.
#[wasm_bindgen]
pub fn editor_normalize_css_property(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    Ok(json_string(&editor_policy::normalize_property(
        value
            .as_utf8()
            .ok_or_else(|| error("CSS property must be UTF-8"))?,
    )))
}

/// Tests the editor's curated CSS inheritance metadata.
#[wasm_bindgen]
pub fn editor_is_inheritable_property(value_json: String) -> Result<bool, JsValue> {
    let value = parse_string(&value_json)?;
    Ok(editor_policy::is_inheritable_property(
        value
            .as_utf8()
            .ok_or_else(|| error("CSS property must be UTF-8"))?,
    ))
}

/// Expands one normalized shorthand using the editor's cascade metadata.
#[wasm_bindgen]
pub fn editor_expand_css_shorthand(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    serde_json::to_string(&editor_policy::expand_to_longhands(
        value
            .as_utf8()
            .ok_or_else(|| error("CSS property must be UTF-8"))?,
    ))
    .map_err(error)
}

/// Computes a complete stateless snap operation for the compatibility facade.
#[wasm_bindgen]
pub fn editor_compute_snap(input: JsValue) -> Result<JsValue, JsValue> {
    let input: SnapInput = serde_wasm_bindgen::from_value(input).map_err(error)?;
    snap_result_to_js(&editor_policy::compute_snap(input))
}

/// Computes a complete stateless distance-label operation for the compatibility facade.
#[wasm_bindgen]
pub fn editor_compute_snap_distance_labels(input: JsValue) -> Result<JsValue, JsValue> {
    let input: DistanceLabelsInput = serde_wasm_bindgen::from_value(input).map_err(error)?;
    serde_wasm_bindgen::to_value(&editor_policy::compute_snap_distance_labels(input)).map_err(error)
}

/// Compares pre-read computed CSS maps with the editor's numeric tolerance policy.
#[wasm_bindgen]
pub fn editor_compare_computed(input_json: String) -> Result<String, JsValue> {
    let input: CssCompareInput = serde_json::from_str(&input_json).map_err(error)?;
    serde_json::to_string(&editor_policy::compare_computed(input)).map_err(error)
}

/// Normalizes one browser-read CSS value using the same policy as computed-map comparison.
#[wasm_bindgen]
pub fn editor_normalize_css_value(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    Ok(json_string(&editor_policy::normalize_css_value(
        value
            .as_utf8()
            .ok_or_else(|| error("CSS value must be UTF-8"))?,
    )))
}

/// Compares source order without serializing JavaScript numeric values through JSON.
#[wasm_bindgen]
pub fn editor_compare_source_order(left: JsValue, right: JsValue) -> Result<i32, JsValue> {
    let left: [f64; 3] = serde_wasm_bindgen::from_value(left).map_err(error)?;
    let right: [f64; 3] = serde_wasm_bindgen::from_value(right).map_err(error)?;
    Ok(editor_policy::compare_order(&left, &right))
}

/// Compares host-collected CSS cascade metadata.
#[wasm_bindgen]
pub fn editor_compare_cascade(left: JsValue, right: JsValue) -> Result<i32, JsValue> {
    let left: editor_policy::CascadeRank = serde_wasm_bindgen::from_value(left).map_err(error)?;
    let right: editor_policy::CascadeRank = serde_wasm_bindgen::from_value(right).map_err(error)?;
    Ok(editor_policy::compare_cascade(&left, &right))
}

/// Resolves all longhand winners in one metadata batch, retaining JS candidate identities.
#[wasm_bindgen]
pub fn editor_cascade_overrides(candidates: JsValue) -> Result<JsValue, JsValue> {
    let candidates: Vec<editor_policy::CascadeCandidate> =
        serde_wasm_bindgen::from_value(candidates).map_err(error)?;
    serde_wasm_bindgen::to_value(&editor_policy::cascade_overrides(&candidates)).map_err(error)
}

/// Normalizes display text using the same policy as editor comparisons.
#[wasm_bindgen]
pub fn editor_normalize_text(value_json: String) -> Result<String, JsValue> {
    Ok(json_string(&editor_policy::normalize_text(
        parse_string(&value_json)?
            .as_utf8()
            .ok_or_else(|| error("text must be UTF-8"))?,
    )))
}

/// Formats a custom-property reference without crossing into CSSOM.
#[wasm_bindgen]
pub fn editor_format_css_var(name_json: String, fallback_json: String) -> Result<String, JsValue> {
    let name = parse_string(&name_json)?;
    let fallback = parse_json(&fallback_json)?;
    let fallback = fallback.into_string_value().ok();
    let fallback = fallback.as_ref().and_then(|value| value.as_utf8());
    Ok(json_string(&editor_policy::format_css_var(
        name.as_utf8().ok_or_else(|| error("name must be UTF-8"))?,
        fallback,
    )))
}

/// Parses one standalone custom-property expression.
#[wasm_bindgen]
pub fn editor_parse_css_var(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    let parsed = editor_policy::parse_css_var(
        value
            .as_utf8()
            .ok_or_else(|| error("value must be UTF-8"))?,
    );
    serde_json::to_string(&parsed).map_err(error)
}

/// Extracts custom-property names from arbitrary CSS text.
#[wasm_bindgen]
pub fn editor_extract_css_var_names(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    serde_json::to_string(&editor_policy::extract_css_var_names(
        value
            .as_utf8()
            .ok_or_else(|| error("value must be UTF-8"))?,
    ))
    .map_err(error)
}

/// Scores a host-collected HMR candidate fingerprint.
#[wasm_bindgen]
pub fn editor_score_fingerprint_candidate(input_json: String) -> Result<Option<f64>, JsValue> {
    let input: FingerprintRankInput = serde_json::from_str(&input_json).map_err(error)?;
    Ok(editor_policy::score_fingerprint_candidate(&input))
}

/// Parses a hexadecimal gradient-stop color.
#[wasm_bindgen]
pub fn editor_parse_hex_color(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    serde_json::to_string(&editor_policy::parse_hex_color(
        value
            .as_utf8()
            .ok_or_else(|| error("color must be UTF-8"))?,
    ))
    .map_err(error)
}

/// Parses an RGB or RGBA gradient-stop color.
#[wasm_bindgen]
pub fn editor_parse_rgb_color(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    serde_json::to_string(&editor_policy::parse_rgb_color(
        value
            .as_utf8()
            .ok_or_else(|| error("color must be UTF-8"))?,
    ))
    .map_err(error)
}

/// Formats an RGBA value for authored CSS.
#[wasm_bindgen]
pub fn editor_rgba_to_css(color_json: String) -> Result<String, JsValue> {
    let color = serde_json::from_str(&color_json).map_err(error)?;
    Ok(json_string(&editor_policy::rgba_to_css(color)))
}

/// Interpolates two gradient-stop colors.
#[wasm_bindgen]
pub fn editor_interpolate_rgba(
    left_json: String,
    right_json: String,
    t: f64,
) -> Result<String, JsValue> {
    let left = serde_json::from_str(&left_json).map_err(error)?;
    let right = serde_json::from_str(&right_json).map_err(error)?;
    serde_json::to_string(&editor_policy::interpolate_rgba(left, right, t)).map_err(error)
}

/// Normalizes one parsed gradient-stop collection.
#[wasm_bindgen]
pub fn editor_normalize_gradient_stops(stops_json: String) -> Result<String, JsValue> {
    let stops: Vec<editor_policy::ParsedGradientStop> =
        serde_json::from_str(&stops_json).map_err(error)?;
    serde_json::to_string(&editor_policy::normalize_gradient_stops(&stops)).map_err(error)
}

/// Associates inline and computed gradient stops by nearest position.
#[wasm_bindgen]
pub fn editor_gradient_placeholder_mapping(
    inline_json: String,
    computed_json: String,
) -> Result<String, JsValue> {
    let inline: Vec<editor_policy::GradientStop> =
        serde_json::from_str(&inline_json).map_err(error)?;
    let computed: Vec<editor_policy::GradientStop> =
        serde_json::from_str(&computed_json).map_err(error)?;
    serde_json::to_string(&editor_policy::gradient_placeholder_mapping(
        &inline, &computed,
    ))
    .map_err(error)
}

/// Parses the first box-shadow expression without browser color resolution.
#[wasm_bindgen]
pub fn editor_parse_box_shadow(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    serde_json::to_string(&editor_policy::parse_box_shadow(
        value
            .as_utf8()
            .ok_or_else(|| error("shadow must be UTF-8"))?,
    ))
    .map_err(error)
}

/// Normalizes one effects-control length.
#[wasm_bindgen]
pub fn editor_normalize_length(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    Ok(json_string(&editor_policy::normalize_editor_length(
        value
            .as_utf8()
            .ok_or_else(|| error("length must be UTF-8"))?,
    )))
}

/// Finds a named CSS function while preserving quoted and escaped arguments.
#[wasm_bindgen]
pub fn editor_find_css_function(value_json: String, name_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    let name = parse_string(&name_json)?;
    serde_json::to_string(&editor_policy::find_css_function(
        value
            .as_utf8()
            .ok_or_else(|| error("value must be UTF-8"))?,
        name.as_utf8().ok_or_else(|| error("name must be UTF-8"))?,
    ))
    .map_err(error)
}

/// Splits an authored CSS value at top-level separators.
#[wasm_bindgen]
pub fn editor_split_css_top_level(
    value_json: String,
    separator_json: String,
) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    let separator = parse_string(&separator_json)?;
    let separator = separator
        .as_utf8()
        .and_then(|separator| separator.chars().next())
        .ok_or_else(|| error("separator must be one character"))?;
    serde_json::to_string(&editor_policy::split_css_top_level(
        value
            .as_utf8()
            .ok_or_else(|| error("value must be UTF-8"))?,
        separator,
    ))
    .map_err(error)
}

/// Tokenizes an authored CSS value at top-level whitespace.
#[wasm_bindgen]
pub fn editor_tokenize_css_top_level(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    serde_json::to_string(&editor_policy::tokenize_css_top_level(
        value
            .as_utf8()
            .ok_or_else(|| error("value must be UTF-8"))?,
    ))
    .map_err(error)
}

/// Compares two CSS specificity tuples.
#[wasm_bindgen]
pub fn editor_compare_specificity(left_json: String, right_json: String) -> Result<i64, JsValue> {
    let left = serde_json::from_str(&left_json).map_err(error)?;
    let right = serde_json::from_str(&right_json).map_err(error)?;
    Ok(editor_policy::compare_specificity(left, right))
}

/// Splits a selector list with the Rust CSS grammar scanner.
#[wasm_bindgen]
pub fn editor_split_selector_list(value_json: String) -> Result<String, JsValue> {
    let value = parse_string(&value_json)?;
    serde_json::to_string(&editor_policy::split_selector_list(
        value
            .as_utf8()
            .ok_or_else(|| error("selector must be UTF-8"))?,
    ))
    .map_err(error)
}

/// Computes the complete editor specificity grammar without replacing JavaScript code units.
#[wasm_bindgen]
pub fn editor_compute_specificity(value_json: String) -> Result<String, JsValue> {
    let units = parse_string(&value_json)?.into_utf16_units();
    serde_json::to_string(&editor_policy::compute_specificity(&units)).map_err(error)
}

/// Selects the first highest-specificity member of a host-matched selector collection.
#[wasm_bindgen]
pub fn editor_matched_specificity(selectors_json: String) -> Result<String, JsValue> {
    let selectors = parse_json(&selectors_json)?
        .into_array_values()
        .ok_or_else(|| error("matched selectors must be an array"))?;
    let mut selection = editor_policy::SpecificitySelection::default();
    for (index, selector) in selectors.into_iter().enumerate() {
        let units = selector
            .into_string_value()
            .map_err(|_| error("matched selector must be a string"))?
            .into_utf16_units();
        selection.consider(index, &units);
    }
    serde_json::to_string(&selection.finish()).map_err(error)
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("serializing a string cannot fail")
}
