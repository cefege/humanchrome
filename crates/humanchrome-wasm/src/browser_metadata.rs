//! WASM boundary for browser metadata policy.
//!
//! Hosts retain Chrome rows, IndexedDB transactions, listeners, callbacks, and opaque registry
//! values. This boundary returns normalized fields or source indexes only.

use std::fmt::Write as _;

use humanchrome_core::arguments::JsString;
use humanchrome_core::browser_metadata::{
    self, MarkerMatchRecord, OwnedTabOrderRow, PaceInputPlan, PaceInputValue, ParsedMarkerUrl,
    RegistryEntry,
};
use humanchrome_core::json_document::JsonDocument;
use wasm_bindgen::prelude::*;

use crate::{error, parse_json, parse_string};

/// Normalizes stored marker URL fields around a host-native `URL` parse result.
#[wasm_bindgen]
pub fn browser_metadata_normalize_marker_url(
    raw_json: String,
    parsed_json: String,
) -> Result<String, JsValue> {
    let raw = parse_string(&raw_json)?;
    let parsed = parse_parsed_marker_url(parse_json(&parsed_json)?)?;
    Ok(marker_url_json(browser_metadata::normalize_marker_url(
        raw, parsed,
    )))
}

/// Returns matching marker indexes without moving IndexedDB-owned marker objects across WASM.
#[wasm_bindgen]
pub fn browser_metadata_matching_marker_indexes(
    markers_json: String,
    current_json: String,
) -> Result<String, JsValue> {
    let markers = parse_json(&markers_json)?
        .into_array_values()
        .ok_or_else(|| error("markers must be an array"))?
        .into_iter()
        .map(parse_marker_match_record)
        .collect::<Result<Vec<_>, _>>()?;
    let current = parse_marker_url(parse_json(&current_json)?)?;
    Ok(indexes_json(browser_metadata::matching_marker_indexes(
        &markers, &current,
    )))
}

/// Classifies a host-observed tab-operation message without serializing opaque error objects.
#[wasm_bindgen]
pub fn browser_metadata_classify_tab_error(
    message_json: String,
    tab_id_display_json: String,
) -> Result<String, JsValue> {
    let message = parse_string(&message_json)?;
    let tab_id_display = parse_optional_tab_id_display(parse_json(&tab_id_display_json)?)?;
    Ok(tab_error_plan_json(
        browser_metadata::classify_tab_error_message(message, tab_id_display.as_deref()),
    ))
}

/// Resolves the resource registry's request client key without claiming any browser tab.
#[wasm_bindgen]
pub fn browser_metadata_registry_client_key(client_id_json: String) -> Result<String, JsValue> {
    let client_id = parse_optional_string(parse_json(&client_id_json)?);
    Ok(
        JsonDocument::string(browser_metadata::resolve_registry_client_id(client_id))
            .to_json_text(),
    )
}

/// Selects host registry entries that a tab-close event must evict.
#[wasm_bindgen]
pub fn browser_metadata_registry_forget_tab_indexes(
    entries_json: String,
    tab_id: i64,
) -> Result<String, JsValue> {
    let entries = parse_registry_entries(parse_json(&entries_json)?)?;
    Ok(indexes_json(browser_metadata::registry_forget_tab_indexes(
        &entries, tab_id,
    )))
}

/// Selects host registry entries that a client-release event must evict.
#[wasm_bindgen]
pub fn browser_metadata_registry_forget_client_indexes(
    entries_json: String,
    client_id_json: String,
) -> Result<String, JsValue> {
    let entries = parse_registry_entries(parse_json(&entries_json)?)?;
    let client_id = parse_string(&client_id_json)?;
    Ok(indexes_json(
        browser_metadata::registry_forget_client_indexes(&entries, &client_id),
    ))
}

/// Plans pacing tool validation while retaining JavaScript non-finite-number distinctions.
#[wasm_bindgen]
pub fn browser_metadata_plan_pacing_input(
    profile_json: String,
    min_gap_ms_json: String,
    jitter_ms_json: String,
) -> Result<String, JsValue> {
    let plan = browser_metadata::plan_pacing_input(
        parse_pace_input_value(parse_json(&profile_json)?)?,
        parse_pace_input_value(parse_json(&min_gap_ms_json)?)?,
        parse_pace_input_value(parse_json(&jitter_ms_json)?)?,
    );
    Ok(pacing_plan_json(plan))
}

