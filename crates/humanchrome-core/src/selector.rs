//! Portable selector ranking, parsing, and fingerprint policy for browser adapters.
//!
//! DOM traversal, accessibility inspection, native CSS escaping, and element lookup remain in the
//! browser host. Compatibility fallback escaping and selection policy remain here. This module
//! operates on complete candidate batches so ordering never crosses the host boundary once per
//! comparison.

use std::cmp::Ordering;
use std::collections::HashSet;

use crate::arguments::JsString;

mod legacy_aria;
pub use legacy_aria::legacy_aria_selectors;

mod action_target;
pub use action_target::{
    ActionCandidateBatch, ActionCandidateInput, ActionCandidatePlan, clamp_action_integer,
    prepare_action_candidates,
};

mod accessible_name;
pub use accessible_name::{
    AccessibleNameMatchMode, matches_accessible_name, normalize_accessible_name,
};

const COMPOSITE_SEPARATOR: [u16; 2] = [b'|' as u16, b'>' as u16];
const DEFAULT_MAX_CANDIDATES: f64 = 8.0;
const DEFAULT_TEXT_MAX_LENGTH: f64 = 64.0;
const FINGERPRINT_TEXT_MAX_LENGTH: usize = 32;
const FINGERPRINT_MAX_CLASSES: usize = 8;

const DEFAULT_EDITOR_LOCATOR_MAX_CANDIDATES: f64 = 5.0;
const EDITOR_LOCATOR_MAX_CLASS_COMBO_DEPTH: usize = 3;
const EDITOR_LOCATOR_MAX_CLASS_COUNT: usize = 24;
const EDITOR_LOCATOR_MAX_ANCHOR_DEPTH: usize = 20;
const EDITOR_LOCATOR_DATA_ATTRIBUTES: [&str; 9] = [
    "data-testid",
    "data-test-id",
    "data-test",
    "data-qa",
    "data-cy",
    "name",
    "title",
    "alt",
    "aria-label",
];
const EDITOR_LOCATOR_ANCHOR_ATTRIBUTES: [&str; 5] = [
    "data-testid",
    "data-test-id",
    "data-test",
    "data-qa",
    "data-cy",
];

/// The selector kinds understood by the browser locator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SelectorType {
    /// A CSS selector.
    Css,
    /// An XPath selector.
    XPath,
    /// A CSS selector generated from an attribute.
    Attr,
    /// An ARIA expression with optional role and name metadata.
    Aria,
    /// A visible-text query.
    Text,
    /// A Playwright-style role query.
    Role,
    /// A Playwright-style label query.
    Label,
    /// A Playwright-style placeholder query.
    Placeholder,
    /// A Playwright-style alternative-text query.
    Alt,
    /// A Playwright-style title query.
    Title,
    /// A configured test-id attribute query.
    TestId,
}

/// The origin recorded for a selector candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SelectorCandidateSource {
    /// A previously recorded candidate.
    Recorded,
    /// A candidate supplied directly by a caller.
    User,
    /// A candidate generated from a live element.
    Generated,
}

/// Visible-text matching behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextMatchMode {
    /// The browser host must require an exact accessible-name match.
    Exact,
    /// The browser host may match a containing visible text value.
    Contains,
}

/// Signal flags used to explain a candidate stability score.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct SelectorStabilitySignals {
    /// The selector refers to an id.
    pub uses_id: bool,
    /// The selector refers to a configured test-id-shaped attribute.
    pub uses_test_id: bool,
    /// The selector refers to ARIA metadata.
    pub uses_aria: bool,
    /// The selector refers to visible text.
    pub uses_text: bool,
    /// The selector uses an `:nth-of-type` structural segment.
    pub uses_nth_of_type: bool,
    /// The selector refers to one or more attributes.
    pub uses_attributes: bool,
    /// The selector refers to one or more classes.
    pub uses_class: bool,
}

/// A selector score and its diagnostic signals.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectorStability {
    /// The bounded stability score. Higher values are more stable.
    pub score: f64,
    /// The signals that contributed to the score.
    pub signals: SelectorStabilitySignals,
    /// Present for a selector coupled to iframe traversal.
    pub note: Option<JsString>,
}

/// Structured selector metadata transported between the DOM host and policy kernel.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectorCandidate {
    /// The locator representation to use.
    pub selector_type: SelectorType,
    /// The primary selector representation.
    pub value: JsString,
    /// Caller-adjustable priority; higher values sort first.
    pub weight: Option<f64>,
    /// Where the candidate originated.
    pub source: Option<SelectorCandidateSource>,
    /// The producing strategy identifier.
    pub strategy: Option<JsString>,
    /// A cached stability score, if supplied by persisted data.
    pub stability: Option<SelectorStability>,
    /// Text matching semantics for [`SelectorType::Text`].
    pub text_match: Option<TextMatchMode>,
    /// A tag-name filter for [`SelectorType::Text`].
    pub tag_name_hint: Option<JsString>,
    /// ARIA/role metadata.
    pub role: Option<JsString>,
    /// ARIA/role metadata.
    pub name: Option<JsString>,
    /// Structured text metadata for label-like candidates.
    pub text: Option<JsString>,
    /// Exact-match metadata for structured candidates.
    pub exact: Option<bool>,
    /// Optional configured attribute for [`SelectorType::TestId`].
    pub attribute: Option<JsString>,
}

impl SelectorCandidate {
    /// Creates a candidate with only its required selector representation.
    #[must_use]
    pub fn new(selector_type: SelectorType, value: JsString) -> Self {
        Self {
            selector_type,
            value,
            weight: None,
            source: None,
            strategy: None,
            stability: None,
            text_match: None,
            tag_name_hint: None,
            role: None,
            name: None,
            text: None,
            exact: None,
            attribute: None,
        }
    }
}

/// Compatibility escaping modes for browser hosts without native `CSS.escape`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CssEscapeFallbackMode {
    /// The spec-inspired identifier escaping used by selector generation.
    Identifier,
    /// The historical quote-and-backslash-only escaping used by test-id lookup.
    TestIdAttributeValue,
}

/// DOM collection settings for the web editor locator adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorLocatorCollectionPolicy {
    /// Default number of locator candidates retained by the editor.
    pub default_max_candidates: usize,
    /// Ordered attributes inspected for direct element selectors.
    pub data_attributes: Vec<JsString>,
    /// Ordered attributes inspected when finding an ancestor anchor.
    pub anchor_attributes: Vec<JsString>,
    /// Maximum class combination size attempted by the DOM adapter.
    pub max_class_combo_depth: usize,
    /// Maximum raw classes considered by the DOM adapter.
    pub max_selector_class_count: usize,
    /// Maximum ancestors inspected by the DOM adapter.
    pub max_anchor_depth: usize,
}

/// Policy plan for one web-editor locator collection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorLocatorPlan {
    /// Complete collection settings for the DOM adapter.
    pub collection: EditorLocatorCollectionPolicy,
    /// Maximum candidates retained in the final locator.
    pub max_candidates: usize,
    /// Maximum direct id/data/class candidates retained before fallbacks.
    pub head_limit: usize,
    /// Whether the DOM adapter should inspect ancestor anchors.
    pub collect_anchor: bool,
}

/// The two pieces of an iframe composite selector.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompositeSelectorParts {
    /// Selector for the frame element.
    pub frame_selector: JsString,
    /// Selector evaluated inside the frame; nested composites are retained.
    pub inner_selector: JsString,
}

/// Splits `frame |> inner` selectors using the existing JavaScript filtering semantics.
#[must_use]
pub fn split_composite_selector(selector: &JsString) -> Option<CompositeSelectorParts> {
    let units = units(selector);
    let parts: Vec<Vec<u16>> = split_units(&units, &COMPOSITE_SEPARATOR)
        .into_iter()
        .map(trim_units)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return None;
    }

    let mut parts = parts.into_iter();
    let frame_selector = js_from_units(
        parts
            .next()
            .expect("composite selector has a frame segment"),
    );
    let mut inner = Vec::new();
    for (index, part) in parts.enumerate() {
        if index > 0 {
            inner.extend_from_slice(&[b' ' as u16, b'|' as u16, b'>' as u16, b' ' as u16]);
        }
        inner.extend(part);
    }
    Some(CompositeSelectorParts {
        frame_selector,
        inner_selector: js_from_units(inner),
    })
}

/// Returns whether a selector has at least two nonempty composite segments.
#[must_use]
pub fn is_composite_selector(selector: &JsString) -> bool {
    split_composite_selector(selector).is_some()
}

/// Joins frame and inner selector values exactly as the shared browser helper does.
#[must_use]
pub fn compose_composite_selector(
    frame_selector: &JsString,
    inner_selector: &JsString,
) -> JsString {
    let mut result = trim_js_string(frame_selector);
    result.push_str(" |>");
    result.push_str(" ");
    result.push_js_string(&trim_js_string(inner_selector));
    trim_js_string(&result)
}

