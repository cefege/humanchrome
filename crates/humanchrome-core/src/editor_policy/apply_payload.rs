//! Web-editor apply-message normalization policy.
//!
//! The WASM adapter performs the narrow JavaScript observations needed at this boundary
//! (`Array.isArray`, `Number`, property reads, and `Object.entries`). This module owns every
//! normalization, validation, omission, and insertion-order decision.

use std::fmt;

use crate::arguments::JsString;

/// One `Object.entries` result collected by the browser adapter in JavaScript order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StringMapEntry {
    /// The entry's own enumerable property name.
    pub key: JsString,
    /// The entry value when it was a primitive JavaScript string.
    pub value: Option<JsString>,
}

/// Browser-observed optional object fields for a style map.
pub type StringMapInput = Option<Vec<StringMapEntry>>;

/// Browser-observed fields for a debug source object.
#[derive(Debug, Clone, PartialEq)]
pub struct DebugSourceInput {
    /// The primitive string value of `file`, when present.
    pub file: Option<JsString>,
    /// The exact result of JavaScript `Number(value.line)`.
    pub line: f64,
    /// The exact result of JavaScript `Number(value.column)`.
    pub column: f64,
    /// The primitive string value of `componentName`, when present.
    pub component_name: Option<JsString>,
}

/// Browser-observed optional object fields for a style operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleOperationInput {
    /// The primitive string value of `type`, when present.
    pub operation_type: Option<JsString>,
    /// Own enumerable `before` entries.
    pub before: StringMapInput,
    /// Own enumerable `after` entries.
    pub after: StringMapInput,
    /// String values retained from an `Array.isArray(removed)` collection.
    pub removed: Vec<JsString>,
}

/// Browser-observed apply-message fields. Missing or non-object nested values use `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyPayloadInput {
    /// The primitive string value of `pageUrl`, when present.
    pub page_url: Option<JsString>,
    /// The primitive string value of `targetFile`, when present.
    pub target_file: Option<JsString>,
    /// String values retained from `Array.isArray(techStackHint)`.
    pub tech_stack_hint: Vec<JsString>,
    /// The primitive string value of `fingerprint.tag`, when present.
    pub fingerprint_tag: Option<JsString>,
    /// The primitive string value of `fingerprint.id`, when present.
    pub fingerprint_id: Option<JsString>,
    /// String values retained from `Array.isArray(fingerprint.classes)`.
    pub fingerprint_classes: Vec<JsString>,
    /// The primitive string value of `fingerprint.text`, when present.
    pub fingerprint_text: Option<JsString>,
    /// The primitive string value of `instruction.type`, when present.
    pub instruction_type: Option<JsString>,
    /// The primitive string value of `instruction.description`, when present.
    pub instruction_description: Option<JsString>,
    /// The primitive string value of `instruction.text`, when present.
    pub instruction_text: Option<JsString>,
    /// Own enumerable `instruction.style` entries.
    pub instruction_style: StringMapInput,
    /// String values retained from `Array.isArray(selectorCandidates)`.
    pub selector_candidates: Vec<JsString>,
    /// Nested debug fields when `debugSource` was a JavaScript object.
    pub debug_source: Option<DebugSourceInput>,
    /// Nested operation fields when `operation` was a JavaScript object.
    pub operation: Option<StyleOperationInput>,
}

/// Normalized fingerprint fields for one apply message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyFingerprint {
    /// Trimmed tag, or the historical `unknown` fallback.
    pub tag: JsString,
    /// Trimmed identifier when non-empty.
    pub id: Option<JsString>,
    /// Original non-empty class strings in array order.
    pub classes: Vec<JsString>,
    /// Trimmed text when non-empty.
    pub text: Option<JsString>,
}

/// Valid apply instruction variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyInstructionType {
    /// Updates an element's text content.
    UpdateText,
    /// Updates an element's style declarations.
    UpdateStyle,
}

/// A normalized apply instruction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyInstruction {
    /// The validated instruction operation.
    pub instruction_type: ApplyInstructionType,
    /// Non-empty trimmed description.
    pub description: JsString,
    /// Trimmed replacement text when non-empty.
    pub text: Option<JsString>,
    /// Trimmed non-empty style entries in JavaScript insertion order.
    pub style: Option<Vec<(JsString, JsString)>>,
}

