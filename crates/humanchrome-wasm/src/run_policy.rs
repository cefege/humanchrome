//! WASM bindings for portable V3 run, queue, recovery, and breakpoint policy.

use humanchrome_core::arguments::JsString;
use humanchrome_core::json_document::JsonDocument;
use humanchrome_core::run_policy::{
    self, Breakpoints, CronClockParts, CronExpression, DomTriggerInput, ErrorPlan,
    PolicyFieldSource, QueueOrderKey, RecoveryAction, TriggerAdmission, TriggerAdmissionConfig,
    TriggerAdmissionState, TriggerDropReason,
};
use js_sys::{Array, Function, Reflect};
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

fn integer(value: f64, field_name: &str) -> Result<i64, JsValue> {
    if !value.is_finite() || value < i64::MIN as f64 || value > i64::MAX as f64 {
        return Err(error(format!("{field_name} must be a finite number")));
    }
    Ok(value as i64)
}

fn clock_parts(value: JsValue, include_timestamp: bool) -> Result<CronClockParts, JsValue> {
    let number = |field: &str| -> Result<f64, JsValue> {
        Reflect::get(&value, &JsValue::from_str(field))?
            .as_f64()
            .ok_or_else(|| error(format!("Date observer returned invalid {field}")))
    };
    Ok(CronClockParts {
        timestamp_ms: if include_timestamp {
            integer(number("timestampMs")?, "timestampMs")?
        } else {
            0
        },
        year: integer(number("year")?, "year")? as i32,
        month: integer(number("month")?, "month")? as u8,
        day: integer(number("day")?, "day")? as u8,
        hour: integer(number("hour")?, "hour")? as u8,
        minute: integer(number("minute")?, "minute")? as u8,
        day_of_week: integer(number("dayOfWeek")?, "dayOfWeek")? as u8,
    })
}

fn cron_error(error_value: JsValue) -> String {
    error_value
        .as_string()
        .unwrap_or_else(|| "Date observer failed".to_owned())
}