/// Input options whose absent fields receive the browser generator defaults.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SelectorGenerationOptions {
    /// Candidate count requested by the caller.
    pub max_candidates: Option<f64>,
    /// Whether DOM adapters should emit text candidates.
    pub include_text: Option<bool>,
    /// Whether DOM adapters should emit ARIA candidates.
    pub include_aria: Option<bool>,
    /// Whether DOM adapters should emit unique CSS candidates.
    pub include_css_unique: Option<bool>,
    /// Whether DOM adapters should emit structural CSS candidates.
    pub include_css_path: Option<bool>,
    /// Attributes inspected by the DOM test-id strategy.
    pub test_id_attributes: Option<Vec<JsString>>,
    /// Maximum UTF-16 text length collected by the DOM text strategy.
    pub text_max_length: Option<f64>,
    /// Tags accepted by the DOM text strategy.
    pub text_tags: Option<Vec<JsString>>,
}

/// Fully resolved selector-generation settings for DOM adapters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedSelectorGenerationOptions {
    /// The bounded number of ranked candidates to retain.
    pub max_candidates: usize,
    /// Whether DOM adapters should emit text candidates.
    pub include_text: bool,
    /// Whether DOM adapters should emit ARIA candidates.
    pub include_aria: bool,
    /// Whether DOM adapters should emit unique CSS candidates.
    pub include_css_unique: bool,
    /// Whether DOM adapters should emit structural CSS candidates.
    pub include_css_path: bool,
    /// Attributes inspected by the DOM test-id strategy.
    pub test_id_attributes: Vec<JsString>,
    /// Maximum UTF-16 text length collected by the DOM text strategy.
    pub text_max_length: usize,
    /// Tags accepted by the DOM text strategy.
    pub text_tags: Vec<JsString>,
}

/// Applies the existing generator defaults and integer clamps without DOM access.
#[must_use]
pub fn normalize_selector_generation_options(
    options: Option<&SelectorGenerationOptions>,
) -> NormalizedSelectorGenerationOptions {
    let options = options.cloned().unwrap_or_default();
    NormalizedSelectorGenerationOptions {
        max_candidates: clamp_int(
            options.max_candidates.unwrap_or(DEFAULT_MAX_CANDIDATES),
            1,
            50,
        ),
        include_text: options.include_text.unwrap_or(true),
        include_aria: options.include_aria.unwrap_or(true),
        include_css_unique: options.include_css_unique.unwrap_or(true),
        include_css_path: options.include_css_path.unwrap_or(true),
        test_id_attributes: options
            .test_id_attributes
            .unwrap_or_else(default_test_id_attributes),
        text_max_length: clamp_int(
            options.text_max_length.unwrap_or(DEFAULT_TEXT_MAX_LENGTH),
            1,
            256,
        ),
        text_tags: options.text_tags.unwrap_or_else(default_text_tags),
    }
}

/// Produces one complete web-editor collection plan without DOM access.
#[must_use]
pub fn editor_locator_plan(
    max_candidates: Option<f64>,
    anchor_available: bool,
) -> EditorLocatorPlan {
    let max_candidates = normalize_editor_locator_max_candidates(max_candidates);
    let tail_reserved = 1 + usize::from(anchor_available);
    EditorLocatorPlan {
        collection: EditorLocatorCollectionPolicy {
            default_max_candidates: DEFAULT_EDITOR_LOCATOR_MAX_CANDIDATES as usize,
            data_attributes: EDITOR_LOCATOR_DATA_ATTRIBUTES
                .into_iter()
                .map(JsString::from)
                .collect(),
            anchor_attributes: EDITOR_LOCATOR_ANCHOR_ATTRIBUTES
                .into_iter()
                .map(JsString::from)
                .collect(),
            max_class_combo_depth: EDITOR_LOCATOR_MAX_CLASS_COMBO_DEPTH,
            max_selector_class_count: EDITOR_LOCATOR_MAX_CLASS_COUNT,
            max_anchor_depth: EDITOR_LOCATOR_MAX_ANCHOR_DEPTH,
        },
        max_candidates,
        head_limit: max_candidates.saturating_sub(tail_reserved).max(1),
        collect_anchor: max_candidates >= DEFAULT_EDITOR_LOCATOR_MAX_CANDIDATES as usize,
    }
}

/// Returns the eligible raw class indexes for the editor's DOM adapter.
#[must_use]
pub fn editor_locator_class_indexes(classes: &[JsString]) -> Vec<usize> {
    classes
        .iter()
        .enumerate()
        .filter_map(|(index, class)| is_editor_class_name(class).then_some(index))
        .take(EDITOR_LOCATOR_MAX_CLASS_COUNT)
        .collect()
}

/// Selects a web-editor locator's direct and fallback selector candidates.
#[must_use]
pub fn select_editor_locator_candidates(
    head_candidates: Vec<JsString>,
    path_candidate: Option<JsString>,
    anchor_candidate: Option<JsString>,
    max_candidates: Option<f64>,
) -> Vec<JsString> {
    let plan = editor_locator_plan(max_candidates, anchor_candidate.is_some());
    let mut selected = Vec::with_capacity(plan.max_candidates.min(head_candidates.len() + 2));
    let mut seen = HashSet::with_capacity(head_candidates.len() + 2);
    for candidate in head_candidates {
        if selected.len() >= plan.head_limit {
            break;
        }
        push_trimmed_unique(&mut selected, &mut seen, candidate);
    }
    if selected.len() < plan.max_candidates
        && let Some(path_candidate) = path_candidate
    {
        push_trimmed_unique(&mut selected, &mut seen, path_candidate);
    }
    if selected.len() < plan.max_candidates
        && let Some(anchor_candidate) = anchor_candidate
    {
        push_trimmed_unique(&mut selected, &mut seen, anchor_candidate);
    }
    selected
}

/// Escapes a browser string with the selected historical compatibility behavior.
#[must_use]
pub fn css_escape_fallback(value: &JsString, mode: CssEscapeFallbackMode) -> JsString {
    match mode {
        CssEscapeFallbackMode::Identifier => css_escape_identifier(value),
        CssEscapeFallbackMode::TestIdAttributeValue => {
            let mut output = Vec::with_capacity(value.utf16_len());
            for unit in value.utf16_units() {
                if unit == b'"' as u16 || unit == b'\\' as u16 {
                    output.push(b'\\' as u16);
                }
                output.push(unit);
            }
            js_from_units(output)
        }
    }
}

/// Computes the portability/stability score for one candidate.
#[must_use]
pub fn compute_selector_stability(candidate: &SelectorCandidate) -> SelectorStability {
    match candidate.selector_type {
        SelectorType::Css | SelectorType::Attr => {
            if let Some(composite) = split_composite_selector(&candidate.value) {
                let signals = merge_signals(
                    analyze_css_like(&composite.frame_selector),
                    analyze_css_like(&composite.inner_selector),
                );
                let mut score = base_score_for_css_signals(signals) - 0.05;
                if signals.uses_nth_of_type {
                    score -= 0.2;
                }
                score -= length_penalty(candidate.value.utf16_len());
                return SelectorStability {
                    score: clamp01(score),
                    signals,
                    note: Some(JsString::from("composite")),
                };
            }
            let signals = analyze_css_like(&candidate.value);
            let mut score = base_score_for_css_signals(signals);
            if signals.uses_nth_of_type {
                score -= 0.2;
            }
            score -= length_penalty(candidate.value.utf16_len());
            SelectorStability {
                score: clamp01(score),
                signals,
                note: None,
            }
        }
        SelectorType::XPath => {
            let value = units(&candidate.value);
            let signals = SelectorStabilitySignals {
                uses_attributes: xpath_has_attribute(&value),
                uses_id: xpath_has_named_attribute(&value, b"id"),
                uses_test_id: xpath_has_named_attribute(&value, b"data-testid"),
                ..SelectorStabilitySignals::default()
            };
            let mut score = if signals.uses_test_id {
                0.85
            } else if signals.uses_id {
                0.75
            } else if signals.uses_attributes {
                0.55
            } else {
                0.42
            };
            score -= length_penalty(value.len());
            SelectorStability {
                score: clamp01(score),
                signals,
                note: None,
            }
        }
        SelectorType::Aria => {
            let has_name = candidate
                .name
                .as_ref()
                .is_some_and(|name| !trim_units(units(name)).is_empty());
            let has_role = candidate
                .role
                .as_ref()
                .is_some_and(|role| !trim_units(units(role)).is_empty());
            let mut score = if has_name && has_role {
                0.8
            } else if has_name {
                0.72
            } else {
                0.6
            };
            score -= length_penalty(candidate.value.utf16_len());
            SelectorStability {
                score: clamp01(score),
                signals: SelectorStabilitySignals {
                    uses_aria: true,
                    ..SelectorStabilitySignals::default()
                },
                note: None,
            }
        }
        SelectorType::Role => {
            let has_name = candidate
                .name
                .as_ref()
                .is_some_and(|name| !trim_units(units(name)).is_empty());
            let mut score = if has_name { 0.88 } else { 0.6 };
            score -= length_penalty(candidate.value.utf16_len());
            SelectorStability {
                score: clamp01(score),
                signals: SelectorStabilitySignals {
                    uses_aria: true,
                    ..SelectorStabilitySignals::default()
                },
                note: None,
            }
        }
        SelectorType::TestId => SelectorStability {
            score: clamp01(0.95 - length_penalty(candidate.value.utf16_len())),
            signals: SelectorStabilitySignals {
                uses_test_id: true,
                ..SelectorStabilitySignals::default()
            },
            note: None,
        },
        SelectorType::Label
        | SelectorType::Placeholder
        | SelectorType::Alt
        | SelectorType::Title => {
            let base = match candidate.selector_type {
                SelectorType::Label => 0.82,
                SelectorType::Placeholder => 0.7,
                SelectorType::Alt => 0.75,
                SelectorType::Title => 0.6,
                _ => unreachable!("attribute selector variants were matched above"),
            };
            SelectorStability {
                score: clamp01(base - length_penalty(candidate.value.utf16_len())),
                signals: SelectorStabilitySignals {
                    uses_attributes: true,
                    ..SelectorStabilitySignals::default()
                },
                note: None,
            }
        }
        SelectorType::Text => {
            let text_length = trim_units(units(&candidate.value)).len();
            let score = if text_length > 80 {
                0.3
            } else if (6..=48).contains(&text_length) {
                0.45
            } else {
                0.35
            };
            SelectorStability {
                score,
                signals: SelectorStabilitySignals {
                    uses_text: true,
                    ..SelectorStabilitySignals::default()
                },
                note: None,
            }
        }
    }
}

