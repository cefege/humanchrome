//! Trigger admission, cron scheduling, and DOM-observer payload policy.
//!
//! Hosts own Chrome listeners, alarms, and Date/Intl observations. This module owns the
//! deterministic decisions over those observations.

use crate::arguments::JsString;

use serde::Serialize;

use std::collections::{BTreeSet, HashMap};

use indexmap::IndexSet;

/// Normalized storm-control configuration for one trigger manager.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TriggerAdmissionConfig {
    cooldown_ms: u64,
    max_queued: Option<u64>,
}

impl TriggerAdmissionConfig {
    /// Validates the JavaScript storm-control fields.
    ///
    /// `None` represents either `undefined` or `null`.
    pub fn new(cooldown_ms: Option<f64>, max_queued: Option<f64>) -> Result<Self, String> {
        Ok(Self {
            cooldown_ms: normalize_non_negative(cooldown_ms, 0, "storm.cooldownMs")?,
            max_queued: max_queued
                .map(|value| normalize_positive(value, "storm.maxQueued"))
                .transpose()?,
        })
    }

    /// Returns whether the host must obtain the current queued count before admission.
    #[must_use]
    pub fn has_queue_cap(self) -> bool {
        self.max_queued.is_some()
    }
}

fn normalize_non_negative(
    value: Option<f64>,
    fallback: u64,
    field_name: &str,
) -> Result<u64, String> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    if !value.is_finite() {
        return Err(format!("{field_name} must be a finite number"));
    }
    Ok(value.floor().max(0.0) as u64)
}

fn normalize_positive(value: f64, field_name: &str) -> Result<u64, String> {
    if !value.is_finite() {
        return Err(format!("{field_name} must be a finite number"));
    }
    let value = value.floor();
    if value < 1.0 {
        return Err(format!("{field_name} must be >= 1"));
    }
    Ok(value as u64)
}

/// Why one trigger fire was not admitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerDropReason {
    /// The manager has not started.
    NotStarted,
    /// The trigger is not currently installed.
    NotInstalled,
    /// The persisted queue plus enqueues in progress reaches the configured cap.
    MaxQueued,
    /// The trigger fired inside its own cooldown window.
    Cooldown,
}

/// Result of a trigger-fire admission attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerAdmission {
    /// The host may enqueue and must later report its terminal outcome with this ticket.
    Admitted { ticket: u64 },
    /// The host must drop the fire without enqueueing.
    Dropped(TriggerDropReason),
}

#[derive(Clone, Debug)]
struct PendingAdmission {
    trigger_id: JsString,
    previous_last_fire: Option<i64>,
}

/// Stateful admission policy for one V3 trigger manager.
#[derive(Clone, Debug)]
pub struct TriggerAdmissionState {
    config: TriggerAdmissionConfig,
    started: bool,
    installed: IndexSet<JsString>,
    last_fire_at: HashMap<JsString, i64>,
    pending: HashMap<u64, PendingAdmission>,
    next_ticket: u64,
}

impl TriggerAdmissionState {
    /// Creates a stopped admission state from validated storm-control configuration.
    #[must_use]
    pub fn new(config: TriggerAdmissionConfig) -> Self {
        Self {
            config,
            started: false,
            installed: IndexSet::new(),
            last_fire_at: HashMap::new(),
            pending: HashMap::new(),
            next_ticket: 1,
        }
    }

    /// Starts admission without installing any trigger identities.
    pub fn start(&mut self) {
        self.started = true;
    }

    /// Stops admission and clears installed identities and cooldown stamps.
    pub fn stop(&mut self) {
        self.started = false;
        self.installed.clear();
        self.last_fire_at.clear();
    }

    /// Returns whether the manager is started.
    #[must_use]
    pub fn is_started(&self) -> bool {
        self.started
    }

    /// Returns whether the configured cap requires a host queue-count observation.
    #[must_use]
    pub fn has_queue_cap(&self) -> bool {
        self.config.has_queue_cap()
    }

    /// Replaces installed trigger identities after the host has uninstalled its handlers.
    pub fn clear_installed(&mut self) {
        self.installed.clear();
    }

