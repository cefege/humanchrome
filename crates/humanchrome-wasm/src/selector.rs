//! WASM boundary for batch selector ranking and pure locator policy.
//!
//! The host supplies complete candidate batches once. Results refer back to candidate indexes and
//! patches so opaque caller metadata and object identity remain in TypeScript.

use js_sys::JsString as WebString;
use wasm_bindgen::prelude::*;

use humanchrome_core::arguments::JsString;
use humanchrome_core::json_document::JsonDocument;
use humanchrome_core::selector::{
    self, CssEscapeFallbackMode, FingerprintInput, FingerprintOptions, PrefixedSelectorKind,
    SelectorCandidate, SelectorCandidateSource, SelectorGenerationOptions, SelectorStability,
    SelectorTarget, SelectorType, TextMatchMode,
};

use crate::{error, parse_json, parse_string};

mod action_target;

/// Normalizes DOM-observed names without changing the host's synchronous API.
#[wasm_bindgen]
pub fn selector_normalize_accessible_name(value: WebString) -> WebString {
    let value = crate::intrinsics::from_js_string(&value);
    crate::intrinsics::to_js_string(&selector::normalize_accessible_name(&value))
}

/// Matches strings using core policy and the browser's native Unicode lowercase intrinsic.
#[wasm_bindgen]
pub fn selector_matches_accessible_name(
    computed: WebString,
    target: WebString,
    mode: &str,
) -> bool {
    let mode = match mode {
        "exact" => selector::AccessibleNameMatchMode::Exact,
        "iexact" => selector::AccessibleNameMatchMode::InsensitiveExact,
        _ => selector::AccessibleNameMatchMode::Contains,
    };
    selector::matches_accessible_name(
        &crate::intrinsics::from_js_string(&computed),
        &crate::intrinsics::from_js_string(&target),
        mode,
        crate::intrinsics::lower_case,
    )
}

/// Builds the legacy ARIA fallback queries without browser handles or UTF-16 replacement.
#[wasm_bindgen]
pub fn selector_legacy_aria_selectors(value_json: String) -> Result<String, JsValue> {
    let selectors = selector::legacy_aria_selectors(parse_string(&value_json)?);
    Ok(JsonDocument::array(selectors.into_iter().map(JsonDocument::string)).to_json_text())
}