/// A normalized optional framework debug source.
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyDebugSource {
    /// Non-empty trimmed source file.
    pub file: JsString,
    /// Positive finite line number.
    pub line: Option<f64>,
    /// Non-negative finite column number.
    pub column: Option<f64>,
    /// Non-empty trimmed component name.
    pub component_name: Option<JsString>,
}

/// A normalized style operation with explicit empty before/after maps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyStyleOperation {
    /// Always `update_style`.
    pub before: Vec<(JsString, JsString)>,
    /// Always `update_style`.
    pub after: Vec<(JsString, JsString)>,
    /// Original non-empty removal names in array order.
    pub removed: Vec<JsString>,
}

/// Fully normalized single-element editor apply payload.
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyPayload {
    /// Required trimmed page URL.
    pub page_url: JsString,
    /// Optional trimmed target file.
    pub target_file: Option<JsString>,
    /// Normalized element fingerprint.
    pub fingerprint: ApplyFingerprint,
    /// Optional non-empty original string array.
    pub tech_stack_hint: Option<Vec<JsString>>,
    /// Validated instruction.
    pub instruction: ApplyInstruction,
    /// Optional non-empty original string array.
    pub selector_candidates: Option<Vec<JsString>>,
    /// Optional normalized source metadata.
    pub debug_source: Option<ApplyDebugSource>,
    /// Optional normalized style operation.
    pub operation: Option<ApplyStyleOperation>,
}

/// Apply-payload validation failures with the historical JavaScript error text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyPayloadError {
    /// `instruction.type` was not one of the two supported values.
    InvalidInstructionType,
    /// `pageUrl` was absent, non-string, or blank after trim.
    PageUrlRequired,
    /// `instruction.description` was absent, non-string, or blank after trim.
    InstructionDescriptionRequired,
}

impl fmt::Display for ApplyPayloadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInstructionType => "Invalid instruction.type",
            Self::PageUrlRequired => "pageUrl is required",
            Self::InstructionDescriptionRequired => "instruction.description is required",
        })
    }
}

impl std::error::Error for ApplyPayloadError {}

/// Normalizes a browser-observed single-element apply payload.
///
/// # Errors
///
/// Returns the historical validation error for an invalid instruction type, blank page URL, or
/// blank instruction description. Type validation intentionally happens before required-field
/// validation because that is the JavaScript observable order.
pub fn normalize_apply_payload(
    input: ApplyPayloadInput,
) -> Result<ApplyPayload, ApplyPayloadError> {
    let page_url = trimmed(input.page_url);
    let target_file = trimmed(input.target_file);
    let fingerprint = ApplyFingerprint {
        tag: trimmed(input.fingerprint_tag).unwrap_or_else(|| JsString::from("unknown")),
        id: trimmed(input.fingerprint_id),
        classes: input.fingerprint_classes,
        text: trimmed(input.fingerprint_text),
    };
    let instruction_type = parse_apply_instruction_type(input.instruction_type)?;
    let description = trimmed(input.instruction_description).unwrap_or_else(|| JsString::from(""));
    let instruction = ApplyInstruction {
        instruction_type,
        description: description.clone(),
        text: trimmed(input.instruction_text),
        style: normalize_style_map(input.instruction_style, false),
    };

    let Some(page_url) = page_url else {
        return Err(ApplyPayloadError::PageUrlRequired);
    };
    if description.utf16_len() == 0 {
        return Err(ApplyPayloadError::InstructionDescriptionRequired);
    }

    let tech_stack_hint = nonempty_array(input.tech_stack_hint);
    let mut payload = ApplyPayload {
        page_url,
        target_file,
        fingerprint,
        tech_stack_hint,
        instruction,
        selector_candidates: None,
        debug_source: None,
        operation: None,
    };
    normalize_apply_payload_extensions(
        &mut payload,
        input.selector_candidates,
        input.debug_source,
        input.operation,
    );
    Ok(payload)
}

/// Applies optional post-validation payload extensions in their source-order sequence.
pub fn normalize_apply_payload_extensions(
    payload: &mut ApplyPayload,
    selector_candidates: Vec<JsString>,
    debug_source: Option<DebugSourceInput>,
    operation: Option<StyleOperationInput>,
) {
    payload.selector_candidates = nonempty_array(selector_candidates);
    payload.debug_source = debug_source.and_then(normalize_debug_source);
    payload.operation = operation.and_then(normalize_operation);
}

