//! Action-target decoding and opaque metadata transport for the selector core.

use humanchrome_core::{
    arguments::JsString,
    selector::{self, ActionCandidateInput, SelectorType, TextMatchMode},
    workflow::StringIntrinsics,
};
use js_sys::{Array, JsString as WebString, Object, Reflect};
use wasm_bindgen::{JsCast, prelude::*};

use crate::workflow::{self, BrowserIntrinsics};

fn field(value: &JsValue, key: &str) -> Result<JsValue, JsValue> {
    Reflect::get(value, &JsValue::from_str(key))
}

fn string_value(value: &JsValue) -> Option<JsString> {
    value
        .is_string()
        .then(|| crate::intrinsics::from_js_string(value.unchecked_ref::<WebString>()))
}

fn optional_string(value: Option<&JsString>) -> JsValue {
    value.map_or(JsValue::UNDEFINED, |value| {
        crate::intrinsics::to_js_string(value).into()
    })
}

fn resolve_value(value: JsValue, scope: &JsValue) -> Result<Option<JsString>, JsValue> {
    match crate::replay_policy::resolve_legacy_string(value, scope.clone()) {
        Ok(value) => {
            let value = crate::intrinsics::from_js_string(value.unchecked_ref::<WebString>());
            workflow::expand_legacy_string(&value, scope).map(Some)
        }
        Err(humanchrome_core::replay_policy::LegacyStringResolutionError::Policy(_)) => Ok(None),
        Err(humanchrome_core::replay_policy::LegacyStringResolutionError::Intrinsic(exception)) => {
            Err(exception)
        }
    }
}

fn decode_candidate(raw: &JsValue, scope: &JsValue) -> Result<ActionCandidateInput, JsValue> {
    let kind = string_value(&field(raw, "type")?).and_then(|value| super::parse_type(value).ok());
    let mut input = ActionCandidateInput {
        selector_type: kind,
        weight: field(raw, "weight")?.as_f64(),
        ..Default::default()
    };
    match kind {
        Some(SelectorType::Css | SelectorType::Attr) => {
            input.value = resolve_value(field(raw, "selector")?, scope)?;
        }
        Some(SelectorType::XPath) => {
            input.value = resolve_value(field(raw, "xpath")?, scope)?;
        }
        Some(SelectorType::Text) => {
            input.value = resolve_value(field(raw, "text")?, scope)?;
            input.tag_name_hint = string_value(&field(raw, "tagNameHint")?);
            input.text_match = match field(raw, "match")?.as_string().as_deref() {
                Some("exact") => Some(TextMatchMode::Exact),
                Some("contains") => Some(TextMatchMode::Contains),
                _ => None,
            };
        }
        Some(SelectorType::Aria) => {
            input.role = resolve_value(field(raw, "role")?, scope)?;
            input.name = resolve_value(field(raw, "name")?, scope)?;
        }
        _ => {}
    }
    Ok(input)
}