/// Attaches a computed score only when persisted data did not supply one.
#[must_use]
pub fn with_stability(mut candidate: SelectorCandidate) -> SelectorCandidate {
    if candidate.stability.is_none() {
        candidate.stability = Some(compute_selector_stability(&candidate));
    }
    candidate
}

/// Attaches missing stability scores and stably orders a complete candidate batch.
///
/// Unlike [`rank_candidates`], this preserves duplicate candidates, sources, and batch length for
/// locator callers that only need the legacy re-sort of persisted candidate lists.
#[must_use]
pub fn sort_selector_candidates(mut candidates: Vec<SelectorCandidate>) -> Vec<SelectorCandidate> {
    for candidate in &mut candidates {
        apply_builtin_candidate_weight(candidate);
        if candidate.stability.is_none() {
            candidate.stability = Some(compute_selector_stability(candidate));
        }
    }
    candidates.sort_by(|a, b| ordering_from_compare(compare_selector_candidates(a, b)));
    candidates
}

/// Returns the JavaScript comparator number used by existing stable candidate sorts.
///
/// A NaN result represents JavaScript's "equal for sort" behavior. Use
/// [`rank_candidates`] rather than interpreting that result directly.
#[must_use]
pub fn compare_selector_candidates(a: &SelectorCandidate, b: &SelectorCandidate) -> f64 {
    let a_weight = effective_candidate_weight(a);
    let b_weight = effective_candidate_weight(b);
    if a_weight != b_weight {
        return b_weight - a_weight;
    }

    let a_stability = a.stability.as_ref().map_or_else(
        || compute_selector_stability(a).score,
        |stability| stability.score,
    );
    let b_stability = b.stability.as_ref().map_or_else(
        || compute_selector_stability(b).score,
        |stability| stability.score,
    );
    if a_stability != b_stability {
        return b_stability - a_stability;
    }

    let a_priority = selector_type_priority(a.selector_type);
    let b_priority = selector_type_priority(b.selector_type);
    if a_priority != b_priority {
        return f64::from(b_priority - a_priority);
    }

    a.value.utf16_len() as f64 - b.value.utf16_len() as f64
}

fn effective_candidate_weight(candidate: &SelectorCandidate) -> f64 {
    candidate
        .weight
        .or_else(|| builtin_candidate_weight(candidate))
        .unwrap_or(0.0)
}

fn apply_builtin_candidate_weight(candidate: &mut SelectorCandidate) {
    if candidate.weight.is_none() {
        candidate.weight = builtin_candidate_weight(candidate);
    }
}

fn builtin_candidate_weight(candidate: &SelectorCandidate) -> Option<f64> {
    if candidate.source != Some(SelectorCandidateSource::Generated) {
        return None;
    }
    match candidate.strategy.as_ref().and_then(JsString::as_utf8) {
        Some("testid") => Some(test_id_candidate_weight(&candidate.value)),
        Some("aria") => Some(40.0),
        Some("label") if candidate.selector_type == SelectorType::Aria => Some(30.0),
        Some("placeholder") if candidate.selector_type == SelectorType::Attr => Some(25.0),
        Some("text") => Some(10.0),
        Some("anchor-relpath") => Some(-10.0),
        Some("css-path") => Some(-30.0),
        _ => None,
    }
}

fn test_id_candidate_weight(value: &JsString) -> f64 {
    let value = units(value);
    let Some(attribute_start) = value.iter().position(|unit| *unit == b'[' as u16) else {
        return 50.0;
    };
    let attribute = &value[attribute_start + 1..];
    if starts_with_ascii(attribute, b"alt=") {
        20.0
    } else if starts_with_ascii(attribute, b"title=") {
        18.0
    } else if starts_with_ascii(attribute, b"name=") {
        15.0
    } else {
        50.0
    }
}

/// Produces the exact JavaScript deduplication key for a candidate.
#[must_use]
pub fn candidate_key(candidate: &SelectorCandidate) -> JsString {
    match candidate.selector_type {
        SelectorType::Text => {
            let mut value = JsString::from("text:");
            value.push_js_string(&candidate.value);
            value.push_str(":");
            if let Some(tag_name_hint) = &candidate.tag_name_hint {
                value.push_js_string(tag_name_hint);
            }
            value.push_str(":");
            if let Some(text_match) = candidate.text_match {
                value.push_str(match text_match {
                    TextMatchMode::Exact => "exact",
                    TextMatchMode::Contains => "contains",
                });
            }
            value
        }
        SelectorType::Aria => {
            let mut value = JsString::from("aria:");
            if let Some(role) = &candidate.role {
                value.push_js_string(role);
            }
            value.push_str(":");
            if let Some(name) = &candidate.name {
                value.push_js_string(name);
            }
            value.push_str(":");
            value.push_js_string(&candidate.value);
            value
        }
        _ => {
            let mut value = JsString::from(selector_type_name(candidate.selector_type));
            value.push_str(":");
            value.push_js_string(&candidate.value);
            value
        }
    }
}

/// A ranked target ready for the browser locator.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectorTarget {
    /// The fastest CSS/attribute selector, or the best candidate when none exists.
    pub selector: JsString,
    /// Stable, deduplicated candidates. This is always nonempty.
    pub candidates: Vec<SelectorCandidate>,
    /// Optional DOM tag-name hint retained from the browser host.
    pub tag_name: Option<JsString>,
}

/// Normalizes, deduplicates, ranks, truncates, and selects a candidate batch in one call.
///
/// DOM strategies must set their strategy identifier before passing their complete raw batch.
/// The returned fallback is the existing `body` CSS candidate when the batch is empty.
#[must_use]
pub fn rank_candidates(
    raw_candidates: Vec<SelectorCandidate>,
    options: &NormalizedSelectorGenerationOptions,
    tag_name: Option<JsString>,
) -> SelectorTarget {
    let mut seen = HashSet::with_capacity(raw_candidates.len());
    let mut candidates = Vec::with_capacity(raw_candidates.len().max(1));
    for mut candidate in raw_candidates {
        let key = candidate_key(&candidate);
        if !seen.insert(key) {
            continue;
        }
        if candidate.source.is_none() {
            candidate.source = Some(SelectorCandidateSource::Generated);
        }
        candidates.push(candidate);
    }

    let mut candidates = sort_selector_candidates(candidates);
    if candidates.is_empty() {
        let mut fallback = SelectorCandidate::new(SelectorType::Css, JsString::from("body"));
        fallback.source = Some(SelectorCandidateSource::Generated);
        fallback.strategy = Some(JsString::from("fallback"));
        let fallback = with_stability(fallback);
        return SelectorTarget {
            selector: fallback.value.clone(),
            candidates: vec![fallback],
            tag_name,
        };
    }

    candidates.truncate(options.max_candidates);
    let selector = candidates
        .iter()
        .find(|candidate| {
            matches!(
                candidate.selector_type,
                SelectorType::Css | SelectorType::Attr
            )
        })
        .map_or_else(
            || candidates[0].value.clone(),
            |candidate| candidate.value.clone(),
        );
    SelectorTarget {
        selector,
        candidates,
        tag_name,
    }
}

/// Selector kinds accepted by the prefixed-selector syntax.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PrefixedSelectorKind {
    /// CSS selector syntax.
    Css,
    /// XPath selector syntax.
    XPath,
    /// Role selector syntax.
    Role,
    /// Label selector syntax.
    Label,
    /// Placeholder selector syntax.
    Placeholder,
    /// Alternative-text selector syntax.
    Alt,
    /// Title selector syntax.
    Title,
    /// Test-id selector syntax.
    TestId,
    /// Text selector syntax.
    Text,
}

