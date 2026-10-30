//! Portable browser metadata policy for URL markers, resource registries, and tab listings.
//!
//! Chrome rows, IndexedDB records, timers, callbacks, and opaque registry values remain host-owned.

use std::cmp::Ordering;

use crate::arguments::JsString;

/// Synthetic registry lane for entries without a request-scoped client.
pub const SYSTEM_REGISTRY_CLIENT: &str = "__system";
/// Largest accepted per-tool pacing override in milliseconds.
pub const MAX_PACING_OVERRIDE_MS: f64 = 30_000.0;

/// URL components produced by the host's native `URL` parser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMarkerUrl {
    /// Browser-normalized origin.
    pub origin: JsString,
    /// Browser-normalized hostname.
    pub host: JsString,
    /// Browser-normalized pathname.
    pub path: JsString,
}

/// Stored marker URL fields used by matching policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkerUrl {
    /// The exact raw URL supplied by the caller.
    pub url: JsString,
    /// Browser-normalized origin, or an empty string after a URL parse failure.
    pub origin: JsString,
    /// Browser-normalized hostname, or an empty string after a URL parse failure.
    pub host: JsString,
    /// Browser-normalized pathname, or an empty string after a URL parse failure.
    pub path: JsString,
}

/// Marker metadata needed for URL matching; marker objects themselves remain host-owned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkerMatchRecord {
    /// Exact match mode when present.
    pub match_type: Option<JsString>,
    /// Persisted origin field.
    pub origin: Option<JsString>,
    /// Persisted hostname field.
    pub host: Option<JsString>,
    /// Persisted pathname field.
    pub path: Option<JsString>,
}

/// Registry entry metadata used to choose host-owned values for eviction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryEntry {
    /// Resolved registry client key.
    pub client_id: JsString,
    /// Chrome tab identifier.
    pub tab_id: i64,
    /// Whether the host value is not JavaScript `undefined`.
    pub value_is_defined: bool,
}

/// Browser row metadata used for deterministic owned-tab rendering order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OwnedTabOrderRow {
    /// Source position in the host-owned row collection.
    pub source_index: usize,
    /// Chrome window identifier; absent values follow JavaScript's `?? 0` behavior.
    pub window_id: Option<f64>,
    /// Chrome tab identifier.
    pub tab_id: f64,
}

/// Primitive classification supplied by the host without JSON's non-finite-number loss.
#[derive(Clone, Debug, PartialEq)]
pub enum PaceInputValue {
    /// JavaScript `undefined`.
    Undefined,
    /// A JavaScript string, including lossless UTF-16 data.
    String(JsString),
    /// A finite JavaScript number.
    FiniteNumber(f64),
    /// Any non-string/non-finite input.
    Other,
}

/// Accepted pacing profile names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaceProfile {
    /// Disable pacing.
    Off,
    /// Human pacing.
    Human,
    /// Careful pacing.
    Careful,
    /// Fast pacing.
    Fast,
}

impl PaceProfile {
    /// Returns the public profile spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Human => "human",
            Self::Careful => "careful",
            Self::Fast => "fast",
        }
    }
}

/// Pacing tool argument result, preserving read-versus-write and invalid-profile distinctions.
#[derive(Clone, Debug, PartialEq)]
pub enum PaceInputPlan {
    /// No profile argument: return the current state.
    Read,
    /// A non-string profile uses the existing fixed validation error.
    InvalidProfileType,
    /// A string profile is not one of the accepted names.
    InvalidProfileValue(JsString),
    /// A valid profile and finite, clamped optional overrides.
    Set {
        /// Requested pacing profile.
        profile: PaceProfile,
        /// Optional replacement minimum delay.
        min_gap_ms: Option<f64>,
        /// Optional replacement jitter bound.
        jitter_ms: Option<f64>,
    },
}

/// Error category selected from a host-observed tab-operation message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabErrorCategory {
    /// The browser tab or its content-script receiver is no longer available.
    TabClosed,
    /// The message has no tab-lifecycle classification.
    Unknown,
}

/// Typed tab-error classification and normalized message plan.
///
/// Error identity, detail merging, and MCP serialization remain in the JavaScript host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabErrorPlan {
    /// The public structured-error category.
    pub category: TabErrorCategory,
    /// The message to serialize without further host normalization.
    pub message: JsString,
}

