//! Portable V3 run, queue, recovery, artifact, and breakpoint policy.
//!
//! Browser timers, IndexedDB transactions, plugin execution, event emission, and Chrome
//! operations remain host effects. This module owns only deterministic decisions driven by
//! host-supplied values.

mod triggers;

pub use triggers::{
    CronClockParts, CronExpression, DomTriggerInput, DomTriggerPayload, TriggerAdmission,
    TriggerAdmissionConfig, TriggerAdmissionState, TriggerDropReason, cron_next_local,
    cron_next_zoned, dom_trigger_payload,
};

use indexmap::IndexMap;

use crate::arguments::JsString;
use crate::json_document::JsonDocument;

/// Normalized queue values produced from the JavaScript enqueue arguments.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EnqueueNumbers {
    /// Higher values run earlier.
    pub priority: f64,
    /// Number of attempts including the first execution.
    pub max_attempts: f64,
}

/// Validates and floors one JavaScript numeric queue argument.
///
/// `None` represents JavaScript `undefined` or `null`; non-finite values are rejected.
pub fn normalize_enqueue_number(
    value: Option<f64>,
    default_value: f64,
    field_name: &str,
    min: Option<f64>,
    max: Option<f64>,
) -> Result<f64, String> {
    let Some(value) = value else {
        return Ok(default_value);
    };
    if !value.is_finite() {
        return Err(format!("{field_name} must be a finite number"));
    }
    let value = value.floor();
    if let Some(min) = min
        && value < min
    {
        return Err(format!("{field_name} must be >= {min}"));
    }
    if let Some(max) = max
        && value > max
    {
        return Err(format!("{field_name} must be <= {max}"));
    }
    Ok(value)
}

/// Normalizes the two numeric fields accepted by `enqueueRun`.
pub fn normalize_enqueue_numbers(
    priority: Option<f64>,
    max_attempts: Option<f64>,
) -> Result<EnqueueNumbers, String> {
    Ok(EnqueueNumbers {
        priority: normalize_enqueue_number(priority, 0.0, "priority", None, None)?,
        max_attempts: normalize_enqueue_number(max_attempts, 1.0, "maxAttempts", Some(1.0), None)?,
    })
}

/// Projects a queue row to the fields used by JavaScript's ordering comparator.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QueueOrderKey {
    /// Original array position, retained to preserve JavaScript stable-sort behavior.
    pub index: usize,
    /// Higher priority wins.
    pub priority: f64,
    /// Earlier timestamps win within a priority.
    pub created_at: f64,
}

/// Orders queue keys exactly as the V3 queue comparator does.
///
/// A non-orderable JavaScript numeric subtraction (for example `NaN`) compares as zero,
/// matching `Array.prototype.sort`'s treatment of a `NaN` comparator result.
#[must_use]
pub fn queue_sort_indexes(keys: &mut [QueueOrderKey]) -> Vec<usize> {
    keys.sort_by(|left, right| {
        let delta = if left.priority != right.priority {
            right.priority - left.priority
        } else {
            left.created_at - right.created_at
        };
        if delta < 0.0 {
            std::cmp::Ordering::Less
        } else if delta > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    keys.iter().map(|key| key.index).collect()
}

/// Returns whether a lease is expired at the supplied host clock value.
#[must_use]
pub fn is_lease_expired(expires_at: f64, now: f64) -> bool {
    expires_at < now
}

/// Creates the timer-free lease expiration timestamp used by the host storage adapter.
#[must_use]
pub fn lease_expires_at(now: f64, ttl_ms: f64) -> f64 {
    now + ttl_ms
}

/// Decides whether artifact capture should be requested from the browser host.
#[must_use]
pub fn should_capture_screenshot(policy: &str, failed: bool) -> bool {
    policy == "always" || (policy == "onFailure" && failed)
}

/// A storage action selected during crash recovery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryAction {
    /// The queue item cannot execute and must be removed.
    Clean,
    /// The run record should be returned to queued state.
    Requeue,
    /// The run record should remain paused under the new owner.
    AdoptPaused,
    /// No host write is needed.
    Keep,
}

/// Selects the initial recovery action from a possibly missing run status.
#[must_use]
pub fn recovery_preclean_action(run_status: Option<&str>) -> RecoveryAction {
    match run_status {
        None | Some("succeeded" | "failed" | "canceled") => RecoveryAction::Clean,
        Some(_) => RecoveryAction::Keep,
    }
}

/// Selects reconciliation after the queue adapter reports an orphaned lease transition.
#[must_use]
pub fn recovery_reconcile_action(
    recovered_status: &str,
    run_status: Option<&str>,
) -> RecoveryAction {
    match recovery_preclean_action(run_status) {
        RecoveryAction::Clean => RecoveryAction::Clean,
        RecoveryAction::Keep => match recovered_status {
            "running" => RecoveryAction::Requeue,
            "paused" => RecoveryAction::AdoptPaused,
            _ => RecoveryAction::Keep,
        },
        RecoveryAction::Requeue | RecoveryAction::AdoptPaused => RecoveryAction::Keep,
    }
}

/// Source selected by JavaScript nullish-coalescing policy fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyFieldSource {
    /// The node-level policy value wins.
    Node,
    /// The flow-level default remains in effect.
    Flow,
}

