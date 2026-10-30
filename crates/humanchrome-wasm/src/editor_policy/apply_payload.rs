//! Opaque-handle WASM adapter for web-editor apply-message normalization.
//!
//! This module intentionally reads JavaScript properties and arrays directly. JSON would erase
//! `undefined`, lone surrogates, `Number` coercion, and the batch payload's element identities.

use humanchrome_core::arguments::JsString;
use humanchrome_core::editor_policy::{
    self, ApplyDebugSource, ApplyFingerprint, ApplyInstructionType, ApplyPayload,
    ApplyPayloadInput, ApplyStyleOperation, DebugSourceInput, StringMapEntry, StringMapInput,
    StyleOperationInput,
};
use js_sys::{Array, Object, Reflect};
use wasm_bindgen::{JsCast, JsValue};

#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(js_name = Number)]
    fn javascript_number(value: &JsValue) -> f64;
}

pub(super) fn normalize_string(value: JsValue) -> JsValue {
    js_string(&editor_policy::normalize_string(string_value(&value)))
}

pub(super) fn normalize_apply_payload(raw: JsValue) -> Result<JsValue, JsValue> {
    let object = object_or_empty(&raw);
    let input = apply_payload_input(&object)?;
    let mut payload = editor_policy::normalize_apply_payload(input).map_err(crate::error)?;
    let selector_candidates = string_array(&property(&object, "selectorCandidates")?);
    let debug_source = debug_source_input(nested_object(&object, "debugSource")?.as_ref())?;
    let operation = operation_input(nested_object(&object, "operation")?.as_ref())?;
    editor_policy::normalize_apply_payload_extensions(
        &mut payload,
        selector_candidates,
        debug_source,
        operation,
    );
    apply_payload_to_js(&payload)
}

pub(super) fn normalize_apply_batch_payload(raw: JsValue) -> Result<JsValue, JsValue> {
    let object = object_or_empty(&raw);
    let tab_id = javascript_number(&property(&object, "tabId")?);
    let elements = batch_elements(&property(&object, "elements")?);
    let excluded_keys = string_array(&property(&object, "excludedKeys")?);
    let page_url = string_value(&property(&object, "pageUrl")?);
    let normalized = editor_policy::normalize_apply_batch(tab_id, excluded_keys, page_url);

    let output = Object::new();
    set(&output, "tabId", JsValue::from_f64(normalized.tab_id))?;
    set(&output, "elements", elements)?;
    set(
        &output,
        "excludedKeys",
        strings_to_js(&normalized.excluded_keys).into(),
    )?;
    set(
        &output,
        "pageUrl",
        optional_string_to_js(normalized.page_url),
    )?;
    Ok(output.into())
}

fn apply_payload_input(object: &Object) -> Result<ApplyPayloadInput, JsValue> {
    let page_url = string_property(object, "pageUrl")?;
    let target_file = string_property(object, "targetFile")?;
    let tech_stack_hint = string_array(&property(object, "techStackHint")?);
    let fingerprint = nested_object(object, "fingerprint")?;
    let fingerprint_tag = optional_string_property(fingerprint.as_ref(), "tag")?;
    let fingerprint_id = optional_string_property(fingerprint.as_ref(), "id")?;
    let fingerprint_classes = optional_string_array_property(fingerprint.as_ref(), "classes")?;
    let fingerprint_text = optional_string_property(fingerprint.as_ref(), "text")?;
    let instruction = nested_object(object, "instruction")?;
    let instruction_type = optional_string_property(instruction.as_ref(), "type")?;
    editor_policy::parse_apply_instruction_type(instruction_type.clone()).map_err(crate::error)?;
    let instruction_description = optional_string_property(instruction.as_ref(), "description")?;
    let instruction_text = optional_string_property(instruction.as_ref(), "text")?;
    let instruction_style = optional_style_map_property(instruction.as_ref(), "style")?;

    Ok(ApplyPayloadInput {
        page_url,
        target_file,
        tech_stack_hint,
        fingerprint_tag,
        fingerprint_id,
        fingerprint_classes,
        fingerprint_text,
        instruction_type,
        instruction_description,
        instruction_text,
        instruction_style,
        selector_candidates: Vec::new(),
        debug_source: None,
        operation: None,
    })
}