/// Ranks one raw candidate collection, crossing the WASM boundary only once.
#[wasm_bindgen]
pub fn selector_rank(
    candidates_json: String,
    options_json: String,
    tag_name_json: String,
) -> Result<String, JsValue> {
    let raw_documents = parse_json(&candidates_json)?
        .into_array_values()
        .ok_or_else(|| error("candidates must be an array"))?;
    let raw = raw_documents
        .into_iter()
        .map(parse_candidate)
        .collect::<Result<Vec<_>, _>>()?;
    let options = selector::normalize_selector_generation_options(Some(&parse_generation_options(
        parse_json(&options_json)?,
    )?));
    let tag_name = optional_js_string(parse_json(&tag_name_json)?)?;
    let target = selector::rank_candidates(raw.clone(), &options, tag_name);
    let mut consumed = vec![false; raw.len()];
    let indexes = target
        .candidates
        .iter()
        .map(|candidate| {
            let key = selector::candidate_key(candidate);
            let index = raw.iter().enumerate().find_map(|(index, raw_candidate)| {
                (!consumed[index] && selector::candidate_key(raw_candidate) == key).then_some(index)
            });
            if let Some(index) = index {
                consumed[index] = true;
                index as i64
            } else {
                -1
            }
        })
        .collect::<Vec<_>>();
    let patches = target
        .candidates
        .iter()
        .zip(indexes.iter())
        .map(|(candidate, index)| {
            candidate_patch_json(
                usize::try_from(*index)
                    .ok()
                    .and_then(|index| raw.get(index)),
                candidate,
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "{{\"candidateIndexes\":[{}],\"patches\":[{patches}],\"selector\":{},\"tagName\":{},\"fallback\":{}}}",
        indexes
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(","),
        json_string(&target.selector),
        optional_js_json(target.tag_name.as_ref()),
        indexes.first() == Some(&-1)
    ))
}

/// Stably reorders a complete persisted candidate collection without deduplicating or truncating.
#[wasm_bindgen]
pub fn selector_sort(candidates_json: String) -> Result<String, JsValue> {
    let raw = parse_json(&candidates_json)?
        .into_array_values()
        .ok_or_else(|| error("candidates must be an array"))?
        .into_iter()
        .map(parse_candidate)
        .collect::<Result<Vec<_>, _>>()?;
    let sorted = selector::sort_selector_candidates(raw.clone());
    let mut consumed = vec![false; raw.len()];
    let indexes = sorted
        .iter()
        .map(|candidate| {
            let key = selector::candidate_key(candidate);
            let index = raw.iter().enumerate().find_map(|(index, raw_candidate)| {
                (!consumed[index] && selector::candidate_key(raw_candidate) == key).then_some(index)
            });
            if let Some(index) = index {
                consumed[index] = true;
                index as i64
            } else {
                -1
            }
        })
        .collect::<Vec<_>>();
    let patches = sorted
        .iter()
        .zip(indexes.iter())
        .map(|(candidate, index)| {
            candidate_patch_json(
                usize::try_from(*index)
                    .ok()
                    .and_then(|index| raw.get(index)),
                candidate,
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "{{\"candidateIndexes\":[{}],\"patches\":[{patches}]}}",
        indexes
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(","),
    ))
}

/// Applies the current selector comparator to two candidate JSON values for legacy callers.
#[wasm_bindgen]
pub fn selector_compare(left_json: String, right_json: String) -> Result<f64, JsValue> {
    Ok(selector::compare_selector_candidates(
        &parse_candidate(parse_json(&left_json)?)?,
        &parse_candidate(parse_json(&right_json)?)?,
    ))
}
/// Computes one candidate's stability patch.
#[wasm_bindgen]
pub fn selector_stability(candidate_json: String) -> Result<String, JsValue> {
    Ok(stability_json(&selector::compute_selector_stability(
        &parse_candidate(parse_json(&candidate_json)?)?,
    )))
}
/// Produces the exact deduplication key for a candidate.
#[wasm_bindgen]
pub fn selector_candidate_key(candidate_json: String) -> Result<String, JsValue> {
    Ok(json_string(&selector::candidate_key(&parse_candidate(
        parse_json(&candidate_json)?,
    )?)))
}
/// Resolves generator defaults and numeric clamps.
#[wasm_bindgen]
pub fn selector_normalize_options(options_json: String) -> Result<String, JsValue> {
    normalized_options_json(&selector::normalize_selector_generation_options(Some(
        &parse_generation_options(parse_json(&options_json)?)?,
    )))
}

/// Applies a Rust-owned compatibility escape when the host lacks native `CSS.escape`.
#[wasm_bindgen]
pub fn selector_css_escape_fallback(
    value_json: String,
    mode_json: String,
) -> Result<String, JsValue> {
    let mode = match parse_string(&mode_json)?.as_utf8() {
        Some("identifier") => CssEscapeFallbackMode::Identifier,
        Some("testid-attribute") => CssEscapeFallbackMode::TestIdAttributeValue,
        _ => return Err(error("unknown CSS escape fallback mode")),
    };
    Ok(json_string(&selector::css_escape_fallback(
        &parse_string(&value_json)?,
        mode,
    )))
}

/// Returns a DOM collection plan for the web-editor locator adapter.
#[wasm_bindgen]
pub fn selector_editor_locator_plan(
    max_candidates_json: String,
    anchor_available: bool,
) -> Result<String, JsValue> {
    let plan = selector::editor_locator_plan(
        optional_number(parse_json(&max_candidates_json)?)?,
        anchor_available,
    );
    Ok(editor_locator_plan_json(&plan))
}

/// Returns eligible class indexes for the web-editor locator DOM adapter.
#[wasm_bindgen]
pub fn selector_editor_locator_class_indexes(classes_json: String) -> Result<String, JsValue> {
    let classes = string_array(parse_json(&classes_json)?)?;
    Ok(format!(
        "[{}]",
        selector::editor_locator_class_indexes(&classes)
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",")
    ))
}

/// Selects one complete web-editor locator candidate batch.
#[wasm_bindgen]
pub fn selector_editor_locator_select(
    head_candidates_json: String,
    path_candidate_json: String,
    anchor_candidate_json: String,
    max_candidates_json: String,
) -> Result<String, JsValue> {
    let head_candidates = string_array(parse_json(&head_candidates_json)?)?;
    let path_candidate = optional_js_string(parse_json(&path_candidate_json)?)?;
    let anchor_candidate = optional_js_string(parse_json(&anchor_candidate_json)?)?;
    let max_candidates = optional_number(parse_json(&max_candidates_json)?)?;
    Ok(format!(
        "[{}]",
        selector::select_editor_locator_candidates(
            head_candidates,
            path_candidate,
            anchor_candidate,
            max_candidates,
        )
        .iter()
        .map(json_string)
        .collect::<Vec<_>>()
        .join(",")
    ))
}
/// Splits a composite selector into frame and inner components, or returns JSON null.
#[wasm_bindgen]
pub fn selector_split_composite(selector_json: String) -> Result<String, JsValue> {
    Ok(
        selector::split_composite_selector(&parse_string(&selector_json)?)
            .map(|parts| {
                format!(
                    "{{\"frameSelector\":{},\"innerSelector\":{}}}",
                    json_string(&parts.frame_selector),
                    json_string(&parts.inner_selector)
                )
            })
            .unwrap_or_else(|| "null".to_owned()),
    )
}
/// Tests composite selector syntax.
#[wasm_bindgen]
pub fn selector_is_composite(selector_json: String) -> Result<bool, JsValue> {
    Ok(selector::is_composite_selector(&parse_string(
        &selector_json,
    )?))
}
/// Composes a canonical iframe composite selector.
#[wasm_bindgen]
pub fn selector_compose_composite(
    frame_json: String,
    inner_json: String,
) -> Result<String, JsValue> {
    Ok(json_string(&selector::compose_composite_selector(
        &parse_string(&frame_json)?,
        &parse_string(&inner_json)?,
    )))
}
/// Parses a prefixed selector expression.
#[wasm_bindgen]
pub fn selector_parse_prefixed(input_json: String) -> Result<String, JsValue> {
    parsed_prefixed_json(&selector::parse_prefixed_selector(&parse_string(
        &input_json,
    )?))
}
/// Converts a prefixed selector parse result to a candidate patch, or JSON null.
#[wasm_bindgen]
pub fn selector_prefixed_candidate(input_json: String) -> Result<String, JsValue> {
    Ok(
        selector::prefixed_selector_candidate(&selector::parse_prefixed_selector(&parse_string(
            &input_json,
        )?))
        .map(|candidate| candidate_json(&candidate))
        .unwrap_or_else(|| "null".to_owned()),
    )
}
/// Parses a role-selector value.
#[wasm_bindgen]
pub fn selector_parse_role(input_json: String) -> Result<String, JsValue> {
    let parsed = selector::parse_role_selector(&parse_string(&input_json)?);
    let mut fields = Vec::with_capacity(3);
    if let Some(role) = &parsed.role {
        fields.push(("role", json_string(role)));
    }
    if let Some(name) = &parsed.name {
        fields.push(("name", json_string(name)));
    }
    if let Some(exact) = parsed.exact {
        fields.push(("exact", exact.to_string()));
    }
    Ok(object_json(fields))
}

/// Parses a human-readable ARIA expression.
#[wasm_bindgen]
pub fn selector_parse_aria_expression(input_json: String) -> Result<String, JsValue> {
    let (role, name) = selector::parse_aria_expression(&parse_string(&input_json)?);
    let mut fields = Vec::with_capacity(2);
    if let Some(role) = &role {
        fields.push(("role", json_string(role)));
    }
    if let Some(name) = &name {
        fields.push(("name", json_string(name)));
    }
    Ok(object_json(fields))
}
/// Returns deterministic ARIA-to-CSS fallback candidates.
#[wasm_bindgen]
pub fn selector_aria_to_css(role_json: String, name_json: String) -> Result<String, JsValue> {
    Ok(format!(
        "[{}]",
        selector::aria_to_css_selectors(
            optional_js_string(parse_json(&role_json)?)?.as_ref(),
            optional_js_string(parse_json(&name_json)?)?.as_ref()
        )
        .iter()
        .map(json_string)
        .collect::<Vec<_>>()
        .join(",")
    ))
}

/// Computes a DOM-collected structural fingerprint using JavaScript lower-casing semantics.
#[wasm_bindgen]
pub fn selector_compute_fingerprint(
    input_json: String,
    options_json: String,
) -> Result<String, JsValue> {
    Ok(json_string(&selector::compute_fingerprint(
        &parse_fingerprint_input(parse_json(&input_json)?)?,
        Some(&parse_fingerprint_options(parse_json(&options_json)?)?),
        crate::intrinsics::lower_case,
    )))
}
/// Parses a fingerprint without dropping empty fields.
#[wasm_bindgen]
pub fn selector_parse_fingerprint(input_json: String) -> Result<String, JsValue> {
    fingerprint_json(&selector::parse_fingerprint(&parse_string(&input_json)?))
}
/// Verifies a fingerprint against DOM-collected tag/id values.
#[wasm_bindgen]
pub fn selector_verify_fingerprint(
    tag_json: String,
    id_json: String,
    fingerprint_json: String,
) -> Result<bool, JsValue> {
    Ok(selector::verify_fingerprint(
        optional_js_string(parse_json(&tag_json)?)?.as_ref(),
        optional_js_string(parse_json(&id_json)?)?.as_ref(),
        &parse_string(&fingerprint_json)?,
        crate::intrinsics::lower_case,
    ))
}
/// Computes a fingerprint similarity score using JavaScript lower-casing semantics.
#[wasm_bindgen]
pub fn selector_fingerprint_similarity(
    left_json: String,
    right_json: String,
) -> Result<f64, JsValue> {
    Ok(selector::fingerprint_similarity(
        &parse_string(&left_json)?,
        &parse_string(&right_json)?,
        crate::intrinsics::lower_case,
    ))
}
/// Applies the default or supplied fingerprint threshold.
#[wasm_bindgen]
pub fn selector_fingerprint_matches(
    left_json: String,
    right_json: String,
    threshold_json: String,
) -> Result<String, JsValue> {
    let threshold = optional_number(parse_json(&threshold_json)?)?;
    let result = selector::fingerprint_matches(
        &parse_string(&left_json)?,
        &parse_string(&right_json)?,
        threshold,
        crate::intrinsics::lower_case,
    );
    Ok(format!(
        "{{\"match\":{},\"score\":{}}}",
        result.matched, result.score
    ))
}
/// Derives a composite frame selector from a target and its candidate order.
#[wasm_bindgen]
pub fn selector_derive_frame(target_json: String) -> Result<String, JsValue> {
    Ok(optional_js_json(
        selector::derive_frame_selector(&parse_target(parse_json(&target_json)?)?).as_ref(),
    ))
}
/// Derives the text-tag locator hint from a target/candidate index.
#[wasm_bindgen]
pub fn selector_derive_tag_hint(
    target_json: String,
    candidate_index: i32,
) -> Result<String, JsValue> {
    let target = parse_target(parse_json(&target_json)?)?;
    Ok(optional_js_json(
        selector::derive_tag_name_hint(
            &target,
            usize::try_from(candidate_index)
                .ok()
                .and_then(|index| target.candidates.get(index)),
        )
        .as_ref(),
    ))
}

fn parse_candidate(mut value: JsonDocument) -> Result<SelectorCandidate, JsValue> {
    let selector_type = parse_type(take_string(&mut value, "type")?)?;
    let mut candidate = SelectorCandidate::new(selector_type, take_string(&mut value, "value")?);
    candidate.weight = take_optional(&mut value, "weight")
        .map(number)
        .transpose()?;
    candidate.source = take_optional(&mut value, "source")
        .map(|value| parse_source(value.as_ref().to_js_string()))
        .transpose()?;
    candidate.strategy = take_optional(&mut value, "strategy")
        .map(document_string)
        .transpose()?;
    candidate.stability = take_optional(&mut value, "stability")
        .map(parse_stability)
        .transpose()?;
    candidate.text_match = take_optional(&mut value, "match")
        .map(|value| parse_match(value.as_ref().to_js_string()))
        .transpose()?;
    candidate.tag_name_hint = take_optional(&mut value, "tagNameHint")
        .map(document_string)
        .transpose()?;
    candidate.role = take_optional(&mut value, "role")
        .map(document_string)
        .transpose()?;
    candidate.name = take_optional(&mut value, "name")
        .map(document_string)
        .transpose()?;
    candidate.text = take_optional(&mut value, "text")
        .map(document_string)
        .transpose()?;
    candidate.exact = take_optional(&mut value, "exact")
        .map(boolean)
        .transpose()?;
    candidate.attribute = take_optional(&mut value, "attribute")
        .map(document_string)
        .transpose()?;
    Ok(candidate)
}
fn parse_type(value: JsString) -> Result<SelectorType, JsValue> {
    match value.as_utf8() {
        Some("css") => Ok(SelectorType::Css),
        Some("xpath") => Ok(SelectorType::XPath),
        Some("attr") => Ok(SelectorType::Attr),
        Some("aria") => Ok(SelectorType::Aria),
        Some("text") => Ok(SelectorType::Text),
        Some("role") => Ok(SelectorType::Role),
        Some("label") => Ok(SelectorType::Label),
        Some("placeholder") => Ok(SelectorType::Placeholder),
        Some("alt") => Ok(SelectorType::Alt),
        Some("title") => Ok(SelectorType::Title),
        Some("testid") => Ok(SelectorType::TestId),
        _ => Err(error("unknown selector type")),
    }
}
fn parse_source(value: JsString) -> Result<SelectorCandidateSource, JsValue> {
    match value.as_utf8() {
        Some("recorded") => Ok(SelectorCandidateSource::Recorded),
        Some("user") => Ok(SelectorCandidateSource::User),
        Some("generated") => Ok(SelectorCandidateSource::Generated),
        _ => Err(error("unknown selector source")),
    }
}
fn parse_match(value: JsString) -> Result<TextMatchMode, JsValue> {
    match value.as_utf8() {
        Some("exact") => Ok(TextMatchMode::Exact),
        Some("contains") => Ok(TextMatchMode::Contains),
        _ => Err(error("unknown text match mode")),
    }
}
fn parse_stability(mut value: JsonDocument) -> Result<SelectorStability, JsValue> {
    let score = number(take_required(&mut value, "score")?)?;
    let mut signals_doc =
        take_optional(&mut value, "signals").unwrap_or_else(|| JsonDocument::object([]));
    let signals = humanchrome_core::selector::SelectorStabilitySignals {
        uses_id: optional_bool(&mut signals_doc, "usesId")?,
        uses_test_id: optional_bool(&mut signals_doc, "usesTestId")?,
        uses_aria: optional_bool(&mut signals_doc, "usesAria")?,
        uses_text: optional_bool(&mut signals_doc, "usesText")?,
        uses_nth_of_type: optional_bool(&mut signals_doc, "usesNthOfType")?,
        uses_attributes: optional_bool(&mut signals_doc, "usesAttributes")?,
        uses_class: optional_bool(&mut signals_doc, "usesClass")?,
    };
    Ok(SelectorStability {
        score,
        signals,
        note: take_optional(&mut value, "note")
            .map(document_string)
            .transpose()?,
    })
}
fn parse_generation_options(mut value: JsonDocument) -> Result<SelectorGenerationOptions, JsValue> {
    if value.as_ref().is_null() {
        return Ok(SelectorGenerationOptions::default());
    }
    Ok(SelectorGenerationOptions {
        max_candidates: take_optional(&mut value, "maxCandidates")
            .map(number)
            .transpose()?,
        include_text: take_optional(&mut value, "includeText")
            .map(boolean)
            .transpose()?,
        include_aria: take_optional(&mut value, "includeAria")
            .map(boolean)
            .transpose()?,
        include_css_unique: take_optional(&mut value, "includeCssUnique")
            .map(boolean)
            .transpose()?,
        include_css_path: take_optional(&mut value, "includeCssPath")
            .map(boolean)
            .transpose()?,
        test_id_attributes: take_optional(&mut value, "testIdAttributes")
            .map(string_array)
            .transpose()?,
        text_max_length: take_optional(&mut value, "textMaxLength")
            .map(number)
            .transpose()?,
        text_tags: take_optional(&mut value, "textTags")
            .map(string_array)
            .transpose()?,
    })
}
fn parse_fingerprint_input(mut value: JsonDocument) -> Result<FingerprintInput, JsValue> {
    Ok(FingerprintInput {
        tag_name: take_optional(&mut value, "tagName")
            .map(document_string)
            .transpose()?,
        id: take_optional(&mut value, "id")
            .map(document_string)
            .transpose()?,
        classes: take_optional(&mut value, "classes")
            .map(string_array)
            .transpose()?
            .unwrap_or_default(),
        text_content: take_optional(&mut value, "textContent")
            .map(document_string)
            .transpose()?,
    })
}
fn parse_fingerprint_options(mut value: JsonDocument) -> Result<FingerprintOptions, JsValue> {
    if value.as_ref().is_null() {
        return Ok(FingerprintOptions::default());
    }
    Ok(FingerprintOptions {
        text_max_length: take_optional(&mut value, "textMaxLength")
            .map(number)
            .transpose()?,
        max_classes: take_optional(&mut value, "maxClasses")
            .map(number)
            .transpose()?,
    })
}
fn parse_target(mut value: JsonDocument) -> Result<SelectorTarget, JsValue> {
    let selector = take_optional(&mut value, "selector")
        .map(document_string)
        .transpose()?
        .unwrap_or_else(|| JsString::from(""));
    let candidates = take_required(&mut value, "candidates")?
        .into_array_values()
        .ok_or_else(|| error("target candidates must be an array"))?
        .into_iter()
        .map(parse_candidate)
        .collect::<Result<Vec<_>, _>>()?;
    if candidates.is_empty() {
        return Err(error("target candidates cannot be empty"));
    }
    Ok(SelectorTarget {
        selector,
        candidates,
        tag_name: take_optional(&mut value, "tagName")
            .map(document_string)
            .transpose()?,
    })
}
fn take_required(value: &mut JsonDocument, key: &str) -> Result<JsonDocument, JsValue> {
    value
        .remove(key)
        .ok_or_else(|| error(format!("missing {key}")))
}
fn take_optional(value: &mut JsonDocument, key: &str) -> Option<JsonDocument> {
    value.remove(key).filter(|value| !value.as_ref().is_null())
}
fn take_string(value: &mut JsonDocument, key: &str) -> Result<JsString, JsValue> {
    document_string(take_required(value, key)?)
}
fn document_string(value: JsonDocument) -> Result<JsString, JsValue> {
    if !value.as_ref().is_string() {
        return Err(error("expected string"));
    }
    Ok(value.as_ref().to_js_string())
}
fn optional_js_string(value: JsonDocument) -> Result<Option<JsString>, JsValue> {
    if value.as_ref().is_null() {
        Ok(None)
    } else {
        document_string(value).map(Some)
    }
}
fn string_array(value: JsonDocument) -> Result<Vec<JsString>, JsValue> {
    value
        .into_array_values()
        .ok_or_else(|| error("expected string array"))?
        .into_iter()
        .map(document_string)
        .collect()
}
fn number(value: JsonDocument) -> Result<f64, JsValue> {
    if let Some(number) = value.as_ref().as_f64() {
        return Ok(number);
    }
    let Some(fields) = value.into_object_fields() else {
        return Err(error("expected number"));
    };
    if let [(key, marker)] = fields.as_slice()
        && key.as_utf8() == Some("__humanchromeNumber")
        && marker.as_ref().is_string()
    {
        return match marker.as_ref().to_js_string().as_utf8() {
            Some("NaN") => Ok(f64::NAN),
            Some("Infinity") => Ok(f64::INFINITY),
            Some("-Infinity") => Ok(f64::NEG_INFINITY),
            _ => Err(error("expected number")),
        };
    }
    Err(error("expected number"))
}
fn optional_number(value: JsonDocument) -> Result<Option<f64>, JsValue> {
    if value.as_ref().is_null() {
        Ok(None)
    } else {
        number(value).map(Some)
    }
}
fn boolean(value: JsonDocument) -> Result<bool, JsValue> {
    value
        .as_ref()
        .as_bool()
        .ok_or_else(|| error("expected boolean"))
}
fn optional_bool(value: &mut JsonDocument, key: &str) -> Result<bool, JsValue> {
    take_optional(value, key)
        .map(boolean)
        .transpose()
        .map(Option::unwrap_or_default)
}
fn selector_type_name(value: SelectorType) -> &'static str {
    match value {
        SelectorType::Css => "css",
        SelectorType::XPath => "xpath",
        SelectorType::Attr => "attr",
        SelectorType::Aria => "aria",
        SelectorType::Text => "text",
        SelectorType::Role => "role",
        SelectorType::Label => "label",
        SelectorType::Placeholder => "placeholder",
        SelectorType::Alt => "alt",
        SelectorType::Title => "title",
        SelectorType::TestId => "testid",
    }
}
fn source_name(value: SelectorCandidateSource) -> &'static str {
    match value {
        SelectorCandidateSource::Recorded => "recorded",
        SelectorCandidateSource::User => "user",
        SelectorCandidateSource::Generated => "generated",
    }
}
fn candidate_json(value: &SelectorCandidate) -> String {
    let mut fields = vec![
        (
            "type",
            JsonDocument::from(selector_type_name(value.selector_type)).to_json_text(),
        ),
        ("value", json_string(&value.value)),
    ];
    if let Some(weight) = value.weight {
        fields.push(("weight", number_json(weight)));
    }
    if let Some(source) = value.source {
        fields.push((
            "source",
            JsonDocument::from(source_name(source)).to_json_text(),
        ));
    }
    if let Some(strategy) = &value.strategy {
        fields.push(("strategy", json_string(strategy)));
    }
    if let Some(stability) = &value.stability {
        fields.push(("stability", stability_json(stability)));
    }
    if let Some(text_match) = value.text_match {
        let text_match = match text_match {
            TextMatchMode::Exact => "exact",
            TextMatchMode::Contains => "contains",
        };
        fields.push(("match", JsonDocument::from(text_match).to_json_text()));
    }
    if let Some(tag_name_hint) = &value.tag_name_hint {
        fields.push(("tagNameHint", json_string(tag_name_hint)));
    }
    if let Some(role) = &value.role {
        fields.push(("role", json_string(role)));
    }
    if let Some(name) = &value.name {
        fields.push(("name", json_string(name)));
    }
    if let Some(text) = &value.text {
        fields.push(("text", json_string(text)));
    }
    if let Some(exact) = value.exact {
        fields.push(("exact", exact.to_string()));
    }
    if let Some(attribute) = &value.attribute {
        fields.push(("attribute", json_string(attribute)));
    }
    object_json(fields)
}

