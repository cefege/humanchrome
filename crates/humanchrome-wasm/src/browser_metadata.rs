//! WASM boundary for browser metadata policy.
//!
//! Hosts retain Chrome rows, IndexedDB transactions, listeners, callbacks, and opaque registry
//! values. This boundary returns normalized fields or source indexes only.

use std::fmt::Write as _;

use humanchrome_core::arguments::JsString;
use humanchrome_core::browser_metadata::{
    self, CloseTabCandidate, CloseTabMatchField, CloseTabMatcher, MarkerMatchRecord,
    NavigationCandidate, NavigationUrlFacts, OwnedTabOrderRow, PaceInputPlan, PaceInputValue,
    ParsedMarkerUrl, RegistryEntry,
};
use humanchrome_core::json_document::JsonDocument;
use js_sys::{Array, Function, Reflect};
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::{error, intrinsics, parse_json, parse_string};

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

/// Expands a navigation URL into existing Chrome query patterns using host-observed URL facts.
#[wasm_bindgen]
pub fn browser_metadata_navigation_url_patterns(
    input_json: String,
    parsed_json: String,
) -> Result<String, JsValue> {
    let input = parse_string(&input_json)?;
    let parsed = parse_navigation_url_facts(parse_json(&parsed_json)?)?;
    Ok(js_string_array_json(
        browser_metadata::navigation_url_patterns(input, parsed.as_ref()),
    ))
}

