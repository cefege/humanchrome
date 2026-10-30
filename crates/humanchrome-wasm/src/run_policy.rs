//! WASM bindings for portable V3 run, queue, recovery, and breakpoint policy.

use humanchrome_core::arguments::JsString;
use humanchrome_core::json_document::JsonDocument;
use humanchrome_core::run_policy::{
    self, Breakpoints, ErrorPlan, PolicyFieldSource, QueueOrderKey, RecoveryAction,
};
use js_sys::{Array, Reflect};
use wasm_bindgen::prelude::*;

use crate::{error, parse_json, parse_string};

fn optional_number(value: &JsValue, field_name: &str) -> Result<Option<f64>, JsValue> {
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    value
        .as_f64()
        .map(Some)
        .ok_or_else(|| error(format!("{field_name} must be a finite number")))
}

fn optional_status(value: Option<String>) -> Option<String> {
    value
}
fn field_is_non_nullish(object: &JsValue, field: &str) -> Result<bool, JsValue> {
    let value = Reflect::get(object, &JsValue::from_str(field))?;
    Ok(!value.is_null() && !value.is_undefined())
}

fn field_is_truthy(object: &JsValue, field: &str) -> Result<bool, JsValue> {
    Ok(Reflect::get(object, &JsValue::from_str(field))?.is_truthy())
}

fn recovery_action_name(action: RecoveryAction) -> &'static str {
    match action {
        RecoveryAction::Clean => "clean",
        RecoveryAction::Requeue => "requeue",
        RecoveryAction::AdoptPaused => "adoptPaused",
        RecoveryAction::Keep => "keep",
    }
}

fn error_plan_json(plan: ErrorPlan) -> String {
    let document = match plan {
        ErrorPlan::Stop => JsonDocument::object([("kind", JsonDocument::from("stop"))]),
        ErrorPlan::Continue => JsonDocument::object([("kind", JsonDocument::from("continue"))]),
        ErrorPlan::GotoEdgeLabel(label) => JsonDocument::object([
            ("kind", JsonDocument::from("goto")),
            (
                "target",
                JsonDocument::object([
                    ("kind", JsonDocument::from("edgeLabel")),
                    ("label", JsonDocument::string(label)),
                ]),
            ),
        ]),
        ErrorPlan::GotoNode(node_id) => JsonDocument::object([
            ("kind", JsonDocument::from("goto")),
            (
                "target",
                JsonDocument::object([
                    ("kind", JsonDocument::from("node")),
                    ("nodeId", JsonDocument::string(node_id)),
                ]),
            ),
        ]),
        ErrorPlan::RetryBase => JsonDocument::object([
            ("kind", JsonDocument::from("retry")),
            ("hasOverride", JsonDocument::from(false)),
        ]),
        ErrorPlan::RetryOverride => JsonDocument::object([
            ("kind", JsonDocument::from("retry")),
            ("hasOverride", JsonDocument::from(true)),
        ]),
    };
    document.to_json_text()
}

fn breakpoints_json(breakpoints: &Breakpoints, enabled_only: bool) -> String {
    let values = if enabled_only {
        breakpoints
            .enabled()
            .into_iter()
            .map(JsonDocument::string)
            .collect::<Vec<_>>()
    } else {
        breakpoints
            .all()
            .into_iter()
            .map(|(node_id, enabled)| {
                JsonDocument::object([
                    ("nodeId", JsonDocument::string(node_id)),
                    ("enabled", JsonDocument::from(enabled)),
                ])
            })
            .collect()
    };
    JsonDocument::array(values).to_json_text()
}

fn parse_node_ids(node_ids_json: &str) -> Result<Vec<JsString>, JsValue> {
    let node_ids = parse_json(node_ids_json)?
        .into_array_values()
        .ok_or_else(|| error("breakpoints must be an array"))?;
    node_ids
        .into_iter()
        .map(|node_id| {
            let value = node_id.as_ref();
            if !value.is_string() {
                return Err(error("breakpoint nodeId must be a string"));
            }
            Ok(value.to_js_string())
        })
        .collect()
}

