//! Narrow host-language intrinsics whose semantics are defined by JavaScript.

use humanchrome_core::arguments::JsString;
use wasm_bindgen::JsCast;

/// Transfers valid UTF-8 directly and preserves unpaired UTF-16 through JSON text.
pub(crate) fn to_js_string(value: &JsString) -> js_sys::JsString {
    if let Some(text) = value.as_utf8() {
        return js_sys::JsString::from(text);
    }
    js_sys::JSON::parse(&value.json_string_literal())
        .expect("core string serialization produces a valid JSON string literal")
        .unchecked_into()
}

/// JSON.stringify escapes lone surrogates before wasm-bindgen's UTF-8 transfer.
pub(crate) fn from_js_string(value: &js_sys::JsString) -> JsString {
    let literal = js_sys::JSON::stringify(value.as_ref())
        .expect("JSON.stringify cannot reject a primitive JavaScript string")
        .as_string()
        .expect("well-formed JSON string text is valid UTF-8");
    JsString::from_json_string_literal(&literal)
        .expect("JSON.stringify produces a valid JSON string literal")
}

pub(crate) fn lower_case(value: &JsString) -> JsString {
    from_js_string(&to_js_string(value).to_lower_case())
}