    /// Marks one successfully installed trigger identity as eligible to fire.
    pub fn install(&mut self, trigger_id: JsString) {
        self.installed.insert(trigger_id);
    }

    /// Removes one uninstalled trigger identity.
    pub fn uninstall(&mut self, trigger_id: &JsString) {
        self.installed.shift_remove(trigger_id);
    }

    /// Returns installed trigger identities in their successful-install order.
    #[must_use]
    pub fn installed_ids(&self) -> Vec<JsString> {
        self.installed.iter().cloned().collect()
    }

    /// Applies cap-before-cooldown admission using explicit host time and queue count.
    pub fn admit(
        &mut self,
        trigger_id: &JsString,
        now_ms: i64,
        queued_count: u64,
    ) -> TriggerAdmission {
        if !self.started {
            return TriggerAdmission::Dropped(TriggerDropReason::NotStarted);
        }
        if !self.installed.contains(trigger_id) {
            return TriggerAdmission::Dropped(TriggerDropReason::NotInstalled);
        }
        if let Some(max_queued) = self.config.max_queued
            && queued_count.saturating_add(self.pending.len() as u64) >= max_queued
        {
            return TriggerAdmission::Dropped(TriggerDropReason::MaxQueued);
        }

        let previous_last_fire = self.last_fire_at.get(trigger_id).copied();
        if self.config.cooldown_ms > 0
            && previous_last_fire.is_some_and(|previous| {
                now_ms.saturating_sub(previous) < self.config.cooldown_ms as i64
            })
        {
            return TriggerAdmission::Dropped(TriggerDropReason::Cooldown);
        }
        if self.config.cooldown_ms > 0 {
            self.last_fire_at.insert(trigger_id.clone(), now_ms);
        }

        let ticket = self.next_ticket;
        self.next_ticket = self.next_ticket.wrapping_add(1).max(1);
        self.pending.insert(
            ticket,
            PendingAdmission {
                trigger_id: trigger_id.clone(),
                previous_last_fire,
            },
        );
        TriggerAdmission::Admitted { ticket }
    }

    /// Formats the established drop error for one admission decision.
    #[must_use]
    pub fn drop_message(&self, trigger_id: &JsString, reason: TriggerDropReason) -> JsString {
        match reason {
            TriggerDropReason::NotStarted => JsString::from_string("TriggerManager is not started"),
            TriggerDropReason::NotInstalled => trigger_message(trigger_id, " is not installed"),
            TriggerDropReason::MaxQueued => trigger_message(
                trigger_id,
                &format!(
                    " dropped (maxQueued={})",
                    self.config.max_queued.unwrap_or_default()
                ),
            ),
            TriggerDropReason::Cooldown => trigger_message(
                trigger_id,
                &format!(" dropped (cooldown {}ms)", self.config.cooldown_ms),
            ),
        }
    }

    /// Completes a host enqueue and restores the preceding cooldown stamp on failure.
    pub fn finish(&mut self, ticket: u64, succeeded: bool) {
        let Some(pending) = self.pending.remove(&ticket) else {
            return;
        };
        if succeeded || self.config.cooldown_ms == 0 {
            return;
        }
        match pending.previous_last_fire {
            Some(previous) => {
                self.last_fire_at.insert(pending.trigger_id, previous);
            }
            None => {
                self.last_fire_at.remove(&pending.trigger_id);
            }
        }
    }
}

fn trigger_message(trigger_id: &JsString, suffix: &str) -> JsString {
    let mut message = JsString::from_string("Trigger \"");
    message.push_js_string(trigger_id);
    message.push_str("\"");
    message.push_str(suffix);
    message
}

/// Parsed five-field cron expression.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CronExpression {
    minute: Vec<u8>,
    hour: Vec<u8>,
    day_of_month: Vec<u8>,
    month: Vec<u8>,
    day_of_week: Vec<u8>,
}