/// Validates and normalizes queue priority and max-attempt inputs without reading browser state.
#[wasm_bindgen]
pub fn run_policy_normalize_enqueue(
    priority: JsValue,
    max_attempts: JsValue,
) -> Result<String, JsValue> {
    let priority = optional_number(&priority, "priority")?;
    let max_attempts = optional_number(&max_attempts, "maxAttempts")?;
    let normalized =
        run_policy::normalize_enqueue_numbers(priority, max_attempts).map_err(error)?;
    Ok(JsonDocument::object([
        (
            "priority",
            JsonDocument::from(serde_json::json!(normalized.priority)),
        ),
        (
            "maxAttempts",
            JsonDocument::from(serde_json::json!(normalized.max_attempts)),
        ),
    ])
    .to_json_text())
}

/// Produces stable sort indexes for projected V3 queue rows without serializing JavaScript numbers.
#[wasm_bindgen]
pub fn run_policy_queue_sort_indexes(items: JsValue) -> String {
    let items = Array::from(&items);
    let mut keys = Vec::with_capacity(items.length() as usize);
    for index in 0..items.length() {
        let item = items.get(index);
        let priority = Reflect::get(&item, &JsValue::from_str("priority"))
            .ok()
            .and_then(|value| value.as_f64())
            .unwrap_or(f64::NAN);
        let created_at = Reflect::get(&item, &JsValue::from_str("createdAt"))
            .ok()
            .and_then(|value| value.as_f64())
            .unwrap_or(f64::NAN);
        keys.push(QueueOrderKey {
            index: index as usize,
            priority,
            created_at,
        });
    }
    let indexes = run_policy::queue_sort_indexes(&mut keys);
    JsonDocument::array(
        indexes
            .into_iter()
            .map(|index| JsonDocument::from(serde_json::json!(index))),
    )
    .to_json_text()
}

/// Compares two queue rows using V3's priority/FIFO comparator.
#[wasm_bindgen]
pub fn run_policy_compare_queue_items(
    left_priority: f64,
    left_created_at: f64,
    right_priority: f64,
    right_created_at: f64,
) -> f64 {
    if left_priority != right_priority {
        right_priority - left_priority
    } else {
        left_created_at - right_created_at
    }
}

/// Returns whether a host-supplied lease expiration is strictly before the current time.
#[wasm_bindgen]
pub fn run_policy_is_lease_expired(expires_at: f64, now: f64) -> bool {
    run_policy::is_lease_expired(expires_at, now)
}

/// Computes a lease expiration from explicit host time and TTL values.
#[wasm_bindgen]
pub fn run_policy_lease_expires_at(now: f64, ttl_ms: f64) -> f64 {
    run_policy::lease_expires_at(now, ttl_ms)
}

/// Selects screenshot capture without calling Chrome or storing image data.
#[wasm_bindgen]
pub fn run_policy_should_capture_screenshot(policy: String, failed: bool) -> bool {
    run_policy::should_capture_screenshot(&policy, failed)
}

/// Selects cleanup before orphan-lease recovery from a host-supplied run status.
#[wasm_bindgen]
pub fn run_policy_recovery_preclean(status: Option<String>) -> String {
    recovery_action_name(run_policy::recovery_preclean_action(
        optional_status(status).as_deref(),
    ))
    .to_owned()
}

/// Selects the record reconciliation after a host queue lease recovery transition.
#[wasm_bindgen]
pub fn run_policy_recovery_reconcile(
    recovered_status: String,
    run_status: Option<String>,
) -> String {
    recovery_action_name(run_policy::recovery_reconcile_action(
        &recovered_status,
        optional_status(run_status).as_deref(),
    ))
    .to_owned()
}

