//! Stable client-id normalization for free-form session names.

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

const MAX_SESSION_NAME_UTF16_UNITS: usize = 64;

/// Normalizes a free-form session name into the stable client-id used for ownership.
///
/// Returns `None` for non-strings, empty values, reserved names, and synthetic
/// UI identifiers beginning with `__` after separator replacement and filtering.
#[must_use]
pub fn normalize_session_name(raw: &Value) -> Option<String> {
    let Value::String(raw) = raw else {
        return None;
    };

    let normalized: String = raw.nfc().collect();
    let lower = trim_ecmascript_whitespace(&normalized).to_lowercase();
    if lower.is_empty() {
        return None;
    }

    let mut replaced = String::with_capacity(lower.len());
    let mut previous_was_separator = false;
    for character in lower.chars() {
        if is_separator(character) {
            if !previous_was_separator {
                replaced.push('-');
            }
            previous_was_separator = true;
        } else {
            previous_was_separator = false;
            if character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '.' | '-')
            {
                replaced.push(character);
            }
        }
    }
    if replaced.starts_with("__") {
        return None;
    }

    let mut collapsed = String::with_capacity(replaced.len());
    let mut previous = '\0';
    for character in replaced.chars() {
        if matches!(character, '-' | '_' | '.') && character == previous {
            continue;
        }
        collapsed.push(character);
        previous = character;
    }
    let trimmed = collapsed.trim_matches(|character| matches!(character, '-' | '_' | '.'));
    if trimmed.is_empty() {
        return None;
    }

    // Filtering leaves only ASCII, so JavaScript UTF-16 length equals byte and
    // Rust character length. The final trim reproduces slice(...).replace().
    let capped = &trimmed[..trimmed.len().min(MAX_SESSION_NAME_UTF16_UNITS)];
    let capped = capped.trim_end_matches(['-', '_', '.']);
    if capped.is_empty() || matches!(capped, "default" | "null" | "undefined") {
        return None;
    }
    Some(capped.to_owned())
}

fn is_separator(character: char) -> bool {
    is_ecmascript_whitespace(character) || matches!(character, '/' | '\\' | ':')
}

fn trim_ecmascript_whitespace(value: &str) -> &str {
    value.trim_matches(is_ecmascript_whitespace)
}

fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::normalize_session_name;

    #[test]
    fn normalizes_separators_and_runs_before_trimming() {
        assert_eq!(
            normalize_session_name(&json!("  Foo bar/baz\\qux:zap  ")),
            Some("foo-bar-baz-qux-zap".to_owned())
        );
        assert_eq!(
            normalize_session_name(&json!("foo---bar___baz...qux")),
            Some("foo-bar_baz.qux".to_owned())
        );
    }

    #[test]
    fn rejects_synthetic_prefix_before_underscore_collapse() {
        assert_eq!(normalize_session_name(&json!("__ui:popup")), None);
        assert_eq!(normalize_session_name(&json!("__foo")), None);
    }

    #[test]
    fn uses_nfc_and_ecmascript_whitespace_rules() {
        assert_eq!(
            normalize_session_name(&json!("\u{feff} Cafe\u{301} \u{feff}")),
            normalize_session_name(&json!("Café"))
        );
    }

    #[test]
    fn caps_then_strips_a_trailing_separator() {
        let input = format!("{}-rest", "a".repeat(64));
        assert_eq!(normalize_session_name(&json!(input)), Some("a".repeat(64)));
    }

    #[test]
    fn rejects_empty_reserved_and_non_string_inputs() {
        for value in [
            json!(null),
            json!(42),
            json!("!@#$"),
            json!("NULL"),
            json!("undefined"),
        ] {
            assert_eq!(normalize_session_name(&value), None, "value {value}");
        }
    }
}
