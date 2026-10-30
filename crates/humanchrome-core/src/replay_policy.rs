//! Portable legacy record/replay policy with browser effects supplied by JavaScript hosts.

use serde::Serialize;

use crate::graph;

mod variables;
pub use variables::recording_variable_append_plan;

const MINIMAL_HYBRID_ACTION_TYPES: [&str; 8] = [
    "fill",
    "key",
    "scroll",
    "drag",
    "wait",
    "delay",
    "screenshot",
    "assert",
];
const MIGRATED_ACTION_TYPES: [&str; 11] = [
    "navigate",
    "click",
    "dblclick",
    "fill",
    "key",
    "scroll",
    "drag",
    "wait",
    "delay",
    "screenshot",
    "assert",
];
const NEEDS_VALIDATION_TYPES: [&str; 11] = [
    "extract",
    "http",
    "script",
    "openTab",
    "switchTab",
    "closeTab",
    "handleDownload",
    "if",
    "foreach",
    "while",
    "switchFrame",
];
const LEGACY_ONLY_TYPES: [&str; 4] = [
    "triggerEvent",
    "setAttribute",
    "loopElements",
    "executeFlow",
];

/// The immutable action-type sets used by legacy record/replay execution routing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionModeSets {
    /// Low-risk action types selected by the default hybrid configuration.
    pub minimal_hybrid_action_types: Vec<&'static str>,
    /// Action types selected when hybrid mode has an explicit empty allowlist.
    pub migrated_action_types: Vec<&'static str>,
    /// Action types present but deliberately not selected by the hybrid default.
    pub needs_validation_types: Vec<&'static str>,
    /// Action types that must remain on the legacy executor in hybrid mode.
    pub legacy_only_types: Vec<&'static str>,
}

/// Returns the routing sets without mirroring their membership in JavaScript.
#[must_use]
pub fn execution_mode_sets() -> ExecutionModeSets {
    ExecutionModeSets {
        minimal_hybrid_action_types: MINIMAL_HYBRID_ACTION_TYPES.to_vec(),
        migrated_action_types: MIGRATED_ACTION_TYPES.to_vec(),
        needs_validation_types: NEEDS_VALIDATION_TYPES.to_vec(),
        legacy_only_types: LEGACY_ONLY_TYPES.to_vec(),
    }
}

/// Selects whether one step uses the action executor under legacy execution-mode precedence.
#[must_use]
pub fn should_use_actions(
    mode: &str,
    step_type: &str,
    legacy_only_types: Option<&[String]>,
    actions_allowlist: Option<&[String]>,
) -> bool {
    match mode {
        "legacy" => false,
        "actions" => true,
        "hybrid" => {
            if legacy_only_types.is_some_and(|types| types.iter().any(|kind| kind == step_type)) {
                return false;
            }
            if let Some(types) = actions_allowlist.filter(|types| !types.is_empty()) {
                return types.iter().any(|kind| kind == step_type);
            }
            MIGRATED_ACTION_TYPES.contains(&step_type)
        }
        _ => false,
    }
}

/// Computes a legacy retry delay after JavaScript has performed its observable numeric coercions.
#[must_use]
pub fn retry_delay_ms(base: f64, backoff: &str, attempt: f64) -> f64 {
    if base > 0.0 {
        if backoff == "exp" {
            base * 2.0_f64.powf(attempt)
        } else {
            base
        }
    } else {
        0.0
    }
}

/// Computes ActionRegistry's total attempts from the authored retries-beyond-first value.
#[must_use]
pub fn action_max_attempts(retries: f64) -> f64 {
    if retries.is_nan() {
        f64::NAN
    } else {
        1.0 + retries.max(0.0).floor()
    }
}

/// Normalizes a supplied timeout exactly as the legacy `Math.max(0, Math.floor(...))` policy.
#[must_use]
pub fn timeout_ms(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.floor().max(0.0)
    }
}

/// Returns whether the current zero-based retry failure has exhausted the host-coerced limit.
#[must_use]
pub fn retry_exhausted(attempt: f64, max: f64) -> bool {
    attempt >= max
}