/// Plans the V3 node-policy merge while JavaScript retains `undefined` and opaque values.
#[wasm_bindgen]
pub fn run_policy_node_policy_merge_plan(
    _flow_default: JsValue,
    node_policy: JsValue,
) -> Result<String, JsValue> {
    if !node_policy.is_object() {
        return Err(error("node policy merge requires objects"));
    }
    let plan = run_policy::node_policy_merge_plan(
        field_is_non_nullish(&node_policy, "timeout")?,
        field_is_non_nullish(&node_policy, "retry")?,
        field_is_non_nullish(&node_policy, "onError")?,
        field_is_truthy(&node_policy, "artifacts")?,
    );
    let source = |value: PolicyFieldSource| match value {
        PolicyFieldSource::Node => JsonDocument::from("node"),
        PolicyFieldSource::Flow => JsonDocument::from("flow"),
    };
    Ok(JsonDocument::object([
        ("timeout", source(plan.timeout)),
        ("retry", source(plan.retry)),
        ("onError", source(plan.on_error)),
        ("mergeArtifacts", JsonDocument::from(plan.merge_artifacts)),
    ])
    .to_json_text())
}

/// Selects an error-routing branch without evaluating plugins or traversing edges.
#[wasm_bindgen]
pub fn run_policy_error_plan(
    policy_json: &str,
    has_on_error_edge: bool,
) -> Result<String, JsValue> {
    let policy = parse_json(policy_json)?;
    Ok(error_plan_json(run_policy::error_plan(
        &policy,
        has_on_error_edge,
    )))
}

/// Stateful Rust breakpoint policy for one active run.
#[wasm_bindgen]
pub struct RustRunBreakpoints {
    inner: Breakpoints,
}

#[wasm_bindgen]
impl RustRunBreakpoints {
    /// Creates the run's breakpoint state from an optional JSON node-id array.
    #[wasm_bindgen(constructor)]
    pub fn new(node_ids_json: Option<String>) -> Result<Self, JsValue> {
        let node_ids = node_ids_json
            .as_deref()
            .map(parse_node_ids)
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            inner: Breakpoints::new(node_ids),
        })
    }

    /// Adds or enables a breakpoint.
    pub fn add(&mut self, node_id_json: &str) -> Result<(), JsValue> {
        self.inner.add(parse_string(node_id_json)?);
        Ok(())
    }

    /// Removes a breakpoint.
    pub fn remove(&mut self, node_id_json: &str) -> Result<(), JsValue> {
        self.inner.remove(&parse_string(node_id_json)?);
        Ok(())
    }

    /// Replaces every breakpoint.
    pub fn set_all(&mut self, node_ids_json: &str) -> Result<(), JsValue> {
        self.inner.set_all(parse_node_ids(node_ids_json)?);
        Ok(())
    }

    /// Enables one existing breakpoint.
    pub fn enable(&mut self, node_id_json: &str) -> Result<(), JsValue> {
        self.inner.enable(&parse_string(node_id_json)?);
        Ok(())
    }

    /// Disables one existing breakpoint.
    pub fn disable(&mut self, node_id_json: &str) -> Result<(), JsValue> {
        self.inner.disable(&parse_string(node_id_json)?);
        Ok(())
    }

    /// Returns whether one breakpoint is enabled.
    pub fn has_breakpoint(&self, node_id_json: &str) -> Result<bool, JsValue> {
        Ok(self.inner.has_breakpoint(&parse_string(node_id_json)?))
    }

    /// Returns whether this node should pause execution.
    pub fn should_pause_at(&self, node_id_json: &str) -> Result<bool, JsValue> {
        Ok(self.inner.should_pause_at(&parse_string(node_id_json)?))
    }

    /// Enables or clears one-shot step-over behavior.
    pub fn set_step_over(&mut self, enabled: bool) {
        self.inner.set_step_over(enabled);
    }

    /// Returns whether one-shot step-over is active.
    pub fn step_over(&self) -> bool {
        self.inner.step_over()
    }

    /// Returns all breakpoints in insertion order.
    pub fn all(&self) -> String {
        breakpoints_json(&self.inner, false)
    }

    /// Returns enabled node identifiers in insertion order.
    pub fn enabled(&self) -> String {
        breakpoints_json(&self.inner, true)
    }

    /// Clears all breakpoint state.
    pub fn clear(&mut self) {
        self.inner.clear();
    }
}