/// Result of parsing a selector prefix without DOM access.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedPrefixedSelector {
    /// The recognized selector kind, or CSS for legacy unprefixed input.
    pub kind: PrefixedSelectorKind,
    /// Raw value after a recognized prefix.
    pub value: JsString,
    /// Extracted role metadata.
    pub role: Option<JsString>,
    /// Extracted accessible-name metadata.
    pub name: Option<JsString>,
    /// Extracted exact-match metadata.
    pub exact: Option<bool>,
    /// The original input untouched by parsing.
    pub raw: JsString,
}

/// Parses existing selector prefix syntax, retaining lone UTF-16 surrogates exactly.
#[must_use]
pub fn parse_prefixed_selector(input: &JsString) -> ParsedPrefixedSelector {
    let raw = input.clone();
    if is_composite_selector(&raw) {
        return ParsedPrefixedSelector {
            kind: PrefixedSelectorKind::Css,
            value: raw.clone(),
            role: None,
            name: None,
            exact: None,
            raw,
        };
    }

    let raw_units = units(&raw);
    if let Some(colon) = raw_units.iter().position(|unit| *unit == b':' as u16)
        && colon > 0
        && colon < raw_units.len() - 1
    {
        let prefix = trim_units(raw_units[..colon].to_vec());
        if let Some(kind) = prefixed_kind(&prefix) {
            let mut value = js_from_units(trim_units(raw_units[colon + 1..].to_vec()));
            let mut parsed = ParsedPrefixedSelector {
                kind,
                value: value.clone(),
                role: None,
                name: None,
                exact: None,
                raw,
            };
            match kind {
                PrefixedSelectorKind::Role => {
                    let role = parse_role_selector(&value);
                    parsed.role = role.role;
                    parsed.name = role.name;
                    parsed.exact = role.exact;
                }
                PrefixedSelectorKind::Label
                | PrefixedSelectorKind::Placeholder
                | PrefixedSelectorKind::Alt
                | PrefixedSelectorKind::Title
                | PrefixedSelectorKind::Text => {
                    let value_units = units(&value);
                    if ends_with_ascii(&value_units, b"@exact") {
                        value = js_from_units(trim_units(
                            value_units[..value_units.len() - b"@exact".len()].to_vec(),
                        ));
                        parsed.value = value;
                        parsed.exact = Some(true);
                    }
                }
                _ => {}
            }
            return parsed;
        }
    }

    ParsedPrefixedSelector {
        kind: PrefixedSelectorKind::Css,
        value: raw.clone(),
        role: None,
        name: None,
        exact: None,
        raw,
    }
}

/// Converts a structured prefixed selector into the candidate the locator would construct.
#[must_use]
pub fn prefixed_selector_candidate(parsed: &ParsedPrefixedSelector) -> Option<SelectorCandidate> {
    let (selector_type, strategy) = match parsed.kind {
        PrefixedSelectorKind::Role => (SelectorType::Role, "role"),
        PrefixedSelectorKind::Label => (SelectorType::Label, "label"),
        PrefixedSelectorKind::Placeholder => (SelectorType::Placeholder, "placeholder"),
        PrefixedSelectorKind::Alt => (SelectorType::Alt, "alt"),
        PrefixedSelectorKind::Title => (SelectorType::Title, "title"),
        PrefixedSelectorKind::TestId => (SelectorType::TestId, "testid"),
        PrefixedSelectorKind::Text => (SelectorType::Text, "text"),
        PrefixedSelectorKind::Css | PrefixedSelectorKind::XPath => return None,
    };
    if matches!(parsed.kind, PrefixedSelectorKind::Role) && parsed.role.is_none() {
        return None;
    }
    let mut candidate = SelectorCandidate::new(selector_type, parsed.value.clone());
    candidate.source = Some(SelectorCandidateSource::User);
    candidate.strategy = Some(JsString::from(strategy));
    candidate.exact = parsed.exact;
    match parsed.kind {
        PrefixedSelectorKind::Role => {
            candidate.role = parsed.role.clone();
            candidate.name = parsed.name.clone();
        }
        PrefixedSelectorKind::Label
        | PrefixedSelectorKind::Placeholder
        | PrefixedSelectorKind::Alt
        | PrefixedSelectorKind::Title => candidate.text = Some(parsed.value.clone()),
        PrefixedSelectorKind::Text => {
            candidate.text_match = Some(if parsed.exact == Some(true) {
                TextMatchMode::Exact
            } else {
                TextMatchMode::Contains
            });
        }
        PrefixedSelectorKind::TestId => {}
        PrefixedSelectorKind::Css | PrefixedSelectorKind::XPath => unreachable!("filtered above"),
    }
    Some(candidate)
}

/// Parsed components of a role selector value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedRoleSelector {
    /// The normalized role when syntax is valid.
    pub role: Option<JsString>,
    /// The optional accessible name.
    pub name: Option<JsString>,
    /// The optional exact-match flag.
    pub exact: Option<bool>,
}

/// Parses the existing `role:button[name="Save",exact=true]` value grammar.
#[must_use]
pub fn parse_role_selector(value: &JsString) -> ParsedRoleSelector {
    let value = trim_units(units(value));
    if value.is_empty() {
        return ParsedRoleSelector {
            role: None,
            name: None,
            exact: None,
        };
    }
    if is_role_identifier(&value) {
        return ParsedRoleSelector {
            role: Some(js_from_units(lowercase_ascii(&value))),
            name: None,
            exact: None,
        };
    }

    let Some(open) = value.iter().position(|unit| *unit == b'[' as u16) else {
        return empty_parsed_role();
    };
    let role_units = trim_units(value[..open].to_vec());
    if value.last() != Some(&(b']' as u16))
        || role_units.is_empty()
        || !is_role_identifier(&role_units)
    {
        return empty_parsed_role();
    }
    let role = js_from_units(lowercase_ascii(&role_units));
    let body = trim_units(value[open + 1..value.len() - 1].to_vec());
    if body.is_empty() {
        return empty_parsed_role();
    }

    let mut tokens = Vec::new();
    let mut current = Vec::new();
    let mut depth = 0_i32;
    let mut quote = None;
    for unit in body {
        if let Some(open_quote) = quote {
            current.push(unit);
            if unit == open_quote {
                quote = None;
            }
            continue;
        }
        if unit == b'\'' as u16 || unit == b'"' as u16 {
            quote = Some(unit);
            current.push(unit);
            continue;
        }
        if unit == b',' as u16 && depth == 0 {
            tokens.push(current);
            current = Vec::new();
            continue;
        }
        if unit == b'[' as u16 || unit == b'(' as u16 {
            depth += 1;
        }
        if unit == b']' as u16 || unit == b')' as u16 {
            depth -= 1;
        }
        current.push(unit);
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    let mut name = None;
    let mut exact = None;
    for token in tokens {
        let Some(equal) = token.iter().position(|unit| *unit == b'=' as u16) else {
            continue;
        };
        let key = lowercase_ascii(&trim_units(token[..equal].to_vec()));
        let mut raw = trim_units(token[equal + 1..].to_vec());
        if raw.len() >= 2
            && ((raw[0] == b'"' as u16 && raw.last() == Some(&(b'"' as u16)))
                || (raw[0] == b'\'' as u16 && raw.last() == Some(&(b'\'' as u16))))
        {
            raw = raw[1..raw.len() - 1].to_vec();
        }
        if ascii_eq(&key, b"name") {
            name = Some(js_from_units(raw));
        } else if ascii_eq(&key, b"exact") {
            exact = Some(ascii_exact(&raw, b"true") || ascii_exact(&raw, b"1"));
        }
    }
    ParsedRoleSelector {
        role: Some(role),
        name,
        exact,
    }
}

/// A structural fingerprint detached from DOM APIs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ElementFingerprint {
    /// Element tag name.
    pub tag: JsString,
    /// Stored element id, including an explicitly empty value when present in text.
    pub id: Option<JsString>,
    /// Stored classes, including empty components from `class=`.
    pub classes: Option<Vec<JsString>>,
    /// Stored normalized text.
    pub text: Option<JsString>,
    /// Untouched original fingerprint text.
    pub raw: JsString,
}

/// DOM-derived inputs required to produce a fingerprint.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FingerprintInput {
    /// `element.tagName` supplied by the DOM host.
    pub tag_name: Option<JsString>,
    /// `element.id` supplied by the DOM host.
    pub id: Option<JsString>,
    /// `Array.from(element.classList)` supplied by the DOM host.
    pub classes: Vec<JsString>,
    /// `element.textContent` supplied by the DOM host.
    pub text_content: Option<JsString>,
}

/// Options accepted by fingerprint construction.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FingerprintOptions {
    /// JavaScript `slice` end for UTF-16 text retained in the fingerprint.
    pub text_max_length: Option<f64>,
    /// JavaScript `slice` end for class tokens retained in the fingerprint.
    pub max_classes: Option<f64>,
}