fn candidate_patch_json(original: Option<&SelectorCandidate>, value: &SelectorCandidate) -> String {
    let mut fields = Vec::with_capacity(3);
    if original.is_none_or(|original| original.source != value.source)
        && let Some(source) = value.source
    {
        fields.push((
            "source",
            JsonDocument::from(source_name(source)).to_json_text(),
        ));
    }
    if original.is_none_or(|original| original.weight.is_none())
        && let Some(weight) = value.weight
    {
        fields.push(("weight", number_json(weight)));
    }
    if original.is_none_or(|original| original.stability.is_none())
        && let Some(stability) = &value.stability
    {
        fields.push(("stability", stability_json(stability)));
    }
    object_json(fields)
}

fn stability_json(value: &SelectorStability) -> String {
    let mut signals = Vec::with_capacity(7);
    if value.signals.uses_id {
        signals.push(("usesId", "true".to_owned()));
    }
    if value.signals.uses_test_id {
        signals.push(("usesTestId", "true".to_owned()));
    }
    if value.signals.uses_aria {
        signals.push(("usesAria", "true".to_owned()));
    }
    if value.signals.uses_text {
        signals.push(("usesText", "true".to_owned()));
    }
    if value.signals.uses_nth_of_type {
        signals.push(("usesNthOfType", "true".to_owned()));
    }
    if value.signals.uses_attributes {
        signals.push(("usesAttributes", "true".to_owned()));
    }
    if value.signals.uses_class {
        signals.push(("usesClass", "true".to_owned()));
    }

    let mut fields = vec![
        ("score", number_json(value.score)),
        ("signals", object_json(signals)),
    ];
    if let Some(note) = &value.note {
        fields.push(("note", json_string(note)));
    }
    object_json(fields)
}
fn editor_locator_plan_json(value: &humanchrome_core::selector::EditorLocatorPlan) -> String {
    format!(
        "{{\"defaultMaxCandidates\":{},\"dataAttributes\":[{}],\"anchorAttributes\":[{}],\"maxClassComboDepth\":{},\"maxSelectorClassCount\":{},\"maxAnchorDepth\":{},\"maxCandidates\":{},\"headLimit\":{},\"collectAnchor\":{}}}",
        value.collection.default_max_candidates,
        value
            .collection
            .data_attributes
            .iter()
            .map(json_string)
            .collect::<Vec<_>>()
            .join(","),
        value
            .collection
            .anchor_attributes
            .iter()
            .map(json_string)
            .collect::<Vec<_>>()
            .join(","),
        value.collection.max_class_combo_depth,
        value.collection.max_selector_class_count,
        value.collection.max_anchor_depth,
        value.max_candidates,
        value.head_limit,
        value.collect_anchor,
    )
}

