//! Record-and-replay graph conversion policy shared by native and browser hosts.

use std::collections::HashMap;

use humanchrome_contracts::CONTRACT;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};
use thiserror::Error;

/// A JSON field that distinguishes an omitted field from an explicit `null`.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum JsonField {
    /// The field was not present in the source object.
    #[default]
    Absent,
    /// The field was present, including when its value was JSON `null`.
    Value(Value),
}

impl JsonField {
    /// Returns whether the source omitted this field.
    #[must_use]
    pub const fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }

    fn value(&self) -> Option<&Value> {
        match self {
            Self::Absent => None,
            Self::Value(value) => Some(value),
        }
    }
}

impl Serialize for JsonField {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Absent => serializer.serialize_unit(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for JsonField {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Value::deserialize(deserializer).map(Self::Value)
    }
}

/// A record/replay node, retaining unrecognized JSON fields during graph ordering.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RRNode {
    /// Stable node identifier.
    pub id: String,
    /// Declarative record/replay step type.
    #[serde(rename = "type")]
    pub r#type: String,
    /// Per-step configuration, preserving absent versus explicit `null`.
    #[serde(default, skip_serializing_if = "JsonField::is_absent")]
    pub config: JsonField,
    /// Additional node fields that graph ordering must preserve.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A directed record/replay graph edge.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RREdge {
    /// Edge identifier.
    pub id: String,
    /// Source node identifier.
    pub from: String,
    /// Destination node identifier.
    pub to: String,
    /// Optional branch label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A linear-step graph representation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Dag {
    /// Graph nodes in source order.
    pub nodes: Vec<RRNode>,
    /// Directed sequential edges.
    pub edges: Vec<RREdge>,
}

/// An edge references a source node that does not exist in the graph.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("Cannot read properties of undefined (reading 'push')")]
pub struct GraphError {
    /// The missing source-node identifier.
    pub from: String,
}

fn graph_constant(section: &str, key: &str) -> &'static str {
    CONTRACT["declarativeInputs"]["graph"][section][key]
        .as_str()
        .expect("generated graph contract must contain the requested string constant")
}
/// Returns the generated record/replay step-type constants without mirroring them in Rust.
#[must_use]
pub fn rr_step_types() -> &'static Map<String, Value> {
    CONTRACT["declarativeInputs"]["graph"]["rrStepTypes"]
        .as_object()
        .expect("generated graph contract must contain record/replay step types")
}

fn rr_step_type(key: &str) -> &'static str {
    graph_constant("rrStepTypes", key)
}

fn edge_label(key: &str) -> &'static str {
    graph_constant("edgeLabels", key)
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_none_or(|number| number != 0.0 && !number.is_nan()),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn normalize_target(value: &mut Value) {
    if is_truthy(value) && !matches!(value, Value::Array(_) | Value::Object(_)) {
        *value = Value::Object(Map::from_iter([(
            String::from("candidates"),
            Value::Array(Vec::new()),
        )]));
    }
}

fn copied_property(config: Option<&Value>, property: &str) -> Option<Value> {
    config
        .and_then(Value::as_object)
        .and_then(|object| object.get(property))
        .cloned()
}

fn nullish_config_property(config: Option<&Value>, property: &str) -> Option<Value> {
    copied_property(config, property).filter(|value| !value.is_null())
}

fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                0.0
            } else if matches!(trimmed, "Infinity" | "+Infinity") {
                f64::INFINITY
            } else if trimmed == "-Infinity" {
                f64::NEG_INFINITY
            } else if let Some(hex) = trimmed
                .strip_prefix("0x")
                .or_else(|| trimmed.strip_prefix("0X"))
            {
                u64::from_str_radix(hex, 16).map_or(f64::NAN, |value| value as f64)
            } else if let Some(binary) = trimmed
                .strip_prefix("0b")
                .or_else(|| trimmed.strip_prefix("0B"))
            {
                u64::from_str_radix(binary, 2).map_or(f64::NAN, |value| value as f64)
            } else if let Some(octal) = trimmed
                .strip_prefix("0o")
                .or_else(|| trimmed.strip_prefix("0O"))
            {
                u64::from_str_radix(octal, 8).map_or(f64::NAN, |value| value as f64)
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Array(values) if values.is_empty() => 0.0,
        _ => f64::NAN,
    }
}

