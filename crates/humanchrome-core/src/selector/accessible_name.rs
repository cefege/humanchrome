//! Accessible-name string policy after the host has inspected the DOM.

use std::borrow::Cow;

use crate::arguments::JsString;

use super::is_js_whitespace;

/// String matching requested by role/label/placeholder/title/alt locators.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AccessibleNameMatchMode {
    /// Case-sensitive equality after whitespace normalization.
    Exact,
    /// Equality after the browser's native case conversion.
    InsensitiveExact,
    /// Substring matching after the browser's native case conversion.
    Contains,
}

/// Collapses ECMAScript whitespace, borrowing already-normalized names without allocation.
#[must_use]
pub fn normalize_accessible_name(value: &JsString) -> Cow<'_, JsString> {
    let mut previous_space = true;
    let mut needs_normalization = false;
    let mut any = false;
    for unit in value.utf16_units() {
        any = true;
        let space = is_js_whitespace(unit);
        if space && (unit != u16::from(b' ') || previous_space) {
            needs_normalization = true;
            break;
        }
        previous_space = space;
    }
    if !any || (!needs_normalization && !previous_space) {
        return Cow::Borrowed(value);
    }
    let mut output = Vec::with_capacity(value.utf16_len());
    let mut pending_space = false;
    for unit in value.utf16_units() {
        if is_js_whitespace(unit) {
            pending_space = true;
        } else {
            if pending_space && !output.is_empty() {
                output.push(u16::from(b' '));
            }
            output.push(unit);
            pending_space = false;
        }
    }
    Cow::Owned(JsString::from_utf16_units(output))
}

/// Matches normalized names while delegating Unicode case conversion to the JavaScript host.
#[must_use]
pub fn matches_accessible_name(
    computed: &JsString,
    target: &JsString,
    mode: AccessibleNameMatchMode,
    mut lowercase: impl FnMut(&JsString) -> JsString,
) -> bool {
    let computed = normalize_accessible_name(computed);
    let target = normalize_accessible_name(target);
    if computed.utf16_units().next().is_none() || target.utf16_units().next().is_none() {
        return false;
    }
    if mode == AccessibleNameMatchMode::Exact {
        return computed == target;
    }
    let computed = lowercase(&computed);
    let target = lowercase(&target);
    if mode == AccessibleNameMatchMode::InsensitiveExact {
        return computed == target;
    }
    match (computed.as_utf8(), target.as_utf8()) {
        (Some(computed), Some(target)) => computed.contains(target),
        _ => {
            let computed = computed.utf16_units().collect::<Vec<_>>();
            let target = target.utf16_units().collect::<Vec<_>>();
            computed.windows(target.len()).any(|part| part == target)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_names_borrow_and_exact_matching_does_not_case_fold() {
        let name = JsString::from("Save file");
        assert!(matches!(normalize_accessible_name(&name), Cow::Borrowed(_)));
        assert!(matches_accessible_name(
            &JsString::from(" \tSave\nfile\u{feff}"),
            &name,
            AccessibleNameMatchMode::Exact,
            |_| panic!("exact matching must not invoke lowercase")
        ));
        assert!(!matches_accessible_name(
            &name,
            &JsString::from("save file"),
            AccessibleNameMatchMode::Exact,
            |_| panic!("exact matching must not invoke lowercase")
        ));
    }

    #[test]
    fn empty_normalized_queries_never_match_and_surrogates_remain_lossless() {
        assert!(!matches_accessible_name(
            &JsString::from("Save"),
            &JsString::from(" \n "),
            AccessibleNameMatchMode::Contains,
            Clone::clone
        ));
        let surrogate = JsString::from_utf16_units(vec![0xd800]);
        let name = JsString::from_utf16_units(vec![b' ' as u16, 0xd800, b' ' as u16]);
        assert!(matches_accessible_name(
            &name,
            &surrogate,
            AccessibleNameMatchMode::Contains,
            Clone::clone
        ));
    }
}
