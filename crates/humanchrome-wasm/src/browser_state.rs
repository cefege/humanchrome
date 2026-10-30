//! WASM boundary for the browser ownership, dispatch, pacing, and queue policy.

use indexmap::IndexSet;
use wasm_bindgen::prelude::*;

use humanchrome_core::arguments::JsString;
use humanchrome_core::browser_state::{
    AutoSpawnPolicy, BrowserState, DEFAULT_TAB_LOCK_TIMEOUT_MS, DispatchContinuation, DispatchPlan,
    DispatchRequest, PacingOverrides, PacingProfile, TabLiveness, TargetAccess, TargetRequest,
    UrlTargeting, WindowTargeting,
};
use humanchrome_core::json_document::JsonDocument;

use crate::{encode_serializable, error, parse_json, parse_string};

/// Stateful, effect-free browser policy handle. Chrome probes, timers, and Promise settlement
/// remain in the host; continuations are retained here so a liveness resume cannot re-resolve a
/// different active tab.
#[wasm_bindgen]
pub struct RustBrowserState {
    state: BrowserState,
    continuations: Vec<Option<DispatchContinuation>>,
}

#[wasm_bindgen]
impl RustBrowserState {
    /// Creates an empty browser policy state.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            state: BrowserState::new(),
            continuations: Vec::new(),
        }
    }

    /// Returns whether the host should schedule its debounced persistence write.
    pub fn persistence_dirty(&self) -> bool {
        self.state.persistence_dirty()
    }
    /// Marks the last host persistence write complete.
    pub fn mark_persisted(&mut self) {
        self.state.mark_persisted();
    }
    /// Returns the lossless `chrome.storage.session` ownership payload.
    pub fn ownership_snapshot(&self) -> Result<String, JsValue> {
        encode_serializable(&self.state.ownership_snapshot())
    }

    /// Restores ownership from a JSON payload and optional live Chrome tab ids.
    pub fn restore_ownership(
        &mut self,
        snapshot_json: String,
        alive_tab_ids_json: String,
        now: i64,
    ) -> Result<String, JsValue> {
        let snapshot = parse_snapshot(parse_json(&snapshot_json)?)?;
        let alive = parse_optional_ids(parse_json(&alive_tab_ids_json)?)?;
        encode_serializable(&self.state.restore_ownership(snapshot, alive.as_ref(), now))
    }

    /// Returns a diagnostic client state or JSON null.
    pub fn client_snapshot(&self, client_id_json: String) -> Result<String, JsValue> {
        let client_id = parse_optional_string(parse_json(&client_id_json)?)?;
        match self.state.client_snapshot(client_id.as_deref()) {
            Some(value) => encode_serializable(&value),
            None => Ok("null".to_owned()),
        }
    }
    /// Evicts stale client records.
    pub fn evict_stale_clients(&mut self, now: i64) -> usize {
        self.state.evict_stale_clients(now)
    }

    /// Sets transient client pacing from a profile and optional override object.
    pub fn set_pacing(
        &mut self,
        client_id_json: String,
        profile_json: String,
        overrides_json: String,
        now: i64,
    ) -> Result<String, JsValue> {
        let client_id = parse_optional_string(parse_json(&client_id_json)?)?;
        let profile = parse_pacing_profile(parse_string(&profile_json)?)?;
        let overrides = parse_pacing_overrides(parse_json(&overrides_json)?)?;
        match self
            .state
            .set_pacing(client_id.as_deref(), profile, overrides, now)
        {
            Some(value) => encode_serializable(&value),
            None => Ok("null".to_owned()),
        }
    }
    /// Returns transient pacing state or JSON null.
    pub fn pacing(&self, client_id_json: String) -> Result<String, JsValue> {
        let client_id = parse_optional_string(parse_json(&client_id_json)?)?;
        match self.state.pacing(client_id.as_deref()) {
            Some(value) => encode_serializable(&value),
            None => Ok("null".to_owned()),
        }
    }
    /// Consumes a pacing delay using the host clock and random sample.
    pub fn consume_pacing_delay(
        &mut self,
        client_id_json: String,
        now: i64,
        random_sample: f64,
    ) -> Result<i64, JsValue> {
        let client_id = parse_optional_string(parse_json(&client_id_json)?)?;
        Ok(self
            .state
            .consume_pacing_delay(client_id.as_deref(), now, random_sample))
    }

    /// Claims a tab and returns its former owner or JSON null.
    pub fn claim_tab(
        &mut self,
        client_id_json: String,
        tab_id: i64,
        window_id_json: String,
        now: i64,
    ) -> Result<String, JsValue> {
        let client_id = parse_optional_string(parse_json(&client_id_json)?)?;
        let window_id = parse_optional_i64(parse_json(&window_id_json)?)?;
        Ok(json_optional_string(self.state.claim_tab(
            client_id.as_deref(),
            tab_id,
            window_id,
            now,
        )))
    }
    /// Releases an owned tab without closing it.
    pub fn release_tab(&mut self, client_id_json: String, tab_id: i64) -> Result<bool, JsValue> {
        Ok(self.state.release_tab(
            parse_optional_string(parse_json(&client_id_json)?)?.as_deref(),
            tab_id,
        ))
    }
    /// Returns a tab's owner or JSON null.
    pub fn tab_owner(&self, tab_id: i64) -> String {
        json_optional_string(self.state.tab_owner(tab_id).map(str::to_owned))
    }
    /// Releases all tabs for a disconnected client.
    pub fn release_client(&mut self, client_id_json: String, now: i64) -> Result<usize, JsValue> {
        Ok(self.state.release_client(
            parse_optional_string(parse_json(&client_id_json)?)?.as_deref(),
            now,
        ))
    }
    /// Resolves an owned-tab request and returns a target resolution/error document.
    pub fn resolve_owned_tab(
        &mut self,
        client_id_json: String,
        explicit_tab_id_json: String,
        access_json: String,
        now: i64,
    ) -> Result<String, JsValue> {
        let client = parse_optional_string(parse_json(&client_id_json)?)?;
        let tab = parse_optional_i64(parse_json(&explicit_tab_id_json)?)?;
        let access = parse_access(parse_string(&access_json)?)?;
        resolution_json(
            self.state
                .resolve_owned_tab(client.as_deref(), tab, access, now),
        )
    }
    /// Resolves an alias, retaining lone surrogates in errors.
    pub fn resolve_alias(
        &mut self,
        client_id_json: String,
        alias_json: String,
    ) -> Result<String, JsValue> {
        let client = parse_optional_string(parse_json(&client_id_json)?)?;
        let alias = parse_string(&alias_json)?;
        match self.state.resolve_alias(client.as_deref(), &alias) {
            Ok(tab_id) => Ok(format!("{{\"tabId\":{tab_id}}}")),
            Err(reason) => Ok(format!(
                "{{\"error\":{{\"alias\":{},\"reason\":{}}}}}",
                JsonDocument::string(alias).to_json_text(),
                JsonDocument::from(match reason {
                    humanchrome_core::browser_state::AliasMissReason::UnknownAlias =>
                        "unknown-alias",
                    humanchrome_core::browser_state::AliasMissReason::TabClosed => "tab-closed",
                })
                .to_json_text()
            )),
        }
    }
    /// Resolves the complete dispatcher target contract.
    pub fn resolve_target(&mut self, request_json: String, now: i64) -> Result<String, JsValue> {
        resolution_json(
            self.state
                .resolve_target(&parse_target_request(parse_json(&request_json)?)?, now),
        )
    }
    /// Records a successful tab touch.
    pub fn record_client_tab(
        &mut self,
        client_id_json: String,
        tab_id: i64,
        window_id_json: String,
        now: i64,
    ) -> Result<(), JsValue> {
        self.state.record_client_tab(
            parse_optional_string(parse_json(&client_id_json)?)?.as_deref(),
            tab_id,
            parse_optional_i64(parse_json(&window_id_json)?)?,
            now,
        );
        Ok(())
    }
    /// Records a successful window-only touch.
    pub fn record_client_window(
        &mut self,
        client_id_json: String,
        window_id: i64,
        now: i64,
    ) -> Result<(), JsValue> {
        self.state.record_client_window(
            parse_optional_string(parse_json(&client_id_json)?)?.as_deref(),
            window_id,
            now,
        );
        Ok(())
    }
    /// Resolves the explicit or retained window hint.
    pub fn resolve_owned_window(
        &self,
        client_id_json: String,
        explicit_window_id_json: String,
    ) -> Result<String, JsValue> {
        Ok(json_optional_i64(self.state.resolve_owned_window(
            parse_optional_string(parse_json(&client_id_json)?)?.as_deref(),
            parse_optional_i64(parse_json(&explicit_window_id_json)?)?,
        )))
    }
    /// Clears an invalid cached window hint.
    pub fn clear_last_window(
        &mut self,
        client_id_json: String,
        window_id: i64,
    ) -> Result<bool, JsValue> {
        Ok(self.state.clear_last_window(
            parse_optional_string(parse_json(&client_id_json)?)?.as_deref(),
            window_id,
        ))
    }
    /// Validates the alias grammar without lossy UTF-8 conversion.
    pub fn is_valid_alias(alias_json: String) -> Result<bool, JsValue> {
        Ok(BrowserState::is_valid_alias_js(&parse_string(&alias_json)?))
    }
    /// Sets an alias after the host performs its existing schema/ownership gates.
    pub fn set_alias(
        &mut self,
        client_id_json: String,
        alias_json: String,
        tab_id: i64,
        now: i64,
    ) -> Result<String, JsValue> {
        Ok(json_optional_i64(
            self.state.set_alias(
                parse_optional_string(parse_json(&client_id_json)?)?.as_deref(),
                parse_string(&alias_json)?
                    .as_utf8()
                    .ok_or_else(|| error("alias must be valid UTF-8 after host validation"))?
                    .to_owned(),
                tab_id,
                now,
            ),
        ))
    }
    /// Returns aliases in insertion order.
    pub fn aliases(&self, client_id_json: String) -> Result<String, JsValue> {
        encode_serializable(
            &self
                .state
                .aliases(parse_optional_string(parse_json(&client_id_json)?)?.as_deref()),
        )
    }
    /// Applies a Chrome tab-close notification.
    pub fn handle_tab_removed(&mut self, tab_id: i64) -> bool {
        self.state.handle_tab_removed(tab_id)
    }
    /// Applies a Chrome window-close notification.
    pub fn handle_window_removed(&mut self, window_id: i64) -> bool {
        self.state.handle_window_removed(window_id)
    }

    /// Creates a dispatch plan. `needsLivenessProbe` retains an opaque continuation handle.
    pub fn plan_dispatch(&mut self, request_json: String, now: i64) -> Result<String, JsValue> {
        let request = parse_dispatch_request(parse_json(&request_json)?)?;
        let plan = self.state.plan_dispatch(&request, now);
        self.plan(plan)
    }
    /// Resumes the exact liveness continuation originally returned by [`Self::plan_dispatch`].
    pub fn resume_dispatch(
        &mut self,
        continuation_id: u32,
        liveness_json: String,
    ) -> Result<String, JsValue> {
        let continuation = self
            .continuations
            .get_mut(continuation_id as usize)
            .and_then(Option::take)
            .ok_or_else(|| error("unknown or already-consumed dispatch continuation"))?;
        let liveness = parse_liveness(parse_string(&liveness_json)?)?;
        let plan = self.state.resume_dispatch(continuation, liveness);
        self.plan(plan)
    }
    /// Clamps a requested tab-lock timeout using the existing dispatcher bounds.
    pub fn clamp_tab_lock_timeout(timeout_json: String) -> Result<String, JsValue> {
        Ok(json_optional_i64(BrowserState::clamp_tab_lock_timeout(
            parse_optional_i64(parse_json(&timeout_json)?)?,
        )))
    }

    /// Returns the Rust-owned default timeout for per-tab queue admission.
    pub fn default_tab_lock_timeout() -> i64 {
        DEFAULT_TAB_LOCK_TIMEOUT_MS
    }
    /// Admits one call to a per-tab queue.
    pub fn admit_tab_lock(
        &mut self,
        tab_id: i64,
        client_id_json: String,
        timeout_json: String,
        now: i64,
    ) -> Result<String, JsValue> {
        queue_admission_json(self.state.admit_tab_lock(
            tab_id,
            parse_optional_string(parse_json(&client_id_json)?)?,
            parse_optional_i64(parse_json(&timeout_json)?)?,
            now,
        ))
    }
    /// Applies a host queue timeout.
    pub fn timeout_tab_lock(
        &mut self,
        tab_id: i64,
        ticket: u64,
        now: i64,
        timeout_ms: i64,
    ) -> Result<String, JsValue> {
        queue_transition_json(self.state.timeout_tab_lock(tab_id, ticket, now, timeout_ms))
    }
    /// Releases one held queue ticket idempotently.
    pub fn release_tab_lock(
        &mut self,
        tab_id: i64,
        ticket: u64,
        now: i64,
    ) -> Result<String, JsValue> {
        queue_transition_json(self.state.release_tab_lock(tab_id, ticket, now))
    }
    /// Cancels all callbacks associated with a closed tab queue.
    pub fn close_tab_queue(&mut self, tab_id: i64) -> Result<String, JsValue> {
        queue_transition_json(self.state.close_tab_queue(tab_id))
    }
    /// Returns one camel-case queue inspector record or JSON null.
    pub fn inspect_tab_queue(&self, tab_id: i64, now: i64) -> Result<String, JsValue> {
        match self.state.inspect_tab_queue(tab_id, now) {
            Some(snapshot) => encode_serializable(&snapshot),
            None => Ok("null".to_owned()),
        }
    }
    /// Returns all queue inspector records in insertion order.
    pub fn inspect_all_tab_queues(&self, now: i64) -> Result<String, JsValue> {
        encode_serializable(&self.state.inspect_all_tab_queues(now))
    }
    /// Returns the number of active tab queues.
    pub fn active_locked_tab_count(&self) -> usize {
        self.state.active_locked_tab_count()
    }

    /// Clears queues through the extension's existing test reset hook.
    pub fn _reset_queues_for_test(&mut self) {
        self.state._reset_queues_for_test();
    }
    /// Sets the queue hold estimator through the extension's test escape hatch.
    pub fn _set_queue_mean_hold_for_test(&mut self, tab_id: i64, mean_hold_ms: i64) {
        self.state
            ._set_queue_mean_hold_for_test(tab_id, mean_hold_ms);
    }
    /// Returns raw queue entries through the extension's existing test escape hatch.
    pub fn _queue_entries_for_test(&self, tab_id: i64) -> Result<String, JsValue> {
        encode_serializable(&self.state._queue_entries_for_test(tab_id))
    }
}