/// Tests whether an action failure remains eligible for ActionRegistry retry.
#[must_use]
pub fn should_retry_action(
    has_policy: bool,
    retries: f64,
    error_code: Option<&str>,
    retry_on: Option<&[String]>,
) -> bool {
    has_policy
        && retries
            .partial_cmp(&0.0)
            .is_none_or(std::cmp::Ordering::is_gt)
        && error_code.is_some_and(|code| {
            code != "VALIDATION_ERROR"
                && retry_on
                    .filter(|codes| !codes.is_empty())
                    .is_none_or(|codes| codes.iter().any(|candidate| candidate == code))
        })
}

/// Clamps a foreach worker count with the historical 1–16 bounds.
#[must_use]
pub fn foreach_concurrency(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.clamp(1.0, 16.0)
    }
}

/// Clamps a while-loop bound with the historical 1–10,000 bounds.
#[must_use]
pub fn while_max_iterations(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.clamp(1.0, 10_000.0)
    }
}

/// Describes the portable control-flow operation without executing callbacks or expressions.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ControlPlan {
    /// A foreach loop with host-owned item values and callback execution.
    Foreach {
        /// The variable that provides the source list.
        list_var: String,
        /// The variable assigned for each source item.
        item_var: String,
        /// The subflow callback target.
        subflow_id: String,
        /// The bounded worker count.
        concurrency: f64,
    },
    /// A while loop with a host-owned expression callback.
    While {
        /// The subflow callback target.
        subflow_id: String,
        /// The bounded iteration count.
        max_iterations: f64,
    },
}

/// Validates a foreach declaration and returns its normalized control plan.
pub fn foreach_plan(
    list_var: Option<&str>,
    item_var: Option<&str>,
    subflow_id: Option<&str>,
    concurrency: f64,
) -> Result<ControlPlan, &'static str> {
    let Some(list_var) = list_var.filter(|value| !value.is_empty()) else {
        return Err("foreach: listVar and subflowId are required");
    };
    let Some(subflow_id) = subflow_id.filter(|value| !value.is_empty()) else {
        return Err("foreach: listVar and subflowId are required");
    };
    Ok(ControlPlan::Foreach {
        list_var: String::from(list_var),
        item_var: item_var
            .filter(|value| !value.is_empty())
            .map_or_else(|| String::from("item"), String::from),
        subflow_id: String::from(subflow_id),
        concurrency: foreach_concurrency(concurrency),
    })
}

/// Validates a while declaration and returns its normalized control plan.
pub fn while_plan(
    has_condition: bool,
    subflow_id: Option<&str>,
    max_iterations: f64,
) -> Result<ControlPlan, &'static str> {
    let Some(subflow_id) = subflow_id.filter(|value| !value.is_empty()) else {
        return Err("while: condition and subflowId are required");
    };
    if !has_condition {
        return Err("while: condition and subflowId are required");
    }
    Ok(ControlPlan::While {
        subflow_id: String::from(subflow_id),
        max_iterations: while_max_iterations(max_iterations),
    })
}

/// Selects an already host-evaluated branch label using legacy if-node fallback semantics.
#[must_use]
pub fn if_branch_label(
    labels: &[String],
    matching_index: Option<usize>,
    has_else: bool,
    else_label: &str,
) -> String {
    matching_index
        .and_then(|index| labels.get(index))
        .cloned()
        .or_else(|| has_else.then(|| String::from(else_label)))
        .unwrap_or_else(|| String::from("default"))
}

/// Validates the legacy if-node requirement before host expression evaluation.
#[must_use]
pub fn validate_if(has_branches: bool, has_condition: bool) -> Option<&'static str> {
    (!has_branches && !has_condition).then_some("Missing condition or branch")
}

/// The Rust-owned graph append decision for one recorded step.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedStepAppendPlan {
    /// The source node id if a sequential edge is required.
    pub previous_node_id: Option<String>,
    /// The generated sequential edge id when a predecessor exists.
    pub edge_id: Option<String>,
    /// The standard label used by sequential recorded edges.
    pub edge_label: &'static str,
}

/// Plans one sequential recorded-step append without owning JavaScript timestamps or node config values.
#[must_use]
pub fn recorded_step_append_plan(
    previous_node_id: Option<&str>,
    edge_count: usize,
    step_id: &str,
) -> RecordedStepAppendPlan {
    let previous_node_id = previous_node_id.map(String::from);
    let edge_id = previous_node_id
        .as_deref()
        .map(|previous| format!("e_{edge_count}_{previous}_{step_id}"));
    RecordedStepAppendPlan {
        previous_node_id,
        edge_id,
        edge_label: "default",
    }
}