impl CronExpression {
    /// Parses the supported five-field cron grammar.
    pub fn parse(cron: &str) -> Result<Self, String> {
        let fields: Vec<&str> = cron.split(' ').collect();
        if fields.len() != 5 {
            return Err(format!(
                "Invalid cron expression: expected 5 fields, got {}",
                fields.len()
            ));
        }
        Ok(Self {
            minute: parse_cron_field(fields[0], 0, 59)?,
            hour: parse_cron_field(fields[1], 0, 23)?,
            day_of_month: parse_cron_field(fields[2], 1, 31)?,
            month: parse_cron_field(fields[3], 1, 12)?,
            day_of_week: parse_cron_field(fields[4], 0, 6)?,
        })
    }
}

fn parse_cron_field(field: &str, min: u8, max: u8) -> Result<Vec<u8>, String> {
    let mut values = BTreeSet::new();
    for part in field.split(',') {
        if part == "*" {
            values.extend(min..=max);
        } else if part.contains('/') {
            let mut pieces = part.split('/');
            let range = pieces.next().unwrap_or_default();
            let step_text = pieces.next().unwrap_or_default();
            let step = js_parse_int(step_text)
                .filter(|value| *value >= 1)
                .ok_or_else(|| {
                    format!("Invalid step in cron field: \"{part}\" (step must be >= 1)")
                })?;
            let start = if range == "*" {
                i64::from(min)
            } else {
                js_parse_int(range)
                    .filter(|value| *value >= i64::from(min) && *value <= i64::from(max))
                    .ok_or_else(|| format!("Invalid range start in cron field: \"{part}\""))?
            };
            let mut value = start;
            while value <= i64::from(max) {
                values.insert(value as u8);
                let Some(next) = value.checked_add(step) else {
                    break;
                };
                value = next;
            }
        } else if part.contains('-') {
            let mut pieces = part.split('-');
            let start = js_parse_int(pieces.next().unwrap_or_default());
            let end = js_parse_int(pieces.next().unwrap_or_default());
            let (Some(start), Some(end)) = (start, end) else {
                return Err(format!("Invalid range in cron field: \"{part}\""));
            };
            if start > end {
                return Err(format!("Invalid range in cron field: \"{part}\""));
            }
            for value in start..=end {
                if value >= i64::from(min) && value <= i64::from(max) {
                    values.insert(value as u8);
                } else {
                    return Err(format!(
                        "Cron field value {value} out of range [{min}, {max}]"
                    ));
                }
            }
        } else {
            let Some(value) = js_parse_int(part) else {
                return Err(format!("Invalid number in cron field: \"{part}\""));
            };
            if value < i64::from(min) || value > i64::from(max) {
                return Err(format!(
                    "Cron field value {value} out of range [{min}, {max}]"
                ));
            }
            values.insert(value as u8);
        }
    }
    Ok(values.into_iter().collect())
}

// JavaScript's parseInt(text, 10) accepts a signed decimal prefix and ignores its suffix.
fn js_parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start_matches(char::is_whitespace);
    let (negative, digits) = match text.as_bytes().first().copied() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let digit_count = digits
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digit_count == 0 {
        return None;
    }
    let value = digits[..digit_count].parse::<i64>().ok()?;
    Some(if negative { -value } else { value })
}

/// Calendar values observed through the host's Date/Intl intrinsic boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CronClockParts {
    /// Epoch milliseconds for a local Date candidate; unused for a zoned observation.
    pub timestamp_ms: i64,
    /// Calendar year.
    pub year: i32,
    /// One-based calendar month.
    pub month: u8,
    /// One-based day of month.
    pub day: u8,
    /// Hour in 24-hour time.
    pub hour: u8,
    /// Minute.
    pub minute: u8,
    /// Sunday-based weekday.
    pub day_of_week: u8,
}

/// Finds the next local-time fire using host Date candidate observations.
///
/// The host callback performs only the legacy `Date#setDate`/`Date#setHours` observation.
pub fn cron_next_local(
    cron: &CronExpression,
    from_ms: i64,
    mut candidate_at: impl FnMut(i64, u16, u8, u8) -> Result<CronClockParts, String>,
) -> Result<i64, String> {
    for day_offset in 0..366 {
        for &hour in &cron.hour {
            for &minute in &cron.minute {
                let candidate = candidate_at(from_ms, day_offset, hour, minute)?;
                if candidate.timestamp_ms <= from_ms || !cron_matches(cron, candidate) {
                    continue;
                }
                return Ok(candidate.timestamp_ms);
            }
        }
    }
    Err("Failed to compute next cron fire time within 1 year".to_owned())
}