/// Prepares a complete replay target while keeping source/stability handles on original objects.
#[wasm_bindgen]
pub fn selector_action_target(target: JsValue, scope: JsValue) -> Result<JsValue, JsValue> {
    let raw_candidates = field(&target, "candidates")?;
    let raw_candidates = if Array::is_array(&raw_candidates) {
        raw_candidates.unchecked_into::<Array>()
    } else {
        Array::new()
    };
    let first_type = if raw_candidates.length() > 0 {
        let first = raw_candidates.get(0);
        let kind = if first.is_null() || first.is_undefined() {
            JsValue::UNDEFINED
        } else {
            field(&first, "type")?
        };
        if kind.is_truthy() {
            let kind = workflow::javascript_string(&kind);
            if kind.length() == 0 {
                JsValue::UNDEFINED
            } else {
                kind.into()
            }
        } else {
            JsValue::UNDEFINED
        }
    } else {
        JsValue::UNDEFINED
    };
    let tag_name = if let Some(tag) = string_value(&field(&target, "tag")?) {
        Some(tag)
    } else {
        let hint = field(&target, "hint")?;
        if hint.is_null() || hint.is_undefined() {
            None
        } else {
            string_value(&field(&hint, "tagName")?)
        }
    };
    let primary = match string_value(&field(&target, "selector")?) {
        Some(value) => {
            let value = BrowserIntrinsics.trim(&value);
            if value.utf16_len() == 0 {
                None
            } else {
                let value =
                    BrowserIntrinsics.trim(&workflow::expand_legacy_string(&value, &scope)?);
                (value.utf16_len() != 0).then_some(value)
            }
        }
        None => None,
    };
    let inputs = raw_candidates
        .iter()
        .map(|raw| decode_candidate(&raw, &scope))
        .collect::<Result<Vec<_>, _>>()?;
    let batch = selector::prepare_action_candidates(inputs, tag_name.as_ref());
    let candidates = Array::new_with_length(batch.candidates.len() as u32);
    for (index, plan) in batch.candidates.iter().enumerate() {
        let candidate = Object::new();
        Reflect::set(
            &candidate,
            &JsValue::from_str("type"),
            &JsValue::from_str(super::selector_type_name(plan.candidate.selector_type)),
        )?;
        Reflect::set(
            &candidate,
            &JsValue::from_str("value"),
            &crate::intrinsics::to_js_string(&plan.candidate.value),
        )?;
        if let Some(weight) = plan.candidate.weight {
            Reflect::set(
                &candidate,
                &JsValue::from_str("weight"),
                &JsValue::from_f64(weight),
            )?;
        }
        if let Some(source_index) = plan.source_index {
            let original = raw_candidates.get(source_index as u32);
            for key in ["source", "stability"] {
                let value = field(&original, key)?;
                if value.is_truthy() {
                    Reflect::set(&candidate, &JsValue::from_str(key), &value)?;
                }
            }
            if plan.candidate.selector_type == SelectorType::Text {
                Reflect::set(
                    &candidate,
                    &JsValue::from_str("match"),
                    &field(&original, "match")?,
                )?;
                let hint = field(&original, "tagNameHint")?;
                let hint = if hint.is_null() || hint.is_undefined() {
                    optional_string(plan.candidate.tag_name_hint.as_ref())
                } else {
                    hint
                };
                Reflect::set(&candidate, &JsValue::from_str("tagNameHint"), &hint)?;
            } else if plan.candidate.selector_type == SelectorType::Aria {
                Reflect::set(
                    &candidate,
                    &JsValue::from_str("role"),
                    &optional_string(plan.candidate.role.as_ref()),
                )?;
                Reflect::set(
                    &candidate,
                    &JsValue::from_str("name"),
                    &optional_string(plan.candidate.name.as_ref()),
                )?;
            }
        }
        candidates.set(index as u32, candidate.into());
    }
    let selector_target = Object::new();
    Reflect::set(
        &selector_target,
        &JsValue::from_str("selector"),
        &optional_string(primary.as_ref()),
    )?;
    Reflect::set(
        &selector_target,
        &JsValue::from_str("candidates"),
        &candidates,
    )?;
    Reflect::set(
        &selector_target,
        &JsValue::from_str("tagName"),
        &optional_string(tag_name.as_ref()),
    )?;
    Reflect::set(
        &selector_target,
        &JsValue::from_str("ref"),
        &optional_string(string_value(&field(&target, "ref")?).as_ref()),
    )?;
    let output = Object::new();
    Reflect::set(
        &output,
        &JsValue::from_str("selectorTarget"),
        &selector_target,
    )?;
    Reflect::set(
        &output,
        &JsValue::from_str("firstCandidateType"),
        &first_type,
    )?;
    let css = match batch.first_css_or_attr {
        Some(index) => field(&candidates.get(index as u32), "value")?,
        None => JsValue::UNDEFINED,
    };
    Reflect::set(&output, &JsValue::from_str("firstCssOrAttr"), &css)?;
    Ok(output.into())
}

/// Preserves JavaScript Number coercion before applying the core's integer-bounds policy.
#[wasm_bindgen]
pub fn selector_clamp_action_integer(value: JsValue, min: f64, max: f64) -> f64 {
    selector::clamp_action_integer(workflow::javascript_number(&value), min, max)
}
