//! WASM host boundary for shared argument, catalog, sanitizer, and encoding policy.
//!
//! Opaque JavaScript values, property walks, and JSON serialization remain in the host. This
//! module transfers only string policy and catalog data across the boundary.

use humanchrome_core::{
    arguments::{did_you_mean_lossless, truncate_received_lossless},
    catalog::Catalog,
    shared_policy,
};
use js_sys::{Array, Object, RegExp};
use wasm_bindgen::{JsCast, prelude::*};

fn json_compatible_value<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(crate::error)
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = String)]
    fn javascript_string(value: &JsValue) -> js_sys::JsString;
}

/// Suggests an enum value without converting an unpaired surrogate through UTF-8.
#[wasm_bindgen]
pub fn shared_did_you_mean(received: JsValue, candidates: Array, max_distance: f64) -> JsValue {
    if !max_distance.is_finite() || max_distance < 0.0 {
        return JsValue::NULL;
    }
    let Some(received) = js_string(&received) else {
        return JsValue::NULL;
    };
    let candidates = strings_from_array(&candidates);
    let max_distance = nonnegative_usize(max_distance);
    did_you_mean_lossless(
        &crate::intrinsics::from_js_string(&received),
        candidates.iter().map(String::as_str),
        max_distance,
    )
    .map_or(JsValue::NULL, JsValue::from)
}

/// Truncates an INVALID_ARGS received value while retaining JavaScript's JSON/String behavior.
#[wasm_bindgen]
pub fn shared_truncate_received(value: JsValue) -> Result<JsValue, JsValue> {
    if value.is_undefined()
        || value.is_null()
        || value.as_bool().is_some()
        || value.as_f64().is_some()
    {
        return Ok(value);
    }
    if let Some(text) = js_string(&value) {
        return received_value_to_js(truncate_received_lossless(
            &crate::intrinsics::from_js_string(&text),
        ));
    }

    // The host intrinsic is intentionally retained: JSON.stringify may execute toJSON and throws
    // for cycles, and String() owns the existing opaque-value fallback semantics.
    let text = match js_sys::JSON::stringify(&value) {
        Ok(result) => {
            let result: JsValue = result.into();
            if result.is_undefined() {
                javascript_string(&value)
            } else {
                result.unchecked_into()
            }
        }
        Err(_) => javascript_string(&value),
    };
    received_value_to_js(truncate_received_lossless(
        &crate::intrinsics::from_js_string(&text),
    ))
}

/// Returns Rust-owned normalization for sanitizer configuration caps.
#[wasm_bindgen]
pub fn shared_normalize_positive_int(value: f64, fallback: f64) -> f64 {
    shared_policy::normalize_positive_int(value, nonnegative_usize(fallback)) as f64
}

/// Identifies an object key whose value must be redacted in non-raw mode.
#[wasm_bindgen]
pub fn shared_is_sensitive_key(key: JsValue) -> bool {
    js_string(&key)
        .is_some_and(|key| shared_policy::is_sensitive_key(&key.as_string().unwrap_or_default()))
}

/// Applies the per-string sanitizer length limit while preserving UTF-16 slicing behavior.
#[wasm_bindgen]
pub fn shared_limit_string(text: JsValue, max_length: f64) -> Result<JsValue, JsValue> {
    let text = require_string(&text)?;
    let text = crate::intrinsics::from_js_string(&text);
    let max_length = nonnegative_usize(max_length);
    let Some((prefix, omitted)) = shared_policy::limit_string_units(&text, max_length) else {
        return Ok(crate::intrinsics::to_js_string(&text).into());
    };
    let mut output = prefix;
    output.push_str(&format!("... [truncated {omitted} chars]"));
    Ok(crate::intrinsics::to_js_string(&output).into())
}

/// Returns TextEncoder-compatible UTF-8 byte length for a JavaScript string.
#[wasm_bindgen]
pub fn shared_utf8_byte_length(text: JsValue) -> Result<f64, JsValue> {
    let text = crate::intrinsics::from_js_string(&require_string(&text)?);
    Ok(shared_policy::utf8_byte_length(&text) as f64)
}

/// Encodes a JavaScript string with TextEncoder-compatible replacement semantics.
#[wasm_bindgen]
pub fn shared_utf8_to_base64(text: JsValue) -> Result<String, JsValue> {
    let text = crate::intrinsics::from_js_string(&require_string(&text)?);
    Ok(shared_policy::utf8_to_base64(&text))
}