/// Selects the best existing navigation candidate index without moving Chrome tab objects.
#[wasm_bindgen]
pub fn browser_metadata_pick_navigation_candidate(
    target_json: String,
    candidates_json: String,
) -> Result<String, JsValue> {
    let target = parse_navigation_url_facts(parse_json(&target_json)?)?;
    let candidates = parse_json(&candidates_json)?
        .into_array_values()
        .ok_or_else(|| error("navigation candidates must be an array"))?
        .into_iter()
        .enumerate()
        .map(|(source_index, value)| {
            Ok(NavigationCandidate {
                source_index,
                parsed: parse_navigation_url_facts(value)?,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    Ok(optional_index_json(
        browser_metadata::pick_best_navigation_candidate(target.as_ref(), &candidates),
    ))
}

/// Selects host-owned tab indexes for close-tab filters using native JavaScript matching intrinsics.
#[wasm_bindgen]
pub fn browser_metadata_close_tab_match_indexes(
    filters_json: String,
    candidates_json: String,
    except_tab_ids_json: String,
    now_ms: f64,
) -> Result<String, JsValue> {
    let ParsedCloseTabFilters {
        url_match,
        title_match,
        older_than_ms,
    } = parse_close_tab_filters(parse_json(&filters_json)?)?;
    let Some(plan) =
        browser_metadata::plan_close_tab_filters(url_match, title_match, older_than_ms)
    else {
        return Ok("{\"kind\":\"invalid\"}".to_owned());
    };
    let candidates = parse_json(&candidates_json)?
        .into_array_values()
        .ok_or_else(|| error("close-tab candidates must be an array"))?
        .into_iter()
        .enumerate()
        .map(|(source_index, value)| parse_close_tab_candidate(value, source_index))
        .collect::<Result<Vec<_>, JsValue>>()?;
    let except_tab_ids = parse_close_tab_except_ids(parse_json(&except_tab_ids_json)?);
    let mut url_matcher = plan
        .url_matcher
        .as_ref()
        .map(compile_js_matcher)
        .transpose()?;
    let mut title_matcher = plan
        .title_matcher
        .as_ref()
        .map(compile_js_matcher)
        .transpose()?;
    let indexes = browser_metadata::select_close_tab_indexes(
        &plan,
        &candidates,
        &except_tab_ids,
        now_ms,
        |field, _, value| match field {
            CloseTabMatchField::Url => url_matcher
                .as_mut()
                .is_some_and(|matcher| matcher.matches(value)),
            CloseTabMatchField::Title => title_matcher
                .as_mut()
                .is_some_and(|matcher| matcher.matches(value)),
        },
    );
    Ok(close_tab_selection_json(indexes))
}

fn parse_navigation_url_facts(value: JsonDocument) -> Result<Option<NavigationUrlFacts>, JsValue> {
    if value.as_ref().is_null() {
        return Ok(None);
    }
    let mut value = value;
    Ok(Some(NavigationUrlFacts {
        protocol: take_required_string(&mut value, "protocol")?,
        host: take_required_string(&mut value, "host")?,
        hostname: take_required_string(&mut value, "hostname")?,
        pathname: take_required_string(&mut value, "pathname")?,
        search: take_required_string(&mut value, "search")?,
    }))
}

#[derive(Debug)]
struct ParsedCloseTabFilters {
    url_match: Option<JsString>,
    title_match: Option<JsString>,
    older_than_ms: Option<f64>,
}

fn parse_close_tab_filters(mut value: JsonDocument) -> Result<ParsedCloseTabFilters, JsValue> {
    Ok(ParsedCloseTabFilters {
        url_match: take_trimmed_optional_string(&mut value, "urlMatches")?,
        title_match: take_trimmed_optional_string(&mut value, "titleMatches")?,
        older_than_ms: take_nonnegative_optional_number(&mut value, "olderThanMs"),
    })
}

fn parse_close_tab_candidate(
    mut value: JsonDocument,
    source_index: usize,
) -> Result<CloseTabCandidate, JsValue> {
    Ok(CloseTabCandidate {
        source_index,
        tab_id: take_js_optional_number(&mut value, "id"),
        url: take_required_string(&mut value, "url")?,
        title: take_required_string(&mut value, "title")?,
        created_at: take_js_optional_number(&mut value, "createdAt"),
    })
}

fn parse_close_tab_except_ids(value: JsonDocument) -> Vec<f64> {
    value
        .into_array_values()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_ref().as_f64())
        .collect()
}

fn take_trimmed_optional_string(
    value: &mut JsonDocument,
    key: &str,
) -> Result<Option<JsString>, JsValue> {
    let Some(value) = value.remove(key) else {
        return Ok(None);
    };
    if !value.as_ref().is_string() {
        return Ok(None);
    }
    let trimmed = js_trim(value.to_js_string())?;
    Ok((trimmed.utf16_len() > 0).then_some(trimmed))
}

fn take_nonnegative_optional_number(value: &mut JsonDocument, key: &str) -> Option<f64> {
    value
        .remove(key)
        .and_then(|value| value.as_ref().as_f64())
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn take_js_optional_number(value: &mut JsonDocument, key: &str) -> Option<f64> {
    value.remove(key).and_then(|value| value.as_ref().as_f64())
}

enum JsCloseTabMatcher {
    Regex(JsValue),
    Substring(JsValue),
}

impl JsCloseTabMatcher {
    fn matches(&mut self, value: &JsString) -> bool {
        let value = core_js_value(value);
        match self {
            Self::Regex(regexp) => call_method(regexp, "test", Some(&value))
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            Self::Substring(needle) => {
                let Ok(value) = call_string_method(&value, "toLowerCase", None) else {
                    return false;
                };
                call_string_method(&value, "includes", Some(needle))
                    .ok()
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            }
        }
    }
}

fn compile_js_matcher(plan: &CloseTabMatcher) -> Result<JsCloseTabMatcher, JsValue> {
    match plan {
        CloseTabMatcher::Substring { needle } => {
            let needle = call_string_method(&core_js_value(needle), "toLowerCase", None)?;
            Ok(JsCloseTabMatcher::Substring(needle))
        }
        CloseTabMatcher::Regex { pattern, flags } => {
            let arguments = Array::new();
            arguments.push(&core_js_value(pattern));
            arguments.push(&core_js_value(flags));
            let constructor = global_function("RegExp")?;
            match Reflect::construct(&constructor, &arguments) {
                Ok(regexp) => Ok(JsCloseTabMatcher::Regex(regexp)),
                Err(_) => {
                    let needle = call_string_method(&core_js_value(pattern), "toLowerCase", None)?;
                    Ok(JsCloseTabMatcher::Substring(needle))
                }
            }
        }
    }
}

fn js_trim(value: JsString) -> Result<JsString, JsValue> {
    js_value_to_core_string(call_string_method(&core_js_value(&value), "trim", None)?)
}

fn core_js_value(value: &JsString) -> JsValue {
    intrinsics::to_js_string(value).into()
}

fn js_value_to_core_string(value: JsValue) -> Result<JsString, JsValue> {
    let value = value
        .dyn_into::<js_sys::JsString>()
        .map_err(|_| error("string intrinsic returned a non-string"))?;
    Ok(intrinsics::from_js_string(&value))
}

fn global_function(name: &str) -> Result<Function, JsValue> {
    Reflect::get(&js_sys::global(), &JsValue::from_str(name))?
        .dyn_into::<Function>()
        .map_err(|_| error(format!("global {name} is not callable")))
}

fn call_string_method(
    value: &JsValue,
    method: &str,
    argument: Option<&JsValue>,
) -> Result<JsValue, JsValue> {
    let constructor = global_function("String")?;
    let prototype = Reflect::get(&constructor, &JsValue::from_str("prototype"))?;
    let method = Reflect::get(&prototype, &JsValue::from_str(method))?
        .dyn_into::<Function>()
        .map_err(|_| error("String intrinsic is not callable"))?;
    match argument {
        Some(argument) => method.call1(value, argument),
        None => method.call0(value),
    }
}

fn call_method(
    target: &JsValue,
    method: &str,
    argument: Option<&JsValue>,
) -> Result<JsValue, JsValue> {
    let method = Reflect::get(target, &JsValue::from_str(method))?
        .dyn_into::<Function>()
        .map_err(|_| error("host method is not callable"))?;
    match argument {
        Some(argument) => method.call1(target, argument),
        None => method.call0(target),
    }
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

fn js_string_array_json(values: Vec<JsString>) -> String {
    let mut json = String::with_capacity(values.len().saturating_mul(16).saturating_add(2));
    json.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push_str(&value.json_string_literal());
    }
    json.push(']');
    json
}

fn optional_index_json(index: Option<usize>) -> String {
    index.map_or_else(|| "null".to_owned(), |index| index.to_string())
}

fn close_tab_selection_json(indexes: Vec<usize>) -> String {
    format!(
        "{{\"kind\":\"selected\",\"indexes\":{}}}",
        indexes_json(indexes)
    )
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