fn js_number_value(number: f64) -> Value {
    if number.fract() == 0.0
        && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&number)
    {
        Value::Number(Number::from(number as i64))
    } else {
        Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

fn spread_json_object(destination: &mut Map<String, Value>, value: Option<&Value>) {
    match value {
        Some(Value::Object(object)) => {
            for (key, value) in object {
                destination.insert(key.clone(), value.clone());
            }
        }
        Some(Value::Array(values)) => {
            for (index, value) in values.iter().enumerate() {
                destination.insert(index.to_string(), value.clone());
            }
        }
        _ => {}
    }
}

/// Orders nodes with the legacy Kahn traversal and its cycle fallback.
///
/// The function intentionally preserves the TypeScript implementation's duplicate-id behavior:
/// lookup maps retain the final node for an identifier, while the initial ready queue still
/// includes every source-position whose identifier has zero indegree. A cycle or unresolved
/// target returns the original node order.
///
/// # Errors
///
/// Returns [`GraphError`] when an edge has no source node, matching the JavaScript failure path.
pub fn topo_order<'source>(
    nodes: &'source [RRNode],
    edges: &[RREdge],
) -> Result<Vec<&'source RRNode>, GraphError> {
    let mut node_by_id = HashMap::with_capacity(nodes.len());
    let mut indegree = HashMap::with_capacity(nodes.len() + edges.len());
    let mut nexts = HashMap::with_capacity(nodes.len());

    for (index, node) in nodes.iter().enumerate() {
        node_by_id.insert(node.id.as_str(), index);
        indegree.insert(node.id.as_str(), 0_i64);
        nexts.entry(node.id.as_str()).or_insert_with(Vec::new);
    }
    for edge in edges {
        *indegree.entry(edge.to.as_str()).or_insert(0) += 1;
    }
    for edge in edges {
        let Some(destinations) = nexts.get_mut(edge.from.as_str()) else {
            return Err(GraphError {
                from: edge.from.clone(),
            });
        };
        destinations.push(edge.to.as_str());
    }

    let mut ready: Vec<&str> = nodes
        .iter()
        .filter(|node| indegree.get(node.id.as_str()).copied().unwrap_or(0) == 0)
        .map(|node| node.id.as_str())
        .collect();
    let mut next_ready = 0;
    let mut ordered = Vec::with_capacity(nodes.len());

    while let Some(id) = ready.get(next_ready).copied() {
        next_ready += 1;
        let Some(&node_index) = node_by_id.get(id) else {
            continue;
        };
        ordered.push(&nodes[node_index]);
        for &target in nexts
            .get(id)
            .expect("node identifiers initialize adjacency lists")
        {
            let target_indegree = indegree.entry(target).or_insert(0);
            *target_indegree -= 1;
            if *target_indegree == 0 {
                ready.push(target);
            }
        }
    }

    if ordered.len() == nodes.len() {
        Ok(ordered)
    } else {
        Ok(nodes.iter().collect())
    }
}