fn admission_json(
    state: &TriggerAdmissionState,
    trigger_id: &JsString,
    admission: TriggerAdmission,
) -> String {
    match admission {
        TriggerAdmission::Admitted { ticket } => format!(r#"{{"kind":"admit","ticket":{ticket}}}"#),
        TriggerAdmission::Dropped(reason) => {
            let reason_name = match reason {
                TriggerDropReason::NotStarted => "notStarted",
                TriggerDropReason::NotInstalled => "notInstalled",
                TriggerDropReason::MaxQueued => "maxQueued",
                TriggerDropReason::Cooldown => "cooldown",
            };
            JsonDocument::object([
                ("kind", JsonDocument::from("drop")),
                ("reason", JsonDocument::from(reason_name)),
                (
                    "message",
                    JsonDocument::string(state.drop_message(trigger_id, reason)),
                ),
            ])
            .to_json_text()
        }
    }
}

/// Rust-owned stateful admission policy for one V3 trigger manager.
#[wasm_bindgen]
pub struct RustTriggerAdmission {
    inner: TriggerAdmissionState,
}

#[wasm_bindgen]
impl RustTriggerAdmission {
    /// Validates storm control and creates a stopped admission state.
    #[wasm_bindgen(constructor)]
    pub fn new(cooldown_ms: JsValue, max_queued: JsValue) -> Result<Self, JsValue> {
        let config = TriggerAdmissionConfig::new(
            optional_number(&cooldown_ms, "storm.cooldownMs")?,
            optional_number(&max_queued, "storm.maxQueued")?,
        )
        .map_err(error)?;
        Ok(Self {
            inner: TriggerAdmissionState::new(config),
        })
    }

    /// Starts fire admission.
    pub fn start(&mut self) {
        self.inner.start();
    }

    /// Stops admission and removes installed identities and cooldown stamps.
    pub fn stop(&mut self) {
        self.inner.stop();
    }

    /// Returns whether the manager is started.
    pub fn is_started(&self) -> bool {
        self.inner.is_started()
    }

    /// Returns whether the host must observe its persisted queue length.
    pub fn has_queue_cap(&self) -> bool {
        self.inner.has_queue_cap()
    }

    /// Clears every installed identity before the host refreshes handlers.
    pub fn clear_installed(&mut self) {
        self.inner.clear_installed();
    }

    /// Marks one host-successfully-installed trigger as eligible to fire.
    pub fn install(&mut self, trigger_id_json: &str) -> Result<(), JsValue> {
        self.inner.install(parse_string(trigger_id_json)?);
        Ok(())
    }

    /// Removes an uninstalled trigger identity.
    pub fn uninstall(&mut self, trigger_id_json: &str) -> Result<(), JsValue> {
        self.inner.uninstall(&parse_string(trigger_id_json)?);
        Ok(())
    }

    /// Returns successfully installed trigger identities in insertion order.
    pub fn installed_ids(&self) -> String {
        JsonDocument::array(
            self.inner
                .installed_ids()
                .into_iter()
                .map(JsonDocument::string),
        )
        .to_json_text()
    }

    /// Admits or drops one host-observed fire without enqueueing a run itself.
    pub fn admit(
        &mut self,
        trigger_id_json: &str,
        now_ms: f64,
        queued_count: f64,
    ) -> Result<String, JsValue> {
        let now_ms = integer(now_ms, "now")?;
        let queued_count = integer(queued_count, "queued count")?;
        if queued_count < 0 {
            return Err(error("queued count must be a finite number"));
        }
        let trigger_id = parse_string(trigger_id_json)?;
        let admission = self.inner.admit(&trigger_id, now_ms, queued_count as u64);
        Ok(admission_json(&self.inner, &trigger_id, admission))
    }

    /// Reports terminal enqueue success or failure, rolling back cooldown only on failure.
    pub fn finish(&mut self, ticket: f64, succeeded: bool) -> Result<(), JsValue> {
        let ticket = integer(ticket, "ticket")?;
        if ticket < 0 {
            return Err(error("ticket must be a finite number"));
        }
        self.inner.finish(ticket as u64, succeeded);
        Ok(())
    }
}

/// Validates the complete five-field cron grammar after host string normalization.
#[wasm_bindgen]
pub fn run_policy_validate_cron(cron: String) -> Result<(), JsValue> {
    CronExpression::parse(&cron).map_err(error)?;
    Ok(())
}

/// Normalizes a cron source value through the host's String intrinsics, then validates grammar.
#[wasm_bindgen]
pub fn run_policy_normalize_cron(value: JsValue, normalize: &Function) -> Result<String, JsValue> {
    let cron = normalize
        .call1(&JsValue::NULL, &value)?
        .as_string()
        .ok_or_else(|| error("cron normalizer must return a string"))?;
    if cron.is_empty() {
        return Err(error("cron must be a non-empty string"));
    }
    CronExpression::parse(&cron).map_err(error)?;
    Ok(cron)
}

/// Normalizes a timezone through host String/Intl observations while retaining error policy in Rust.
#[wasm_bindgen]
pub fn run_policy_normalize_timezone(
    value: JsValue,
    trim: &Function,
    is_valid: &Function,
) -> Result<Option<String>, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    let raw = value
        .as_string()
        .ok_or_else(|| error("timezone must be a string"))?;
    let timezone = trim
        .call1(&JsValue::NULL, &JsValue::from_str(&raw))?
        .as_string()
        .ok_or_else(|| error("timezone trim observer must return a string"))?;
    if timezone.is_empty() {
        return Ok(None);
    }
    let valid = is_valid
        .call1(&JsValue::NULL, &JsValue::from_str(&timezone))?
        .as_bool()
        .unwrap_or(false);
    if !valid {
        return Err(error(format!("Invalid timezone: \"{timezone}\"")));
    }
    Ok(Some(timezone))
}