/// Field-selection plan for a node-policy merge.
///
/// Values stay in JavaScript so `undefined` and opaque values retain their identity; Rust owns
/// the nullish selection and artifact-spread decision only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodePolicyMergePlan {
    /// Source for `timeout`.
    pub timeout: PolicyFieldSource,
    /// Source for `retry`.
    pub retry: PolicyFieldSource,
    /// Source for `onError`.
    pub on_error: PolicyFieldSource,
    /// Whether the host applies the existing object spread to artifact values.
    pub merge_artifacts: bool,
}

/// Plans a V3 node-policy merge from host-observed JavaScript field semantics.
#[must_use]
pub fn node_policy_merge_plan(
    node_has_timeout: bool,
    node_has_retry: bool,
    node_has_on_error: bool,
    node_artifacts_truthy: bool,
) -> NodePolicyMergePlan {
    NodePolicyMergePlan {
        timeout: field_source(node_has_timeout),
        retry: field_source(node_has_retry),
        on_error: field_source(node_has_on_error),
        merge_artifacts: node_artifacts_truthy,
    }
}

fn field_source(node_has_value: bool) -> PolicyFieldSource {
    if node_has_value {
        PolicyFieldSource::Node
    } else {
        PolicyFieldSource::Flow
    }
}

fn nullish_field(policy: &JsonDocument, field: &str) -> Option<JsonDocument> {
    policy
        .get(field)
        .filter(|value| !value.is_null())
        .map(|value| value.to_owned())
}

/// Runner error-routing decision without executing a plugin or traversing the graph.
#[derive(Clone, Debug, PartialEq)]
pub enum ErrorPlan {
    /// Stop the run.
    Stop,
    /// Continue over the failed node.
    Continue,
    /// Follow an already-indexed host edge label.
    GotoEdgeLabel(JsString),
    /// Jump to an existing host node identifier.
    GotoNode(JsString),
    /// Retry with the base retry policy and no host patch.
    RetryBase,
    /// Retry after the host applies its original override object.
    RetryOverride,
}

/// Selects the runner's error-routing branch while leaving traversal and retry timing to their
/// existing Rust workflow owners.
#[must_use]
pub fn error_plan(policy: &JsonDocument, has_on_error_edge: bool) -> ErrorPlan {
    let Some(on_error) = nullish_field(policy, "onError") else {
        return if has_on_error_edge {
            ErrorPlan::GotoEdgeLabel(JsString::from("onError"))
        } else {
            ErrorPlan::Stop
        };
    };
    let Some(kind) = on_error.get("kind").filter(|value| value.is_string()) else {
        return ErrorPlan::Stop;
    };
    match kind.to_js_string().as_utf8() {
        Some("stop") => ErrorPlan::Stop,
        Some("continue") => ErrorPlan::Continue,
        Some("goto") => error_goto_plan(&on_error).unwrap_or(ErrorPlan::Stop),
        Some("retry") => match on_error.get("override") {
            Some(override_policy) if !override_policy.is_null() => ErrorPlan::RetryOverride,
            _ => ErrorPlan::RetryBase,
        },
        _ => ErrorPlan::Stop,
    }
}

