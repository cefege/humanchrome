//! CSS cascade winner selection over host-collected declaration metadata.

use std::cmp::Ordering;

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};

/// Only declaration ranking metadata crosses the boundary; DOM/rule/value objects stay in JS.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CascadeRank {
    pub important: bool,
    pub specificity: [f64; 4],
    pub source_order: [f64; 3],
}

#[derive(Deserialize)]
pub struct CascadeCandidate {
    pub id: String,
    pub affects: Vec<String>,
    #[serde(flatten)]
    pub rank: CascadeRank,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CascadePlan<'a> {
    pub winners: Vec<(&'a str, usize)>,
    pub active_ids: Vec<&'a str>,
}

/// Preserves JS's comparison order, including its non-finite-number behavior.
#[must_use]
pub fn compare_order<const N: usize>(left: &[f64; N], right: &[f64; N]) -> i32 {
    for (&left, &right) in left.iter().zip(right) {
        if left != right {
            return if left > right { 1 } else { -1 };
        }
    }
    0
}

/// Compares importance, specificity, then the stylesheet/rule/declaration source order.
#[must_use]
pub fn compare_cascade(left: &CascadeRank, right: &CascadeRank) -> i32 {
    match left.important.cmp(&right.important) {
        Ordering::Greater => 1,
        Ordering::Less => -1,
        Ordering::Equal => {
            let specificity = compare_order(&left.specificity, &right.specificity);
            if specificity != 0 {
                specificity
            } else {
                compare_order(&left.source_order, &right.source_order)
            }
        }
    }
}

/// Selects each longhand winner in one batch, retaining first-candidate ties and map insertion order.
#[must_use]
pub fn cascade_overrides(candidates: &[CascadeCandidate]) -> CascadePlan<'_> {
    let mut winners: IndexMap<&str, usize> = IndexMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        for longhand in &candidate.affects {
            let replace = winners.get(longhand.as_str()).is_none_or(|&current| {
                compare_cascade(&candidate.rank, &candidates[current].rank) > 0
            });
            if replace {
                winners.insert(longhand, index);
            }
        }
    }
    let active_ids: IndexSet<&str> = winners
        .values()
        .map(|&index| candidates[index].id.as_str())
        .collect();
    CascadePlan {
        winners: winners.into_iter().collect(),
        active_ids: active_ids.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, important: bool, order: f64, affects: &[&str]) -> CascadeCandidate {
        CascadeCandidate {
            id: id.into(),
            affects: affects.iter().map(|value| (*value).into()).collect(),
            rank: CascadeRank {
                important,
                specificity: [0.0; 4],
                source_order: [0.0, 0.0, order],
            },
        }
    }

    #[test]
    fn shorthand_can_win_one_longhand_while_importance_and_first_ties_select_others() {
        let candidates = [
            candidate("shorthand", false, 1.0, &["margin-top", "margin-right"]),
            candidate("important", true, 0.0, &["margin-top"]),
            candidate("equal-later-candidate", false, 1.0, &["margin-right"]),
        ];
        let plan = cascade_overrides(&candidates);
        assert_eq!(plan.winners, [("margin-top", 1), ("margin-right", 0)]);
        assert_eq!(plan.active_ids, ["important", "shorthand"]);
    }
}