/// Coerces a value observed as a primitive JavaScript string, otherwise returning an empty string.
#[must_use]
pub fn normalize_string(value: Option<JsString>) -> JsString {
    value.unwrap_or_else(|| JsString::from(""))
}

/// Normalizes browser-observed batch fields while retaining the opaque `elements` collection host-side.
#[must_use]
pub fn normalize_apply_batch(
    tab_id: f64,
    excluded_keys: Vec<JsString>,
    page_url: Option<JsString>,
) -> ApplyBatch {
    ApplyBatch {
        tab_id: if tab_id.is_finite() && tab_id > 0.0 {
            tab_id
        } else {
            0.0
        },
        excluded_keys: excluded_keys
            .into_iter()
            .filter_map(trimmed_value)
            .collect(),
        page_url: trimmed(page_url),
    }
}

/// Normalized portable fields for an apply batch.
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyBatch {
    /// A positive finite JavaScript number, otherwise zero.
    pub tab_id: f64,
    /// Non-empty trimmed excluded element keys in array order.
    pub excluded_keys: Vec<JsString>,
    /// Optional non-empty trimmed page URL.
    pub page_url: Option<JsString>,
}

/// Validates one observed instruction type using the historical trimmed-string rule.
///
/// # Errors
///
/// Returns `Invalid instruction.type` when the value is missing, non-string, blank, or unsupported.
pub fn parse_apply_instruction_type(
    value: Option<JsString>,
) -> Result<ApplyInstructionType, ApplyPayloadError> {
    match trimmed(value).as_ref().and_then(JsString::as_utf8) {
        Some("update_text") => Ok(ApplyInstructionType::UpdateText),
        Some("update_style") => Ok(ApplyInstructionType::UpdateStyle),
        _ => Err(ApplyPayloadError::InvalidInstructionType),
    }
}

fn normalize_debug_source(input: DebugSourceInput) -> Option<ApplyDebugSource> {
    let file = trimmed(input.file)?;
    Some(ApplyDebugSource {
        file,
        line: (input.line.is_finite() && input.line > 0.0).then_some(input.line),
        column: (input.column.is_finite() && input.column >= 0.0).then_some(input.column),
        component_name: trimmed(input.component_name),
    })
}

fn normalize_operation(input: StyleOperationInput) -> Option<ApplyStyleOperation> {
    if input.operation_type.as_ref().and_then(JsString::as_utf8) != Some("update_style") {
        return None;
    }
    let before = normalize_style_map(input.before, true);
    let after = normalize_style_map(input.after, true);
    if before.is_none() && after.is_none() && input.removed.is_empty() {
        return None;
    }
    Some(ApplyStyleOperation {
        before: before.unwrap_or_default(),
        after: after.unwrap_or_default(),
        removed: input.removed,
    })
}

fn normalize_style_map(
    input: StringMapInput,
    retain_empty_values: bool,
) -> Option<Vec<(JsString, JsString)>> {
    let mut normalized = Vec::new();
    for entry in input? {
        let Some(key) = trimmed_value(entry.key) else {
            continue;
        };
        // `out[key] = value` on the historical plain object invokes the inherited
        // `__proto__` setter; normalized values are strings, so it creates no own entry.
        if key.as_utf8() == Some("__proto__") {
            continue;
        }
        let value = trimmed(entry.value).unwrap_or_else(|| JsString::from(""));
        if !retain_empty_values && value.utf16_len() == 0 {
            continue;
        }
        if let Some((_, existing)) = normalized
            .iter_mut()
            .find(|(candidate, _)| candidate == &key)
        {
            *existing = value;
        } else {
            normalized.push((key, value));
        }
    }
    (!normalized.is_empty()).then_some(normalized)
}

fn nonempty_array(values: Vec<JsString>) -> Option<Vec<JsString>> {
    (!values.is_empty()).then_some(values)
}

fn trimmed(value: Option<JsString>) -> Option<JsString> {
    value.and_then(trimmed_value)
}