/// The Rust-owned initial structure for a newly recorded workflow.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialFlowPlan {
    /// Flow identifier, retaining the authored nonempty string when supplied.
    pub id: String,
    /// Flow display name, retaining the authored nonempty string when supplied.
    pub name: String,
    /// The current record/replay DAG format version.
    pub version: u8,
    /// A meta object with host time values and authored object-spread fields.
    pub meta: serde_json::Map<String, serde_json::Value>,
}

/// Constructs a recorded-flow shell while the host owns timestamps and generated identifiers.
#[must_use]
pub fn initial_flow_plan(
    authored_meta: &serde_json::Value,
    generated_id: &str,
    timestamp: &str,
) -> InitialFlowPlan {
    let authored = authored_meta.as_object();
    let id = authored
        .and_then(|meta| meta.get("id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map_or_else(|| String::from(generated_id), String::from);
    let name = authored
        .and_then(|meta| meta.get("name"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map_or_else(|| String::from("new_workflow"), String::from);
    let mut meta = serde_json::Map::new();
    meta.insert(
        String::from("createdAt"),
        serde_json::Value::String(String::from(timestamp)),
    );
    meta.insert(
        String::from("updatedAt"),
        serde_json::Value::String(String::from(timestamp)),
    );
    if let Some(authored_meta) = authored
        .and_then(|flow| flow.get("meta"))
        .and_then(serde_json::Value::as_object)
    {
        for (key, value) in authored_meta {
            meta.insert(key.clone(), value.clone());
        }
    }
    InitialFlowPlan {
        id,
        name,
        version: 1,
        meta,
    }
}

/// A source projection used to plan recording-session graph mutation without serializing config.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordingNodeProjection {
    /// Caller-owned node id.
    pub id: String,
}

/// A source projection used to check the session's historical linear-edge invariant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordingEdgeProjection {
    /// Caller-owned destination id.
    pub to: String,
}

/// A recorded step identity and requested node type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordingStepProjection {
    /// Caller-owned stable step id.
    pub id: String,
    /// Requested node type.
    pub step_type: String,
}

/// A concrete linear edge selected by recording-session policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RecordingEdgePlan {
    /// Stable edge id.
    pub id: String,
    /// Source node id.
    pub from: String,
    /// Destination node id.
    pub to: String,
    /// Standard sequential edge label.
    pub label: &'static str,
}

/// One host operation which attaches a caller-owned config object at the selected node index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RecordingOperation {
    /// Replaces an existing node's type/config while retaining its other host-owned fields.
    Update {
        /// Incoming source-step position.
        step_index: usize,
        /// Existing node position.
        node_index: usize,
        /// Rust-selected node type.
        node_type: String,
        /// Whether the requested type was replaced with script.
        fallback_type: bool,
    },
    /// Adds a node and, when applicable, its preceding linear edge.
    Append {
        /// Incoming source-step position.
        step_index: usize,
        /// Destination node position after append.
        node_index: usize,
        /// Rust-selected node type.
        node_type: String,
        /// Whether the requested type was replaced with script.
        fallback_type: bool,
        /// Edge selected for the predecessor, if one exists in the cache.
        edge: Option<RecordingEdgePlan>,
    },
    /// Preserves the legacy stale-cache continue behavior.
    Skip {
        /// Incoming source-step position.
        step_index: usize,
    },
}

/// Cache state supplied by Rust after a recording graph mutation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCachePlan {
    /// Last source index for each node id, matching JavaScript Map overwrite behavior.
    pub node_indexes: Vec<(String, usize)>,
    /// The next generated edge sequence.
    pub edge_seq: usize,
}

/// The complete graph decision for one `appendSteps` call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingAppendPlan {
    /// Edges to install before applying operations when the starting graph is non-linear.
    pub rechain_before: Option<Vec<RecordingEdgePlan>>,
    /// Indexed update/append/skip operations whose configs remain host-owned.
    pub operations: Vec<RecordingOperation>,
    /// Edges to install after applying operations when the final graph is non-linear.
    pub rechain_after: Option<Vec<RecordingEdgePlan>>,
    /// The final cache state for the JavaScript session owner.
    pub cache: RecordingCachePlan,
}