/// Converts a Flow V2 node into its legacy linear-step JSON representation.
#[must_use]
pub fn map_node_to_step(node: &RRNode) -> Value {
    let config = node.config.value();
    if node.r#type == rr_step_type("DELAY") {
        let sleep = nullish_config_property(config, "sleep")
            .or_else(|| nullish_config_property(config, "ms"))
            .unwrap_or_else(|| Value::Number(Number::from(1_000)));
        let sleep = js_number(&sleep);
        return Value::Object(Map::from_iter([
            (String::from("id"), Value::String(node.id.clone())),
            (
                String::from("type"),
                Value::String(rr_step_type("WAIT").to_owned()),
            ),
            (
                String::from("condition"),
                Value::Object(Map::from_iter([(
                    String::from("sleep"),
                    js_number_value(if sleep.is_nan() {
                        sleep
                    } else {
                        sleep.max(0.0)
                    }),
                )])),
            ),
        ]));
    }

    let mut step = Map::new();
    step.insert(String::from("id"), Value::String(node.id.clone()));
    step.insert(String::from("type"), Value::String(node.r#type.clone()));
    spread_json_object(&mut step, config);

    for property in ["target", "start", "end"] {
        if let Some(value) = step.get_mut(property) {
            normalize_target(value);
        }
    }
    Value::Object(step)
}

/// Converts nodes to legacy steps after applying legacy graph ordering.
///
/// # Errors
///
/// Returns [`GraphError`] when an edge has no source node.
pub fn nodes_to_steps(nodes: &[RRNode], edges: &[RREdge]) -> Result<Vec<Value>, GraphError> {
    if edges.is_empty() {
        return Ok(nodes.iter().map(map_node_to_step).collect());
    }
    Ok(topo_order(nodes, edges)?
        .into_iter()
        .map(map_node_to_step)
        .collect())
}

/// Removes a legacy step's identity fields to form a node configuration.
#[must_use]
pub fn map_step_to_node_config(step: &Value) -> Map<String, Value> {
    let mut config = Map::new();
    spread_json_object(&mut config, Some(step));
    config.shift_remove("id");
    config.shift_remove("type");

    for property in ["target", "start", "end"] {
        if let Some(value) = config.get_mut(property) {
            normalize_target(value);
        }
    }
    config
}

/// Converts legacy linear steps into Flow V2 nodes.
#[must_use]
pub fn steps_to_nodes(steps: &[Value]) -> Vec<RRNode> {
    steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let object = step.as_object();
            let id = object
                .and_then(|object| object.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map_or_else(|| format!("n_{index}"), ToOwned::to_owned);
            let r#type = object
                .and_then(|object| object.get("type"))
                .and_then(Value::as_str)
                .filter(|step_type| !step_type.is_empty())
                .map_or_else(|| rr_step_type("SCRIPT").to_owned(), ToOwned::to_owned);
            RRNode {
                id,
                r#type,
                config: JsonField::Value(Value::Object(map_step_to_node_config(step))),
                extra: Map::new(),
            }
        })
        .collect()
}

