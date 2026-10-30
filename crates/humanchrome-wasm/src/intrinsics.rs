//! Narrow host-language intrinsics whose semantics are defined by JavaScript.

use humanchrome_core::arguments::JsString;
use wasm_bindgen::{JsCast, prelude::*};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = String)]
    type BrowserString;
    #[wasm_bindgen(method, js_name = isWellFormed)]
    fn is_well_formed(this: &BrowserString) -> bool;
}

thread_local! {
    static HAS_WELL_FORMED_INTRINSIC: bool =
        js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("String"))
            .and_then(|constructor| js_sys::Reflect::get(&constructor, &JsValue::from_str("prototype")))
            .and_then(|prototype| js_sys::Reflect::get(&prototype, &JsValue::from_str("isWellFormed")))
            .is_ok_and(|method| method.is_function());
}

/// Transfers valid UTF-8 directly and preserves unpaired UTF-16 through JSON text.
pub(crate) fn to_js_string(value: &JsString) -> js_sys::JsString {
    if let Some(text) = value.as_utf8() {
        return js_sys::JsString::from(text);
    }
    js_sys::JSON::parse(&value.json_string_literal())
        .expect("core string serialization produces a valid JSON string literal")
        .unchecked_into()
}

/// Avoids JSON encoding for well-formed strings while preserving every UTF-16 code unit.
pub(crate) fn from_js_string(value: &js_sys::JsString) -> JsString {
    if HAS_WELL_FORMED_INTRINSIC.with(|available| *available)
        && value.unchecked_ref::<BrowserString>().is_well_formed()
    {
        return JsString::from(
            value
                .as_string()
                .expect("a well-formed primitive string has a UTF-8 representation"),
        );
    }
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