fn debug_source_input(object: Option<&Object>) -> Result<Option<DebugSourceInput>, JsValue> {
    let Some(object) = object else {
        return Ok(None);
    };
    Ok(Some(DebugSourceInput {
        file: string_property(object, "file")?,
        line: javascript_number(&property(object, "line")?),
        column: javascript_number(&property(object, "column")?),
        component_name: string_property(object, "componentName")?,
    }))
}

fn operation_input(object: Option<&Object>) -> Result<Option<StyleOperationInput>, JsValue> {
    let Some(object) = object else {
        return Ok(None);
    };
    let operation_type = string_property(object, "type")?;
    if operation_type.as_ref().and_then(JsString::as_utf8) != Some("update_style") {
        return Ok(Some(StyleOperationInput {
            operation_type,
            before: None,
            after: None,
            removed: Vec::new(),
        }));
    }
    Ok(Some(StyleOperationInput {
        operation_type,
        before: style_map(&property(object, "before")?)?,
        after: style_map(&property(object, "after")?)?,
        removed: string_array(&property(object, "removed")?),
    }))
}

fn object_or_empty(value: &JsValue) -> Object {
    as_object(value).unwrap_or_default()
}

fn as_object(value: &JsValue) -> Option<Object> {
    (value.is_object() && !value.is_null()).then(|| value.clone().unchecked_into())
}

fn nested_object(object: &Object, key: &str) -> Result<Option<Object>, JsValue> {
    Ok(as_object(&property(object, key)?))
}

fn property(object: &Object, key: &str) -> Result<JsValue, JsValue> {
    Reflect::get(object, &JsValue::from_str(key))
}

fn string_property(object: &Object, key: &str) -> Result<Option<JsString>, JsValue> {
    Ok(string_value(&property(object, key)?))
}

fn optional_string_property(
    object: Option<&Object>,
    key: &str,
) -> Result<Option<JsString>, JsValue> {
    object.map_or(Ok(None), |object| string_property(object, key))
}

fn string_value(value: &JsValue) -> Option<JsString> {
    value
        .is_string()
        .then(|| crate::intrinsics::from_js_string(value.unchecked_ref()))
}

fn string_array(value: &JsValue) -> Vec<JsString> {
    if !Array::is_array(value) {
        return Vec::new();
    }
    let array = value.unchecked_ref::<Array>();
    (0..array.length())
        .filter_map(|index| string_value(&array.get(index)))
        .filter(|item| item.utf16_len() > 0)
        .collect()
}

fn optional_string_array_property(
    object: Option<&Object>,
    key: &str,
) -> Result<Vec<JsString>, JsValue> {
    object.map_or(Ok(Vec::new()), |object| {
        Ok(string_array(&property(object, key)?))
    })
}

fn optional_style_map_property(
    object: Option<&Object>,
    key: &str,
) -> Result<StringMapInput, JsValue> {
    object.map_or(Ok(None), |object| style_map(&property(object, key)?))
}

fn style_map(value: &JsValue) -> Result<StringMapInput, JsValue> {
    let Some(object) = as_object(value) else {
        return Ok(None);
    };
    Ok(Some(
        Object::entries(&object)
            .iter()
            .map(|entry| {
                let entry = entry.unchecked_into::<Array>();
                StringMapEntry {
                    key: crate::intrinsics::from_js_string(entry.get(0).unchecked_ref()),
                    value: string_value(&entry.get(1)),
                }
            })
            .collect(),
    ))
}

fn batch_elements(elements: &JsValue) -> JsValue {
    if Array::is_array(elements) {
        elements.clone()
    } else {
        Array::new().into()
    }
}

fn apply_payload_to_js(payload: &ApplyPayload) -> Result<JsValue, JsValue> {
    let output = Object::new();
    set(&output, "pageUrl", js_string(&payload.page_url))?;
    set(
        &output,
        "targetFile",
        optional_string_to_js(payload.target_file.clone()),
    )?;
    set(
        &output,
        "fingerprint",
        fingerprint_to_js(&payload.fingerprint).into(),
    )?;
    set(
        &output,
        "techStackHint",
        optional_strings_to_js(payload.tech_stack_hint.as_ref())?,
    )?;
    set(&output, "instruction", instruction_to_js(payload).into())?;
    set(
        &output,
        "selectorCandidates",
        optional_strings_to_js(payload.selector_candidates.as_ref())?,
    )?;
    set(
        &output,
        "debugSource",
        debug_source_to_js(payload.debug_source.as_ref())?,
    )?;
    set(
        &output,
        "operation",
        operation_to_js(payload.operation.as_ref())?,
    )?;
    Ok(output.into())
}