/// Builds the existing fingerprint string from browser-collected element fields.
///
/// `case_fold` must use the host's JavaScript `toLowerCase` intrinsic; Rust's per-scalar
/// Unicode casing would not preserve JavaScript contextual casing semantics.
#[must_use]
pub fn compute_fingerprint(
    input: &FingerprintInput,
    options: Option<&FingerprintOptions>,
    case_fold: impl Fn(&JsString) -> JsString,
) -> JsString {
    let options = options.cloned().unwrap_or_default();
    let text_max_length = options
        .text_max_length
        .unwrap_or(FINGERPRINT_TEXT_MAX_LENGTH as f64);
    let max_classes = js_slice_end(
        input.classes.len(),
        options
            .max_classes
            .unwrap_or(FINGERPRINT_MAX_CLASSES as f64),
    );
    let tag = input
        .tag_name
        .as_ref()
        .map(&case_fold)
        .unwrap_or_else(|| JsString::from("unknown"));

    let mut parts = vec![tag];
    if let Some(id) = &input.id {
        let id = trim_js_string(id);
        if !units(&id).is_empty() {
            parts.push(join_js(&[JsString::from("id="), id]));
        }
    }
    if !input.classes.is_empty() && max_classes > 0 {
        let classes = input
            .classes
            .iter()
            .take(max_classes)
            .cloned()
            .collect::<Vec<_>>();
        if !classes.is_empty() {
            let class_list = join_with(&classes, ".");
            parts.push(join_js(&[JsString::from("class="), class_list]));
        }
    }
    let text = input
        .text_content
        .as_ref()
        .map(|text| normalize_fingerprint_text(text, text_max_length))
        .unwrap_or_default();
    if !text.is_empty() {
        parts.push(join_js(&[JsString::from("text="), js_from_units(text)]));
    }
    join_with(&parts, "|")
}

/// Parses a fingerprint without treating empty fields as absent.
#[must_use]
pub fn parse_fingerprint(fingerprint: &JsString) -> ElementFingerprint {
    let parts = split_units(&units(fingerprint), &[b'|' as u16]);
    let tag = parts
        .first()
        .cloned()
        .map(js_from_units)
        .unwrap_or_else(|| JsString::from("unknown"));
    let mut id = None;
    let mut classes = None;
    let mut text = None;
    for part in parts.into_iter().skip(1) {
        if let Some(value) = strip_ascii_prefix(&part, b"id=") {
            id = Some(js_from_units(value.to_vec()));
        } else if let Some(value) = strip_ascii_prefix(&part, b"class=") {
            classes = Some(
                split_units(value, &[b'.' as u16])
                    .into_iter()
                    .map(js_from_units)
                    .collect(),
            );
        } else if let Some(value) = strip_ascii_prefix(&part, b"text=") {
            text = Some(js_from_units(value.to_vec()));
        }
    }
    ElementFingerprint {
        tag,
        id,
        classes,
        text,
        raw: fingerprint.clone(),
    }
}

/// Checks the tag/id portion of a stored fingerprint against browser-provided element fields.
///
/// `case_fold` must be the host's JavaScript `toLowerCase` intrinsic.
#[must_use]
pub fn verify_fingerprint(
    current_tag: Option<&JsString>,
    current_id: Option<&JsString>,
    fingerprint: &JsString,
    case_fold: impl Fn(&JsString) -> JsString,
) -> bool {
    let stored = parse_fingerprint(fingerprint);
    let tag = current_tag
        .map(&case_fold)
        .unwrap_or_else(|| JsString::from("unknown"));
    if stored.tag != tag {
        return false;
    }
    match stored.id {
        Some(id) if !units(&id).is_empty() => current_id.map(trim_js_string).as_ref() == Some(&id),
        _ => true,
    }
}

/// Returns the existing weighted similarity score in `0..=1` for fingerprint text.
///
/// `case_fold` is the narrow host intrinsic callback required for exact JavaScript casing.
#[must_use]
pub fn fingerprint_similarity(
    a: &JsString,
    b: &JsString,
    case_fold: impl Fn(&JsString) -> JsString,
) -> f64 {
    let a = parse_fingerprint(a);
    let b = parse_fingerprint(b);
    if a.tag != b.tag {
        return 0.0;
    }

    let mut score = 0.4;
    let mut weights = 0.4;
    if js_option_truthy(&a.id) || js_option_truthy(&b.id) {
        weights += 0.3;
        if a.id == b.id {
            score += 0.3;
        }
    }
    let a_classes = a.classes.as_deref().unwrap_or_default();
    let b_classes = b.classes.as_deref().unwrap_or_default();
    if !a_classes.is_empty() || !b_classes.is_empty() {
        weights += 0.2;
        let a_set: HashSet<_> = a_classes.iter().collect();
        let b_set: HashSet<_> = b_classes.iter().collect();
        let intersection = a_set.intersection(&b_set).count();
        let union = a_set.union(&b_set).count();
        if union > 0 {
            score += 0.2 * (intersection as f64 / union as f64);
        }
    }
    if js_option_truthy(&a.text) || js_option_truthy(&b.text) {
        weights += 0.1;
        if js_option_truthy(&a.text) && js_option_truthy(&b.text) {
            let (Some(a_text), Some(b_text)) = (a.text.as_ref(), b.text.as_ref()) else {
                unreachable!("truthy optional fingerprint text is present");
            };
            let a_text = case_fold(a_text);
            let b_text = case_fold(b_text);
            if a_text == b_text {
                score += 0.1;
            } else if contains_units(&units(&a_text), &units(&b_text))
                || contains_units(&units(&b_text), &units(&a_text))
            {
                score += 0.05;
            }
        }
    }
    score / weights
}

/// A score plus the existing inclusive threshold result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FingerprintMatch {
    /// Whether the score reaches the supplied threshold.
    pub matched: bool,
    /// The underlying fingerprint similarity score.
    pub score: f64,
}

/// Applies the existing `0.7` default fingerprint threshold.
#[must_use]
pub fn fingerprint_matches(
    a: &JsString,
    b: &JsString,
    threshold: Option<f64>,
    case_fold: impl Fn(&JsString) -> JsString,
) -> FingerprintMatch {
    let score = fingerprint_similarity(a, b, case_fold);
    FingerprintMatch {
        matched: score >= threshold.unwrap_or(0.7),
        score,
    }
}

/// Extracts ARIA role/name metadata from the human-readable expression used by old recordings.
#[must_use]
pub fn parse_aria_expression(expression: &JsString) -> (Option<JsString>, Option<JsString>) {
    let value = trim_units(units(expression));
    let Some(open) = value.iter().position(|unit| *unit == b'[' as u16) else {
        return (None, None);
    };
    if value.last() != Some(&(b']' as u16)) || open == 0 {
        return (None, None);
    }
    let role = trim_units(value[..open].to_vec());
    if role.is_empty() || !role.iter().all(|unit| is_ascii_word(*unit)) {
        return (None, None);
    }
    let body = &value[open + 1..value.len() - 1];
    let mut index = 0;
    while index < body.len() && is_js_whitespace(body[index]) {
        index += 1;
    }
    if !starts_with_ascii(&body[index..], b"name") {
        return (None, None);
    }
    index += b"name".len();
    while index < body.len() && is_js_whitespace(body[index]) {
        index += 1;
    }
    if body.get(index) != Some(&(b'=' as u16)) {
        return (None, None);
    }
    let raw_name = trim_units(body[index + 1..].to_vec());
    if raw_name.is_empty() || raw_name.contains(&(b']' as u16)) {
        return (None, None);
    }
    let name = strip_surrounding_quote(raw_name);
    let role = js_from_units(role);
    let name = (!name.is_empty()).then(|| js_from_units(name));
    (Some(role), name)
}

/// Produces the deterministic ARIA-to-CSS fallback sequence used by the locator host.
#[must_use]
pub fn aria_to_css_selectors(role: Option<&JsString>, name: Option<&JsString>) -> Vec<JsString> {
    let Some(name) = name
        .map(trim_js_string)
        .filter(|name| !units(name).is_empty())
    else {
        return Vec::new();
    };
    let role = role
        .map(trim_js_string)
        .filter(|role| !units(role).is_empty());
    let quoted_name = js_from_utf8(&name.json_string_literal());
    let mut output = Vec::new();
    if let Some(role) = &role {
        output.push(join_js(&[
            JsString::from("[role="),
            js_from_utf8(&role.json_string_literal()),
            JsString::from("][aria-label="),
            quoted_name.clone(),
            JsString::from("]"),
        ]));
    }
    if role
        .as_ref()
        .is_some_and(|role| ascii_exact(&units(role), b"textbox"))
    {
        output.insert(
            0,
            join_js(&[
                JsString::from("input[aria-label="),
                quoted_name.clone(),
                JsString::from("]"),
            ]),
        );
        output.insert(
            1,
            join_js(&[
                JsString::from("textarea[aria-label="),
                quoted_name.clone(),
                JsString::from("]"),
            ]),
        );
        output.insert(
            2,
            join_js(&[
                JsString::from("[role=\"textbox\"][aria-label="),
                quoted_name.clone(),
                JsString::from("]"),
            ]),
        );
    } else if role
        .as_ref()
        .is_some_and(|role| ascii_exact(&units(role), b"button"))
    {
        output.insert(
            0,
            join_js(&[
                JsString::from("button[aria-label="),
                quoted_name.clone(),
                JsString::from("]"),
            ]),
        );
        output.insert(
            1,
            join_js(&[
                JsString::from("[role=\"button\"][aria-label="),
                quoted_name.clone(),
                JsString::from("]"),
            ]),
        );
    } else if role
        .as_ref()
        .is_some_and(|role| ascii_exact(&units(role), b"link"))
    {
        output.insert(
            0,
            join_js(&[
                JsString::from("a[aria-label="),
                quoted_name.clone(),
                JsString::from("]"),
            ]),
        );
        output.insert(
            1,
            join_js(&[
                JsString::from("[role=\"link\"][aria-label="),
                quoted_name.clone(),
                JsString::from("]"),
            ]),
        );
    }
    output.push(join_js(&[
        JsString::from("[aria-label="),
        quoted_name,
        JsString::from("]"),
    ]));
    unique_trimmed_strings(output)
}