fn error_goto_plan(on_error: &JsonDocument) -> Option<ErrorPlan> {
    let target = on_error.get("target")?;
    let kind = target
        .get("kind")
        .filter(|value| value.is_string())?
        .to_js_string();
    let value = match kind.as_utf8()? {
        "edgeLabel" => target.get("label")?,
        "node" => target.get("nodeId")?,
        _ => return None,
    };
    if !value.is_string() {
        return None;
    }
    let value = value.to_js_string();
    match kind.as_utf8()? {
        "edgeLabel" => Some(ErrorPlan::GotoEdgeLabel(value)),
        "node" => Some(ErrorPlan::GotoNode(value)),
        _ => None,
    }
}

/// Stateful breakpoints for one active V3 run.
#[derive(Clone, Debug, Default)]
pub struct Breakpoints {
    breakpoints: IndexMap<JsString, bool>,
    step_over: bool,
}

impl Breakpoints {
    /// Creates a breakpoint state from the initial run-record list.
    #[must_use]
    pub fn new(node_ids: impl IntoIterator<Item = JsString>) -> Self {
        let mut state = Self::default();
        state.set_all(node_ids);
        state
    }

    /// Adds or enables a breakpoint without changing an existing key's order.
    pub fn add(&mut self, node_id: JsString) {
        self.breakpoints.insert(node_id, true);
    }

    /// Removes a breakpoint.
    pub fn remove(&mut self, node_id: &JsString) {
        self.breakpoints.shift_remove(node_id);
    }

    /// Replaces the complete breakpoint set.
    pub fn set_all(&mut self, node_ids: impl IntoIterator<Item = JsString>) {
        self.breakpoints.clear();
        for node_id in node_ids {
            self.add(node_id);
        }
    }

    /// Enables an existing breakpoint.
    pub fn enable(&mut self, node_id: &JsString) {
        if let Some(enabled) = self.breakpoints.get_mut(node_id) {
            *enabled = true;
        }
    }

    /// Disables an existing breakpoint.
    pub fn disable(&mut self, node_id: &JsString) {
        if let Some(enabled) = self.breakpoints.get_mut(node_id) {
            *enabled = false;
        }
    }

    /// Returns whether this node has an enabled breakpoint.
    #[must_use]
    pub fn has_breakpoint(&self, node_id: &JsString) -> bool {
        self.breakpoints.get(node_id).copied().unwrap_or(false)
    }

    /// Returns whether execution pauses for this node.
    #[must_use]
    pub fn should_pause_at(&self, node_id: &JsString) -> bool {
        self.step_over || self.has_breakpoint(node_id)
    }

    /// Selects or clears the one-shot step-over mode.
    pub fn set_step_over(&mut self, enabled: bool) {
        self.step_over = enabled;
    }

    /// Returns whether the one-shot step-over mode is active.
    #[must_use]
    pub fn step_over(&self) -> bool {
        self.step_over
    }

    /// Returns all breakpoints in insertion order.
    #[must_use]
    pub fn all(&self) -> Vec<(JsString, bool)> {
        self.breakpoints
            .iter()
            .map(|(node_id, enabled)| (node_id.clone(), *enabled))
            .collect()
    }

    /// Returns enabled breakpoint node identifiers in insertion order.
    #[must_use]
    pub fn enabled(&self) -> Vec<JsString> {
        self.breakpoints
            .iter()
            .filter(|(_, enabled)| **enabled)
            .map(|(node_id, _)| node_id.clone())
            .collect()
    }

    /// Clears breakpoints and one-shot stepping.
    pub fn clear(&mut self) {
        self.breakpoints.clear();
        self.step_over = false;
    }
}
