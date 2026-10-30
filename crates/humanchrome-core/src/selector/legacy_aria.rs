//! The recorder's legacy, deliberately narrow ARIA-to-CSS fallback grammar.

use super::is_js_whitespace;
use crate::arguments::JsString;

/// Parses the original ASCII-role/name grammar and preserves JSON-string quoting of JS code units.
#[must_use]
pub fn legacy_aria_selectors(value: JsString) -> Vec<JsString> {
    let units = value.into_utf16_units();
    let mut index = 0;
    while units
        .get(index)
        .is_some_and(|unit| matches!(*unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f))
    {
        index += 1;
    }
    if index == 0 {
        return Vec::new();
    }
    let role_end = index;
    let skip_space = |index: &mut usize| {
        while units
            .get(*index)
            .is_some_and(|&unit| is_js_whitespace(unit))
        {
            *index += 1;
        }
    };
    skip_space(&mut index);
    if units.get(index) != Some(&0x5b) {
        return Vec::new();
    }
    index += 1;
    skip_space(&mut index);
    if units.get(index..index + 4) != Some(&[0x6e, 0x61, 0x6d, 0x65]) {
        return Vec::new();
    }
    index += 4;
    skip_space(&mut index);
    if units.get(index) != Some(&0x3d) {
        return Vec::new();
    }
    index += 1;
    let Some(close_offset) = units[index..].iter().position(|&unit| unit == 0x5d) else {
        return Vec::new();
    };
    let close = index + close_offset;
    if close + 1 != units.len() || index == close {
        return Vec::new();
    }
    // The old greedy \s* backtracks one unit when the entire nonempty name is whitespace.
    while index + 1 < close && is_js_whitespace(units[index]) {
        index += 1;
    }
    let mut name = &units[index..close];
    if name.first().is_some_and(|unit| matches!(unit, 0x22 | 0x27)) {
        name = &name[1..];
    }
    if name.last().is_some_and(|unit| matches!(unit, 0x22 | 0x27)) {
        name = &name[..name.len() - 1];
    }
    let name = JsString::from_utf16_units(name.to_vec()).json_string_literal();
    let role: String = units[..role_end]
        .iter()
        .map(|&unit| char::from(unit as u8))
        .collect();
    let selectors = match role.as_str() {
        "textbox" => vec![
            format!("[role=\"textbox\"][aria-label={name}]"),
            format!("input[aria-label={name}]"),
            format!("textarea[aria-label={name}]"),
        ],
        "button" => vec![
            format!("[role=\"button\"][aria-label={name}]"),
            format!("button[aria-label={name}]"),
        ],
        "link" => vec![
            format!("[role=\"link\"][aria-label={name}]"),
            format!("a[aria-label={name}]"),
        ],
        _ => vec![format!(
            "[role={}][aria-label={name}]",
            crate::json::quote(&role)
        )],
    };
    selectors
        .into_iter()
        .map(JsString::from_owned_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::legacy_aria_selectors;
    use crate::arguments::JsString;

    #[test]
    fn legacy_roles_keep_their_original_query_order_and_quoting() {
        let queries = legacy_aria_selectors(JsString::from_string("textbox[name='User']"));
        assert_eq!(
            queries
                .iter()
                .map(JsString::to_string_lossy)
                .collect::<Vec<_>>(),
            [
                "[role=\"textbox\"][aria-label=\"User\"]",
                "input[aria-label=\"User\"]",
                "textarea[aria-label=\"User\"]",
            ]
        );
        assert!(legacy_aria_selectors(JsString::from_string("button[name=]")).is_empty());
        assert!(legacy_aria_selectors(JsString::from_string("按钮[name=x]")).is_empty());
        assert_eq!(
            legacy_aria_selectors(JsString::from_string("button[name= ]"))[0].to_string_lossy(),
            "[role=\"button\"][aria-label=\" \"]"
        );
    }
}