/// Classifies browser tab-operation messages and normalizes no-tab errors when the host supplied
/// a JavaScript-formatted tab identifier.
#[must_use]
pub fn classify_tab_error_message(message: JsString, tab_id_display: Option<&str>) -> TabErrorPlan {
    const NO_TAB_WITH_ID: &[u16] = &[
        b'n' as u16,
        b'o' as u16,
        b' ' as u16,
        b't' as u16,
        b'a' as u16,
        b'b' as u16,
        b' ' as u16,
        b'w' as u16,
        b'i' as u16,
        b't' as u16,
        b'h' as u16,
        b' ' as u16,
        b'i' as u16,
        b'd' as u16,
    ];
    const RECEIVING_END_DOES_NOT_EXIST: &[u16] = &[
        b'r' as u16,
        b'e' as u16,
        b'c' as u16,
        b'e' as u16,
        b'i' as u16,
        b'v' as u16,
        b'i' as u16,
        b'n' as u16,
        b'g' as u16,
        b' ' as u16,
        b'e' as u16,
        b'n' as u16,
        b'd' as u16,
        b' ' as u16,
        b'd' as u16,
        b'o' as u16,
        b'e' as u16,
        b's' as u16,
        b' ' as u16,
        b'n' as u16,
        b'o' as u16,
        b't' as u16,
        b' ' as u16,
        b'e' as u16,
        b'x' as u16,
        b'i' as u16,
        b's' as u16,
        b't' as u16,
    ];
    const COULD_NOT_ESTABLISH_CONNECTION: &[u16] = &[
        b'c' as u16,
        b'o' as u16,
        b'u' as u16,
        b'l' as u16,
        b'd' as u16,
        b' ' as u16,
        b'n' as u16,
        b'o' as u16,
        b't' as u16,
        b' ' as u16,
        b'e' as u16,
        b's' as u16,
        b't' as u16,
        b'a' as u16,
        b'b' as u16,
        b'l' as u16,
        b'i' as u16,
        b's' as u16,
        b'h' as u16,
        b' ' as u16,
        b'c' as u16,
        b'o' as u16,
        b'n' as u16,
        b'n' as u16,
        b'e' as u16,
        b'c' as u16,
        b't' as u16,
        b'i' as u16,
        b'o' as u16,
        b'n' as u16,
    ];

    if contains_ascii_case_insensitive(&message, NO_TAB_WITH_ID) {
        let message = tab_id_display.map_or(message, |tab_id| {
            JsString::from_owned_string(format!("Tab {tab_id} not found"))
        });
        return TabErrorPlan {
            category: TabErrorCategory::TabClosed,
            message,
        };
    }

    let tab_closed = contains_ascii_case_insensitive(&message, RECEIVING_END_DOES_NOT_EXIST)
        || contains_ascii_case_insensitive(&message, COULD_NOT_ESTABLISH_CONNECTION);
    TabErrorPlan {
        category: if tab_closed {
            TabErrorCategory::TabClosed
        } else {
            TabErrorCategory::Unknown
        },
        message,
    }
}

/// Applies the storage policy around the host's native `URL` parsing result.
#[must_use]
pub fn normalize_marker_url(raw: JsString, parsed: Option<ParsedMarkerUrl>) -> MarkerUrl {
    match parsed {
        Some(parsed) => MarkerUrl {
            url: raw,
            origin: parsed.origin,
            host: parsed.host,
            path: parsed.path,
        },
        None => MarkerUrl {
            url: raw,
            origin: JsString::from_string(""),
            host: JsString::from_string(""),
            path: JsString::from_string(""),
        },
    }
}

/// Returns matching marker indexes in their original IndexedDB order.
#[must_use]
pub fn matching_marker_indexes(
    markers: &[Option<MarkerMatchRecord>],
    current: &MarkerUrl,
) -> Vec<usize> {
    markers
        .iter()
        .enumerate()
        .filter_map(|(index, marker)| marker_matches(marker.as_ref()?, current).then_some(index))
        .collect()
}

/// Resolves a missing or empty request client into the resource registry system lane.
#[must_use]
pub fn resolve_registry_client_id(client_id: Option<JsString>) -> JsString {
    client_id
        .filter(|client_id| client_id.utf16_len() > 0)
        .unwrap_or_else(|| JsString::from_string(SYSTEM_REGISTRY_CLIENT))
}

/// Selects defined-value entries for a tab-close eviction in existing iteration order.
#[must_use]
pub fn registry_forget_tab_indexes(entries: &[RegistryEntry], tab_id: i64) -> Vec<usize> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            (entry.tab_id == tab_id && entry.value_is_defined).then_some(index)
        })
        .collect()
}

/// Selects every entry for a client-release eviction in existing iteration order.
#[must_use]
pub fn registry_forget_client_indexes(
    entries: &[RegistryEntry],
    client_id: &JsString,
) -> Vec<usize> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| (entry.client_id == *client_id).then_some(index))
        .collect()
}

/// Plans the pacing tool's profile validation and finite override clamps.
#[must_use]
pub fn plan_pacing_input(
    profile: PaceInputValue,
    min_gap_ms: PaceInputValue,
    jitter_ms: PaceInputValue,
) -> PaceInputPlan {
    let profile = match profile {
        PaceInputValue::Undefined => return PaceInputPlan::Read,
        PaceInputValue::String(profile) => profile,
        PaceInputValue::FiniteNumber(_) | PaceInputValue::Other => {
            return PaceInputPlan::InvalidProfileType;
        }
    };
    let profile = match profile.as_utf8() {
        Some("off") => PaceProfile::Off,
        Some("human") => PaceProfile::Human,
        Some("careful") => PaceProfile::Careful,
        Some("fast") => PaceProfile::Fast,
        _ => return PaceInputPlan::InvalidProfileValue(profile),
    };
    PaceInputPlan::Set {
        profile,
        min_gap_ms: finite_pacing_override(min_gap_ms),
        jitter_ms: finite_pacing_override(jitter_ms),
    }
}

