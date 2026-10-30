//! WASM bindings for legacy graph policy without coupling it to V3 workflow bindings.

use humanchrome_core::arguments::JsString;
use humanchrome_core::graph::{
    self, LegacyDelayProperty, LegacyEdgeProjection, LegacyNodeProjection, LegacyNumber,
};
use humanchrome_core::json_document::JsonDocument;
use wasm_bindgen::prelude::*;

use crate::{error, parse_json};

const NORMALIZED_PROPERTIES: [&str; 3] = ["target", "start", "end"];

fn required_string(document: &JsonDocument, key: &str) -> Result<JsString, JsValue> {
    let value = document
        .get(key)
        .ok_or_else(|| error(format_args!("{key} is required")))?;
    if !value.is_string() {
        return Err(error(format_args!("{key} must be a string")));
    }
    Ok(value.to_js_string())
}

fn optional_string(document: &JsonDocument, key: &str) -> Option<JsString> {
    document
        .get(key)
        .filter(|value| value.is_string())
        .map(|value| value.to_js_string())
}

fn bool_field(document: &JsonDocument, key: &str) -> bool {
    document
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn object_array(text: &str, name: &str) -> Result<Vec<JsonDocument>, JsValue> {
    parse_json(text)?
        .into_array_values()
        .ok_or_else(|| error(format_args!("{name} must be an array")))
}

fn nodes(text: &str) -> Result<Vec<LegacyNodeProjection>, JsValue> {
    object_array(text, "nodes")?
        .into_iter()
        .enumerate()
        .map(|(index, document)| {
            if !document.is_object() {
                return Err(error("node must be an object"));
            }
            Ok(LegacyNodeProjection {
                index,
                id: required_string(&document, "id")?,
                r#type: optional_string(&document, "type").unwrap_or_else(|| JsString::from("")),
            })
        })
        .collect()
}

fn edges(text: &str) -> Result<Vec<LegacyEdgeProjection>, JsValue> {
    object_array(text, "edges")?
        .into_iter()
        .enumerate()
        .map(|(index, document)| {
            if !document.is_object() {
                return Err(error("edge must be an object"));
            }
            Ok(LegacyEdgeProjection {
                index,
                from: required_string(&document, "from")?,
                to: required_string(&document, "to")?,
                label: optional_string(&document, "label"),
                is_default: bool_field(&document, "default"),
            })
        })
        .collect()
}

fn number(document: &JsonDocument) -> Result<LegacyNumber, JsValue> {
    let kind = required_string(document, "kind")?;
    match kind.as_utf8() {
        Some("nan") => Ok(LegacyNumber::Nan),
        Some("infinity") => Ok(LegacyNumber::PositiveInfinity),
        Some("-infinity") => Ok(LegacyNumber::NegativeInfinity),
        Some("finite") => document
            .get("value")
            .and_then(|value| value.as_f64())
            .map(LegacyNumber::Finite)
            .ok_or_else(|| error("finite number must have a numeric value")),
        _ => Err(error("unknown number kind")),
    }
}

fn delay_property(document: Option<JsonDocument>) -> Result<Option<LegacyDelayProperty>, JsValue> {
    let Some(document) = document else {
        return Ok(None);
    };
    if !document.is_object() {
        return Err(error("delay property must be an object"));
    }
    let is_nullish = bool_field(&document, "nullish");
    let number = if is_nullish {
        LegacyNumber::Finite(0.0)
    } else {
        number(&document)?
    };
    Ok(Some(LegacyDelayProperty { is_nullish, number }))
}

fn normalized_properties(document: &JsonDocument) -> Vec<&'static str> {
    let observations = NORMALIZED_PROPERTIES.map(|property| {
        let value = document.get(property);
        (
            property,
            value
                .as_ref()
                .and_then(|value| value.get("truthy"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            value
                .as_ref()
                .and_then(|value| value.get("object"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
        )
    });
    graph::legacy_normalized_properties(&observations)
}

fn json_string(value: &JsString) -> String {
    value.json_string_literal()
}

fn optional_index(index: Option<usize>) -> String {
    index.map_or_else(|| String::from("null"), |index| index.to_string())
}

fn indexes(values: &[usize]) -> String {
    values
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn number_json(value: LegacyNumber) -> String {
    match value {
        LegacyNumber::Finite(value) => {
            serde_json::to_string(&value).expect("finite f64 serializes")
        }
        LegacyNumber::Nan => String::from("\"nan\""),
        LegacyNumber::PositiveInfinity => String::from("\"infinity\""),
        LegacyNumber::NegativeInfinity => String::from("\"-infinity\""),
    }
}

fn step_plan_json(plan: graph::LegacyStepPlan) -> String {
    let properties = plan
        .normalized_properties
        .iter()
        .map(|property| serde_json::to_string(property).expect("static property serializes"))
        .collect::<Vec<_>>()
        .join(",");
    let sleep = plan.sleep.map_or_else(|| String::from("null"), number_json);
    format!(
        "{{\"id\":{},\"type\":{},\"delay\":{},\"sleep\":{},\"normalize\":[{}]}}",
        json_string(&plan.id),
        json_string(&plan.r#type),
        plan.is_delay,
        sleep,
        properties,
    )
}

/// Runs legacy scheduler graph policy over host projections, returning only source indexes.
#[wasm_bindgen]
pub fn graph_legacy_execution_plan(
    nodes_json: String,
    edges_json: String,
) -> Result<String, JsValue> {
    let nodes = nodes(&nodes_json)?;
    let edges = edges(&edges_json)?;
    let plan = graph::legacy_execution_plan(&nodes, &edges).map_err(error)?;
    Ok(format!(
        "{{\"hasCycle\":{},\"defaultEdgeIndexes\":[{}],\"orderedNodeIndexes\":[{}],\"executableNodeIndexes\":[{}],\"startNodeIndex\":{}}}",
        plan.has_cycle,
        indexes(&plan.default_edge_indexes),
        indexes(&plan.ordered_node_indexes),
        indexes(&plan.executable_node_indexes),
        optional_index(plan.start_node_index),
    ))
}

/// Orders an arbitrary legacy edge set with the historical Kahn/cycle-fallback policy.
#[wasm_bindgen]
pub fn graph_legacy_topo_order_indexes(
    nodes_json: String,
    edges_json: String,
) -> Result<String, JsValue> {
    let nodes = nodes(&nodes_json)?;
    let mut edges = edges(&edges_json)?;
    for edge in &mut edges {
        edge.is_default = true;
    }
    let plan = graph::legacy_execution_plan(&nodes, &edges).map_err(error)?;
    Ok(format!("[{}]", indexes(&plan.ordered_node_indexes)))
}

/// Orders legacy node-to-step source positions, preserving no-edge source order in Rust.
#[wasm_bindgen]
pub fn graph_legacy_nodes_to_step_indexes(
    nodes_json: String,
    edges_json: String,
) -> Result<String, JsValue> {
    let nodes = nodes(&nodes_json)?;
    let edges = edges(&edges_json)?;
    let indexes = graph::legacy_nodes_to_step_indexes(&nodes, &edges).map_err(error)?;
    crate::encode_serializable(&indexes)
}

/// Selects builder linear-step node positions after Rust filters trigger/default graph structure.
#[wasm_bindgen]
pub fn graph_legacy_builder_step_indexes(
    nodes_json: String,
    edges_json: String,
) -> Result<String, JsValue> {
    let nodes = nodes(&nodes_json)?;
    let edges = edges(&edges_json)?;
    let indexes = graph::legacy_builder_step_indexes(&nodes, &edges).map_err(error)?;
    crate::encode_serializable(&indexes)
}

/// Selects an exact legacy branch label without applying default-edge fallback.
#[wasm_bindgen]
pub fn graph_legacy_labeled_edge(
    edges_json: String,
    current_id_json: String,
    label_json: String,
) -> Result<Option<usize>, JsValue> {
    let edges = edges(&edges_json)?;
    let current_id = parse_json(&current_id_json)?.to_js_string();
    let label = parse_json(&label_json)?.to_js_string();
    Ok(graph::legacy_labeled_edge_index(
        &edges,
        &current_id,
        &label,
    ))
}

/// Selects the one delay property the host must coerce with JavaScript's `Number`.
#[wasm_bindgen]
pub fn graph_legacy_delay_source(sleep_is_nullish: bool, ms_is_nullish: bool) -> String {
    match graph::legacy_delay_source(sleep_is_nullish, ms_is_nullish) {
        graph::LegacyDelaySource::Sleep => String::from("sleep"),
        graph::LegacyDelaySource::Ms => String::from("ms"),
        graph::LegacyDelaySource::Default => String::from("default"),
    }
}

/// Clamps a single host-coerced legacy delay number through Rust policy.
#[wasm_bindgen]
pub fn graph_legacy_normalize_delay(number_input_json: String) -> Result<String, JsValue> {
    Ok(number_json(graph::legacy_normalize_delay(number(
        &parse_json(&number_input_json)?,
    )?)))
}

/// Selects a scheduler successor without serializing node or edge host metadata.
#[wasm_bindgen]
pub fn graph_legacy_next_edge(
    edges_json: String,
    current_id_json: String,
    label_json: String,
) -> Result<Option<usize>, JsValue> {
    let edges = edges(&edges_json)?;
    let current_id = parse_json(&current_id_json)?.to_js_string();
    let label = parse_json(&label_json)?.to_js_string();
    Ok(graph::legacy_next_edge_index(&edges, &current_id, &label))
}

/// Selects a trigger's first default successor without serializing host graph resources.
#[wasm_bindgen]
pub fn graph_legacy_default_successor(
    edges_json: String,
    current_id_json: String,
) -> Result<Option<usize>, JsValue> {
    let edges = edges(&edges_json)?;
    let current_id = parse_json(&current_id_json)?.to_js_string();
    Ok(graph::legacy_default_successor_index(&edges, &current_id))
}

/// Produces one core-owned step patch; the host reattaches only the original configuration object.
#[wasm_bindgen]
pub fn graph_legacy_node_to_step_plan(node_json: String) -> Result<String, JsValue> {
    let document = parse_json(&node_json)?;
    if !document.is_object() {
        return Err(error("node must be an object"));
    }
    let id = required_string(&document, "id")?;
    let node_type = required_string(&document, "type")?;
    let normalized = document
        .get("properties")
        .map_or_else(Vec::new, |properties| {
            normalized_properties(&properties.to_owned())
        });
    let delay = document.get("delay");
    let sleep = delay
        .as_ref()
        .and_then(|delay| delay.get("sleep"))
        .map(|value| value.to_owned());
    let ms = delay
        .as_ref()
        .and_then(|delay| delay.get("ms"))
        .map(|value| value.to_owned());
    let plan = graph::legacy_node_to_step_plan(
        id,
        node_type,
        normalized,
        delay_property(sleep)?,
        delay_property(ms)?,
    );
    Ok(step_plan_json(plan))
}

/// Produces default identifiers and types for legacy step-to-node conversion.
#[wasm_bindgen]
pub fn graph_legacy_steps_to_nodes_plan(steps_json: String) -> Result<String, JsValue> {
    let steps = object_array(&steps_json, "steps")?;
    let sources = steps
        .iter()
        .map(|step| (optional_string(step, "id"), optional_string(step, "type")))
        .collect::<Vec<_>>();
    let plans = graph::legacy_steps_to_node_plans(&sources);
    let nodes = plans
        .iter()
        .map(|(id, node_type)| {
            format!(
                "{{\"id\":{},\"type\":{}}}",
                json_string(id),
                json_string(node_type)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("[{nodes}]"))
}

/// Generates sequential legacy DAG edge identifiers from source node projections.
#[wasm_bindgen]
pub fn graph_legacy_sequential_edges(nodes_json: String) -> Result<String, JsValue> {
    let nodes = nodes(&nodes_json)?;
    let edges = graph::legacy_sequential_edges(&nodes)
        .iter()
        .map(|(id, from, to)| {
            format!(
                "{{\"id\":{},\"from\":{},\"to\":{},\"label\":{}}}",
                json_string(id),
                json_string(from),
                json_string(to),
                serde_json::to_string(graph::legacy_default_edge_label())
                    .expect("generated edge label serializes"),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("[{edges}]"))
}

/// Returns source positions of non-dangling edges for legacy flow normalization.
#[wasm_bindgen]
pub fn graph_legacy_valid_edge_indexes(
    nodes_json: String,
    edges_json: String,
) -> Result<String, JsValue> {
    let nodes = nodes(&nodes_json)?;
    let edges = edges(&edges_json)?;
    Ok(format!(
        "[{}]",
        indexes(&graph::legacy_valid_edge_indexes(&nodes, &edges))
    ))
}

/// Selects flow-store conversion and retained-versus-generated edge behavior.
#[wasm_bindgen]
pub fn graph_legacy_flow_normalization_plan(
    has_nodes: bool,
    has_steps: bool,
    nodes_json: String,
    edges_json: String,
) -> Result<String, JsValue> {
    let nodes = nodes(&nodes_json)?;
    let edges = edges(&edges_json)?;
    let plan = graph::legacy_flow_normalization_plan(has_nodes, has_steps, &nodes, &edges);
    Ok(format!(
        "{{\"convertSteps\":{},\"validEdgeIndexes\":[{}],\"useGeneratedEdges\":{}}}",
        plan.convert_steps,
        indexes(&plan.valid_edge_indexes),
        plan.use_generated_edges,
    ))
}