fn fingerprint_to_js(fingerprint: &ApplyFingerprint) -> Object {
    let output = Object::new();
    Reflect::set(
        &output,
        &JsValue::from_str("tag"),
        &js_string(&fingerprint.tag),
    )
    .expect("plain output accepts fingerprint tag");
    Reflect::set(
        &output,
        &JsValue::from_str("id"),
        &optional_string_to_js(fingerprint.id.clone()),
    )
    .expect("plain output accepts fingerprint id");
    Reflect::set(
        &output,
        &JsValue::from_str("classes"),
        &strings_to_js(&fingerprint.classes).into(),
    )
    .expect("plain output accepts fingerprint classes");
    Reflect::set(
        &output,
        &JsValue::from_str("text"),
        &optional_string_to_js(fingerprint.text.clone()),
    )
    .expect("plain output accepts fingerprint text");
    output
}

fn instruction_to_js(payload: &ApplyPayload) -> Object {
    let output = Object::new();
    let instruction = &payload.instruction;
    let instruction_type = match instruction.instruction_type {
        ApplyInstructionType::UpdateText => "update_text",
        ApplyInstructionType::UpdateStyle => "update_style",
    };
    Reflect::set(
        &output,
        &JsValue::from_str("type"),
        &JsValue::from_str(instruction_type),
    )
    .expect("plain output accepts instruction type");
    Reflect::set(
        &output,
        &JsValue::from_str("description"),
        &js_string(&instruction.description),
    )
    .expect("plain output accepts instruction description");
    Reflect::set(
        &output,
        &JsValue::from_str("text"),
        &optional_string_to_js(instruction.text.clone()),
    )
    .expect("plain output accepts instruction text");
    Reflect::set(
        &output,
        &JsValue::from_str("style"),
        &optional_style_map_to_js(instruction.style.as_deref()),
    )
    .expect("plain output accepts instruction style");
    output
}

fn debug_source_to_js(source: Option<&ApplyDebugSource>) -> Result<JsValue, JsValue> {
    let Some(source) = source else {
        return Ok(JsValue::UNDEFINED);
    };
    let output = Object::new();
    set(&output, "file", js_string(&source.file))?;
    set(
        &output,
        "line",
        source.line.map_or(JsValue::UNDEFINED, JsValue::from_f64),
    )?;
    set(
        &output,
        "column",
        source.column.map_or(JsValue::UNDEFINED, JsValue::from_f64),
    )?;
    set(
        &output,
        "componentName",
        optional_string_to_js(source.component_name.clone()),
    )?;
    Ok(output.into())
}

fn operation_to_js(operation: Option<&ApplyStyleOperation>) -> Result<JsValue, JsValue> {
    let Some(operation) = operation else {
        return Ok(JsValue::UNDEFINED);
    };
    let output = Object::new();
    set(&output, "type", JsValue::from_str("update_style"))?;
    set(&output, "before", style_map_to_js(&operation.before).into())?;
    set(&output, "after", style_map_to_js(&operation.after).into())?;
    set(&output, "removed", strings_to_js(&operation.removed).into())?;
    Ok(output.into())
}

fn optional_strings_to_js(strings: Option<&Vec<JsString>>) -> Result<JsValue, JsValue> {
    Ok(strings.map_or(JsValue::UNDEFINED, |strings| strings_to_js(strings).into()))
}

fn optional_string_to_js(value: Option<JsString>) -> JsValue {
    value.map_or(JsValue::UNDEFINED, |value| js_string(&value))
}

fn optional_style_map_to_js(entries: Option<&[(JsString, JsString)]>) -> JsValue {
    entries.map_or(JsValue::UNDEFINED, |entries| {
        style_map_to_js(entries).into()
    })
}

fn style_map_to_js(entries: &[(JsString, JsString)]) -> Object {
    let output = Object::new();
    for (key, value) in entries {
        Reflect::set(&output, &js_string(key), &js_string(value))
            .expect("plain output accepts normalized style entry");
    }
    output
}

fn strings_to_js(strings: &[JsString]) -> Array {
    let output = Array::new();
    for value in strings {
        output.push(&js_string(value));
    }
    output
}

fn js_string(value: &JsString) -> JsValue {
    crate::intrinsics::to_js_string(value).into()
}

fn set(output: &Object, key: &str, value: JsValue) -> Result<(), JsValue> {
    Reflect::set(output, &JsValue::from_str(key), &value).map(|_| ())
}