fn normalized_options_json(
    value: &humanchrome_core::selector::NormalizedSelectorGenerationOptions,
) -> Result<String, JsValue> {
    Ok(format!(
        "{{\"maxCandidates\":{},\"includeText\":{},\"includeAria\":{},\"includeCssUnique\":{},\"includeCssPath\":{},\"testIdAttributes\":[{}],\"textMaxLength\":{},\"textTags\":[{}]}}",
        value.max_candidates,
        value.include_text,
        value.include_aria,
        value.include_css_unique,
        value.include_css_path,
        value
            .test_id_attributes
            .iter()
            .map(json_string)
            .collect::<Vec<_>>()
            .join(","),
        value.text_max_length,
        value
            .text_tags
            .iter()
            .map(json_string)
            .collect::<Vec<_>>()
            .join(",")
    ))
}

fn parsed_prefixed_json(
    value: &humanchrome_core::selector::ParsedPrefixedSelector,
) -> Result<String, JsValue> {
    let kind = match value.kind {
        PrefixedSelectorKind::Css => "css",
        PrefixedSelectorKind::XPath => "xpath",
        PrefixedSelectorKind::Role => "role",
        PrefixedSelectorKind::Label => "label",
        PrefixedSelectorKind::Placeholder => "placeholder",
        PrefixedSelectorKind::Alt => "alt",
        PrefixedSelectorKind::Title => "title",
        PrefixedSelectorKind::TestId => "testid",
        PrefixedSelectorKind::Text => "text",
    };
    let mut fields = vec![
        ("kind", JsonDocument::from(kind).to_json_text()),
        ("value", json_string(&value.value)),
        ("raw", json_string(&value.raw)),
    ];
    if let Some(role) = &value.role {
        fields.push(("role", json_string(role)));
    }
    if let Some(name) = &value.name {
        fields.push(("name", json_string(name)));
    }
    if let Some(exact) = value.exact {
        fields.push(("exact", exact.to_string()));
    }
    Ok(object_json(fields))
}
fn fingerprint_json(
    value: &humanchrome_core::selector::ElementFingerprint,
) -> Result<String, JsValue> {
    let mut json = format!(
        "{{\"tag\":{},\"raw\":{}",
        json_string(&value.tag),
        json_string(&value.raw)
    );
    if let Some(id) = &value.id {
        json.push_str(",\"id\":");
        json.push_str(&json_string(id));
    }
    if let Some(classes) = &value.classes {
        json.push_str(",\"classes\":[");
        for (index, class) in classes.iter().enumerate() {
            if index != 0 {
                json.push(',');
            }
            json.push_str(&json_string(class));
        }
        json.push(']');
    }
    if let Some(text) = &value.text {
        json.push_str(",\"text\":");
        json.push_str(&json_string(text));
    }
    json.push('}');
    Ok(json)
}
fn json_string(value: &JsString) -> String {
    value.json_string_literal()
}

fn optional_js_json(value: Option<&JsString>) -> String {
    value.map(json_string).unwrap_or_else(|| "null".to_owned())
}

fn object_json(fields: Vec<(&str, String)>) -> String {
    let fields = fields
        .into_iter()
        .map(|(key, value)| format!("\"{key}\":{value}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{fields}}}")
}

fn number_json(value: f64) -> String {
    if value.is_nan() {
        "{\"__humanchromeNumber\":\"NaN\"}".to_owned()
    } else if value == f64::INFINITY {
        "{\"__humanchromeNumber\":\"Infinity\"}".to_owned()
    } else if value == f64::NEG_INFINITY {
        "{\"__humanchromeNumber\":\"-Infinity\"}".to_owned()
    } else {
        value.to_string()
    }
}
