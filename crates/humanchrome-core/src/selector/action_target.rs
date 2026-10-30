//! Candidate preparation shared by legacy action hosts before DOM lookup.

use crate::arguments::JsString;

use super::{SelectorCandidate, SelectorType, TextMatchMode, trim_js_string};

/// A decoded action candidate after the existing structured string resolver runs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ActionCandidateInput {
    /// Unknown authored kinds are retained as an empty discriminant and skipped.
    pub selector_type: Option<SelectorType>,
    /// Resolved query text; a failed resolver leaves this absent.
    pub value: Option<JsString>,
    /// Authored priority, including non-finite values for legacy default handling.
    pub weight: Option<f64>,
    /// Resolved optional ARIA role.
    pub role: Option<JsString>,
    /// Resolved optional ARIA name.
    pub name: Option<JsString>,
    /// Authored text matching behavior.
    pub text_match: Option<TextMatchMode>,
    /// Authored text tag hint before the target-level fallback.
    pub tag_name_hint: Option<JsString>,
}

/// A normalized candidate plus the source object whose opaque metadata stays in the host.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionCandidatePlan {
    /// Absent only for the empty CSS fallback.
    pub source_index: Option<usize>,
    /// Portable selector fields; source and stability handles remain outside Rust.
    pub candidate: SelectorCandidate,
}

/// A complete preparation batch without additional sorting or deduplication.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionCandidateBatch {
    /// Nonempty candidate collection in authored order.
    pub candidates: Vec<ActionCandidatePlan>,
    /// Position of the first nonblank CSS/attribute fallback, without copying its string.
    pub first_css_or_attr: Option<usize>,
}

/// Prepares action priorities and fallbacks while preserving failed-candidate positions.
#[must_use]
pub fn prepare_action_candidates(
    inputs: Vec<ActionCandidateInput>,
    tag_name: Option<&JsString>,
) -> ActionCandidateBatch {
    let mut candidates = Vec::with_capacity(inputs.len().max(1));
    let mut first_css_or_attr = None;
    let mut text_index = 0;
    let mut other_index = 0;
    for (source_index, input) in inputs.into_iter().enumerate() {
        let is_text = input.selector_type == Some(SelectorType::Text);
        let index = if is_text {
            let index = text_index;
            text_index += 1;
            index
        } else {
            let index = other_index;
            other_index += 1;
            index
        };
        let mut candidate = match input.selector_type {
            Some(kind @ (SelectorType::Css | SelectorType::Attr | SelectorType::XPath)) => {
                let Some(value) = input.value else { continue };
                SelectorCandidate::new(kind, value)
            }
            Some(SelectorType::Text) => {
                let Some(value) = input.value else { continue };
                let mut candidate = SelectorCandidate::new(SelectorType::Text, value);
                candidate.text_match = input.text_match;
                candidate.tag_name_hint = input.tag_name_hint.or_else(|| tag_name.cloned());
                candidate
            }
            Some(SelectorType::Aria) => {
                let Some(name) = nonempty_trimmed(input.name) else {
                    continue;
                };
                let role = nonempty_trimmed(input.role);
                let mut value = role
                    .clone()
                    .unwrap_or_else(|| JsString::from("aria-label="));
                if role.is_some() {
                    value.push_str("[name=");
                }
                value.push_str(&name.json_string_literal());
                if role.is_some() {
                    value.push_str("]");
                }
                let mut candidate = SelectorCandidate::new(SelectorType::Aria, value);
                candidate.role = role;
                candidate.name = Some(name);
                candidate
            }
            _ => continue,
        };
        let user_weight = input
            .weight
            .filter(|value| value.is_finite())
            .unwrap_or(0.0);
        candidate.weight = Some((if is_text { 0.0 } else { 1000.0 }) + user_weight - index as f64);
        if first_css_or_attr.is_none()
            && matches!(
                candidate.selector_type,
                SelectorType::Css | SelectorType::Attr
            )
            && trim_js_string(&candidate.value).utf16_len() != 0
        {
            first_css_or_attr = Some(candidates.len());
        }
        candidates.push(ActionCandidatePlan {
            source_index: Some(source_index),
            candidate,
        });
    }
    if candidates.is_empty() {
        candidates.push(ActionCandidatePlan {
            source_index: None,
            candidate: SelectorCandidate::new(SelectorType::Css, JsString::from("")),
        });
    }
    ActionCandidateBatch {
        candidates,
        first_css_or_attr,
    }
}

