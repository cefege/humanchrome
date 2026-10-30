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

/// Browser URL facts observed through the host's native `URL` implementation.
///
/// URL parsing remains browser-owned; this type deliberately contains only the normalized fields
/// needed for navigation-pattern expansion and candidate selection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NavigationUrlFacts {
    /// Browser-normalized protocol, including its trailing colon.
    pub protocol: JsString,
    /// Browser-normalized host, including an explicit port when present.
    pub host: JsString,
    /// Browser-normalized hostname.
    pub hostname: JsString,
    /// Browser-normalized pathname.
    pub pathname: JsString,
    /// Browser-normalized query, including its leading question mark when present.
    pub search: JsString,
}

/// A parsed navigation candidate held by the browser host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NavigationCandidate {
    /// Source position in the host-owned candidate tab array.
    pub source_index: usize,
    /// Native-URL facts for the candidate URL, or `None` when parsing failed.
    pub parsed: Option<NavigationUrlFacts>,
}

/// Matcher syntax selected from one nonempty, host-trimmed close-tab filter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseTabMatcher {
    /// JavaScript `RegExp(pattern, flags)` semantics, retained at the WASM host boundary.
    Regex {
        /// Text between the opening and final slash.
        pattern: JsString,
        /// Text after the final slash.
        flags: JsString,
    },
    /// Case-insensitive JavaScript substring semantics, retained at the WASM host boundary.
    Substring {
        /// The text to find.
        needle: JsString,
    },
}

/// Field whose close-tab matcher is being evaluated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseTabMatchField {
    /// The candidate URL.
    Url,
    /// The candidate title.
    Title,
}

/// Parsed close-tab filter policy before host intrinsic matching.
#[derive(Clone, Debug, PartialEq)]
pub struct CloseTabFilterPlan {
    /// Optional URL matcher.
    pub url_matcher: Option<CloseTabMatcher>,
    /// Optional title matcher.
    pub title_matcher: Option<CloseTabMatcher>,
    /// Optional inclusive age threshold in milliseconds.
    pub older_than_ms: Option<f64>,
}