/// A Rust-selected recording node type plus whether the legacy fallback was applied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingNodeTypePlan {
    /// Valid node type or the historical script fallback.
    pub node_type: String,
    /// Whether the authored type was unsupported.
    pub fallback_type: bool,
}

fn recording_node_type(step_type: &str) -> RecordingNodeTypePlan {
    let supported = graph::rr_step_types()
        .values()
        .any(|value| value.as_str() == Some(step_type))
        || matches!(step_type, "trigger" | "delay");
    if supported {
        RecordingNodeTypePlan {
            node_type: String::from(step_type),
            fallback_type: false,
        }
    } else {
        RecordingNodeTypePlan {
            node_type: String::from("script"),
            fallback_type: true,
        }
    }
}

/// Selects the recording node type for a legacy step type.
#[must_use]
pub fn recording_node_type_plan(step_type: &str) -> RecordingNodeTypePlan {
    recording_node_type(step_type)
}

fn recording_cache(nodes: &[RecordingNodeProjection], edge_seq: usize) -> RecordingCachePlan {
    let mut node_indexes = Vec::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        if node.id.is_empty() {
            continue;
        }
        if let Some(existing) = node_indexes.iter_mut().find(|(id, _)| id == &node.id) {
            existing.1 = index;
        } else {
            node_indexes.push((node.id.clone(), index));
        }
    }
    RecordingCachePlan {
        node_indexes,
        edge_seq,
    }
}

fn recording_linear_edges(nodes: &[RecordingNodeProjection]) -> Vec<RecordingEdgePlan> {
    nodes
        .windows(2)
        .enumerate()
        .map(|(index, pair)| RecordingEdgePlan {
            id: format!("e_{index}_{}_{}", pair[0].id, pair[1].id),
            from: pair[0].id.clone(),
            to: pair[1].id.clone(),
            label: "default",
        })
        .collect()
}

fn recording_invariant(
    nodes: &[RecordingNodeProjection],
    edges: &[RecordingEdgeProjection],
) -> bool {
    edges.len() == nodes.len().saturating_sub(1)
        && edges
            .last()
            .is_none_or(|edge| nodes.last().is_some_and(|node| edge.to == node.id))
}

/// Produces the cache state used by a recording session after start/rebuild operations.
#[must_use]
pub fn recording_cache_plan(
    nodes: &[RecordingNodeProjection],
    edge_seq: usize,
) -> RecordingCachePlan {
    recording_cache(nodes, edge_seq)
}