/// Returns a frame selector from a target selector first, then from candidates in order.
#[must_use]
pub fn derive_frame_selector(target: &SelectorTarget) -> Option<JsString> {
    split_composite_selector(&target.selector)
        .map(|parts| parts.frame_selector)
        .or_else(|| {
            target.candidates.iter().find_map(|candidate| {
                split_composite_selector(&candidate.value).map(|parts| parts.frame_selector)
            })
        })
}

/// Keeps the candidate's text tag hint ahead of the target-wide hint.
#[must_use]
pub fn derive_tag_name_hint(
    target: &SelectorTarget,
    candidate: Option<&SelectorCandidate>,
) -> Option<JsString> {
    candidate
        .filter(|candidate| candidate.selector_type == SelectorType::Text)
        .and_then(|candidate| candidate.tag_name_hint.clone())
        .filter(|hint| hint.utf16_len() > 0)
        .or_else(|| target.tag_name.clone())
}

fn default_test_id_attributes() -> Vec<JsString> {
    [
        "data-testid",
        "data-test-id",
        "data-testId",
        "data-test",
        "data-qa",
        "data-cy",
        "name",
        "title",
        "alt",
    ]
    .into_iter()
    .map(JsString::from)
    .collect()
}

fn default_text_tags() -> Vec<JsString> {
    ["button", "a", "summary"]
        .into_iter()
        .map(JsString::from)
        .collect()
}

fn clamp_int(value: f64, min: usize, max: usize) -> usize {
    if !value.is_finite() {
        return min;
    }
    value.floor().clamp(min as f64, max as f64) as usize
}

fn normalize_editor_locator_max_candidates(value: Option<f64>) -> usize {
    let value = value.unwrap_or(DEFAULT_EDITOR_LOCATOR_MAX_CANDIDATES);
    if value == f64::INFINITY {
        return usize::MAX;
    }
    if !value.is_finite() {
        return 1;
    }
    value.max(1.0).floor().min(usize::MAX as f64) as usize
}

fn clamp01(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

fn length_penalty(length: usize) -> f64 {
    if length <= 60 {
        0.0
    } else if length <= 120 {
        0.05
    } else if length <= 200 {
        0.1
    } else {
        0.18
    }
}

fn merge_signals(
    a: SelectorStabilitySignals,
    b: SelectorStabilitySignals,
) -> SelectorStabilitySignals {
    SelectorStabilitySignals {
        uses_id: a.uses_id || b.uses_id,
        uses_test_id: a.uses_test_id || b.uses_test_id,
        uses_aria: a.uses_aria || b.uses_aria,
        uses_text: a.uses_text || b.uses_text,
        uses_nth_of_type: a.uses_nth_of_type || b.uses_nth_of_type,
        uses_attributes: a.uses_attributes || b.uses_attributes,
        uses_class: a.uses_class || b.uses_class,
    }
}

fn analyze_css_like(selector: &JsString) -> SelectorStabilitySignals {
    let value = units(selector);
    let lower = lowercase_ascii(&value);
    SelectorStabilitySignals {
        uses_id: contains_token_prefixed_by(&value, b'#'),
        uses_test_id: [
            b"[data-testid".as_slice(),
            b"[data-test-id",
            b"[data-test",
            b"[data-qa",
            b"[data-cy",
        ]
        .into_iter()
        .any(|name| contains_ascii(&lower, name)),
        uses_aria: css_uses_aria(&value),
        uses_text: false,
        uses_nth_of_type: contains_ascii(&lower, b":nth-of-type("),
        uses_attributes: has_bracket_pair(&value),
        uses_class: contains_token_prefixed_by(&value, b'.'),
    }
}

fn base_score_for_css_signals(signals: SelectorStabilitySignals) -> f64 {
    if signals.uses_test_id {
        0.95
    } else if signals.uses_id {
        0.9
    } else if signals.uses_aria {
        0.8
    } else if signals.uses_attributes {
        0.75
    } else if signals.uses_class {
        0.65
    } else {
        0.5
    }
}

fn js_slice_end(length: usize, end: f64) -> usize {
    let integer = if end.is_nan() {
        0_i128
    } else if end == f64::INFINITY {
        return length;
    } else if end == f64::NEG_INFINITY {
        0
    } else {
        end.trunc() as i128
    };
    if integer < 0 {
        length.saturating_sub(integer.unsigned_abs() as usize)
    } else {
        (integer as usize).min(length)
    }
}

fn selector_type_priority(selector_type: SelectorType) -> i32 {
    match selector_type {
        SelectorType::TestId => 8,
        SelectorType::Role => 7,
        SelectorType::Label => 6,
        SelectorType::Attr => 5,
        SelectorType::Css => 4,
        SelectorType::Placeholder
        | SelectorType::Alt
        | SelectorType::Title
        | SelectorType::Aria => 3,
        SelectorType::XPath => 2,
        SelectorType::Text => 1,
    }
}

fn selector_type_name(selector_type: SelectorType) -> &'static str {
    match selector_type {
        SelectorType::Css => "css",
        SelectorType::XPath => "xpath",
        SelectorType::Attr => "attr",
        SelectorType::Aria => "aria",
        SelectorType::Text => "text",
        SelectorType::Role => "role",
        SelectorType::Label => "label",
        SelectorType::Placeholder => "placeholder",
        SelectorType::Alt => "alt",
        SelectorType::Title => "title",
        SelectorType::TestId => "testid",
    }
}

