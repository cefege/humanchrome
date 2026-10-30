//! Browser WASM exports over portable humanchrome policy; no native service dependencies.

use humanchrome_core::arguments::JsString;
use humanchrome_core::json_document::JsonDocument;
use wasm_bindgen::JsValue;

mod browser_metadata;
mod browser_state;
mod builder_policy;
mod editor_policy;
mod embedding_cache;
mod intrinsics;
mod legacy_graph;
mod output;
mod replay_policy;
mod run_policy;
mod selector;
mod semantic;
mod shared_policy;
mod workflow;

fn parse_json(text: &str) -> Result<JsonDocument, JsValue> {
    JsonDocument::parse(text).map_err(error)
}

fn parse_string(text: &str) -> Result<JsString, JsValue> {
    JsString::from_json_string_literal(text).map_err(error)
}

fn encode_serializable<T: serde::Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(error)
}

fn error(message: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&message.to_string()).into()
}