/// Caps formatted output and provides the exact footer fields for the JS envelope.
#[wasm_bindgen]
pub fn shared_truncate_output_text(text: JsValue, max_bytes: f64) -> Result<JsValue, JsValue> {
    let text = crate::intrinsics::from_js_string(&require_string(&text)?);
    let max_bytes = nonnegative_usize(max_bytes);
    let plan = shared_policy::truncate_output_text(&text, max_bytes);
    let output = Object::new();
    set(
        &output,
        "text",
        crate::intrinsics::to_js_string(&plan.prefix).into(),
    )?;
    set(&output, "truncated", JsValue::from_bool(plan.truncated))?;
    set(
        &output,
        "originalBytes",
        JsValue::from_f64(plan.original_bytes as f64),
    )?;
    Ok(output.into())
}

/// Applies the ordered text-redaction rules while retaining JavaScript RegExp/String semantics.
#[wasm_bindgen]
pub fn shared_sanitize_text(text: JsValue, raw: bool) -> Result<JsValue, JsValue> {
    let original = require_string(&text)?;
    if raw {
        return sanitizer_result(original.into(), false);
    }

    if looks_like_pair_string(&original, ';') || looks_like_pair_string(&original, '&') {
        return sanitizer_result(
            JsValue::from_str("[BLOCKED: Cookie/query string data]"),
            true,
        );
    }
    if matches(&original, r"^[A-Za-z0-9+/]{20,}={0,2}$", "") {
        return sanitizer_result(JsValue::from_str("[BLOCKED: Base64 encoded data]"), true);
    }
    if matches(&original, r"^[a-f0-9]{32,}$", "i") {
        return sanitizer_result(JsValue::from_str("[BLOCKED: Hex credential]"), true);
    }

    let mut output = original;
    let mut redacted = false;
    for (pattern, flags, replacement) in [
        (
            r"\bBearer\s+([A-Za-z0-9._~+/=-]+)\b",
            "gi",
            "Bearer <redacted>",
        ),
        (
            r"\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
            "g",
            "<redacted_jwt>",
        ),
        (
            r"(^|[?&])(access_token|refresh_token|id_token|token|api_key|apikey|password|passwd|pwd|secret|session|sid|credential|auth|oauth)=([^&#\s]+)",
            "gi",
            "$1$2=<redacted>",
        ),
        (
            r#"\b(authorization|cookie|set-cookie|x-api-key|api_key|apikey|password|passwd|pwd|secret|token|access_token|refresh_token|id_token|session|sid|credential|private_key|oauth)\b\s*[:=]\s*([^\s,;\"']+)"#,
            "gi",
            "$1=<redacted>",
        ),
        (r"\b[A-Za-z0-9+/]{40,}={0,2}\b", "g", "<redacted_base64>"),
        (r"\b[a-f0-9]{40,}\b", "gi", "<redacted_hex>"),
    ] {
        let matcher = RegExp::new(pattern, flags);
        if output.search(&matcher) >= 0 {
            redacted = true;
            output = output.replace_by_pattern(&matcher, replacement);
        }
    }
    sanitizer_result(output.into(), redacted)
}

/// Returns static catalog names in its contract-defined sorted order.
#[wasm_bindgen]
pub fn shared_catalog_known_names() -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&Catalog::embedded().known_tool_names()).map_err(crate::error)
}

/// Tests a static catalog name without a host-side duplicate index.
#[wasm_bindgen]
pub fn shared_catalog_is_known(name: JsValue) -> bool {
    js_string(&name).is_some_and(|name| {
        Catalog::embedded().is_known_tool_name(&name.as_string().unwrap_or_default())
    })
}
/// Filters suggested-next tool names before the host attaches result metadata.
#[wasm_bindgen]
pub fn shared_suggested_next(hints: Array, limit: f64) -> Result<JsValue, JsValue> {
    let hints = strings_from_array(&hints);
    serde_wasm_bindgen::to_value(&shared_policy::suggested_next(
        hints,
        nonnegative_usize(limit),
    ))
    .map_err(crate::error)
}