fn ordering_from_compare(result: f64) -> Ordering {
    if result.is_nan() || result == 0.0 {
        Ordering::Equal
    } else if result < 0.0 {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

fn prefixed_kind(prefix: &[u16]) -> Option<PrefixedSelectorKind> {
    if ascii_eq(prefix, b"css") {
        Some(PrefixedSelectorKind::Css)
    } else if ascii_eq(prefix, b"xpath") {
        Some(PrefixedSelectorKind::XPath)
    } else if ascii_eq(prefix, b"role") {
        Some(PrefixedSelectorKind::Role)
    } else if ascii_eq(prefix, b"label") {
        Some(PrefixedSelectorKind::Label)
    } else if ascii_eq(prefix, b"placeholder") {
        Some(PrefixedSelectorKind::Placeholder)
    } else if ascii_eq(prefix, b"alt") {
        Some(PrefixedSelectorKind::Alt)
    } else if ascii_eq(prefix, b"title") {
        Some(PrefixedSelectorKind::Title)
    } else if ascii_eq(prefix, b"testid") {
        Some(PrefixedSelectorKind::TestId)
    } else if ascii_eq(prefix, b"text") {
        Some(PrefixedSelectorKind::Text)
    } else {
        None
    }
}

fn empty_parsed_role() -> ParsedRoleSelector {
    ParsedRoleSelector {
        role: None,
        name: None,
        exact: None,
    }
}

fn is_role_identifier(value: &[u16]) -> bool {
    !value.is_empty()
        && is_ascii_alpha(value[0])
        && value[1..].iter().all(|unit| {
            is_ascii_alpha(*unit)
                || is_ascii_digit(*unit)
                || *unit == b'_' as u16
                || *unit == b'-' as u16
        })
}

fn xpath_has_attribute(value: &[u16]) -> bool {
    let mut index = 0;
    while index < value.len() {
        if value[index] == b'@' as u16 {
            let mut end = index + 1;
            while end < value.len() && (is_ascii_word(value[end]) || value[end] == b'-' as u16) {
                end += 1;
            }
            if end > index + 1 {
                while end < value.len() && is_js_whitespace(value[end]) {
                    end += 1;
                }
                if value.get(end) == Some(&(b'=' as u16)) {
                    return true;
                }
            }
        }
        index += 1;
    }
    false
}

fn xpath_has_named_attribute(value: &[u16], name: &[u8]) -> bool {
    let mut pattern = Vec::with_capacity(name.len() + 1);
    pattern.push(b'@' as u16);
    pattern.extend(name.iter().map(|byte| u16::from(*byte)));
    let mut start = 0;
    while let Some(found) = find_units(&value[start..], &pattern) {
        let mut end = start + found + pattern.len();
        while end < value.len() && is_js_whitespace(value[end]) {
            end += 1;
        }
        if value.get(end) == Some(&(b'=' as u16)) {
            return true;
        }
        start += found + 1;
    }
    false
}

fn css_uses_aria(value: &[u16]) -> bool {
    let lower = lowercase_ascii(value);
    let mut start = 0;
    while let Some(found) = find_ascii(&lower[start..], b"[") {
        let mut index = start + found + 1;
        while index < lower.len() && is_js_whitespace(lower[index]) {
            index += 1;
        }
        if starts_with_ascii(&lower[index..], b"aria-") {
            let rest = &lower[index + 5..];
            if rest.first().is_some_and(|unit| *unit != b'=' as u16)
                && rest.contains(&(b'=' as u16))
            {
                return true;
            }
        }
        if starts_with_ascii(&lower[index..], b"role") {
            let mut end = index + 4;
            while end < lower.len() && is_js_whitespace(lower[end]) {
                end += 1;
            }
            if lower.get(end) == Some(&(b'=' as u16)) {
                return true;
            }
        }
        start = index;
    }

    let mut index = 0;
    while let Some(found) = find_ascii(&lower[index..], b"role") {
        let role_start = index + found;
        let left_word = role_start
            .checked_sub(1)
            .is_some_and(|left| is_ascii_word(lower[left]));
        let mut end = role_start + 4;
        while end < lower.len() && is_js_whitespace(lower[end]) {
            end += 1;
        }
        if !left_word && lower.get(end) == Some(&(b'=' as u16)) {
            return true;
        }
        index = role_start + 1;
    }
    false
}

fn has_bracket_pair(value: &[u16]) -> bool {
    value
        .iter()
        .position(|unit| *unit == b'[' as u16)
        .is_some_and(|open| value[open + 1..].contains(&(b']' as u16)))
}

fn contains_token_prefixed_by(value: &[u16], token: u8) -> bool {
    let token = u16::from(token);
    for (index, unit) in value.iter().enumerate() {
        if *unit != token {
            continue;
        }
        let valid_prefix = index == 0
            || is_js_whitespace(value[index - 1])
            || matches!(value[index - 1], x if x == b'>' as u16 || x == b'+' as u16 || x == b'~' as u16);
        if !valid_prefix {
            continue;
        }
        let mut cursor = index + 1;
        while cursor < value.len()
            && !matches!(value[cursor], x if is_js_whitespace(x) || x == b'>' as u16 || x == b'+' as u16 || x == b'~' as u16 || x == b'.' as u16 || x == b':' as u16 || x == b'#' as u16 || x == b'[' as u16)
        {
            cursor += 1;
        }
        if cursor > index + 1 {
            return true;
        }
    }
    false
}

fn is_editor_class_name(value: &JsString) -> bool {
    let mut units = value.utf16_units();
    let Some(first) = units.next() else {
        return false;
    };
    if !(is_ascii_alpha(first) || first == b'_' as u16) {
        return false;
    }
    units.all(|unit| {
        is_ascii_alpha(unit) || is_ascii_digit(unit) || unit == b'_' as u16 || unit == b'-' as u16
    })
}

fn push_trimmed_unique(
    selected: &mut Vec<JsString>,
    seen: &mut HashSet<JsString>,
    candidate: JsString,
) {
    let candidate = trim_js_string(&candidate);
    if !units(&candidate).is_empty() && seen.insert(candidate.clone()) {
        selected.push(candidate);
    }
}

fn css_escape_identifier(value: &JsString) -> JsString {
    let units = units(value);
    if units.is_empty() {
        return JsString::from("");
    }
    let first = units[0];
    let length = units.len();
    let mut output = Vec::with_capacity(length);
    for (index, unit) in units.into_iter().enumerate() {
        if unit == 0 {
            output.push(0xfffd);
        } else if (1..=0x1f).contains(&unit)
            || unit == 0x7f
            || (index == 0 && is_ascii_digit(unit))
            || (index == 1 && is_ascii_digit(unit) && first == b'-' as u16)
        {
            output.push(b'\\' as u16);
            push_ascii_hex(unit, &mut output);
            output.push(b' ' as u16);
        } else if index == 0 && length == 1 && unit == b'-' as u16 {
            output.push(b'\\' as u16);
            output.push(unit);
        } else if is_ascii_alpha(unit)
            || is_ascii_digit(unit)
            || unit == b'-' as u16
            || unit == b'_' as u16
        {
            output.push(unit);
        } else {
            output.push(b'\\' as u16);
            output.push(unit);
        }
    }
    js_from_units(output)
}

fn push_ascii_hex(value: u16, output: &mut Vec<u16>) {
    let mut emitted = false;
    for shift in [12, 8, 4, 0] {
        let digit = (value >> shift) & 0x0f;
        if digit != 0 || emitted || shift == 0 {
            emitted = true;
            output.push(if digit < 10 {
                b'0' as u16 + digit
            } else {
                b'a' as u16 + (digit - 10)
            });
        }
    }
}

fn normalize_fingerprint_text(value: &JsString, max_length: f64) -> Vec<u16> {
    let value = units(value);
    let mut normalized = Vec::with_capacity(value.len());
    let mut whitespace = false;
    for unit in value {
        if is_js_whitespace(unit) {
            whitespace = true;
        } else {
            if whitespace && !normalized.is_empty() {
                normalized.push(b' ' as u16);
            }
            normalized.push(unit);
            whitespace = false;
        }
    }
    normalized.truncate(js_slice_end(normalized.len(), max_length));
    normalized
}

fn strip_surrounding_quote(mut value: Vec<u16>) -> Vec<u16> {
    if value
        .first()
        .is_some_and(|unit| *unit == b'\'' as u16 || *unit == b'"' as u16)
    {
        value.remove(0);
    }
    if value
        .last()
        .is_some_and(|unit| *unit == b'\'' as u16 || *unit == b'"' as u16)
    {
        value.pop();
    }
    value
}

fn unique_trimmed_strings(values: Vec<JsString>) -> Vec<JsString> {
    let mut seen = HashSet::with_capacity(values.len());
    values
        .into_iter()
        .filter_map(|value| {
            let value = trim_js_string(&value);
            (!units(&value).is_empty() && seen.insert(value.clone())).then_some(value)
        })
        .collect()
}

fn js_option_truthy(value: &Option<JsString>) -> bool {
    value
        .as_ref()
        .is_some_and(|value| value.utf16_units().next().is_some())
}

fn trim_js_string(value: &JsString) -> JsString {
    js_from_units(trim_units(units(value)))
}

fn join_js(parts: &[JsString]) -> JsString {
    let mut result = JsString::from("");
    for part in parts {
        result.push_js_string(part);
    }
    result
}

fn join_with(parts: &[JsString], separator: &str) -> JsString {
    let mut result = JsString::from("");
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            result.push_str(separator);
        }
        result.push_js_string(part);
    }
    result
}

fn js_from_utf8(value: &str) -> JsString {
    JsString::from(value)
}

fn units(value: &JsString) -> Vec<u16> {
    value.utf16_units().collect()
}

fn js_from_units(units: Vec<u16>) -> JsString {
    JsString::from_utf16_units(units)
}

fn trim_units(mut value: Vec<u16>) -> Vec<u16> {
    let start = value
        .iter()
        .position(|unit| !is_js_whitespace(*unit))
        .unwrap_or(value.len());
    let end = value
        .iter()
        .rposition(|unit| !is_js_whitespace(*unit))
        .map_or(start, |index| index + 1);
    value.truncate(end);
    value.drain(..start);
    value
}
fn split_units(value: &[u16], separator: &[u16]) -> Vec<Vec<u16>> {
    if separator.is_empty() {
        return value.iter().map(|unit| vec![*unit]).collect();
    }
    let mut output = Vec::new();
    let mut start = 0;
    while let Some(found) = find_units(&value[start..], separator) {
        let end = start + found;
        output.push(value[start..end].to_vec());
        start = end + separator.len();
    }
    output.push(value[start..].to_vec());
    output
}

fn find_units(value: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    value
        .windows(needle.len())
        .position(|window| window == needle)
}

fn contains_units(value: &[u16], needle: &[u16]) -> bool {
    find_units(value, needle).is_some()
}

fn contains_ascii(value: &[u16], needle: &[u8]) -> bool {
    find_ascii(value, needle).is_some()
}

fn find_ascii(value: &[u16], needle: &[u8]) -> Option<usize> {
    value.windows(needle.len()).position(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(unit, byte)| *unit == u16::from(*byte))
    })
}

fn starts_with_ascii(value: &[u16], ascii: &[u8]) -> bool {
    value.len() >= ascii.len()
        && value
            .iter()
            .zip(ascii)
            .all(|(unit, byte)| *unit == u16::from(*byte))
}

