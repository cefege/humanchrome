//! Typed WASM bindings for reusable workflow traversal, import, trigger, and resolver policy.

use std::cmp::Ordering;

use humanchrome_core::arguments::JsString;
use humanchrome_core::json_document::JsonDocument;
use humanchrome_core::workflow::{
    self, CanvasPoint, CompiledUrlRules, ExpressionEvaluator, LegacyRetryPolicy, LocaleCompare,
    Resolvable, RetryBackoff, RetryJitter, RetryPolicy, StringIntrinsics, TemplateFormat,
    TemplatePart, UrlMatchKind, UrlMatchRule, UrlParts, V2Binding, V2Edge, V2Flow, V2Meta, V2Node,
    V2Schedule, V2Trigger, V2TriggerKind, V2Variable, V3Flow, VariablePathSegment, VariablePointer,
    VariableStore, WorkflowContext, WorkflowEdge, WorkflowFlow, WorkflowNode,
};
use indexmap::IndexMap;
use js_sys::{Array, Function, JsString as WebString, Object, Reflect};
use serde_json::Value;
use wasm_bindgen::{JsCast, prelude::*};

#[wasm_bindgen]
extern "C" {
    type BrowserString;
    #[wasm_bindgen(method, js_name = trim)]
    fn js_trim(this: &BrowserString) -> WebString;
    #[wasm_bindgen(method, js_name = startsWith)]
    fn js_starts_with(this: &BrowserString, prefix: &BrowserString) -> bool;
    #[wasm_bindgen(method, js_name = endsWith)]
    fn js_ends_with(this: &BrowserString, suffix: &BrowserString) -> bool;
    #[wasm_bindgen(method, js_name = localeCompare)]
    fn js_locale_compare(this: &BrowserString, other: &BrowserString) -> i32;
    #[wasm_bindgen(js_name = encodeURIComponent)]
    fn js_encode_uri_component(value: &WebString) -> WebString;
    #[wasm_bindgen(js_name = Number)]
    fn js_number(value: &WebString) -> f64;
    #[wasm_bindgen(js_name = URL)]
    type BrowserUrl;
    #[wasm_bindgen(constructor, catch, js_class = "URL")]
    fn new(value: &WebString) -> Result<BrowserUrl, JsValue>;
    #[wasm_bindgen(method, getter)]
    fn hostname(this: &BrowserUrl) -> WebString;
    #[wasm_bindgen(method, getter)]
    fn pathname(this: &BrowserUrl) -> WebString;
    #[wasm_bindgen(js_name = String)]
    pub(crate) fn javascript_string(value: &JsValue) -> WebString;
    #[wasm_bindgen(js_name = Object)]
    fn javascript_object(value: &JsValue) -> Object;
    #[wasm_bindgen(js_name = Number)]
    pub(crate) fn javascript_number(value: &JsValue) -> f64;
}

pub(crate) struct BrowserIntrinsics;

impl StringIntrinsics for BrowserIntrinsics {
    fn trim(&self, value: &JsString) -> JsString {
        let value = crate::intrinsics::to_js_string(value);
        crate::intrinsics::from_js_string(&value.unchecked_ref::<BrowserString>().js_trim())
    }

    fn to_lower_case(&self, value: &JsString) -> JsString {
        crate::intrinsics::lower_case(value)
    }

    fn starts_with(&self, value: &JsString, prefix: &JsString) -> bool {
        let value = crate::intrinsics::to_js_string(value);
        let prefix = crate::intrinsics::to_js_string(prefix);
        value
            .unchecked_ref::<BrowserString>()
            .js_starts_with(prefix.unchecked_ref())
    }

    fn ends_with(&self, value: &JsString, suffix: &JsString) -> bool {
        let value = crate::intrinsics::to_js_string(value);
        let suffix = crate::intrinsics::to_js_string(suffix);
        value
            .unchecked_ref::<BrowserString>()
            .js_ends_with(suffix.unchecked_ref())
    }

    fn encode_uri_component(&self, value: &JsString) -> JsString {
        crate::intrinsics::from_js_string(&js_encode_uri_component(
            &crate::intrinsics::to_js_string(value),
        ))
    }

    fn number_from_string(&self, value: &JsString) -> f64 {
        js_number(&crate::intrinsics::to_js_string(value))
    }
}

impl LocaleCompare for BrowserIntrinsics {
    fn locale_compare(&self, left: &str, right: &str) -> Ordering {
        let left = WebString::from(left);
        let right = WebString::from(right);
        left.unchecked_ref::<BrowserString>()
            .js_locale_compare(right.unchecked_ref())
            .cmp(&0)
    }
}

struct HostExpressionEvaluator<'callback> {
    callback: &'callback Function,
}

impl ExpressionEvaluator for HostExpressionEvaluator<'_> {
    fn evaluate(&self, expression: &JsonDocument) -> Result<JsonDocument, String> {
        let expression =
            js_sys::JSON::parse(&expression.to_json_text()).map_err(|error| js_error(&error))?;
        let value = self
            .callback
            .call1(&JsValue::UNDEFINED, &expression)
            .map_err(|error| js_error(&error))?;
        let json: String = js_sys::JSON::stringify(&value)
            .map_err(|error| js_error(&error))?
            .into();
        JsonDocument::parse(&json).map_err(|error| error.to_string())
    }
}

fn js_error(value: &JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            value
                .dyn_ref::<js_sys::Error>()
                .and_then(|error| error.message().as_string())
        })
        .unwrap_or_else(|| String::from("Expression evaluation failed"))
}

fn json_string(value: &JsString) -> String {
    value.json_string_literal()
}

fn json_array(values: impl IntoIterator<Item = String>) -> String {
    format!("[{}]", values.into_iter().collect::<Vec<_>>().join(","))
}