/// Resolves static and dynamic catalog names through the Rust catalog owner.
#[wasm_bindgen]
pub fn shared_catalog_resolve(name: JsValue, extras: Array) -> Result<JsValue, JsValue> {
    let name = json_string_value(&name)?;
    let extras = strings_from_array(&extras);
    let value = serde_json::Value::String(name);
    json_compatible_value(&Catalog::embedded().resolve_tool_name(&value, &extras))
}

/// Suggests a static or dynamic tool name through the Rust catalog owner.
#[wasm_bindgen]
pub fn shared_catalog_suggest(received: JsValue, extras: Array) -> Result<JsValue, JsValue> {
    let received = json_string_value(&received)?;
    let extras = strings_from_array(&extras);
    let value = serde_json::Value::String(received);
    json_compatible_value(&Catalog::embedded().suggest_tool_name(&value, &extras))
}

/// Searches the embedded catalog with the existing Rust ranking policy.
#[wasm_bindgen]
pub fn shared_catalog_search(query: JsValue) -> Result<JsValue, JsValue> {
    let query = json_string_value(&query)?;
    serde_wasm_bindgen::to_value(&Catalog::embedded().search(&query)).map_err(crate::error)
}

/// Builds a `chrome_help` response from the embedded catalog.
#[wasm_bindgen]
pub fn shared_catalog_help(argument: JsValue) -> Result<JsValue, JsValue> {
    let argument = js_to_json(&argument)?;
    json_compatible_value(&Catalog::embedded().build_tool_help(argument.as_ref()))
}

fn received_value_to_js(
    value: humanchrome_core::arguments::ReceivedValue,
) -> Result<JsValue, JsValue> {
    match value {
        humanchrome_core::arguments::ReceivedValue::Value(value) => {
            serde_wasm_bindgen::to_value(&value).map_err(crate::error)
        }
        humanchrome_core::arguments::ReceivedValue::String(value) => {
            Ok(crate::intrinsics::to_js_string(&value).into())
        }
    }
}

fn sanitizer_result(text: JsValue, redacted: bool) -> Result<JsValue, JsValue> {
    let output = Object::new();
    set(&output, "text", text)?;
    set(&output, "redacted", JsValue::from_bool(redacted))?;
    Ok(output.into())
}

fn set(target: &Object, key: &str, value: JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(target, &JsValue::from_str(key), &value).map(|_| ())
}

fn js_string(value: &JsValue) -> Option<js_sys::JsString> {
    value.is_string().then(|| value.clone().unchecked_into())
}

fn require_string(value: &JsValue) -> Result<js_sys::JsString, JsValue> {
    js_string(value).ok_or_else(|| js_sys::TypeError::new("expected string").into())
}

fn strings_from_array(values: &Array) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| js_string(&value)?.as_string())
        .collect()
}

fn json_string_value(value: &JsValue) -> Result<String, JsValue> {
    js_string(value)
        .and_then(|value| value.as_string())
        .ok_or_else(|| js_sys::TypeError::new("expected string").into())
}

fn js_to_json(value: &JsValue) -> Result<Option<serde_json::Value>, JsValue> {
    if value.is_undefined() {
        return Ok(None);
    }
    let stringified: JsValue = js_sys::JSON::stringify(value)?.into();
    if stringified.is_undefined() {
        return Ok(None);
    }
    let text = stringified
        .as_string()
        .ok_or_else(|| crate::error("JSON.stringify did not return text"))?;
    serde_json::from_str(&text).map(Some).map_err(crate::error)
}

fn nonnegative_usize(value: f64) -> usize {
    if !value.is_finite() || value <= 0.0 {
        0
    } else if value >= usize::MAX as f64 {
        usize::MAX
    } else {
        value.floor() as usize
    }
}

fn matches(value: &js_sys::JsString, pattern: &str, flags: &str) -> bool {
    value.search(&RegExp::new(pattern, flags)) >= 0
}

fn looks_like_pair_string(value: &js_sys::JsString, delimiter: char) -> bool {
    let trimmed = value.trim();
    let Some(trimmed) = trimmed.as_string() else {
        return false;
    };
    if trimmed.is_empty() || !trimmed.contains('=') || !trimmed.contains(delimiter) {
        return false;
    }
    let parts = js_sys::JsString::from(trimmed).split(&delimiter.to_string());
    if parts.length() < 2 {
        return false;
    }
    parts
        .iter()
        .filter_map(|part| part.as_string())
        .filter(|part| part.find('=').is_some_and(|index| index > 0))
        .take(2)
        .count()
        >= 2
}