fn strip_ascii_prefix<'a>(value: &'a [u16], prefix: &[u8]) -> Option<&'a [u16]> {
    if value.len() < prefix.len()
        || !value
            .iter()
            .zip(prefix)
            .all(|(unit, byte)| *unit == u16::from(*byte))
    {
        return None;
    }
    Some(&value[prefix.len()..])
}

fn ascii_eq(value: &[u16], ascii: &[u8]) -> bool {
    value.len() == ascii.len()
        && value
            .iter()
            .zip(ascii)
            .all(|(unit, byte)| ascii_lower(*unit) == ascii_lower(u16::from(*byte)))
}

fn lowercase_ascii(value: &[u16]) -> Vec<u16> {
    value.iter().map(|unit| ascii_lower(*unit)).collect()
}

fn ascii_exact(value: &[u16], ascii: &[u8]) -> bool {
    value.len() == ascii.len()
        && value
            .iter()
            .zip(ascii)
            .all(|(unit, byte)| *unit == u16::from(*byte))
}
fn ascii_lower(unit: u16) -> u16 {
    if (b'A' as u16..=b'Z' as u16).contains(&unit) {
        unit + (b'a' - b'A') as u16
    } else {
        unit
    }
}

fn is_ascii_alpha(unit: u16) -> bool {
    (b'a' as u16..=b'z' as u16).contains(&ascii_lower(unit))
}

fn is_ascii_digit(unit: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&unit)
}

fn is_ascii_word(unit: u16) -> bool {
    is_ascii_alpha(unit) || is_ascii_digit(unit) || unit == b'_' as u16
}

fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x0009..=0x000d
            | 0x0020
            | 0x00a0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn ends_with_ascii(value: &[u16], ascii: &[u8]) -> bool {
    value.len() >= ascii.len()
        && value[value.len() - ascii.len()..]
            .iter()
            .zip(ascii)
            .all(|(unit, byte)| *unit == u16::from(*byte))
}

#[cfg(test)]
mod tests {
    use super::{
        FingerprintInput, FingerprintOptions, JsString, NormalizedSelectorGenerationOptions,
        PrefixedSelectorKind, SelectorCandidate, SelectorTarget, SelectorType, compute_fingerprint,
        derive_tag_name_hint, fingerprint_matches, fingerprint_similarity, parse_fingerprint,
        parse_prefixed_selector, rank_candidates, split_composite_selector,
    };

    fn options() -> NormalizedSelectorGenerationOptions {
        super::normalize_selector_generation_options(None)
    }

    fn case_fold(value: &JsString) -> JsString {
        JsString::from(
            value
                .to_string_if_well_formed()
                .expect("test input has no unpaired surrogate")
                .to_lowercase(),
        )
    }

    #[test]
    fn preserves_lone_surrogates_in_ranked_candidates() {
        let surrogate =
            JsString::from_json_string_literal(r#""\ud800""#).expect("literal is valid");
        let candidate = SelectorCandidate::new(SelectorType::Text, surrogate.clone());
        let target = rank_candidates(vec![candidate], &options(), None);
        assert_eq!(
            target.candidates[0].value.json_string_literal(),
            surrogate.json_string_literal()
        );
    }

    #[test]
    fn ranks_by_weight_then_stability_and_keeps_css_primary() {
        let mut semantic =
            SelectorCandidate::new(SelectorType::Role, JsString::from("button[name=Save]"));
        semantic.role = Some(JsString::from("button"));
        semantic.name = Some(JsString::from("Save"));
        semantic.weight = Some(50.0);
        let mut css =
            SelectorCandidate::new(SelectorType::Attr, JsString::from("[data-testid=save]"));
        css.weight = Some(40.0);
        let target = rank_candidates(vec![semantic, css], &options(), None);
        assert_eq!(target.candidates[0].selector_type, SelectorType::Role);
        assert_eq!(target.selector, JsString::from("[data-testid=save]"));
    }

    #[test]
    fn recorder_form_candidates_keep_their_priority_without_reweighting_modern_kinds() {
        let generated = |kind, value, strategy| {
            let mut candidate = SelectorCandidate::new(kind, JsString::from(value));
            candidate.source = Some(super::SelectorCandidateSource::Generated);
            candidate.strategy = Some(JsString::from(strategy));
            candidate
        };
        let recorder = rank_candidates(
            vec![
                generated(SelectorType::Css, "#email", "css-unique"),
                generated(SelectorType::Aria, "textbox[name=\"Email\"]", "label"),
                generated(
                    SelectorType::Attr,
                    "[placeholder=\"Address\"]",
                    "placeholder",
                ),
            ],
            &options(),
            None,
        );
        assert_eq!(
            recorder
                .candidates
                .iter()
                .map(|candidate| candidate.selector_type)
                .collect::<Vec<_>>(),
            [SelectorType::Aria, SelectorType::Attr, SelectorType::Css]
        );
        assert_eq!(
            recorder.selector,
            JsString::from("[placeholder=\"Address\"]")
        );

        let modern = rank_candidates(
            vec![
                generated(SelectorType::Css, "#email", "css-unique"),
                generated(SelectorType::Label, "Email", "label"),
                generated(SelectorType::Placeholder, "Address", "placeholder"),
            ],
            &options(),
            None,
        );
        assert_eq!(modern.candidates[0].selector_type, SelectorType::Css);
        assert_eq!(modern.selector, JsString::from("#email"));
    }

    #[test]
    fn uses_body_fallback_for_empty_collections() {
        let target = rank_candidates(Vec::new(), &options(), None);
        assert_eq!(target.selector, JsString::from("body"));
        assert_eq!(target.candidates.len(), 1);
    }

    #[test]
    fn splits_nested_composites_after_filtering_empty_segments() {
        let parts = split_composite_selector(&JsString::from(" iframe |> |> role:button "))
            .expect("composite");
        assert_eq!(parts.frame_selector, JsString::from("iframe"));
        assert_eq!(parts.inner_selector, JsString::from("role:button"));
    }

    #[test]
    fn parses_prefixed_role_and_exact_text() {
        let role =
            parse_prefixed_selector(&JsString::from("role:button[name=\"Save\",exact=true]"));
        assert_eq!(role.kind, PrefixedSelectorKind::Role);
        assert_eq!(role.role, Some(JsString::from("button")));
        assert_eq!(role.name, Some(JsString::from("Save")));
        assert_eq!(role.exact, Some(true));
        let text = parse_prefixed_selector(&JsString::from("text:Save@exact"));
        assert_eq!(text.value, JsString::from("Save"));
        assert_eq!(text.exact, Some(true));
    }

    #[test]
    fn fingerprints_use_utf16_text_slicing_and_thresholds() {
        let input = FingerprintInput {
            tag_name: Some(JsString::from("BUTTON")),
            id: Some(JsString::from(" submit ")),
            classes: vec![JsString::from("btn"), JsString::from("primary")],
            text_content: Some(JsString::from(" Save\n now ")),
        };
        let fingerprint = compute_fingerprint(&input, None, case_fold);
        assert_eq!(
            fingerprint,
            JsString::from("button|id=submit|class=btn.primary|text=Save now")
        );
        assert!(fingerprint_matches(&fingerprint, &fingerprint, None, case_fold).matched);
    }

    #[test]
    fn fingerprint_parser_ignores_short_segments_and_empty_text_is_not_compared() {
        let parsed = parse_fingerprint(&JsString::from("button|"));
        assert_eq!(parsed.tag, JsString::from("button"));
        let score = fingerprint_similarity(
            &JsString::from("button|text=abc"),
            &JsString::from("button|text="),
            |value| value.clone(),
        );
        assert_eq!(score, 0.8);
    }

    #[test]
    fn fingerprint_negative_text_slice_uses_normalized_length() {
        let input = FingerprintInput {
            tag_name: Some(JsString::from("BUTTON")),
            id: None,
            classes: Vec::new(),
            text_content: Some(JsString::from("  abc  ")),
        };
        let options = FingerprintOptions {
            text_max_length: Some(-1.0),
            max_classes: None,
        };
        assert_eq!(
            compute_fingerprint(&input, Some(&options), case_fold),
            JsString::from("button|text=ab")
        );
    }

    #[test]
    fn fingerprint_case_fold_uses_the_host_intrinsic() {
        let score = fingerprint_similarity(
            &JsString::from("button|text=ΟΣ"),
            &JsString::from("button|text=ος"),
            |value| {
                if value == &JsString::from("ΟΣ") {
                    JsString::from("ος")
                } else {
                    value.clone()
                }
            },
        );
        assert_eq!(score, 1.0);
    }

    #[test]
    fn empty_text_tag_hint_falls_back_to_target_hint() {
        let mut candidate = SelectorCandidate::new(SelectorType::Text, JsString::from("Save"));
        candidate.tag_name_hint = Some(JsString::from(""));
        let target = SelectorTarget {
            selector: JsString::from("body"),
            candidates: vec![candidate.clone()],
            tag_name: Some(JsString::from("button")),
        };
        assert_eq!(
            derive_tag_name_hint(&target, Some(&candidate)),
            Some(JsString::from("button"))
        );
    }
}