/// Finds the next zoned fire using host Intl observations and the legacy offset refinement.
pub fn cron_next_zoned(
    cron: &CronExpression,
    from_ms: i64,
    mut zoned_parts_at: impl FnMut(i64) -> Result<CronClockParts, String>,
) -> Result<i64, String> {
    let base = zoned_parts_at(from_ms.saturating_add(1_000))?;
    let mut date = CivilDate::new(base.year, base.month, base.day);
    for day_offset in 0..366 {
        if day_offset > 0 {
            date = date.next_day();
        }
        let day_of_week = date.day_of_week();
        if !cron.month.contains(&date.month)
            || (!cron.day_of_month.contains(&date.day) && !cron.day_of_week.contains(&day_of_week))
        {
            continue;
        }
        for &hour in &cron.hour {
            for &minute in &cron.minute {
                let base_utc = date.utc_ms(hour, minute);
                let mut candidate = base_utc;
                for _ in 0..3 {
                    let observed = zoned_parts_at(candidate)?;
                    let offset = CivilDate::new(observed.year, observed.month, observed.day)
                        .utc_ms(observed.hour, observed.minute)
                        .saturating_sub(candidate);
                    let next = base_utc.saturating_sub(offset);
                    if next == candidate {
                        break;
                    }
                    candidate = next;
                }
                if candidate <= from_ms {
                    continue;
                }
                let round_trip = zoned_parts_at(candidate)?;
                if round_trip.year != date.year
                    || round_trip.month != date.month
                    || round_trip.day != date.day
                    || round_trip.hour != hour
                    || round_trip.minute != minute
                {
                    continue;
                }
                return Ok(candidate);
            }
        }
    }
    Err("Failed to compute next cron fire time within 1 year".to_owned())
}

fn cron_matches(cron: &CronExpression, candidate: CronClockParts) -> bool {
    cron.month.contains(&candidate.month)
        && (cron.day_of_month.contains(&candidate.day)
            || cron.day_of_week.contains(&candidate.day_of_week))
}

#[derive(Clone, Copy, Debug)]
struct CivilDate {
    year: i32,
    month: u8,
    day: u8,
}

impl CivilDate {
    const fn new(year: i32, month: u8, day: u8) -> Self {
        Self { year, month, day }
    }

    fn next_day(mut self) -> Self {
        self.day += 1;
        if self.day > days_in_month(self.year, self.month) {
            self.day = 1;
            self.month += 1;
            if self.month > 12 {
                self.month = 1;
                self.year += 1;
            }
        }
        self
    }

    fn day_of_week(self) -> u8 {
        // 1970-01-01 was Thursday (4 when Sunday is zero).
        ((days_from_civil(self.year, self.month, self.day) + 4).rem_euclid(7)) as u8
    }

    fn utc_ms(self, hour: u8, minute: u8) -> i64 {
        days_from_civil(self.year, self.month, self.day)
            .saturating_mul(86_400_000)
            .saturating_add(i64::from(hour) * 3_600_000)
            .saturating_add(i64::from(minute) * 60_000)
    }
}

const fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

const fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

// Howard Hinnant's civil-date conversion, measured from the Unix epoch.
fn days_from_civil(year: i32, month: u8, day: u8) -> i64 {
    let year = i64::from(year) - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Host-observed values needed to canonicalize one DOM observer trigger.
#[derive(Clone, Debug, PartialEq)]
pub struct DomTriggerInput {
    /// Trigger identity.
    pub id: String,
    /// Host String-coerced and String-trimmed selector.
    pub selector: String,
    /// Whether the source value was exactly boolean false.
    pub appear_is_false: bool,
    /// Whether the source value was exactly boolean false.
    pub once_is_false: bool,
    /// Numeric debounce input, if it is a finite number.
    pub debounce_ms: Option<f64>,
}

/// Canonical DOM-observer payload row.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomTriggerPayload {
    /// Trigger identity.
    pub id: String,
    /// Non-empty trimmed CSS selector.
    pub selector: String,
    /// Defaults true unless exactly false.
    pub appear: bool,
    /// Defaults true unless exactly false.
    pub once: bool,
    /// Non-negative floored debounce, defaulting to 800 milliseconds.
    pub debounce_ms: f64,
}