/// Returns source indexes stably sorted by window id then tab id.
#[wasm_bindgen]
pub fn browser_metadata_owned_tab_order(rows_json: String) -> Result<String, JsValue> {
    let rows = parse_json(&rows_json)?
        .into_array_values()
        .ok_or_else(|| error("owned tab rows must be an array"))?
        .into_iter()
        .map(parse_owned_tab_order_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(indexes_json(browser_metadata::stable_owned_tab_order(
        &rows,
    )))
}

fn parse_optional_tab_id_display(value: JsonDocument) -> Result<Option<String>, JsValue> {
    if value.as_ref().is_null() {
        return Ok(None);
    }
    if !value.as_ref().is_string() {
        return Err(error("tab id display must be a string or null"));
    }
    value
        .to_js_string()
        .to_string_if_well_formed()
        .ok_or_else(|| error("tab id display must be well-formed"))
        .map(Some)
}

fn parse_parsed_marker_url(value: JsonDocument) -> Result<Option<ParsedMarkerUrl>, JsValue> {
    if value.as_ref().is_null() {
        return Ok(None);
    }
    let mut value = value;
    Ok(Some(ParsedMarkerUrl {
        origin: take_required_string(&mut value, "origin")?,
        host: take_required_string(&mut value, "host")?,
        path: take_required_string(&mut value, "path")?,
    }))
}

fn parse_marker_url(mut value: JsonDocument) -> Result<browser_metadata::MarkerUrl, JsValue> {
    Ok(browser_metadata::MarkerUrl {
        url: take_required_string(&mut value, "url")?,
        origin: take_required_string(&mut value, "origin")?,
        host: take_required_string(&mut value, "host")?,
        path: take_required_string(&mut value, "path")?,
    })
}

fn parse_marker_match_record(value: JsonDocument) -> Result<Option<MarkerMatchRecord>, JsValue> {
    if !value.is_object() {
        return Ok(None);
    }
    let mut value = value;
    Ok(Some(MarkerMatchRecord {
        match_type: take_optional_string(&mut value, "matchType"),
        origin: take_optional_string(&mut value, "origin"),
        host: take_optional_string(&mut value, "host"),
        path: take_optional_string(&mut value, "path"),
    }))
}

fn parse_registry_entries(value: JsonDocument) -> Result<Vec<RegistryEntry>, JsValue> {
    value
        .into_array_values()
        .ok_or_else(|| error("registry entries must be an array"))?
        .into_iter()
        .map(|mut value| {
            Ok(RegistryEntry {
                client_id: take_required_string(&mut value, "clientId")?,
                tab_id: take_required_i64(&mut value, "tabId")?,
                value_is_defined: take_required_bool(&mut value, "valueIsDefined")?,
            })
        })
        .collect()
}

fn parse_pace_input_value(mut value: JsonDocument) -> Result<PaceInputValue, JsValue> {
    let kind = take_required_string(&mut value, "kind")?;
    match kind.as_utf8() {
        Some("undefined") => Ok(PaceInputValue::Undefined),
        Some("string") => Ok(PaceInputValue::String(take_required_string(
            &mut value, "value",
        )?)),
        Some("finite-number") => Ok(PaceInputValue::FiniteNumber(take_required_f64(
            &mut value, "value",
        )?)),
        Some("other") => Ok(PaceInputValue::Other),
        _ => Err(error("invalid pace input kind")),
    }
}

fn parse_owned_tab_order_row(mut value: JsonDocument) -> Result<OwnedTabOrderRow, JsValue> {
    Ok(OwnedTabOrderRow {
        source_index: usize::try_from(take_required_i64(&mut value, "sourceIndex")?)
            .map_err(|_| error("sourceIndex must be non-negative"))?,
        window_id: take_optional_f64(&mut value, "windowId")?,
        tab_id: take_required_f64(&mut value, "tabId")?,
    })
}

fn tab_error_plan_json(plan: browser_metadata::TabErrorPlan) -> String {
    let code = match plan.category {
        browser_metadata::TabErrorCategory::TabClosed => "TAB_CLOSED",
        browser_metadata::TabErrorCategory::Unknown => "UNKNOWN",
    };
    JsonDocument::object_lossless([
        (JsString::from_string("code"), JsonDocument::from(code)),
        (
            JsString::from_string("message"),
            JsonDocument::string(plan.message),
        ),
    ])
    .to_json_text()
}

fn marker_url_json(value: browser_metadata::MarkerUrl) -> String {
    JsonDocument::object_lossless([
        (
            JsString::from_string("url"),
            JsonDocument::string(value.url),
        ),
        (
            JsString::from_string("origin"),
            JsonDocument::string(value.origin),
        ),
        (
            JsString::from_string("host"),
            JsonDocument::string(value.host),
        ),
        (
            JsString::from_string("path"),
            JsonDocument::string(value.path),
        ),
    ])
    .to_json_text()
}

fn indexes_json(indexes: Vec<usize>) -> String {
    let mut json = String::with_capacity(indexes.len().saturating_mul(3).saturating_add(2));
    json.push('[');
    for (position, index) in indexes.into_iter().enumerate() {
        if position > 0 {
            json.push(',');
        }
        write!(json, "{index}").expect("writing an index to a String cannot fail");
    }
    json.push(']');
    json
}

fn pacing_plan_json(plan: PaceInputPlan) -> String {
    match plan {
        PaceInputPlan::Read => "{\"kind\":\"read\"}".to_owned(),
        PaceInputPlan::InvalidProfileType => "{\"kind\":\"invalidProfileType\"}".to_owned(),
        PaceInputPlan::InvalidProfileValue(profile) => JsonDocument::object_lossless([
            (
                JsString::from_string("kind"),
                JsonDocument::from("invalidProfileValue"),
            ),
            (
                JsString::from_string("profile"),
                JsonDocument::string(profile),
            ),
        ])
        .to_json_text(),
        PaceInputPlan::Set {
            profile,
            min_gap_ms,
            jitter_ms,
        } => format!(
            "{{\"kind\":\"set\",\"profile\":\"{}\",\"minGapMs\":{},\"jitterMs\":{}}}",
            profile.as_str(),
            optional_number_json(min_gap_ms),
            optional_number_json(jitter_ms),
        ),
    }
}

fn optional_number_json(value: Option<f64>) -> String {
    value.map_or_else(|| "null".to_owned(), |value| value.to_string())
}

fn take_required_string(value: &mut JsonDocument, key: &str) -> Result<JsString, JsValue> {
    let value = value
        .remove(key)
        .ok_or_else(|| error(format!("missing {key}")))?;
    if !value.as_ref().is_string() {
        return Err(error(format!("{key} must be a string")));
    }
    Ok(value.to_js_string())
}

fn take_optional_string(value: &mut JsonDocument, key: &str) -> Option<JsString> {
    let value = value.remove(key)?;
    value.as_ref().is_string().then(|| value.to_js_string())
}

fn take_required_i64(value: &mut JsonDocument, key: &str) -> Result<i64, JsValue> {
    let value = take_required_f64(value, key)?;
    (value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value <= i64::MAX as f64)
        .then_some(value as i64)
        .ok_or_else(|| error(format!("{key} must be a finite integer")))
}

fn take_required_f64(value: &mut JsonDocument, key: &str) -> Result<f64, JsValue> {
    value
        .remove(key)
        .and_then(|value| value.as_ref().as_f64())
        .filter(|value| value.is_finite())
        .ok_or_else(|| error(format!("{key} must be a finite number")))
}

fn take_optional_f64(value: &mut JsonDocument, key: &str) -> Result<Option<f64>, JsValue> {
    match value.remove(key) {
        None => Ok(None),
        Some(value) if value.as_ref().is_null() => Ok(None),
        Some(value) => value
            .as_ref()
            .as_f64()
            .filter(|value| value.is_finite())
            .map(Some)
            .ok_or_else(|| error(format!("{key} must be a finite number"))),
    }
}

fn take_required_bool(value: &mut JsonDocument, key: &str) -> Result<bool, JsValue> {
    value
        .remove(key)
        .and_then(|value| value.as_ref().as_bool())
        .ok_or_else(|| error(format!("{key} must be a boolean")))
}

fn parse_optional_string(value: JsonDocument) -> Option<JsString> {
    value.as_ref().is_string().then(|| value.to_js_string())
}