/// Candidate metadata required for close-tab selection while Chrome tab objects remain host-owned.
#[derive(Clone, Debug, PartialEq)]
pub struct CloseTabCandidate {
    /// Source position in the host-owned query result.
    pub source_index: usize,
    /// Tab identifier when Chrome supplied a JavaScript number.
    pub tab_id: Option<f64>,
    /// URL value after the host's nullish-empty normalization.
    pub url: JsString,
    /// Title value after the host's nullish-empty normalization.
    pub title: JsString,
    /// Creation timestamp tracked by the browser host.
    pub created_at: Option<f64>,
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

/// Expands a navigation target into the existing Chrome URL-query patterns.
///
/// A wildcard target passes through unchanged. For a parseable non-wildcard target, this retains
/// the current HTTP/HTTPS and www/no-www expansion order; malformed inputs use the legacy suffix
/// wildcard fallback.
#[must_use]
pub fn navigation_url_patterns(
    input: JsString,
    parsed: Option<&NavigationUrlFacts>,
) -> Vec<JsString> {
    if js_contains_unit(&input, u16::from(b'*')) {
        return vec![input];
    }

    let Some(parsed) = parsed else {
        return vec![navigation_fallback_pattern(input)];
    };

    let is_ip = is_ipv4_like(&parsed.hostname) || js_starts_with_ascii(&parsed.hostname, b"[");
    let is_multi_label = js_contains_unit(&parsed.hostname, u16::from(b'.')) && !is_ip;
    let host_without_www = strip_ascii_www(&parsed.host);
    let host_with_www = prepend_ascii("www.", &host_without_www);
    let alternate_protocol = if js_string_eq_ascii(&parsed.protocol, b"https:") {
        JsString::from_string("http:")
    } else {
        JsString::from_string("https:")
    };

    let mut patterns = Vec::with_capacity(if is_multi_label { 6 } else { 2 });
    push_unique_js_string(
        &mut patterns,
        join_navigation_pattern(&parsed.protocol, &parsed.host),
    );
    if is_multi_label {
        push_unique_js_string(
            &mut patterns,
            join_navigation_pattern(&parsed.protocol, &host_without_www),
        );
        push_unique_js_string(
            &mut patterns,
            join_navigation_pattern(&parsed.protocol, &host_with_www),
        );
    }
    push_unique_js_string(
        &mut patterns,
        join_navigation_pattern(&alternate_protocol, &parsed.host),
    );
    if is_multi_label {
        push_unique_js_string(
            &mut patterns,
            join_navigation_pattern(&alternate_protocol, &host_without_www),
        );
        push_unique_js_string(
            &mut patterns,
            join_navigation_pattern(&alternate_protocol, &host_with_www),
        );
    }
    patterns
}

/// Selects the first highest-scoring host-owned navigation candidate.
///
/// A malformed target preserves the existing first-candidate fallback. Parseable targets score
/// only exact normalized path/query combinations; the historical root-host fallback is deliberately
/// absent.
#[must_use]
pub fn pick_best_navigation_candidate(
    target: Option<&NavigationUrlFacts>,
    candidates: &[NavigationCandidate],
) -> Option<usize> {
    let Some(target) = target else {
        return candidates.first().map(|candidate| candidate.source_index);
    };

    let target_path = normalize_navigation_path(&target.pathname);
    let target_has_query = target.search.utf16_len() > 0;
    let mut best: Option<(usize, i8)> = None;

    for candidate in candidates {
        let source_index = candidate.source_index;
        let Some(candidate) = candidate.parsed.as_ref() else {
            continue;
        };
        if !js_host_base_eq(&candidate.host, &target.host) {
            continue;
        }

        let candidate_path = normalize_navigation_path(&candidate.pathname);
        let path_equal = js_string_eq(&candidate_path, &target_path);
        let search_equal = js_string_eq(&candidate.search, &target.search);
        let score = if target_has_query && path_equal && search_equal {
            3
        } else if path_equal && !target_has_query {
            2
        } else {
            -1
        };

        if score > 0 && best.is_none_or(|(_, best_score)| score > best_score) {
            best = Some((source_index, score));
            if score == 3 {
                break;
            }
        }
    }
    best.map(|(index, _)| index)
}

/// Parses host-trimmed close-tab filters and validates that at least one filter is usable.
#[must_use]
pub fn plan_close_tab_filters(
    url_match: Option<JsString>,
    title_match: Option<JsString>,
    older_than_ms: Option<f64>,
) -> Option<CloseTabFilterPlan> {
    let url_matcher = url_match.and_then(close_tab_matcher);
    let title_matcher = title_match.and_then(close_tab_matcher);
    let older_than_ms = older_than_ms.filter(|value| value.is_finite() && *value >= 0.0);
    (url_matcher.is_some() || title_matcher.is_some() || older_than_ms.is_some()).then_some(
        CloseTabFilterPlan {
            url_matcher,
            title_matcher,
            older_than_ms,
        },
    )
}

/// Returns host-owned candidate indexes selected by the close-tab filter plan.
///
/// The matcher callback is invoked in the same short-circuit order as the legacy JavaScript loop,
/// retaining JavaScript `RegExp.lastIndex` and string intrinsic behavior at the WASM boundary.
#[must_use]
pub fn select_close_tab_indexes<F>(
    plan: &CloseTabFilterPlan,
    candidates: &[CloseTabCandidate],
    except_tab_ids: &[f64],
    now_ms: f64,
    mut matches: F,
) -> Vec<usize>
where
    F: FnMut(CloseTabMatchField, &CloseTabMatcher, &JsString) -> bool,
{
    candidates
        .iter()
        .filter_map(|candidate| {
            let tab_id = candidate.tab_id?;
            if except_tab_ids
                .iter()
                .any(|except| js_same_value_zero(*except, tab_id))
            {
                return None;
            }
            if plan
                .url_matcher
                .as_ref()
                .is_some_and(|matcher| !matches(CloseTabMatchField::Url, matcher, &candidate.url))
            {
                return None;
            }
            if plan.title_matcher.as_ref().is_some_and(|matcher| {
                !matches(CloseTabMatchField::Title, matcher, &candidate.title)
            }) {
                return None;
            }
            if let Some(older_than_ms) = plan.older_than_ms {
                let created_at = candidate.created_at?;
                if now_ms - created_at < older_than_ms {
                    return None;
                }
            }
            Some(candidate.source_index)
        })
        .collect()
}

fn close_tab_matcher(value: JsString) -> Option<CloseTabMatcher> {
    if value.utf16_len() == 0 {
        return None;
    }
    let units = value.into_utf16_units();
    if units.len() > 1
        && units[0] == u16::from(b'/')
        && let Some(last_slash) = units.iter().rposition(|unit| *unit == u16::from(b'/'))
        && last_slash > 0
    {
        return Some(CloseTabMatcher::Regex {
            pattern: JsString::from_utf16_units(units[1..last_slash].to_vec()),
            flags: JsString::from_utf16_units(units[last_slash + 1..].to_vec()),
        });
    }
    Some(CloseTabMatcher::Substring {
        needle: JsString::from_utf16_units(units),
    })
}

fn navigation_fallback_pattern(input: JsString) -> JsString {
    let mut units = input.into_utf16_units();
    if units.last() == Some(&u16::from(b'/')) {
        units.push(u16::from(b'*'));
    } else {
        units.extend("/*".encode_utf16());
    }
    JsString::from_utf16_units(units)
}

fn join_navigation_pattern(protocol: &JsString, host: &JsString) -> JsString {
    let mut units = Vec::with_capacity(protocol.utf16_len() + host.utf16_len() + 4);
    units.extend(protocol.utf16_units());
    units.extend("//".encode_utf16());
    units.extend(host.utf16_units());
    units.extend("/*".encode_utf16());
    JsString::from_utf16_units(units)
}

fn prepend_ascii(prefix: &str, value: &JsString) -> JsString {
    let mut units = Vec::with_capacity(prefix.len() + value.utf16_len());
    units.extend(prefix.encode_utf16());
    units.extend(value.utf16_units());
    JsString::from_utf16_units(units)
}

fn strip_ascii_www(value: &JsString) -> JsString {
    const WWW_PREFIX: &[u16] = &[b'w' as u16, b'w' as u16, b'w' as u16, b'.' as u16];
    let units: Vec<u16> = value.utf16_units().collect();
    if units.starts_with(WWW_PREFIX) {
        JsString::from_utf16_units(units[WWW_PREFIX.len()..].to_vec())
    } else {
        JsString::from_utf16_units(units)
    }
}

fn normalize_navigation_path(path: &JsString) -> JsString {
    let mut units: Vec<u16> = path.utf16_units().collect();
    if units.is_empty() {
        return JsString::from_string("/");
    }
    if units[0] != u16::from(b'/') {
        units.insert(0, u16::from(b'/'));
    }
    if units.len() > 1 && units.last() == Some(&u16::from(b'/')) {
        units.pop();
    }
    JsString::from_utf16_units(units)
}

fn is_ipv4_like(hostname: &JsString) -> bool {
    let units: Vec<u16> = hostname.utf16_units().collect();
    let mut cursor = 0;
    for component in 0..4 {
        let start = cursor;
        while cursor < units.len() && (u16::from(b'0')..=u16::from(b'9')).contains(&units[cursor]) {
            cursor += 1;
        }
        let digits = cursor - start;
        if !(1..=3).contains(&digits) {
            return false;
        }
        if component < 3 {
            if units.get(cursor) != Some(&u16::from(b'.')) {
                return false;
            }
            cursor += 1;
        }
    }
    cursor == units.len()
}

fn js_contains_unit(value: &JsString, expected: u16) -> bool {
    value.utf16_units().any(|unit| unit == expected)
}

fn js_starts_with_ascii(value: &JsString, prefix: &[u8]) -> bool {
    value
        .utf16_units()
        .zip(prefix.iter().copied().map(u16::from))
        .all(|(left, right)| left == right)
        && value.utf16_len() >= prefix.len()
}

fn js_string_eq(left: &JsString, right: &JsString) -> bool {
    left.utf16_units().eq(right.utf16_units())
}

fn js_string_eq_ascii(value: &JsString, expected: &[u8]) -> bool {
    value
        .utf16_units()
        .eq(expected.iter().copied().map(u16::from))
}

fn js_host_base_eq(left: &JsString, right: &JsString) -> bool {
    let left_skip = usize::from(js_starts_with_ascii(left, b"www.")) * 4;
    let right_skip = usize::from(js_starts_with_ascii(right, b"www.")) * 4;
    left.utf16_units()
        .skip(left_skip)
        .map(ascii_lowercase)
        .eq(right.utf16_units().skip(right_skip).map(ascii_lowercase))
}

fn js_same_value_zero(left: f64, right: f64) -> bool {
    left == right || (left.is_nan() && right.is_nan())
}

fn push_unique_js_string(values: &mut Vec<JsString>, value: JsString) {
    if !values.iter().any(|existing| js_string_eq(existing, &value)) {
        values.push(value);
    }
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

    fn navigation_facts(
        protocol: &str,
        host: &str,
        hostname: &str,
        pathname: &str,
        search: &str,
    ) -> NavigationUrlFacts {
        NavigationUrlFacts {
            protocol: JsString::from_string(protocol),
            host: JsString::from_string(host),
            hostname: JsString::from_string(hostname),
            pathname: JsString::from_string(pathname),
            search: JsString::from_string(search),
        }
    }

    #[test]
    fn expands_navigation_patterns_with_domain_variants_but_not_ip_or_single_label_hosts() {
        let domain = navigation_facts("https:", "www.example.com", "www.example.com", "/x", "");
        let patterns = navigation_url_patterns(
            JsString::from_string("https://www.example.com/x"),
            Some(&domain),
        );
        let patterns: Vec<String> = patterns
            .into_iter()
            .map(|pattern| {
                pattern
                    .to_string_if_well_formed()
                    .expect("test URL is well formed")
            })
            .collect();
        assert_eq!(
            patterns,
            [
                "https://www.example.com/*",
                "https://example.com/*",
                "http://www.example.com/*",
                "http://example.com/*",
            ]
        );

        let ipv4 = navigation_facts("https:", "127.0.0.1", "127.0.0.1", "/", "");
        assert_eq!(
            navigation_url_patterns(JsString::from_string("https://127.0.0.1"), Some(&ipv4)).len(),
            2
        );

        let ipv6 = navigation_facts("https:", "[::1]", "[::1]", "/", "");
        assert_eq!(
            navigation_url_patterns(JsString::from_string("https://[::1]"), Some(&ipv6)).len(),
            2
        );
        let single_label = navigation_facts("https:", "localhost", "localhost", "/", "");
        assert_eq!(
            navigation_url_patterns(
                JsString::from_string("https://localhost"),
                Some(&single_label)
            )
            .len(),
            2
        );
    }

    #[test]
    fn navigation_patterns_preserve_wildcards_and_malformed_suffix_fallback() {
        assert_eq!(
            navigation_url_patterns(JsString::from_string("https://example.com/*"), None)[0]
                .to_string_if_well_formed()
                .as_deref(),
            Some("https://example.com/*")
        );
        assert_eq!(
            navigation_url_patterns(JsString::from_string("not a url/"), None)[0]
                .to_string_if_well_formed()
                .as_deref(),
            Some("not a url/*")
        );
    }

    #[test]
    fn navigation_candidate_selection_keeps_first_equal_and_has_no_host_only_fallback() {
        let target = navigation_facts("https:", "example.com", "example.com", "/feed/", "");
        let root = navigation_facts("https:", "example.com", "example.com", "/", "");
        let normalized_feed = navigation_facts("https:", "example.com", "example.com", "/feed", "");
        let candidates = [
            NavigationCandidate {
                source_index: 4,
                parsed: Some(root),
            },
            NavigationCandidate {
                source_index: 7,
                parsed: Some(normalized_feed),
            },
            NavigationCandidate {
                source_index: 9,
                parsed: Some(navigation_facts(
                    "https:",
                    "example.com",
                    "example.com",
                    "/feed",
                    "?stale",
                )),
            },
        ];
        assert_eq!(
            pick_best_navigation_candidate(Some(&target), &candidates),
            Some(7)
        );

        let root_target = navigation_facts("https:", "example.com", "example.com", "/", "");
        assert_eq!(
            pick_best_navigation_candidate(Some(&root_target), &candidates),
            Some(4)
        );
        let other_root_candidates = [NavigationCandidate {
            source_index: 3,
            parsed: Some(navigation_facts(
                "https:",
                "example.com",
                "example.com",
                "/different",
                "",
            )),
        }];
        assert_eq!(
            pick_best_navigation_candidate(Some(&root_target), &other_root_candidates),
            None
        );
    }

    #[test]
    fn malformed_navigation_target_keeps_first_candidate_without_parsing_it() {
        let candidates = [
            NavigationCandidate {
                source_index: 2,
                parsed: None,
            },
            NavigationCandidate {
                source_index: 5,
                parsed: Some(navigation_facts(
                    "https:",
                    "example.com",
                    "example.com",
                    "/",
                    "",
                )),
            },
        ];
        assert_eq!(pick_best_navigation_candidate(None, &candidates), Some(2));
    }

    #[test]
    fn close_tab_selection_ands_filters_excludes_first_and_skips_unknown_creation_times() {
        let plan = plan_close_tab_filters(
            Some(JsString::from_string("example")),
            Some(JsString::from_string("matching")),
            Some(30_000.0),
        )
        .expect("filters are usable");
        let candidates = [
            CloseTabCandidate {
                source_index: 0,
                tab_id: Some(1.0),
                url: JsString::from_string("https://example.com/a"),
                title: JsString::from_string("matching"),
                created_at: Some(20_000.0),
            },
            CloseTabCandidate {
                source_index: 1,
                tab_id: Some(2.0),
                url: JsString::from_string("https://example.com/b"),
                title: JsString::from_string("matching"),
                created_at: Some(20_000.0),
            },
            CloseTabCandidate {
                source_index: 2,
                tab_id: Some(3.0),
                url: JsString::from_string("https://example.com/c"),
                title: JsString::from_string("other"),
                created_at: Some(20_000.0),
            },
            CloseTabCandidate {
                source_index: 3,
                tab_id: Some(4.0),
                url: JsString::from_string("https://example.com/d"),
                title: JsString::from_string("matching"),
                created_at: None,
            },
        ];
        let selected =
            select_close_tab_indexes(&plan, &candidates, &[2.0], 60_000.0, |_, matcher, value| {
                let CloseTabMatcher::Substring { needle } = matcher else {
                    panic!("test only supplies substring filters");
                };
                value
                    .to_string_if_well_formed()
                    .expect("test strings are well formed")
                    .to_ascii_lowercase()
                    .contains(
                        &needle
                            .to_string_if_well_formed()
                            .expect("test strings are well formed")
                            .to_ascii_lowercase(),
                    )
            });
        assert_eq!(selected, [0]);
    }

    #[test]
    fn close_tab_filter_decomposes_regex_and_preserves_invalid_regex_fallback_pattern() {
        let plan = plan_close_tab_filters(Some(JsString::from_string("/[bad/")), None, None)
            .expect("filter is usable");
        assert_eq!(
            plan.url_matcher,
            Some(CloseTabMatcher::Regex {
                pattern: JsString::from_string("[bad"),
                flags: JsString::from_string(""),
            })
        );
        assert!(plan_close_tab_filters(None, None, None).is_none());
    }
}