fn json_object(values: impl IntoIterator<Item = (&'static str, String)>) -> String {
    let fields = values
        .into_iter()
        .map(|(key, value)| format!("\"{key}\":{value}"))
        .collect::<Vec<_>>();
    format!("{{{}}}", fields.join(","))
}

fn field(document: &JsonDocument, key: &str) -> Option<JsonDocument> {
    document.get(key).map(|value| value.to_owned())
}

fn required_string(document: &JsonDocument, key: &str) -> Result<JsString, JsValue> {
    let Some(value) = field(document, key) else {
        return Err(crate::error(format!("Missing required field: {key}")));
    };
    if !value.as_ref().is_string() {
        return Err(crate::error(format!("Expected string field: {key}")));
    }
    crate::parse_string(&value.to_json_text())
}

fn optional_string(document: &JsonDocument, key: &str) -> Result<Option<JsString>, JsValue> {
    field(document, key)
        .filter(|value| !value.as_ref().is_null())
        .map(|value| {
            if !value.as_ref().is_string() {
                return Err(crate::error(format!("Expected string field: {key}")));
            }
            crate::parse_string(&value.to_json_text())
        })
        .transpose()
}

fn required_identifier(document: &JsonDocument, key: &str) -> Result<String, JsValue> {
    Ok(required_string(document, key)?.to_string_lossy())
}

fn optional_bool(document: &JsonDocument, key: &str) -> Result<Option<bool>, JsValue> {
    field(document, key)
        .map(|value| {
            value
                .as_ref()
                .as_bool()
                .ok_or_else(|| crate::error(format!("Expected boolean field: {key}")))
        })
        .transpose()
}

fn optional_number(document: &JsonDocument, key: &str) -> Result<Option<f64>, JsValue> {
    field(document, key)
        .map(|value| {
            value
                .as_ref()
                .as_f64()
                .ok_or_else(|| crate::error(format!("Expected numeric field: {key}")))
        })
        .transpose()
}

fn object_array(document: &JsonDocument, key: &str) -> Result<Vec<JsonDocument>, JsValue> {
    field(document, key)
        .map(|value| {
            value
                .into_array_values()
                .ok_or_else(|| crate::error(format!("Expected array field: {key}")))
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

fn flow_node(document: &JsonDocument) -> Result<WorkflowNode, JsValue> {
    let ui = field(document, "ui").and_then(|value| {
        let x = field(&value, "x").and_then(|value| value.as_ref().as_f64())?;
        let y = field(&value, "y").and_then(|value| value.as_ref().as_f64())?;
        (x.is_finite() && y.is_finite()).then_some(CanvasPoint { x, y })
    });
    Ok(WorkflowNode {
        id: required_identifier(document, "id")?,
        kind: required_identifier(document, "kind")?,
        name: optional_string(document, "name")?,
        disabled: optional_bool(document, "disabled")?,
        config: field(document, "config").unwrap_or_else(|| JsonDocument::object([])),
        ui,
    })
}

fn workflow_edge(document: &JsonDocument) -> Result<WorkflowEdge, JsValue> {
    Ok(WorkflowEdge {
        id: required_identifier(document, "id")?,
        from: required_identifier(document, "from")?,
        to: required_identifier(document, "to")?,
        label: optional_string(document, "label")?.map(|value| value.to_string_lossy()),
    })
}

fn workflow_flow(document: &JsonDocument) -> Result<WorkflowFlow, JsValue> {
    Ok(WorkflowFlow::new(
        required_identifier(document, "id")?,
        required_identifier(document, "entryNodeId")?,
        object_array(document, "nodes")?
            .iter()
            .map(flow_node)
            .collect::<Result<Vec<_>, _>>()?,
        object_array(document, "edges")?
            .iter()
            .map(workflow_edge)
            .collect::<Result<Vec<_>, _>>()?,
    ))
}

pub(crate) fn variable_store(document: JsonDocument) -> Result<VariableStore, JsValue> {
    let values = document
        .into_object_fields()
        .ok_or_else(|| crate::error("Expected variables object"))?;
    let mut variables = IndexMap::with_capacity(values.len());
    for (key, value) in values {
        variables.insert(key.to_string_lossy(), value);
    }
    Ok(variables)
}

fn parse_url_rule(document: &JsonDocument) -> Result<UrlMatchRule, JsValue> {
    let kind = match required_identifier(document, "kind")?.as_str() {
        "url" => UrlMatchKind::Url,
        "domain" => UrlMatchKind::Domain,
        "path" => UrlMatchKind::Path,
        _ => return Err(crate::error("Unknown URL match kind")),
    };
    Ok(UrlMatchRule {
        kind,
        value: required_string(document, "value")?,
    })
}

pub(crate) fn parse_resolvable(document: JsonDocument) -> Result<Resolvable, JsValue> {
    let Some(kind) = field(&document, "kind").filter(|value| value.as_ref().is_string()) else {
        return Ok(Resolvable::Literal(document));
    };
    match crate::parse_string(&kind.to_json_text())?
        .to_string_lossy()
        .as_str()
    {
        "var" => {
            let Some(reference) =
                field(&document, "ref").filter(|value| value.as_ref().is_object())
            else {
                return Ok(Resolvable::Literal(document));
            };
            let Some(name) = field(&reference, "name").filter(|value| value.as_ref().is_string())
            else {
                return Ok(Resolvable::Literal(document));
            };
            let name = crate::parse_string(&name.to_json_text())?;
            if name.utf16_len() == 0 {
                return Ok(Resolvable::Literal(document));
            }
            let path = match field(&reference, "path") {
                None => Vec::new(),
                Some(path) => {
                    let Some(path) = path.into_array_values() else {
                        return Ok(Resolvable::Literal(document));
                    };
                    let mut segments = Vec::with_capacity(path.len());
                    for segment in path {
                        if segment.as_ref().is_string() {
                            segments.push(VariablePathSegment::Key(
                                crate::parse_string(&segment.to_json_text())?.to_string_lossy(),
                            ));
                        } else if let Some(value) = segment.as_ref().as_f64() {
                            if value.is_finite() && value.fract() == 0.0 {
                                segments.push(VariablePathSegment::Index(value as i64));
                            } else {
                                return Ok(Resolvable::Literal(document));
                            }
                        } else {
                            return Ok(Resolvable::Literal(document));
                        }
                    }
                    segments
                }
            };
            Ok(Resolvable::Variable {
                reference: VariablePointer {
                    name: name.to_string_lossy(),
                    path,
                },
                default: field(&document, "default"),
            })
        }
        "expr" => {
            let Some(expression) = field(&document, "expr") else {
                return Ok(Resolvable::Literal(document));
            };
            Ok(Resolvable::Expression {
                expression,
                default: field(&document, "default"),
            })
        }
        "template" => {
            let Some(parts) = field(&document, "parts").and_then(JsonDocument::into_array_values)
            else {
                return Ok(Resolvable::Literal(document));
            };
            if parts.is_empty() {
                return Ok(Resolvable::Literal(document));
            }
            let parts = parts
                .into_iter()
                .map(parse_template_part)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Resolvable::Template {
                authored: document,
                parts,
            })
        }
        _ => Ok(Resolvable::Literal(document)),
    }
}

fn parse_template_part(document: JsonDocument) -> Result<TemplatePart, JsValue> {
    let Some(kind) = field(&document, "kind").filter(|value| value.as_ref().is_string()) else {
        return Ok(TemplatePart::Invalid);
    };
    let kind_text = crate::parse_string(&kind.to_json_text())?;
    match kind_text.to_string_lossy().as_str() {
        "text" => match optional_string(&document, "value")? {
            Some(value) => Ok(TemplatePart::Text(value)),
            None => Ok(TemplatePart::Invalid),
        },
        "insert" => {
            let value = field(&document, "value")
                .ok_or_else(|| crate::error("Invalid template insert part"))?;
            let format = match optional_string(&document, "format")?
                .map(|value| value.to_string_lossy())
                .as_deref()
            {
                Some("json") => TemplateFormat::Json,
                Some("urlEncoded") => TemplateFormat::UrlEncoded,
                _ => TemplateFormat::Text,
            };
            Ok(TemplatePart::Insert {
                value: Box::new(parse_resolvable(value)?),
                format,
            })
        }
        _ => Ok(TemplatePart::Unknown { kind: kind_text }),
    }
}

fn node_json(node: &WorkflowNode) -> String {
    let mut values = vec![
        (
            "id",
            serde_json::to_string(&node.id).expect("string serializes"),
        ),
        (
            "kind",
            serde_json::to_string(&node.kind).expect("string serializes"),
        ),
        ("config", node.config.to_json_text()),
    ];
    if let Some(name) = &node.name {
        values.push(("name", json_string(name)));
    }
    if let Some(disabled) = node.disabled {
        values.push(("disabled", disabled.to_string()));
    }
    if let Some(ui) = node.ui {
        values.push((
            "ui",
            json_object([("x", ui.x.to_string()), ("y", ui.y.to_string())]),
        ));
    }
    json_object(values)
}

fn edge_json(edge: &WorkflowEdge) -> String {
    let mut values = vec![
        (
            "id",
            serde_json::to_string(&edge.id).expect("string serializes"),
        ),
        (
            "from",
            serde_json::to_string(&edge.from).expect("string serializes"),
        ),
        (
            "to",
            serde_json::to_string(&edge.to).expect("string serializes"),
        ),
    ];
    if let Some(label) = &edge.label {
        values.push((
            "label",
            serde_json::to_string(label).expect("string serializes"),
        ));
    }
    json_object(values)
}

fn v3_flow_json(flow: &V3Flow) -> String {
    let mut values = vec![
        ("schemaVersion", flow.schema_version.to_string()),
        (
            "id",
            serde_json::to_string(&flow.id).expect("string serializes"),
        ),
        ("name", json_string(&flow.name)),
        ("createdAt", json_string(&flow.created_at)),
        ("updatedAt", json_string(&flow.updated_at)),
        (
            "entryNodeId",
            serde_json::to_string(&flow.entry_node_id).expect("string serializes"),
        ),
        ("nodes", json_array(flow.nodes.iter().map(node_json))),
        ("edges", json_array(flow.edges.iter().map(edge_json))),
    ];
    if let Some(description) = &flow.description {
        values.push(("description", json_string(description)));
    }
    if !flow.variables.is_empty() {
        values.push((
            "variables",
            json_array(flow.variables.iter().map(|variable| {
                let mut value = vec![(
                    "name",
                    serde_json::to_string(&variable.name).expect("string serializes"),
                )];
                if let Some(label) = &variable.label {
                    value.push(("label", json_string(label)));
                }
                if let Some(sensitive) = variable.sensitive {
                    value.push(("sensitive", sensitive.to_string()));
                }
                if let Some(default) = &variable.default {
                    value.push(("default", default.to_json_text()));
                }
                if let Some(required) = variable.required {
                    value.push(("required", required.to_string()));
                }
                json_object(value)
            })),
        ));
    }
    if let Some(meta) = &flow.meta {
        values.push((
            "meta",
            json_object([
                ("tags", json_array(meta.tags.iter().map(json_string))),
                (
                    "bindings",
                    json_array(meta.bindings.iter().map(|binding| {
                        json_object([
                            (
                                "kind",
                                serde_json::to_string(&binding.kind).expect("string serializes"),
                            ),
                            ("value", json_string(&binding.value)),
                        ])
                    })),
                ),
            ]),
        ));
    }
    json_object(values)
}

fn v2_flow_json(flow: &V2Flow) -> String {
    let mut values = vec![
        (
            "id",
            serde_json::to_string(&flow.id).expect("string serializes"),
        ),
        ("name", json_string(&flow.name)),
        ("version", flow.version.to_string()),
        (
            "meta",
            json_object([
                (
                    "createdAt",
                    flow.meta
                        .as_ref()
                        .and_then(|meta| meta.created_at.as_ref())
                        .map(json_string)
                        .unwrap_or_else(|| "null".into()),
                ),
                (
                    "updatedAt",
                    flow.meta
                        .as_ref()
                        .and_then(|meta| meta.updated_at.as_ref())
                        .map(json_string)
                        .unwrap_or_else(|| "null".into()),
                ),
                (
                    "tags",
                    json_array(
                        flow.meta
                            .as_ref()
                            .map(|meta| meta.tags.iter().map(json_string).collect::<Vec<_>>())
                            .unwrap_or_default(),
                    ),
                ),
                (
                    "bindings",
                    json_array(
                        flow.meta
                            .as_ref()
                            .map(|meta| {
                                meta.bindings
                                    .iter()
                                    .map(|binding| {
                                        json_object([
                                            (
                                                "type",
                                                serde_json::to_string(&binding.r#type)
                                                    .expect("string serializes"),
                                            ),
                                            ("value", json_string(&binding.value)),
                                        ])
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default(),
                    ),
                ),
            ]),
        ),
        (
            "nodes",
            json_array(flow.nodes.iter().map(|node| {
                let mut value = vec![
                    (
                        "id",
                        serde_json::to_string(&node.id).expect("string serializes"),
                    ),
                    (
                        "type",
                        serde_json::to_string(&node.r#type).expect("string serializes"),
                    ),
                ];
                if let Some(name) = &node.name {
                    value.push(("name", json_string(name)));
                }
                if let Some(disabled) = node.disabled {
                    value.push(("disabled", disabled.to_string()));
                }
                if let Some(config) = &node.config {
                    value.push(("config", config.to_json_text()));
                }
                if let Some(ui) = node.ui {
                    value.push((
                        "ui",
                        json_object([("x", ui.x.to_string()), ("y", ui.y.to_string())]),
                    ));
                }
                json_object(value)
            })),
        ),
        (
            "edges",
            json_array(flow.edges.iter().map(|edge| {
                let mut value = vec![
                    (
                        "id",
                        serde_json::to_string(&edge.id).expect("string serializes"),
                    ),
                    (
                        "from",
                        serde_json::to_string(&edge.from).expect("string serializes"),
                    ),
                    (
                        "to",
                        serde_json::to_string(&edge.to).expect("string serializes"),
                    ),
                ];
                if let Some(label) = &edge.label {
                    value.push((
                        "label",
                        serde_json::to_string(label).expect("string serializes"),
                    ));
                }
                json_object(value)
            })),
        ),
    ];
    if let Some(description) = &flow.description {
        values.push(("description", json_string(description)));
    }
    if !flow.variables.is_empty() {
        values.push((
            "variables",
            json_array(flow.variables.iter().map(|variable| {
                let mut value = vec![(
                    "key",
                    serde_json::to_string(&variable.key).expect("string serializes"),
                )];
                if let Some(label) = &variable.label {
                    value.push(("label", json_string(label)));
                }
                if let Some(sensitive) = variable.sensitive {
                    value.push(("sensitive", sensitive.to_string()));
                }
                if let Some(default) = &variable.default {
                    value.push(("default", default.to_json_text()));
                }
                if variable.required == Some(true) {
                    value.push(("rules", "{\"required\":true}".into()));
                }
                json_object(value)
            })),
        ));
    }
    json_object(values)
}

fn conversion_json<T>(
    result: workflow::ConversionResult<T>,
    serialize: impl FnOnce(&T) -> String,
) -> String {
    let mut values = vec![
        ("success", result.is_success().to_string()),
        (
            "errors",
            json_array(
                result
                    .errors
                    .into_iter()
                    .map(|error| serde_json::to_string(&error).expect("string serializes")),
            ),
        ),
        (
            "warnings",
            json_array(
                result
                    .warnings
                    .into_iter()
                    .map(|warning| serde_json::to_string(&warning).expect("string serializes")),
            ),
        ),
    ];
    if let Some(data) = result.data.as_ref() {
        values.push(("data", serialize(data)));
    }
    json_object(values)
}

fn v2_flow(document: &JsonDocument) -> Result<V2Flow, JsValue> {
    let meta = field(document, "meta")
        .filter(|value| value.as_ref().is_object())
        .map(|meta| -> Result<V2Meta, JsValue> {
            let tags = object_array(&meta, "tags")?
                .into_iter()
                .map(|value| crate::parse_string(&value.to_json_text()))
                .collect::<Result<Vec<_>, _>>()?;
            let bindings = object_array(&meta, "bindings")?
                .iter()
                .map(|binding| {
                    Ok(V2Binding {
                        r#type: required_identifier(binding, "type")?,
                        value: required_string(binding, "value")?,
                    })
                })
                .collect::<Result<Vec<_>, JsValue>>()?;
            Ok(V2Meta {
                created_at: optional_string(&meta, "createdAt")?,
                updated_at: optional_string(&meta, "updatedAt")?,
                tags,
                bindings,
            })
        })
        .transpose()?;
    let variables = object_array(document, "variables")?
        .iter()
        .map(|variable| {
            let rules = field(variable, "rules");
            Ok(V2Variable {
                key: optional_string(variable, "key")?
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default(),
                label: optional_string(variable, "label")?,
                sensitive: optional_bool(variable, "sensitive")?,
                default: field(variable, "default"),
                required: rules
                    .as_ref()
                    .map(|rules| optional_bool(rules, "required"))
                    .transpose()?
                    .flatten(),
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    let nodes = object_array(document, "nodes")?
        .iter()
        .map(|node| {
            Ok(V2Node {
                id: optional_string(node, "id")?
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default(),
                r#type: optional_string(node, "type")?
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default(),
                name: optional_string(node, "name")?,
                disabled: optional_bool(node, "disabled")?,
                config: field(node, "config"),
                ui: field(node, "ui").and_then(|ui| {
                    let x = field(&ui, "x").and_then(|value| value.as_ref().as_f64())?;
                    let y = field(&ui, "y").and_then(|value| value.as_ref().as_f64())?;
                    (x.is_finite() && y.is_finite()).then_some(CanvasPoint { x, y })
                }),
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    let edges = object_array(document, "edges")?
        .iter()
        .map(|edge| {
            Ok(V2Edge {
                id: optional_string(edge, "id")?
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default(),
                from: optional_string(edge, "from")?
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default(),
                to: optional_string(edge, "to")?
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default(),
                label: optional_string(edge, "label")?.map(|value| value.to_string_lossy()),
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    let subflow_ids = field(document, "subflows")
        .and_then(|value| value.into_object_fields())
        .unwrap_or_default()
        .into_iter()
        .map(|(key, _)| key.to_string_lossy())
        .collect();
    Ok(V2Flow {
        id: optional_string(document, "id")?
            .map(|value| value.to_string_lossy())
            .unwrap_or_default(),
        name: optional_string(document, "name")?.unwrap_or_else(|| JsString::from("")),
        version: optional_number(document, "version")?.unwrap_or(2.0),
        description: optional_string(document, "description")?,
        meta,
        variables,
        nodes,
        edges,
        subflow_ids,
    })
}

fn v3_flow(document: &JsonDocument) -> Result<V3Flow, JsValue> {
    let flow = workflow_flow(document)?;
    let variables = object_array(document, "variables")?
        .iter()
        .map(|variable| {
            Ok(workflow::V3Variable {
                name: required_identifier(variable, "name")?,
                label: optional_string(variable, "label")?,
                sensitive: optional_bool(variable, "sensitive")?,
                default: field(variable, "default"),
                required: optional_bool(variable, "required")?,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    let meta = field(document, "meta")
        .filter(|value| value.as_ref().is_object())
        .map(|meta| -> Result<workflow::V3Meta, JsValue> {
            Ok(workflow::V3Meta {
                tags: object_array(&meta, "tags")?
                    .iter()
                    .map(|value| crate::parse_string(&value.to_json_text()))
                    .collect::<Result<Vec<_>, _>>()?,
                bindings: object_array(&meta, "bindings")?
                    .iter()
                    .map(|binding| {
                        Ok(workflow::V3Binding {
                            kind: required_identifier(binding, "kind")?,
                            value: required_string(binding, "value")?,
                        })
                    })
                    .collect::<Result<Vec<_>, JsValue>>()?,
            })
        })
        .transpose()?;
    Ok(V3Flow {
        schema_version: optional_number(document, "schemaVersion")?.unwrap_or(3.0) as u8,
        id: flow.id,
        name: required_string(document, "name")?,
        description: optional_string(document, "description")?,
        created_at: required_string(document, "createdAt")?,
        updated_at: required_string(document, "updatedAt")?,
        entry_node_id: flow.entry_node_id,
        nodes: flow.nodes,
        edges: flow.edges,
        variables,
        meta,
    })
}

fn v2_trigger(document: &JsonDocument) -> Result<V2Trigger, JsValue> {
    let kind =
        optional_string(document, "type")?.map(|value| match value.to_string_lossy().as_str() {
            "url" => V2TriggerKind::Url,
            "command" => V2TriggerKind::Command,
            "manual" => V2TriggerKind::Manual,
            "schedule" => V2TriggerKind::Schedule,
            "element" => V2TriggerKind::Element,
            _ => V2TriggerKind::Unknown(value),
        });
    let matches = object_array(document, "match")?
        .iter()
        .map(parse_url_rule)
        .collect::<Result<Vec<_>, _>>()?;
    let schedule = field(document, "schedule")
        .filter(|value| value.as_ref().is_object())
        .map(|schedule| {
            let kind = required_identifier(&schedule, "type")?;
            match kind.as_str() {
                "interval" => Ok(V2Schedule::Interval {
                    interval_ms: optional_number(&schedule, "intervalMs")?.unwrap_or(60_000.0),
                }),
                "daily" => Ok(V2Schedule::Daily {
                    time: optional_string(&schedule, "time")?,
                }),
                "weekly" => {
                    let days = match field(&schedule, "days") {
                        None => None,
                        Some(days) => Some(
                            days.into_array_values()
                                .ok_or_else(|| crate::error("Expected weekly days array"))?
                                .into_iter()
                                .map(|day| {
                                    day.as_ref()
                                        .as_f64()
                                        .filter(|value| value.is_finite() && value.fract() == 0.0)
                                        .map(|value| value as i64)
                                        .ok_or_else(|| crate::error("Expected integer weekday"))
                                })
                                .collect::<Result<Vec<_>, _>>()?,
                        ),
                    };
                    Ok(V2Schedule::Weekly {
                        time: optional_string(&schedule, "time")?,
                        days,
                    })
                }
                _ => Err(crate::error("Unknown V2 schedule type")),
            }
        })
        .transpose()?;
    Ok(V2Trigger {
        id: required_identifier(document, "id")?,
        kind,
        flow_id: required_identifier(document, "flowId")?,
        enabled: optional_bool(document, "enabled")?,
        matches,
        command_key: optional_string(document, "commandKey")?,
        schedule,
    })
}

fn trigger_json(trigger: &workflow::V3Trigger) -> String {
    match trigger {
        workflow::V3Trigger::Manual {
            id,
            flow_id,
            enabled,
        } => json_object([
            ("id", serde_json::to_string(id).expect("string serializes")),
            ("kind", "\"manual\"".into()),
            (
                "flowId",
                serde_json::to_string(flow_id).expect("string serializes"),
            ),
            ("enabled", enabled.to_string()),
        ]),
        workflow::V3Trigger::Url {
            id,
            flow_id,
            enabled,
            matches,
        } => json_object([
            ("id", serde_json::to_string(id).expect("string serializes")),
            ("kind", "\"url\"".into()),
            (
                "flowId",
                serde_json::to_string(flow_id).expect("string serializes"),
            ),
            ("enabled", enabled.to_string()),
            (
                "match",
                json_array(matches.iter().map(|rule| {
                    json_object([
                        (
                            "kind",
                            serde_json::to_string(&match rule.kind {
                                UrlMatchKind::Url => "url",
                                UrlMatchKind::Domain => "domain",
                                UrlMatchKind::Path => "path",
                            })
                            .expect("string serializes"),
                        ),
                        ("value", json_string(&rule.value)),
                    ])
                })),
            ),
        ]),
        workflow::V3Trigger::Command {
            id,
            flow_id,
            enabled,
            command_key,
        } => json_object([
            ("id", serde_json::to_string(id).expect("string serializes")),
            ("kind", "\"command\"".into()),
            (
                "flowId",
                serde_json::to_string(flow_id).expect("string serializes"),
            ),
            ("enabled", enabled.to_string()),
            ("commandKey", json_string(command_key)),
        ]),
        workflow::V3Trigger::Cron {
            id,
            flow_id,
            enabled,
            cron,
        } => json_object([
            ("id", serde_json::to_string(id).expect("string serializes")),
            ("kind", "\"cron\"".into()),
            (
                "flowId",
                serde_json::to_string(flow_id).expect("string serializes"),
            ),
            ("enabled", enabled.to_string()),
            ("cron", json_string(cron)),
        ]),
    }
}

/// Reusable indexed flow plus variable context held entirely in the WASM realm.
#[wasm_bindgen]
pub struct WorkflowHandle {
    context: WorkflowContext,
}

#[wasm_bindgen]
impl WorkflowHandle {
    /// Parses a V3 flow and variables once for repeated traversal and resolution decisions.
    #[wasm_bindgen(constructor)]
    pub fn new(flow_json: &str, variables_json: &str) -> Result<WorkflowHandle, JsValue> {
        let flow = workflow_flow(&crate::parse_json(flow_json)?)?;
        let variables = variable_store(crate::parse_json(variables_json)?)?;
        Ok(Self {
            context: WorkflowContext::new(flow, variables),
        })
    }

    /// Chooses the next node using label/default/sole-edge precedence without graph reserialization.
    pub fn next_node(
        &self,
        node_id: &str,
        label_json: Option<String>,
    ) -> Result<Option<String>, JsValue> {
        let label = label_json.as_deref().map(crate::parse_string).transpose()?;
        let label = label.as_ref().map(JsString::to_string_lossy);
        Ok(self
            .context
            .flow()
            .next_node(node_id, label.as_deref())
            .map(str::to_owned))
    }

    /// Returns the first authored node source position for host identity-preserving lookup.
    pub fn node_index(&self, node_id: &str) -> Option<u32> {
        self.context
            .flow()
            .node_index(node_id)
            .and_then(|index| u32::try_from(index).ok())
    }

    /// Returns outgoing edge source positions so the host can retain original edge objects.
    pub fn out_edge_indices(&self, node_id: &str) -> String {
        json_array(
            self.context
                .flow()
                .out_edge_indices(node_id)
                .map(|index| index.to_string()),
        )
    }

    /// Returns incoming edge source positions so the host can retain original edge objects.
    pub fn in_edge_indices(&self, node_id: &str) -> String {
        json_array(
            self.context
                .flow()
                .in_edge_indices(node_id)
                .map(|index| index.to_string()),
        )
    }

    /// Returns the source position of the first outgoing edge carrying `label`.
    pub fn edge_index_by_label(
        &self,
        node_id: &str,
        label_json: &str,
    ) -> Result<Option<u32>, JsValue> {
        let label = crate::parse_string(label_json)?;
        Ok(self
            .context
            .flow()
            .edge_index_by_label(node_id, &label.to_string_lossy())
            .and_then(|index| u32::try_from(index).ok()))
    }

    /// Returns the first depth-first cycle path, including its repeated terminal node.
    pub fn detect_cycle(&self) -> String {
        self.context
            .flow()
            .detect_cycle()
            .map(|path| {
                json_array(
                    path.into_iter()
                        .map(|id| serde_json::to_string(&id).expect("string serializes")),
                )
            })
            .unwrap_or_else(|| String::from("null"))
    }

    /// Returns reachable node ids in JavaScript depth-first Set insertion order.
    pub fn reachable_node_ids(&self) -> String {
        json_array(
            self.context
                .flow()
                .reachable_node_ids_in_dfs_order()
                .into_iter()
                .map(|id| serde_json::to_string(&id).expect("string serializes")),
        )
    }

    /// Returns V3 validation errors and preserves first-cycle discovery ordering.
    pub fn validate_dag(&self) -> String {
        let validation = self.context.flow().validate_dag();
        json_object([
            ("ok", validation.is_ok().to_string()),
            (
                "errors",
                json_array(validation.errors.iter().map(|error| {
                    json_object([
                        (
                            "code",
                            serde_json::to_string(error.code.as_str()).expect("string serializes"),
                        ),
                        (
                            "message",
                            serde_json::to_string(&error.message).expect("string serializes"),
                        ),
                    ])
                })),
            ),
        ])
    }

    /// Resolves generic JSON through the supplied real expression callback when needed.
    pub fn resolve_json(
        &self,
        resolvable_json: &str,
        evaluator: &Function,
    ) -> Result<String, JsValue> {
        let value = parse_resolvable(crate::parse_json(resolvable_json)?)?;
        let result = self
            .context
            .resolver(
                &HostExpressionEvaluator {
                    callback: evaluator,
                },
                &BrowserIntrinsics,
            )
            .json(&value)
            .map_err(crate::error)?;
        Ok(result.to_json_text())
    }

    /// Resolves a string with exact template authored/parts behavior and lossless UTF-16 output JSON.
    pub fn resolve_string(
        &self,
        resolvable_json: &str,
        evaluator: &Function,
    ) -> Result<String, JsValue> {
        let value = parse_resolvable(crate::parse_json(resolvable_json)?)?;
        let result = self
            .context
            .resolver(
                &HostExpressionEvaluator {
                    callback: evaluator,
                },
                &BrowserIntrinsics,
            )
            .string(&value)
            .map_err(crate::error)?;
        Ok(json_string(&result))
    }

    /// Resolves a finite number; blank variable strings retain the legacy rejection path.
    pub fn resolve_number(
        &self,
        resolvable_json: &str,
        evaluator: &Function,
    ) -> Result<f64, JsValue> {
        let value = parse_resolvable(crate::parse_json(resolvable_json)?)?;
        self.context
            .resolver(
                &HostExpressionEvaluator {
                    callback: evaluator,
                },
                &BrowserIntrinsics,
            )
            .number(&value)
            .map_err(crate::error)
    }

    /// Applies host-decided variable patches without rebuilding the indexed graph.
    pub fn apply_variable_patch(&mut self, patch_json: &str) -> Result<(), JsValue> {
        let patch = variable_store(crate::parse_json(patch_json)?)?;
        self.context.variables_mut().extend(patch);
        Ok(())
    }

    /// Applies ordered set/delete operations without rebuilding the indexed flow.
    pub fn apply_variable_operations(&mut self, operations_json: &str) -> Result<(), JsValue> {
        let operations = crate::parse_json(operations_json)?
            .into_array_values()
            .ok_or_else(|| crate::error("Expected variable operations array"))?;
        for operation in operations {
            let kind = operation
                .get("op")
                .map(|value| value.to_owned().to_js_string())
                .ok_or_else(|| crate::error("Variable operation missing op"))?;
            let name = operation
                .get("name")
                .map(|value| value.to_owned().to_js_string())
                .ok_or_else(|| crate::error("Variable operation missing name"))?;
            match kind.to_string_lossy().as_str() {
                "set" => {
                    let value = operation
                        .get("value")
                        .map(|value| value.to_owned())
                        .unwrap_or_else(|| JsonDocument::from(Value::Null));
                    self.context
                        .variables_mut()
                        .insert(name.to_string_lossy(), value);
                }
                "delete" => {
                    self.context
                        .variables_mut()
                        .shift_remove(&name.to_string_lossy());
                }
                _ => return Err(crate::error("Unknown variable operation")),
            }
        }
        Ok(())
    }
}

/// Converts a V2 flow with host-supplied conversion time and browser locale ordering.
#[wasm_bindgen]
pub fn workflow_convert_v2_to_v3(
    flow_json: &str,
    conversion_time_json: &str,
) -> Result<String, JsValue> {
    let flow = v2_flow(&crate::parse_json(flow_json)?)?;
    let time = crate::parse_string(conversion_time_json)?;
    Ok(conversion_json(
        workflow::convert_v2_flow(&flow, time, &BrowserIntrinsics),
        v3_flow_json,
    ))
}

/// Converts a V3 flow back to the legacy builder's V2 representation.
#[wasm_bindgen]
pub fn workflow_convert_v3_to_v2(flow_json: &str) -> Result<String, JsValue> {
    let result = workflow::convert_v3_flow(&v3_flow(&crate::parse_json(flow_json)?)?);
    Ok(conversion_json(result, v2_flow_json))
}

/// Converts one V2 trigger, retaining omitted versus explicit weekly `days` arrays.
#[wasm_bindgen]
pub fn workflow_convert_v2_trigger(trigger_input_json: &str) -> Result<String, JsValue> {
    let trigger = v2_trigger(&crate::parse_json(trigger_input_json)?)?;
    Ok(conversion_json(
        workflow::convert_v2_trigger(&trigger, &BrowserIntrinsics),
        trigger_json,
    ))
}

/// Compiles and matches URL trigger rules through actual browser URL and String intrinsics.
#[wasm_bindgen]
pub fn workflow_url_matches(rules_json: &str, raw_url_json: &str) -> Result<bool, JsValue> {
    let rules = crate::parse_json(rules_json)?
        .into_array_values()
        .ok_or_else(|| crate::error("Expected URL rules array"))?
        .iter()
        .map(parse_url_rule)
        .collect::<Result<Vec<_>, _>>()?;
    let raw_url = crate::parse_string(raw_url_json)?;
    let Some(parsed) = parse_browser_url(&raw_url) else {
        return Ok(false);
    };
    Ok(
        CompiledUrlRules::compile(&rules, &BrowserIntrinsics).matches(
            &raw_url,
            &parsed,
            &BrowserIntrinsics,
        ),
    )
}

fn parse_browser_url(raw_url: &JsString) -> Option<UrlParts> {
    let parsed = BrowserUrl::new(&crate::intrinsics::to_js_string(raw_url)).ok()?;
    Some(UrlParts {
        hostname: parsed.hostname().into(),
        pathname: parsed.pathname().into(),
    })
}

/// Reusable normalized URL trigger rules held in the WASM realm.
#[wasm_bindgen]
pub struct WorkflowUrlRules {
    rules: CompiledUrlRules,
}

#[wasm_bindgen]
impl WorkflowUrlRules {
    /// Compiles authored rules once using browser String normalization semantics.
    #[wasm_bindgen(constructor)]
    pub fn new(rules_json: &str) -> Result<Self, JsValue> {
        let rules = crate::parse_json(rules_json)?
            .into_array_values()
            .ok_or_else(|| crate::error("Expected URL rules array"))?
            .iter()
            .map(parse_url_rule)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            rules: CompiledUrlRules::compile(&rules, &BrowserIntrinsics),
        })
    }

    /// Matches a raw URL using browser URL parsing and the retained compiled rules.
    pub fn matches(&self, raw_url_json: &str) -> Result<bool, JsValue> {
        let raw_url = crate::parse_string(raw_url_json)?;
        Ok(parse_browser_url(&raw_url)
            .is_some_and(|parsed| self.rules.matches(&raw_url, &parsed, &BrowserIntrinsics)))
    }
}

/// Computes V3 retry timing from explicit host random data without reading timers or globals.
#[wasm_bindgen]
pub fn workflow_retry_delay(
    policy_json: &str,
    attempt: f64,
    random_sample: f64,
) -> Result<f64, JsValue> {
    let policy = crate::parse_json(policy_json)?;
    let backoff = match optional_string(&policy, "backoff")?
        .map(|value| value.to_string_lossy())
        .as_deref()
    {
        Some("linear") => RetryBackoff::Linear,
        Some("exponential") | Some("exp") => RetryBackoff::Exponential,
        _ => RetryBackoff::None,
    };
    let jitter = match optional_string(&policy, "jitter")?
        .map(|value| value.to_string_lossy())
        .as_deref()
    {
        Some("full") => RetryJitter::Full,
        _ => RetryJitter::None,
    };
    Ok(workflow::compute_retry_delay_ms(
        RetryPolicy {
            interval_ms: optional_number(&policy, "intervalMs")?.unwrap_or(0.0),
            max_interval_ms: optional_number(&policy, "maxIntervalMs")?,
            backoff,
            jitter,
        },
        attempt,
        random_sample,
    ))
}

fn legacy_rule_value(rule: &JsValue) -> Result<JsString, JsValue> {
    if rule.is_null() || rule.is_undefined() {
        return Err(crate::error("Legacy URL rule is nullish"));
    }
    let value = host_property_get(rule, &JsValue::from_str("value"))?;
    let value = if value.is_truthy() {
        value
    } else {
        JsValue::from_str("")
    };
    Ok(crate::intrinsics::from_js_string(&javascript_string(
        &value,
    )))
}

fn legacy_url_rule(rule: &JsValue) -> Result<Option<UrlMatchRule>, JsValue> {
    let value = legacy_rule_value(rule)?;
    let kind = host_property_get(rule, &JsValue::from_str("kind"))?;
    let Some(kind) = kind.as_string().and_then(|kind| match kind.as_str() {
        "url" => Some(UrlMatchKind::Url),
        "domain" => Some(UrlMatchKind::Domain),
        "path" => Some(UrlMatchKind::Path),
        _ => None,
    }) else {
        return Ok(None);
    };
    Ok(Some(UrlMatchRule { kind, value }))
}

fn host_property_get(value: &JsValue, key: &JsValue) -> Result<JsValue, JsValue> {
    Reflect::get(&javascript_object(value), key)
}

fn legacy_assign_lookup(source: &JsValue, segments: &[JsString]) -> JsValue {
    let result: Result<JsValue, JsValue> = (|| {
        let mut current = source.clone();
        for segment in segments {
            if current.is_null() || current.is_undefined() {
                return Ok(JsValue::UNDEFINED);
            }
            current =
                host_property_get(&current, &crate::intrinsics::to_js_string(segment).into())?;
        }
        Ok(current)
    })();
    result.unwrap_or(JsValue::UNDEFINED)
}

fn legacy_handler_lookup(source: &JsValue, path: &JsString) -> Result<JsValue, JsValue> {
    if path.utf16_len() == 0 || !source.is_object() || source.is_null() {
        return Ok(source.clone());
    }
    let mut current = source.clone();
    for segment in workflow::legacy_handler_path_segments(path) {
        if current.is_null() || current.is_undefined() || !current.is_object() {
            return Ok(JsValue::UNDEFINED);
        }
        current = Reflect::get(&current, &crate::intrinsics::to_js_string(&segment).into())?;
    }
    Ok(current)
}

fn legacy_template_replacement(scope: &JsValue, key: &JsString) -> Result<JsString, JsValue> {
    let value = host_property_get(scope, &crate::intrinsics::to_js_string(key).into())?;
    if value.is_null() || value.is_undefined() {
        return Ok(JsString::from_string(""));
    }
    Ok(crate::intrinsics::from_js_string(&javascript_string(
        &value,
    )))
}

pub(crate) fn expand_legacy_string(
    template: &JsString,
    scope: &JsValue,
) -> Result<JsString, JsValue> {
    workflow::expand_legacy_braces(template, |key| legacy_template_replacement(scope, key))
}

fn legacy_expand_templates_inner(
    value: &JsValue,
    scope: &JsValue,
    object_prototype: &JsValue,
) -> Result<JsValue, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(value.clone());
    }
    if value.is_string() {
        let template = crate::intrinsics::from_js_string(value.unchecked_ref::<WebString>());
        let expanded = expand_legacy_string(&template, scope)?;
        return Ok(crate::intrinsics::to_js_string(&expanded).into());
    }
    if Array::is_array(value) {
        let source = value.unchecked_ref::<Array>();
        let output = Array::new_with_length(source.length());
        for index in 0..source.length() {
            let key = JsValue::from_f64(f64::from(index));
            if Reflect::has(value, &key)? {
                let expanded = legacy_expand_templates_inner(
                    &Reflect::get(value, &key)?,
                    scope,
                    object_prototype,
                )?;
                Reflect::set(&output, &key, &expanded)?;
            }
        }
        return Ok(output.into());
    }
    if !value.is_object() {
        return Ok(value.clone());
    }
    let prototype: JsValue = Reflect::get_prototype_of(value)?.into();
    if !prototype.is_null() && prototype != *object_prototype {
        return Ok(value.clone());
    }
    let output = Object::new();
    for key in Object::keys(&javascript_object(value)).iter() {
        let expanded =
            legacy_expand_templates_inner(&Reflect::get(value, &key)?, scope, object_prototype)?;
        Reflect::set(&output, &key, &expanded)?;
    }
    Ok(output.into())
}

/// Expands legacy `{name}` placeholders without serializing host-owned values.
#[wasm_bindgen]
pub fn workflow_legacy_expand_templates_deep(
    value: JsValue,
    scope: JsValue,
) -> Result<JsValue, JsValue> {
    let object_prototype: JsValue = Reflect::get_prototype_of(&Object::new())?.into();
    legacy_expand_templates_inner(&value, &scope, &object_prototype)
}

/// Applies legacy assignment paths while preserving source and target JavaScript handles.
#[wasm_bindgen]
pub fn workflow_legacy_apply_assign(
    target: JsValue,
    source: JsValue,
    assign: JsValue,
) -> Result<(), JsValue> {
    if !assign.is_truthy() {
        return Ok(());
    }
    for entry in Object::entries(&javascript_object(&assign)).iter() {
        let entry = entry.unchecked_into::<Array>();
        let name = entry.get(0);
        let path = entry.get(1);
        let path = crate::intrinsics::from_js_string(&javascript_string(&path));
        let value = legacy_assign_lookup(&source, &workflow::legacy_assign_path_segments(&path));
        Reflect::set(&target, &name, &value)?;
    }
    Ok(())
}

/// Reads one legacy action-handler path without changing undefined into a serialized value.
#[wasm_bindgen]
pub fn workflow_legacy_handler_lookup(source: JsValue, path: JsValue) -> Result<JsValue, JsValue> {
    let path = crate::intrinsics::from_js_string(&javascript_string(&path));
    legacy_handler_lookup(&source, &path)
}

/// Matches legacy URL triggers with their raw prefix and substring behavior.
#[wasm_bindgen]
pub fn workflow_legacy_url_matches(rules: JsValue, raw_url: JsValue) -> bool {
    (|| {
        if !Array::is_array(&rules) {
            return Err(crate::error("Legacy URL rules must be an array"));
        }
        let raw_url = crate::intrinsics::from_js_string(&javascript_string(&raw_url));
        let parsed = parse_browser_url(&raw_url).ok_or_else(|| crate::error("Invalid URL"))?;
        for rule in rules.unchecked_into::<Array>().iter() {
            let Some(rule) = legacy_url_rule(&rule)? else {
                continue;
            };
            if workflow::legacy_url_matches(&[rule], &raw_url, &parsed) {
                return Ok(true);
            }
        }
        Ok(false)
    })()
    .unwrap_or(false)
}

/// Computes legacy action retry timing from an explicit host random sample.
#[wasm_bindgen]
pub fn workflow_legacy_retry_delay(
    policy: JsValue,
    retry_index: f64,
    random_sample: f64,
) -> Result<f64, JsValue> {
    let backoff = match Reflect::get(&policy, &JsValue::from_str("backoff"))?
        .as_string()
        .as_deref()
    {
        Some("linear") => RetryBackoff::Linear,
        Some("exp") => RetryBackoff::Exponential,
        _ => RetryBackoff::None,
    };
    let jitter = match Reflect::get(&policy, &JsValue::from_str("jitter"))?
        .as_string()
        .as_deref()
    {
        Some("full") => RetryJitter::Full,
        _ => RetryJitter::None,
    };
    let interval_ms = javascript_number(&Reflect::get(&policy, &JsValue::from_str("intervalMs"))?);
    let max_interval = Reflect::get(&policy, &JsValue::from_str("maxIntervalMs"))?;
    let max_interval_ms = (!max_interval.is_undefined()).then(|| javascript_number(&max_interval));
    Ok(workflow::compute_legacy_retry_delay_ms(
        LegacyRetryPolicy {
            interval_ms,
            max_interval_ms,
            backoff,
            jitter,
        },
        retry_index,
        random_sample,
    ))
}