/// Canonicalizes and stably orders one complete DOM-observer payload batch.
///
/// The comparison callback is the host's native `localeCompare` observation.
pub fn dom_trigger_payload(
    entries: impl IntoIterator<Item = DomTriggerInput>,
    mut locale_compare: impl FnMut(&str, &str) -> Result<i32, String>,
) -> Result<Vec<DomTriggerPayload>, String> {
    let mut out = Vec::new();
    for entry in entries {
        let selector = entry.selector;
        if selector.is_empty() {
            continue;
        }
        out.push(DomTriggerPayload {
            id: entry.id,
            selector,
            appear: !entry.appear_is_false,
            once: !entry.once_is_false,
            debounce_ms: entry
                .debounce_ms
                .filter(|value| value.is_finite())
                .map(|value| value.floor().max(0.0))
                .unwrap_or(800.0),
        });
    }

    // Insertion sorting retains the legacy stable sort when localeCompare returns zero.
    for index in 1..out.len() {
        let mut cursor = index;
        while cursor > 0 && locale_compare(&out[cursor].id, &out[cursor - 1].id)? < 0 {
            out.swap(cursor, cursor - 1);
            cursor -= 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_caps_before_cooldown_and_rolls_back_failure() {
        let config = TriggerAdmissionConfig::new(Some(500.0), Some(1.0)).expect("valid config");
        let mut state = TriggerAdmissionState::new(config);
        state.start();
        let trigger = JsString::from_string("trigger");
        state.install(trigger.clone());
        let TriggerAdmission::Admitted { ticket } = state.admit(&trigger, 100, 0) else {
            panic!("first fire should admit");
        };
        assert_eq!(
            state.admit(&trigger, 200, 1),
            TriggerAdmission::Dropped(TriggerDropReason::MaxQueued)
        );
        state.finish(ticket, false);
        assert!(matches!(
            state.admit(&trigger, 200, 0),
            TriggerAdmission::Admitted { .. }
        ));
    }

    #[test]
    fn cron_parser_sorts_and_deduplicates() {
        let cron = CronExpression::parse("5,1,5 0 1 * 0").expect("valid cron");
        assert_eq!(cron.minute, vec![1, 5]);
        assert_eq!(cron.month, (1..=12).collect::<Vec<_>>());
    }

    #[test]
    fn dom_payload_defaults_and_stable_order() {
        let payload = dom_trigger_payload(
            [
                DomTriggerInput {
                    id: "b".into(),
                    selector: "#b".into(),
                    appear_is_false: false,
                    once_is_false: false,
                    debounce_ms: Some(f64::NAN),
                },
                DomTriggerInput {
                    id: "a".into(),
                    selector: "".into(),
                    appear_is_false: false,
                    once_is_false: false,
                    debounce_ms: None,
                },
                DomTriggerInput {
                    id: "a".into(),
                    selector: "#a".into(),
                    appear_is_false: true,
                    once_is_false: true,
                    debounce_ms: Some(-0.1),
                },
            ],
            |left, right| {
                Ok(match left.cmp(right) {
                    std::cmp::Ordering::Less => -1,
                    std::cmp::Ordering::Equal => 0,
                    std::cmp::Ordering::Greater => 1,
                })
            },
        )
        .expect("comparison succeeds");
        assert_eq!(payload.len(), 2);
        assert_eq!(payload[0].id, "a");
        assert_eq!(payload[0].debounce_ms, 0.0);
        assert_eq!(payload[1].debounce_ms, 800.0);
    }
}
