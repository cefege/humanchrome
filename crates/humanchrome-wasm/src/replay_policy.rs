//! WASM bindings for legacy record/replay policy while JavaScript retains effects and intrinsics.

use humanchrome_core::replay_policy;
use serde::Deserialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::{encode_serializable, error};

/// Plans variable upserts using native SameValueZero key identity, retaining opaque values in JS.
#[wasm_bindgen]
pub fn replay_recording_variable_append_plan(
    existing: js_sys::Array,
    incoming: js_sys::Array,
) -> Result<JsValue, JsValue> {
    let identities = js_sys::Map::new();
    let mut next = 0_u32;
    let mut keys = |values: js_sys::Array| {
        values
            .iter()
            .map(|value| {
                if !value.is_truthy() {
                    return None;
                }
                let previous = identities.get(&value);
                if let Some(id) = previous.as_f64() {
                    return Some(id as u32);
                }
                let id = next;
                next += 1;
                identities.set(&value, &JsValue::from_f64(f64::from(id)));
                Some(id)
            })
            .collect::<Vec<_>>()
    };
    let existing = keys(existing);
    let incoming = keys(incoming);
    serde_wasm_bindgen::to_value(&replay_policy::recording_variable_append_plan(
        &existing, &incoming,
    ))
    .map_err(error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeachInput {
    #[serde(default)]
    list_var: Value,
    #[serde(default)]
    item_var: Value,
    #[serde(default)]
    subflow_id: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhileInput {
    has_condition: bool,
    #[serde(default)]
    subflow_id: Value,
}
fn optional_string(value: &Value) -> Option<&str> {
    value.as_str()
}

fn parse<T: for<'de> Deserialize<'de>>(text: &str) -> Result<T, JsValue> {
    serde_json::from_str(text).map_err(error)
}

#[derive(Deserialize)]
struct RecordingNodeInput {
    id: String,
}

#[derive(Deserialize)]
struct RecordingEdgeInput {
    to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStepInput {
    id: String,
    #[serde(rename = "type")]
    step_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingAppendInput {
    nodes: Vec<RecordingNodeInput>,
    edges: Vec<RecordingEdgeInput>,
    cache: Vec<(String, usize)>,
    edge_seq: usize,
    steps: Vec<RecordingStepInput>,
}

/// Returns the execution-mode action sets owned by the Rust policy module.
#[wasm_bindgen]
pub fn replay_execution_mode_sets() -> Result<String, JsValue> {
    encode_serializable(&replay_policy::execution_mode_sets())
}

/// Routes a legacy record/replay step to actions or the legacy executor.
#[wasm_bindgen]
pub fn replay_should_use_actions(
    mode: String,
    step_type: String,
    legacy_only_json: String,
    actions_allowlist_json: String,
) -> Result<bool, JsValue> {
    let legacy_only: Option<Vec<String>> = parse(&legacy_only_json)?;
    let actions_allowlist: Option<Vec<String>> = parse(&actions_allowlist_json)?;
    Ok(replay_policy::should_use_actions(
        &mode,
        &step_type,
        legacy_only.as_deref(),
        actions_allowlist.as_deref(),
    ))
}

/// Applies the historical retry exhaustion comparison to host-coerced values.
#[wasm_bindgen]
pub fn replay_retry_exhausted(attempt: f64, max: f64) -> bool {
    replay_policy::retry_exhausted(attempt, max)
}

/// Computes one effect-free legacy retry delay after the host coerces numeric inputs.
#[wasm_bindgen]
pub fn replay_retry_delay_ms(base: f64, backoff: String, attempt: f64) -> f64 {
    replay_policy::retry_delay_ms(base, &backoff, attempt)
}

/// Computes ActionRegistry's total attempt count without scheduling retries.
#[wasm_bindgen]
pub fn replay_action_max_attempts(retries: f64) -> f64 {
    replay_policy::action_max_attempts(retries)
}

/// Normalizes a supplied ActionRegistry timeout without creating timers.
#[wasm_bindgen]
pub fn replay_timeout_ms(value: f64) -> f64 {
    replay_policy::timeout_ms(value)
}

/// Tests whether ActionRegistry may retry a result without inspecting its opaque payload.
#[wasm_bindgen]
pub fn replay_should_retry_action(
    has_policy: bool,
    retries: f64,
    error_code: Option<String>,
    retry_on_json: String,
) -> Result<bool, JsValue> {
    let retry_on: Option<Vec<String>> = parse(&retry_on_json)?;
    Ok(replay_policy::should_retry_action(
        has_policy,
        retries,
        error_code.as_deref(),
        retry_on.as_deref(),
    ))
}

/// Returns the exact bounded foreach control declaration without executing subflows.
#[wasm_bindgen]
pub fn replay_foreach_plan(input_json: String, concurrency: f64) -> Result<String, JsValue> {
    let input: ForeachInput = parse(&input_json)?;
    let plan = replay_policy::foreach_plan(
        optional_string(&input.list_var),
        optional_string(&input.item_var),
        optional_string(&input.subflow_id),
        concurrency,
    )
    .map_err(error)?;
    match plan {
        replay_policy::ControlPlan::Foreach {
            list_var,
            item_var,
            subflow_id,
            ..
        } => serde_json::to_string(&serde_json::json!({
            "kind": "foreach",
            "listVar": list_var,
            "itemVar": item_var,
            "subflowId": subflow_id,
        }))
        .map_err(error),
        replay_policy::ControlPlan::While { .. } => {
            Err(error("foreach policy returned while plan"))
        }
    }
}

/// Clamps a foreach worker count while retaining JavaScript NaN and infinity values.
#[wasm_bindgen]
pub fn replay_foreach_concurrency(value: f64) -> f64 {
    replay_policy::foreach_concurrency(value)
}

/// Returns the exact bounded while control declaration without evaluating its expression.
#[wasm_bindgen]
pub fn replay_while_plan(input_json: String, max_iterations: f64) -> Result<String, JsValue> {
    let input: WhileInput = parse(&input_json)?;
    let plan = replay_policy::while_plan(
        input.has_condition,
        optional_string(&input.subflow_id),
        max_iterations,
    )
    .map_err(error)?;
    match plan {
        replay_policy::ControlPlan::While { subflow_id, .. } => {
            serde_json::to_string(&serde_json::json!({
                "kind": "while",
                "subflowId": subflow_id,
            }))
            .map_err(error)
        }
        replay_policy::ControlPlan::Foreach { .. } => {
            Err(error("while policy returned foreach plan"))
        }
    }
}

/// Clamps a while iteration bound while retaining JavaScript NaN and infinity values.
#[wasm_bindgen]
pub fn replay_while_max_iterations(value: f64) -> f64 {
    replay_policy::while_max_iterations(value)
}

/// Selects a branch label after JavaScript evaluates user-authored expressions.
#[wasm_bindgen]
pub fn replay_if_branch_label(
    labels_json: String,
    matching_index_json: String,
    has_else: bool,
    else_label: String,
) -> Result<String, JsValue> {
    let labels: Vec<String> = parse(&labels_json)?;
    let matching_index: Option<usize> = parse(&matching_index_json)?;
    Ok(replay_policy::if_branch_label(
        &labels,
        matching_index,
        has_else,
        &else_label,
    ))
}

/// Validates an if declaration before host-owned condition evaluation.
#[wasm_bindgen]
pub fn replay_validate_if(has_branches: bool, has_condition: bool) -> Option<String> {
    replay_policy::validate_if(has_branches, has_condition).map(String::from)
}

/// Plans sequential DAG mutation for one recorded event without copying its opaque config.
#[wasm_bindgen]
pub fn replay_recorded_step_append_plan(
    previous_node_id: Option<String>,
    edge_count: usize,
    step_id: String,
) -> Result<String, JsValue> {
    encode_serializable(&replay_policy::recorded_step_append_plan(
        previous_node_id.as_deref(),
        edge_count,
        &step_id,
    ))
}

/// Rebuilds recording-session cache indexes without crossing opaque node config values.
#[wasm_bindgen]
pub fn replay_recording_cache_plan(nodes_json: String, edge_seq: usize) -> Result<String, JsValue> {
    let nodes: Vec<RecordingNodeInput> = parse(&nodes_json)?;
    let projections = nodes
        .into_iter()
        .map(|node| replay_policy::RecordingNodeProjection { id: node.id })
        .collect::<Vec<_>>();
    encode_serializable(&replay_policy::recording_cache_plan(&projections, edge_seq))
}

/// Plans all recording-session upsert/rechain decisions while JavaScript retains config values.
#[wasm_bindgen]
pub fn replay_recording_append_plan(input_json: String) -> Result<String, JsValue> {
    let input: RecordingAppendInput = parse(&input_json)?;
    let nodes = input
        .nodes
        .into_iter()
        .map(|node| replay_policy::RecordingNodeProjection { id: node.id })
        .collect::<Vec<_>>();
    let edges = input
        .edges
        .into_iter()
        .map(|edge| replay_policy::RecordingEdgeProjection { to: edge.to })
        .collect::<Vec<_>>();
    let steps = input
        .steps
        .into_iter()
        .map(|step| replay_policy::RecordingStepProjection {
            id: step.id,
            step_type: step.step_type,
        })
        .collect::<Vec<_>>();
    encode_serializable(&replay_policy::recording_append_plan(
        &nodes,
        &edges,
        &input.cache,
        input.edge_seq,
        &steps,
    ))
}

/// Selects a recording node type while preserving JavaScript's warning side effect in the host.
#[wasm_bindgen]
pub fn replay_recording_node_type_plan(step_type: String) -> Result<String, JsValue> {
    encode_serializable(&replay_policy::recording_node_type_plan(&step_type))
}

/// Constructs the immutable initial recorded-flow fields; the host retains empty arrays by identity.
#[wasm_bindgen]
pub fn replay_initial_flow_plan(
    authored_meta_json: String,
    generated_id: String,
    timestamp: String,
) -> Result<String, JsValue> {
    let authored_meta: Value = parse(&authored_meta_json)?;
    encode_serializable(&replay_policy::initial_flow_plan(
        &authored_meta,
        &generated_id,
        &timestamp,
    ))
}