impl RustBrowserState {
    fn plan(&mut self, plan: DispatchPlan) -> Result<String, JsValue> {
        match plan {
            DispatchPlan::Rejected { error } => Ok(format!(
                "{{\"kind\":\"rejected\",\"error\":{}}}",
                policy_error_json(error)
            )),
            DispatchPlan::NeedsLivenessProbe { continuation } => {
                let tab_id = continuation.tab_id();
                let id = self.continuations.len();
                self.continuations.push(Some(continuation));
                Ok(format!(
                    "{{\"kind\":\"needsLivenessProbe\",\"continuationId\":{id},\"tabId\":{tab_id}}}"
                ))
            }
            DispatchPlan::Ready { target } => Ok(format!(
                "{{\"kind\":\"ready\",\"target\":{}}}",
                encode_serializable(&target)?
            )),
        }
    }
}

fn parse_snapshot(
    value: JsonDocument,
) -> Result<humanchrome_core::browser_state::OwnershipSnapshot, JsValue> {
    let mut clients = indexmap::IndexMap::new();
    for (client, entry) in value
        .into_object_fields()
        .ok_or_else(|| error("ownership snapshot must be an object"))?
    {
        let client = client
            .as_utf8()
            .ok_or_else(|| error("client id must be UTF-8"))?
            .to_owned();
        let mut entry = entry;
        let owned_tab_ids = parse_ids(take_required(&mut entry, "ownedTabIds")?)?;
        let active_tab_id = take_optional(&mut entry, "activeTabId")
            .map(parse_i64)
            .transpose()?;
        let last_window_id = take_optional(&mut entry, "lastWindowId")
            .map(parse_i64)
            .transpose()?;
        let last_seen_at = take_optional(&mut entry, "lastSeenAt")
            .map(parse_i64)
            .transpose()?
            .unwrap_or(0);
        let aliases = take_optional(&mut entry, "aliases")
            .map(parse_aliases)
            .transpose()?;
        clients.insert(
            client,
            humanchrome_core::browser_state::PersistedClientEntry {
                owned_tab_ids,
                active_tab_id,
                last_window_id,
                last_seen_at,
                aliases,
            },
        );
    }
    Ok(humanchrome_core::browser_state::OwnershipSnapshot { clients })
}
fn parse_aliases(value: JsonDocument) -> Result<indexmap::IndexMap<String, i64>, JsValue> {
    value
        .into_object_fields()
        .ok_or_else(|| error("aliases must be an object"))?
        .into_iter()
        .map(|(key, value)| {
            Ok((
                key.as_utf8()
                    .ok_or_else(|| error("alias must be UTF-8"))?
                    .to_owned(),
                parse_i64(value)?,
            ))
        })
        .collect()
}
fn parse_optional_ids(value: JsonDocument) -> Result<Option<IndexSet<i64>>, JsValue> {
    if value.as_ref().is_null() {
        Ok(None)
    } else {
        Ok(Some(parse_ids(value)?.into_iter().collect()))
    }
}
fn parse_ids(value: JsonDocument) -> Result<Vec<i64>, JsValue> {
    value
        .into_array_values()
        .ok_or_else(|| error("tab ids must be an array"))?
        .into_iter()
        .map(parse_i64)
        .collect()
}
fn parse_i64(value: JsonDocument) -> Result<i64, JsValue> {
    value
        .as_ref()
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && number.fract() == 0.0
                && *number >= i64::MIN as f64
                && *number <= i64::MAX as f64
        })
        .map(|number| number as i64)
        .ok_or_else(|| error("expected finite integer"))
}
fn parse_optional_i64(value: JsonDocument) -> Result<Option<i64>, JsValue> {
    if value.as_ref().is_null() {
        Ok(None)
    } else {
        parse_i64(value).map(Some)
    }
}
fn parse_optional_string(value: JsonDocument) -> Result<Option<String>, JsValue> {
    if value.as_ref().is_null() {
        return Ok(None);
    }
    let value = value.as_ref().to_js_string();
    Ok(Some(
        value
            .as_utf8()
            .ok_or_else(|| error("expected UTF-8 string"))?
            .to_owned(),
    ))
}
fn parse_pacing_profile(value: JsString) -> Result<PacingProfile, JsValue> {
    match value.as_utf8() {
        Some("off") => Ok(PacingProfile::Off),
        Some("human") => Ok(PacingProfile::Human),
        Some("careful") => Ok(PacingProfile::Careful),
        Some("fast") => Ok(PacingProfile::Fast),
        _ => Err(error("unknown pacing profile")),
    }
}
fn parse_pacing_overrides(mut value: JsonDocument) -> Result<PacingOverrides, JsValue> {
    if value.as_ref().is_null() {
        return Ok(PacingOverrides::default());
    }
    Ok(PacingOverrides {
        min_gap_ms: take_optional(&mut value, "minGapMs")
            .map(parse_i64)
            .transpose()?,
        jitter_ms: take_optional(&mut value, "jitterMs")
            .map(parse_i64)
            .transpose()?,
    })
}
fn parse_access(value: JsString) -> Result<TargetAccess, JsValue> {
    match value.as_utf8() {
        Some("read") => Ok(TargetAccess::Read),
        Some("mutate") => Ok(TargetAccess::Mutate),
        _ => Err(error("target access must be read or mutate")),
    }
}
fn parse_target_request(mut value: JsonDocument) -> Result<TargetRequest, JsValue> {
    Ok(TargetRequest {
        client_id: take_optional(&mut value, "clientId")
            .map(parse_optional_string)
            .transpose()?
            .flatten(),
        explicit_tab_id: take_optional(&mut value, "explicitTabId")
            .map(parse_i64)
            .transpose()?,
        trimmed_tab_alias: take_optional(&mut value, "trimmedTabAlias")
            .map(|value| parse_string(&value.to_json_text()))
            .transpose()?,
        access: take_optional(&mut value, "access")
            .map(|value| parse_access(value.as_ref().to_js_string()))
            .transpose()?
            .unwrap_or_default(),
    })
}
fn parse_dispatch_request(mut value: JsonDocument) -> Result<DispatchRequest, JsValue> {
    Ok(DispatchRequest {
        target: parse_target_request(take_required(&mut value, "target")?)?,
        auto_spawn_policy: match take_optional(&mut value, "autoSpawnPolicy")
            .map(|value| value.as_ref().to_js_string())
            .as_ref()
            .and_then(JsString::as_utf8)
        {
            Some("disabled") => AutoSpawnPolicy::Disabled,
            Some("enabled") | None => AutoSpawnPolicy::Enabled,
            _ => return Err(error("invalid autoSpawnPolicy")),
        },
        url_targeting: match take_optional(&mut value, "urlTargeting")
            .map(|value| value.as_ref().to_js_string())
            .as_ref()
            .and_then(JsString::as_utf8)
        {
            Some("provided") => UrlTargeting::Provided,
            Some("absent") | None => UrlTargeting::Absent,
            _ => return Err(error("invalid urlTargeting")),
        },
        explicit_window_id: take_optional(&mut value, "explicitWindowId")
            .map(parse_i64)
            .transpose()?,
        window_targeting: match take_optional(&mut value, "windowTargeting")
            .map(|value| value.as_ref().to_js_string())
            .as_ref()
            .and_then(JsString::as_utf8)
        {
            Some("explicitOnly") => WindowTargeting::ExplicitOnly,
            Some("useClientHint") | None => WindowTargeting::UseClientHint,
            _ => return Err(error("invalid windowTargeting")),
        },
        tab_liveness: take_optional(&mut value, "tabLiveness")
            .map(|value| parse_liveness(value.as_ref().to_js_string()))
            .transpose()?
            .unwrap_or_default(),
    })
}
fn parse_liveness(value: JsString) -> Result<TabLiveness, JsValue> {
    match value.as_utf8() {
        Some("unprobed") => Ok(TabLiveness::Unprobed),
        Some("live") => Ok(TabLiveness::Live),
        Some("missing") => Ok(TabLiveness::Missing),
        _ => Err(error("invalid tab liveness")),
    }
}
fn take_required(value: &mut JsonDocument, key: &str) -> Result<JsonDocument, JsValue> {
    value
        .remove(key)
        .ok_or_else(|| error(format!("missing {key}")))
}
fn take_optional(value: &mut JsonDocument, key: &str) -> Option<JsonDocument> {
    value.remove(key).filter(|value| !value.as_ref().is_null())
}
fn json_optional_string(value: Option<String>) -> String {
    value
        .map(|value| JsonDocument::from(value).to_json_text())
        .unwrap_or_else(|| "null".to_owned())
}
fn json_optional_i64(value: Option<i64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_owned())
}
fn policy_error_json(value: humanchrome_core::browser_state::BrowserStateError) -> String {
    value.as_json_document().to_json_text()
}
fn resolution_json(
    value: humanchrome_core::browser_state::TargetResolution,
) -> Result<String, JsValue> {
    match value.as_error() {
        Some(error) => Ok(format!("{{\"error\":{}}}", policy_error_json(error))),
        None => Ok(format!("{{\"tabId\":{}}}", json_optional_i64(value.tab_id))),
    }
}
fn queue_admission_json(
    value: humanchrome_core::browser_state::QueueAdmission,
) -> Result<String, JsValue> {
    match value {
        humanchrome_core::browser_state::QueueAdmission::Granted(grant) => Ok(format!(
            "{{\"kind\":\"granted\",\"grant\":{}}}",
            encode_serializable(&grant)?
        )),
        humanchrome_core::browser_state::QueueAdmission::Queued(ticket) => Ok(format!(
            "{{\"kind\":\"queued\",\"ticket\":{}}}",
            encode_serializable(&ticket)?
        )),
        humanchrome_core::browser_state::QueueAdmission::Rejected { error } => Ok(format!(
            "{{\"kind\":\"rejected\",\"error\":{}}}",
            policy_error_json(error)
        )),
    }
}
fn queue_transition_json(
    value: humanchrome_core::browser_state::QueueTransition,
) -> Result<String, JsValue> {
    let promoted = value
        .promoted
        .map(|grant| encode_serializable(&grant))
        .transpose()?
        .unwrap_or_else(|| "null".to_owned());
    let cancelled = value
        .cancelled
        .into_iter()
        .map(|ticket| {
            format!(
                "{{\"ticket\":{},\"error\":{}}}",
                ticket.ticket,
                policy_error_json(ticket.error)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "{{\"promoted\":{promoted},\"cancelled\":[{cancelled}],\"retired\":{}}}",
        value.retired
    ))
}