/// Computes the next local-time cron fire using only host Date candidate observations.
#[wasm_bindgen]
pub fn run_policy_cron_next_local(
    cron: String,
    from_ms: f64,
    local_candidate: &Function,
) -> Result<f64, JsValue> {
    let cron = CronExpression::parse(&cron).map_err(error)?;
    let from_ms = integer(from_ms, "fromMs")?;
    let next = run_policy::cron_next_local(&cron, from_ms, |from, day_offset, hour, minute| {
        local_candidate
            .call4(
                &JsValue::NULL,
                &JsValue::from_f64(from as f64),
                &JsValue::from_f64(day_offset as f64),
                &JsValue::from_f64(hour as f64),
                &JsValue::from_f64(minute as f64),
            )
            .and_then(|value| clock_parts(value, true))
            .map_err(cron_error)
    })
    .map_err(error)?;
    Ok(next as f64)
}

/// Computes the next zoned cron fire using only host Intl DateTimeFormat observations.
#[wasm_bindgen]
pub fn run_policy_cron_next_zoned(
    cron: String,
    timezone: String,
    from_ms: f64,
    zoned_parts: &Function,
) -> Result<f64, JsValue> {
    let cron = CronExpression::parse(&cron).map_err(error)?;
    let from_ms = integer(from_ms, "fromMs")?;
    let next = run_policy::cron_next_zoned(&cron, from_ms, |utc_ms| {
        zoned_parts
            .call2(
                &JsValue::NULL,
                &JsValue::from_f64(utc_ms as f64),
                &JsValue::from_str(&timezone),
            )
            .and_then(|value| clock_parts(value, false))
            .map_err(cron_error)
    })
    .map_err(error)?;
    Ok(next as f64)
}

fn string_field(entry: &JsValue, field: &str, fallback: &str) -> Result<String, JsValue> {
    let value = Reflect::get(entry, &JsValue::from_str(field))?;
    Ok(value.as_string().unwrap_or_else(|| fallback.to_owned()))
}

/// Canonicalizes a complete DOM-observer trigger payload batch and asks the host only to observe
/// native `localeCompare` ordering.
#[wasm_bindgen]
pub fn run_policy_dom_trigger_payload(
    entries: JsValue,
    locale_compare: &Function,
    stringify: &Function,
    trim: &Function,
) -> Result<String, JsValue> {
    let entries = Array::from(&entries);
    let mut inputs = Vec::with_capacity(entries.length() as usize);
    for index in 0..entries.length() {
        let entry = entries.get(index);
        let selector_value = Reflect::get(&entry, &JsValue::from_str("selector"))?;
        let selector = if selector_value.is_null() || selector_value.is_undefined() {
            String::new()
        } else {
            let selector = stringify
                .call1(&JsValue::NULL, &selector_value)?
                .as_string()
                .ok_or_else(|| error("String observer must return a string"))?;
            trim.call1(&JsValue::NULL, &JsValue::from_str(&selector))?
                .as_string()
                .ok_or_else(|| error("String trim observer must return a string"))?
        };
        let appear_is_false =
            Reflect::get(&entry, &JsValue::from_str("appear"))?.as_bool() == Some(false);
        let once_is_false =
            Reflect::get(&entry, &JsValue::from_str("once"))?.as_bool() == Some(false);
        let debounce_ms = Reflect::get(&entry, &JsValue::from_str("debounceMs"))?.as_f64();
        inputs.push(DomTriggerInput {
            id: string_field(&entry, "id", "")?,
            selector,
            appear_is_false,
            once_is_false,
            debounce_ms,
        });
    }
    let payload = run_policy::dom_trigger_payload(inputs, |left, right| {
        locale_compare
            .call2(
                &JsValue::NULL,
                &JsValue::from_str(left),
                &JsValue::from_str(right),
            )
            .and_then(|value| {
                value
                    .as_f64()
                    .ok_or_else(|| error("localeCompare observer returned a non-number"))
            })
            .map(|value| {
                if value < 0.0 {
                    -1
                } else if value > 0.0 {
                    1
                } else {
                    0
                }
            })
            .map_err(cron_error)
    })
    .map_err(error)?;
    serde_json::to_string(&payload).map_err(error)
}