fn trimmed_value(value: JsString) -> Option<JsString> {
    let mut units = value.into_utf16_units();
    let start = units
        .iter()
        .position(|unit| !is_js_whitespace(*unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !is_js_whitespace(*unit))
        .map_or(start, |index| index + 1);
    units.truncate(end);
    units.drain(..start);
    (!units.is_empty()).then(|| JsString::from_utf16_units(units))
}

fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x0009..=0x000d
            | 0x0020
            | 0x00a0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string(value: &str) -> Option<JsString> {
        Some(JsString::from(value))
    }

    fn apply_input() -> ApplyPayloadInput {
        ApplyPayloadInput {
            page_url: string(" https://example.test/path "),
            target_file: string(" src/App.tsx "),
            tech_stack_hint: vec![JsString::from(" React "), JsString::from("  ")],
            fingerprint_tag: string(" button "),
            fingerprint_id: string(" save "),
            fingerprint_classes: vec![JsString::from("btn"), JsString::from("  ")],
            fingerprint_text: string(" Save "),
            instruction_type: string(" update_style "),
            instruction_description: string(" change color "),
            instruction_text: None,
            instruction_style: Some(vec![
                StringMapEntry {
                    key: JsString::from(" color "),
                    value: string(" red "),
                },
                StringMapEntry {
                    key: JsString::from("opacity"),
                    value: string(""),
                },
            ]),
            selector_candidates: vec![JsString::from("#save")],
            debug_source: Some(DebugSourceInput {
                file: string(" src/App.tsx "),
                line: 4.0,
                column: 0.0,
                component_name: string(" SaveButton "),
            }),
            operation: Some(StyleOperationInput {
                operation_type: string("update_style"),
                before: Some(vec![
                    StringMapEntry {
                        key: JsString::from("color"),
                        value: string("blue"),
                    },
                    StringMapEntry {
                        key: JsString::from("opacity"),
                        value: string(""),
                    },
                ]),
                after: Some(vec![
                    StringMapEntry {
                        key: JsString::from("color"),
                        value: string(""),
                    },
                    StringMapEntry {
                        key: JsString::from("opacity"),
                        value: string("0.5"),
                    },
                ]),
                removed: vec![JsString::from("color")],
            }),
        }
    }

    #[test]
    fn apply_payload_retains_array_whitespace_and_empty_operation_values() {
        let result = normalize_apply_payload(apply_input()).expect("valid apply payload");
        assert_eq!(result.page_url.as_utf8(), Some("https://example.test/path"));
        assert_eq!(result.tech_stack_hint.as_ref().map(Vec::len), Some(2));
        assert_eq!(result.fingerprint.classes[1].as_utf8(), Some("  "));
        assert_eq!(result.instruction.style.as_ref().map(Vec::len), Some(1));
        let operation = result.operation.expect("style operation");
        assert_eq!(operation.before[1].1.as_utf8(), Some(""));
        assert_eq!(operation.after[0].1.as_utf8(), Some(""));
    }

    #[test]
    fn apply_payload_preserves_validation_order_and_messages() {
        let mut input = apply_input();
        input.instruction_type = string("other");
        input.page_url = None;
        assert_eq!(
            normalize_apply_payload(input),
            Err(ApplyPayloadError::InvalidInstructionType)
        );

        let mut input = apply_input();
        input.page_url = string(" \u{feff} ");
        assert_eq!(
            normalize_apply_payload(input),
            Err(ApplyPayloadError::PageUrlRequired)
        );

        let mut input = apply_input();
        input.instruction_description = string(" \u{3000} ");
        assert_eq!(
            normalize_apply_payload(input),
            Err(ApplyPayloadError::InstructionDescriptionRequired)
        );
    }

    #[test]
    fn batch_normalization_keeps_positive_fractional_tab_ids_and_filters_blank_keys() {
        let batch = normalize_apply_batch(
            2.5,
            vec![
                JsString::from(" x "),
                JsString::from(""),
                JsString::from("  "),
            ],
            string(" /p "),
        );
        assert_eq!(batch.tab_id, 2.5);
        assert_eq!(batch.excluded_keys[0].as_utf8(), Some("x"));
        assert_eq!(batch.excluded_keys.len(), 1);
        assert_eq!(
            batch.page_url.as_ref().and_then(JsString::as_utf8),
            Some("/p")
        );
        assert_eq!(
            normalize_apply_batch(f64::INFINITY, Vec::new(), None).tab_id,
            0.0
        );
    }
}