/// Returns source indexes sorted stably by JavaScript `windowId ?? 0`, then tab id.
#[must_use]
pub fn stable_owned_tab_order(rows: &[OwnedTabOrderRow]) -> Vec<usize> {
    let mut indexes: Vec<usize> = (0..rows.len()).collect();
    indexes.sort_by(|left, right| {
        let left = rows[*left];
        let right = rows[*right];
        let left_window = left.window_id.unwrap_or(0.0);
        let right_window = right.window_id.unwrap_or(0.0);
        if left_window != right_window {
            return js_subtraction_compare(left_window, right_window);
        }
        js_subtraction_compare(left.tab_id, right.tab_id)
    });
    indexes
}

fn contains_ascii_case_insensitive(value: &JsString, pattern: &[u16]) -> bool {
    const MAX_PATTERN_LEN: usize = 30;
    if pattern.is_empty() {
        return true;
    }
    debug_assert!(
        pattern.len() <= MAX_PATTERN_LEN,
        "tab-error pattern exceeds the fixed matching window"
    );

    let mut failure = [0_usize; MAX_PATTERN_LEN];
    for index in 1..pattern.len() {
        let mut prefix_len = failure[index - 1];
        while prefix_len > 0 && pattern[index] != pattern[prefix_len] {
            prefix_len = failure[prefix_len - 1];
        }
        if pattern[index] == pattern[prefix_len] {
            prefix_len += 1;
        }
        failure[index] = prefix_len;
    }

    let mut matched = 0;
    for unit in value.utf16_units().map(ascii_lowercase) {
        while matched > 0 && unit != pattern[matched] {
            matched = failure[matched - 1];
        }
        if unit == pattern[matched] {
            matched += 1;
        }
        if matched == pattern.len() {
            return true;
        }
    }
    false
}

const fn ascii_lowercase(unit: u16) -> u16 {
    if unit >= b'A' as u16 && unit <= b'Z' as u16 {
        unit + (b'a' as u16 - b'A' as u16)
    } else {
        unit
    }
}

fn marker_matches(marker: &MarkerMatchRecord, current: &MarkerUrl) -> bool {
    match marker.match_type.as_ref().and_then(JsString::as_utf8) {
        Some("exact") => {
            marker.origin.as_ref() == Some(&current.origin)
                && marker.path.as_ref() == Some(&current.path)
        }
        Some("host") => marker
            .host
            .as_ref()
            .is_some_and(|host| host.utf16_len() > 0 && host == &current.host),
        _ => {
            marker.origin.as_ref() == Some(&current.origin)
                && match marker.path.as_ref() {
                    None => true,
                    Some(path) => path.utf16_len() == 0 || js_starts_with(&current.path, path),
                }
        }
    }
}

fn finite_pacing_override(value: PaceInputValue) -> Option<f64> {
    match value {
        PaceInputValue::FiniteNumber(value) => Some(if value == 0.0 {
            0.0
        } else {
            value.clamp(0.0, MAX_PACING_OVERRIDE_MS)
        }),
        PaceInputValue::Undefined | PaceInputValue::String(_) | PaceInputValue::Other => None,
    }
}

fn js_starts_with(value: &JsString, prefix: &JsString) -> bool {
    let mut value = value.utf16_units();
    prefix.utf16_units().all(|unit| value.next() == Some(unit))
}

fn js_subtraction_compare(left: f64, right: f64) -> Ordering {
    let difference = left - right;
    if difference < 0.0 {
        Ordering::Less
    } else if difference > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_tab_messages_and_normalizes_only_no_tab_messages() {
        let no_tab =
            classify_tab_error_message(JsString::from_string("No tab with id: 42"), Some("42"));
        assert_eq!(no_tab.category, TabErrorCategory::TabClosed);
        assert_eq!(
            no_tab.message.to_string_if_well_formed().as_deref(),
            Some("Tab 42 not found")
        );

        let disconnected = classify_tab_error_message(
            JsString::from_string("Receiving end does not exist."),
            Some("7"),
        );
        assert_eq!(disconnected.category, TabErrorCategory::TabClosed);
        assert_eq!(
            disconnected.message.to_string_if_well_formed().as_deref(),
            Some("Receiving end does not exist.")
        );

        let unknown =
            classify_tab_error_message(JsString::from_string("CDP attach failed"), Some("7"));
        assert_eq!(unknown.category, TabErrorCategory::Unknown);
    }
}