/// Converts linear steps into a sequential directed acyclic graph.
#[must_use]
pub fn steps_to_dag(steps: &[Value]) -> Dag {
    let nodes = steps_to_nodes(steps);
    let edges = nodes
        .windows(2)
        .enumerate()
        .map(|(index, pair)| RREdge {
            id: format!("e_{index}_{}_{}", pair[0].id, pair[1].id),
            from: pair[0].id.clone(),
            to: pair[1].id.clone(),
            label: Some(edge_label("DEFAULT").to_owned()),
        })
        .collect();
    Dag { nodes, edges }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        JsonField, RREdge, RRNode, map_node_to_step, map_step_to_node_config, nodes_to_steps,
        steps_to_dag, steps_to_nodes, topo_order,
    };

    fn node(id: &str, step_type: &str) -> RRNode {
        RRNode {
            id: id.into(),
            r#type: step_type.into(),
            config: JsonField::Absent,
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn topo_order_preserves_fifo_ready_order_and_cycle_fallback() {
        let nodes = vec![node("a", "click"), node("b", "fill"), node("c", "wait")];
        let edges = vec![
            RREdge {
                id: "e1".into(),
                from: "a".into(),
                to: "c".into(),
                label: None,
            },
            RREdge {
                id: "e2".into(),
                from: "b".into(),
                to: "c".into(),
                label: None,
            },
        ];
        assert_eq!(
            topo_order(&nodes, &edges).expect("known edge sources"),
            vec![&nodes[0], &nodes[1], &nodes[2]]
        );

        let cyclic = vec![
            RREdge {
                id: "e3".into(),
                from: "a".into(),
                to: "b".into(),
                label: None,
            },
            RREdge {
                id: "e4".into(),
                from: "b".into(),
                to: "a".into(),
                label: None,
            },
        ];
        assert_eq!(
            topo_order(&nodes, &cyclic).expect("known edge sources"),
            nodes.iter().collect::<Vec<_>>()
        );
    }

    #[test]
    fn topo_order_retains_legacy_duplicate_identifier_behavior() {
        let first = node("same", "click");
        let second = node("same", "fill");
        let nodes = [first, second];
        assert_eq!(
            topo_order(&nodes, &[]).expect("empty graph edges"),
            vec![&nodes[1], &nodes[1]]
        );
    }

    #[test]
    fn topo_order_rejects_an_unknown_edge_source() {
        let err = topo_order(
            &[node("present", "click")],
            &[RREdge {
                id: "bad".into(),
                from: "missing".into(),
                to: "present".into(),
                label: None,
            }],
        )
        .expect_err("missing source must follow the JavaScript error path");
        assert_eq!(err.from, "missing");
    }

    #[test]
    fn generic_mapping_spreads_config_and_only_normalizes_truthy_targets() {
        let mapped = map_node_to_step(&RRNode {
            id: "node-id".into(),
            r#type: "click".into(),
            config: JsonField::Value(json!({
                "id": "config-id",
                "type": "fill",
                "target": "not-an-object",
                "start": false,
                "end": [],
                "value": "text"
            })),
            extra: serde_json::Map::new(),
        });
        assert_eq!(
            mapped,
            json!({
                "id": "config-id",
                "type": "fill",
                "target": { "candidates": [] },
                "start": false,
                "end": [],
                "value": "text"
            })
        );
    }

    #[test]
    fn delay_uses_nullish_default_and_clamps_negative_values() {
        let default_delay = map_node_to_step(&RRNode {
            id: "d1".into(),
            r#type: "delay".into(),
            config: JsonField::Value(json!({ "sleep": null, "ms": -4 })),
            extra: serde_json::Map::new(),
        });
        assert_eq!(
            default_delay,
            json!({ "id": "d1", "type": "wait", "condition": { "sleep": 0 } })
        );

        let fallback_delay = map_node_to_step(&RRNode {
            id: "d2".into(),
            r#type: "delay".into(),
            config: JsonField::Absent,
            extra: serde_json::Map::new(),
        });
        assert_eq!(
            fallback_delay,
            json!({ "id": "d2", "type": "wait", "condition": { "sleep": 1000 } })
        );
    }

    #[test]
    fn reverse_mapping_and_dag_keep_generated_edge_ids_and_defaults() {
        let steps = vec![
            json!({ "id": "a", "type": "click", "target": "selector", "other": null }),
            json!({ "id": "a", "type": "wait", "condition": { "sleep": 0 } }),
        ];
        assert_eq!(
            map_step_to_node_config(&steps[0]),
            serde_json::Map::from_iter([
                ("target".into(), json!({ "candidates": [] })),
                ("other".into(), serde_json::Value::Null),
            ])
        );
        let dag = steps_to_dag(&steps);
        assert_eq!(dag.nodes[0].id, "a");
        assert_eq!(dag.edges[0].id, "e_0_a_a");
        assert_eq!(dag.edges[0].label.as_deref(), Some("default"));
        assert_eq!(
            nodes_to_steps(&dag.nodes, &dag.edges).expect("generated edge"),
            vec![
                json!({ "id": "a", "type": "click", "target": { "candidates": [] }, "other": null }),
                steps[1].clone(),
            ]
        );
    }

    #[test]
    fn non_object_steps_receive_legacy_identity_defaults() {
        let nodes = steps_to_nodes(&[json!(null), json!({ "id": "", "type": "" })]);
        assert_eq!(nodes[0].id, "n_0");
        assert_eq!(nodes[0].r#type, "script");
        assert_eq!(nodes[1].id, "n_1");
        assert_eq!(nodes[1].r#type, "script");
    }

    #[test]
    fn node_deserialization_preserves_missing_config_separately_from_null() {
        let absent: RRNode = serde_json::from_value(json!({ "id": "a", "type": "click" }))
            .expect("valid node without config");
        let explicit_null: RRNode =
            serde_json::from_value(json!({ "id": "a", "type": "click", "config": null }))
                .expect("valid node with null config");

        assert!(absent.config.is_absent());
        assert_eq!(
            explicit_null.config,
            JsonField::Value(serde_json::Value::Null)
        );
        assert_eq!(
            serde_json::to_value(absent).expect("serializable node"),
            json!({ "id": "a", "type": "click" })
        );
        assert_eq!(
            serde_json::to_value(explicit_null).expect("serializable node"),
            json!({ "id": "a", "type": "click", "config": null })
        );
    }
}
