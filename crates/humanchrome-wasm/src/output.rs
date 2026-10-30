//! Output host adapter: Rust decides text mutations; JavaScript retains image/opaque resources.

use humanchrome_core::{
    arguments::JsString,
    output::{
        DEFAULT_OUTPUT_BUDGET_BYTES, TruncateEnvelope, TruncateMode, mode_from_raw,
        plan_output_budget, truncate_array_plan, truncate_owned_string,
    },
};
use js_sys::{Array, Reflect};
use wasm_bindgen::{JsCast, prelude::*};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = Number)]
    fn javascript_number(value: &JsValue) -> f64;
    #[wasm_bindgen(js_name = String)]
    fn javascript_string(value: &JsValue) -> js_sys::JsString;
}

/// Returns a pure mutation plan, or undefined when the original result must be retained.
#[wasm_bindgen]
pub fn output_budget_plan(result: JsValue, options: JsValue) -> Result<JsValue, JsValue> {
    if Reflect::get(&options, &JsValue::from_str("raw"))?.is_truthy() || !result.is_object() {
        return Ok(JsValue::UNDEFINED);
    }
    if Reflect::get(&result, &JsValue::from_str("isError"))?.is_truthy() {
        return Ok(JsValue::UNDEFINED);
    }
    let content = Reflect::get(&result, &JsValue::from_str("content"))?;
    if !Array::is_array(&content) {
        return Ok(JsValue::UNDEFINED);
    }
    let content: Array = content.unchecked_into();
    let budget = Reflect::get(&options, &JsValue::from_str("budgetBytes"))?;
    let budget = if budget.is_null() || budget.is_undefined() {
        None
    } else {
        Some(javascript_number(&budget))
    };
    let type_key = JsValue::from_str("type");
    let text_key = JsValue::from_str("text");
    let text_type = JsValue::from_str("text");
    let mut text_blocks = Vec::new();
    for (index, block) in content.iter().enumerate() {
        if !block.is_object() || Reflect::get(&block, &type_key)? != text_type {
            continue;
        }
        // UTF-8 transfer replaces lone surrogates exactly as TextEncoder does. The original
        // JS text is never replaced unless the resulting Rust plan requests truncation.
        if let Some(text) = Reflect::get(&block, &text_key)?.as_string() {
            text_blocks.push((index, text));
        }
    }
    let plan = plan_output_budget(
        content.length() as usize,
        text_blocks
            .iter()
            .map(|(index, text)| (*index, text.as_str())),
        budget,
    );
    match plan {
        Some(plan) => serde_wasm_bindgen::to_value(&plan).map_err(crate::error),
        None => Ok(JsValue::UNDEFINED),
    }
}

/// Makes the Rust-owned public default available to generated build metadata.
#[wasm_bindgen]
pub fn output_default_budget_bytes() -> usize {
    DEFAULT_OUTPUT_BUDGET_BYTES
}

#[derive(serde::Serialize)]
struct HostValue(#[serde(with = "serde_wasm_bindgen::preserve")] JsValue);

fn encode_tool_envelope<T>(
    envelope: TruncateEnvelope<T, f64>,
    data: JsValue,
) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&TruncateEnvelope {
        data: HostValue(data),
        truncated: envelope.truncated,
        original_size: envelope.original_size,
        limit: envelope.limit,
        raw_available: envelope.raw_available,
    })
    .map_err(crate::error)
}

/// Caps lossless JavaScript strings without moving array/image resources into Rust.
#[wasm_bindgen]
pub fn tool_truncate_string(text: JsValue, max_bytes: f64, mode: &str) -> Result<JsValue, JsValue> {
    let mode = TruncateMode::from_name(mode);
    if text.is_undefined() {
        // JSON.stringify(undefined) is undefined; TextEncoder treats that as empty input.
        let envelope =
            truncate_owned_string(JsString::from_owned_string(String::new()), max_bytes, mode);
        if envelope.truncated {
            return Err(js_sys::TypeError::new(
                "Cannot read properties of undefined (reading 'length')",
            )
            .into());
        }
        return encode_tool_envelope(envelope, text);
    }
    let string: js_sys::JsString = text.clone().unchecked_into();
    let envelope =
        truncate_owned_string(crate::intrinsics::from_js_string(&string), max_bytes, mode);
    let data = if envelope.truncated {
        crate::intrinsics::to_js_string(&envelope.data).into()
    } else {
        text
    };
    encode_tool_envelope(envelope, data)
}

/// Applies Rust's relative-end plan while preserving original host array resources.
#[wasm_bindgen]
pub fn tool_truncate_array(values: Array, max_items: f64, mode: &str) -> Result<JsValue, JsValue> {
    let envelope = truncate_array_plan(
        values.length() as usize,
        max_items,
        TruncateMode::from_name(mode),
    );
    let data = if envelope.truncated {
        values.slice(0, envelope.data as u32).into()
    } else {
        values.into()
    };
    encode_tool_envelope(envelope, data)
}

/// Keeps JSON.stringify/String host semantics, including cycles and undefined.
#[wasm_bindgen]
pub fn tool_truncate_json(value: JsValue, max_bytes: f64, mode: &str) -> Result<JsValue, JsValue> {
    let text = js_sys::JSON::stringify(&value).unwrap_or_else(|_| javascript_string(&value));
    tool_truncate_string(text.into(), max_bytes, mode)
}

/// Decodes raw strictly: truthy non-booleans retain preview mode.
#[wasm_bindgen]
pub fn tool_truncate_mode(raw: JsValue) -> String {
    match mode_from_raw(&serde_json::Value::Bool(raw.as_bool() == Some(true))) {
        TruncateMode::Raw => "raw",
        TruncateMode::Preview => "preview",
    }
    .to_owned()
}