/// Plans full recording-session upsert, rechain, and sequential-edge policy without caller configs.
#[must_use]
pub fn recording_append_plan(
    source_nodes: &[RecordingNodeProjection],
    source_edges: &[RecordingEdgeProjection],
    source_cache: &[(String, usize)],
    edge_seq: usize,
    steps: &[RecordingStepProjection],
) -> RecordingAppendPlan {
    let rechain_before = (!recording_invariant(source_nodes, source_edges))
        .then(|| recording_linear_edges(source_nodes));
    let mut nodes = source_nodes.to_vec();
    let mut edges: Vec<RecordingEdgeProjection> = rechain_before.as_ref().map_or_else(
        || source_edges.to_vec(),
        |plans| {
            plans
                .iter()
                .map(|edge| RecordingEdgeProjection {
                    to: edge.to.clone(),
                })
                .collect()
        },
    );
    let mut cache = if rechain_before.is_some() {
        recording_cache(&nodes, edges.len())
    } else {
        RecordingCachePlan {
            node_indexes: source_cache.to_vec(),
            edge_seq,
        }
    };
    let mut operations = Vec::with_capacity(steps.len());
    let mut needs_rebuild = false;

    for (step_index, step) in steps.iter().enumerate() {
        let RecordingNodeTypePlan {
            node_type,
            fallback_type,
        } = recording_node_type(&step.step_type);
        if let Some((_, node_index)) = cache
            .node_indexes
            .iter()
            .find(|(node_id, _)| node_id == &step.id)
        {
            if nodes.get(*node_index).is_none() {
                needs_rebuild = true;
                operations.push(RecordingOperation::Skip { step_index });
            } else {
                operations.push(RecordingOperation::Update {
                    step_index,
                    node_index: *node_index,
                    node_type,
                    fallback_type,
                });
            }
            continue;
        }

        let node_index = nodes.len();
        let previous_node_id = nodes.last().map(|node| node.id.clone());
        nodes.push(RecordingNodeProjection {
            id: step.id.clone(),
        });
        cache.node_indexes.push((step.id.clone(), node_index));
        let edge = previous_node_id.as_deref().and_then(|previous| {
            cache
                .node_indexes
                .iter()
                .any(|(node_id, _)| node_id == previous)
                .then(|| {
                    let edge = RecordingEdgePlan {
                        id: format!("e_{}_{}_{}", cache.edge_seq, previous, step.id),
                        from: String::from(previous),
                        to: step.id.clone(),
                        label: "default",
                    };
                    cache.edge_seq += 1;
                    edges.push(RecordingEdgeProjection {
                        to: edge.to.clone(),
                    });
                    edge
                })
        });
        if previous_node_id.is_some() && edge.is_none() {
            needs_rebuild = true;
        }
        operations.push(RecordingOperation::Append {
            step_index,
            node_index,
            node_type,
            fallback_type,
            edge,
        });
    }

    let rechain_after = (needs_rebuild || !recording_invariant(&nodes, &edges))
        .then(|| recording_linear_edges(&nodes));
    if let Some(edges) = &rechain_after {
        cache = recording_cache(&nodes, edges.len());
    }
    RecordingAppendPlan {
        rechain_before,
        operations,
        rechain_after,
        cache,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hybrid_empty_allowlist_uses_migrated_set_but_undefined_uses_callers_default() {
        assert!(should_use_actions("hybrid", "navigate", None, Some(&[])));
        assert!(!should_use_actions(
            "hybrid",
            "navigate",
            None,
            Some(&[String::from("fill")]),
        ));
    }

    #[test]
    fn retry_eligibility_rejects_validation_errors_and_honors_nonempty_filters() {
        assert!(!should_retry_action(
            true,
            1.0,
            Some("VALIDATION_ERROR"),
            None
        ));
        assert!(!should_retry_action(
            true,
            1.0,
            Some("TIMEOUT"),
            Some(&[String::from("UNKNOWN")]),
        ));
        assert!(should_retry_action(
            true,
            1.0,
            Some("TIMEOUT"),
            Some(&[String::from("TIMEOUT")]),
        ));
    }

    #[test]
    fn initial_flow_preserves_authored_meta_overrides_like_object_spread() {
        let authored = serde_json::json!({
            "id": "authored",
            "meta": { "createdAt": "old", "extra": true },
        });
        let plan = initial_flow_plan(&authored, "generated", "now");
        assert_eq!(plan.id, "authored");
        assert_eq!(plan.meta["createdAt"], serde_json::json!("old"));
        assert_eq!(plan.meta["updatedAt"], serde_json::json!("now"));
        assert_eq!(plan.meta["extra"], serde_json::json!(true));
    }

    #[test]
    fn numeric_clamps_retain_javascript_nan_behavior() {
        assert!(foreach_concurrency(f64::NAN).is_nan());
        assert!(while_max_iterations(f64::NAN).is_nan());
        assert_eq!(timeout_ms(-0.5), 0.0);
    }

    #[test]
    fn recording_append_preserves_upsert_then_monotonic_linear_append() {
        let nodes = vec![
            RecordingNodeProjection {
                id: String::from("first"),
            },
            RecordingNodeProjection {
                id: String::from("second"),
            },
        ];
        let edges = vec![RecordingEdgeProjection {
            to: String::from("second"),
        }];
        let plan = recording_append_plan(
            &nodes,
            &edges,
            &[(String::from("first"), 0), (String::from("second"), 1)],
            1,
            &[
                RecordingStepProjection {
                    id: String::from("second"),
                    step_type: String::from("script"),
                },
                RecordingStepProjection {
                    id: String::from("third"),
                    step_type: String::from("script"),
                },
            ],
        );
        assert!(plan.rechain_before.is_none());
        assert!(plan.rechain_after.is_none());
        assert!(matches!(
            &plan.operations[0],
            RecordingOperation::Update { node_index: 1, .. }
        ));
        assert!(matches!(
            &plan.operations[1],
            RecordingOperation::Append {
                edge: Some(RecordingEdgePlan { id, .. }),
                ..
            } if id == "e_1_second_third"
        ));
        assert_eq!(plan.cache.edge_seq, 2);
    }
}