fn nonempty_trimmed(value: Option<JsString>) -> Option<JsString> {
    value
        .map(|value| trim_js_string(&value))
        .filter(|value| value.utf16_len() != 0)
}

/// Applies the action host's finite-number floor and bounds, retaining signed zero.
#[must_use]
pub fn clamp_action_integer(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    if min.is_nan() || max.is_nan() {
        return f64::NAN;
    }
    let mut value = value.floor();
    if value < min || (value == 0.0 && min == 0.0 && min.is_sign_positive()) {
        value = min;
    }
    if value > max || (value == 0.0 && max == 0.0 && max.is_sign_negative()) {
        value = max;
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_candidates_consume_their_kind_position_but_not_the_css_fallback() {
        let batch = prepare_action_candidates(
            vec![
                ActionCandidateInput {
                    selector_type: Some(SelectorType::Css),
                    ..Default::default()
                },
                ActionCandidateInput {
                    selector_type: Some(SelectorType::Text),
                    value: Some("Save".into()),
                    ..Default::default()
                },
                ActionCandidateInput {
                    selector_type: Some(SelectorType::Css),
                    value: Some("  #save  ".into()),
                    weight: Some(f64::INFINITY),
                    ..Default::default()
                },
                ActionCandidateInput {
                    selector_type: Some(SelectorType::Text),
                    value: Some("Other".into()),
                    ..Default::default()
                },
            ],
            None,
        );
        assert_eq!(
            batch
                .candidates
                .iter()
                .map(|plan| plan.source_index)
                .collect::<Vec<_>>(),
            [Some(1), Some(2), Some(3)]
        );
        assert_eq!(
            batch
                .candidates
                .iter()
                .map(|plan| plan.candidate.weight)
                .collect::<Vec<_>>(),
            [Some(0.0), Some(999.0), Some(-1.0)]
        );
        assert_eq!(batch.first_css_or_attr, Some(1));
        assert_eq!(
            batch.candidates[1].candidate.value,
            JsString::from("  #save  ")
        );
    }

    #[test]
    fn aria_without_a_role_uses_its_label_and_blank_names_leave_the_empty_css_fallback() {
        let batch = prepare_action_candidates(
            vec![ActionCandidateInput {
                selector_type: Some(SelectorType::Aria),
                role: Some(" \t ".into()),
                name: Some(" Save \"now\" ".into()),
                ..Default::default()
            }],
            None,
        );
        assert_eq!(
            batch.candidates[0].candidate.value,
            JsString::from("aria-label=\"Save \\\"now\\\"\"")
        );
        assert_eq!(batch.candidates[0].candidate.role, None);
        let empty = prepare_action_candidates(
            vec![ActionCandidateInput {
                selector_type: Some(SelectorType::Aria),
                name: Some(" \n ".into()),
                ..Default::default()
            }],
            None,
        );
        assert_eq!(empty.candidates[0].source_index, None);
        assert_eq!(empty.candidates[0].candidate.value, JsString::from(""));
        assert_eq!(empty.first_css_or_attr, None);
    }

    #[test]
    fn integer_bounds_preserve_nonfinite_default_inverted_limits_and_signed_zero() {
        assert_eq!(clamp_action_integer(f64::NAN, 3.0, 8.0), 3.0);
        assert_eq!(clamp_action_integer(4.9, 0.0, 8.0), 4.0);
        assert_eq!(clamp_action_integer(4.0, 9.0, 2.0), 2.0);
        assert!(clamp_action_integer(-0.0, 0.0, 1.0).is_sign_positive());
        assert!(clamp_action_integer(0.0, -1.0, -0.0).is_sign_negative());
        assert!(clamp_action_integer(1.0, f64::NAN, 3.0).is_nan());
    }
}
