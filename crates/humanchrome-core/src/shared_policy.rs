//! Portable shared argument, catalog-adjacent, sanitization, and encoding policy.
//!
//! JavaScript hosts retain opaque values and intrinsic serialization. This module owns the
//! decisions that can be made over lossless JavaScript strings and plain metadata.

use crate::arguments::JsString;

/// The default cap used by the JavaScript execution output sanitizer.
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 50 * 1024;
/// The default recursion depth used by the JavaScript execution output sanitizer.
pub const DEFAULT_MAX_DEPTH: usize = 6;
/// The default array-entry cap used by the JavaScript execution output sanitizer.
pub const DEFAULT_MAX_ARRAY_LENGTH: usize = 200;
/// The default object-key cap used by the JavaScript execution output sanitizer.
pub const DEFAULT_MAX_OBJECT_KEYS: usize = 200;
/// The default string-length cap used by the JavaScript execution output sanitizer.
pub const DEFAULT_MAX_STRING_LENGTH: usize = 10_000;

/// Marker fragments whose matching object values are redacted by the host walker.
pub const SENSITIVE_KEY_MARKERS: &[&str] = &[
    "cookie",
    "setcookie",
    "authorization",
    "proxyauthorization",
    "bearer",
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "password",
    "passwd",
    "pwd",
    "secret",
    "clientsecret",
    "apikey",
    "session",
    "sessionid",
    "sid",
    "csrf",
    "xsrf",
    "credential",
    "privatekey",
    "accesskey",
    "auth",
    "oauth",
];

/// A UTF-16-safe truncation plan for formatted sanitizer output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputTextTruncation {
    /// The original TextEncoder byte size.
    pub original_bytes: usize,
    /// The unchanged text when no truncation occurs, otherwise the fitting prefix.
    pub prefix: JsString,
    /// Whether the caller must append the returned footer.
    pub truncated: bool,
}

/// Normalizes a user-provided positive integer with the historical fallback behavior.
#[must_use]
pub fn normalize_positive_int(value: f64, fallback: usize) -> usize {
    if !value.is_finite() {
        return fallback;
    }
    let floored = value.floor();
    if floored <= 1.0 {
        1
    } else if floored >= usize::MAX as f64 {
        usize::MAX
    } else {
        floored as usize
    }
}

/// Returns the TextEncoder-compatible UTF-8 byte count for a JavaScript string.
#[must_use]
pub fn utf8_byte_length(value: &JsString) -> usize {
    value.text_encoder_len()
}

/// Encodes a JavaScript string as UTF-8 base64, replacing lone surrogates like `TextEncoder`.
#[must_use]
pub fn utf8_to_base64(value: &JsString) -> String {
    let bytes = value.to_string_lossy().into_bytes();
    base64_encode(&bytes)
}

/// Limits a JavaScript string by UTF-16 code units, retaining a lone-surrogate boundary.
#[must_use]
pub fn limit_string_units(value: &JsString, max_units: usize) -> Option<(JsString, usize)> {
    let length = value.utf16_len();
    (length > max_units).then(|| (value.slice_to(max_units), length - max_units))
}

/// Plans the existing sanitizer footer truncation without replacing JavaScript strings.
#[must_use]
pub fn truncate_output_text(value: &JsString, max_bytes: usize) -> OutputTextTruncation {
    let original_bytes = value.text_encoder_len();
    if original_bytes <= max_bytes {
        return OutputTextTruncation {
            original_bytes,
            prefix: value.clone(),
            truncated: false,
        };
    }

    let footer = format!("\n... [truncated to {max_bytes} bytes; original {original_bytes} bytes]");
    let budget = max_bytes.saturating_sub(footer.len());
    OutputTextTruncation {
        original_bytes,
        prefix: value.clone().into_text_encoder_prefix(budget),
        truncated: true,
    }
}

/// Normalizes a key using the sanitizer's lowercase ASCII-alphanumeric projection.
#[must_use]
pub fn normalize_sensitive_key(key: &str) -> String {
    key.to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

/// Filters next-tool hints in first-seen order, dropping empty names and duplicates.
#[must_use]
pub fn suggested_next(hints: impl IntoIterator<Item = String>, limit: usize) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }
    let mut output = Vec::with_capacity(limit);
    for hint in hints {
        if hint.is_empty() || output.contains(&hint) {
            continue;
        }
        output.push(hint);
        if output.len() >= limit {
            break;
        }
    }
    output
}

/// Returns whether an object key requires redaction when raw output is disabled.
#[must_use]
pub fn is_sensitive_key(key: &str) -> bool {
    let normalized = normalize_sensitive_key(key);
    SENSITIVE_KEY_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0b11) << 4) | (second >> 4)) as usize] as char);
        match chunk.len() {
            1 => output.push_str("=="),
            2 => {
                output.push(ALPHABET[((second & 0b1111) << 2) as usize] as char);
                output.push('=');
            }
            _ => {
                output.push(ALPHABET[(((second & 0b1111) << 2) | (third >> 6)) as usize] as char);
                output.push(ALPHABET[(third & 0b11_1111) as usize] as char);
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{limit_string_units, truncate_output_text, utf8_to_base64};
    use crate::arguments::JsString;

    #[test]
    fn base64_uses_text_encoder_lone_surrogate_replacement() {
        let value = JsString::from_utf16_units(vec![0xD800]);
        assert_eq!(utf8_to_base64(&value), "77+9");
    }

    #[test]
    fn output_truncation_keeps_a_utf16_boundary() {
        let value = JsString::from_utf16_units(vec![u16::from(b'a'), 0xD83D, 0xDE00]);
        let (prefix, omitted) = limit_string_units(&value, 2).expect("text exceeds unit cap");
        assert_eq!(prefix.into_utf16_units(), vec![u16::from(b'a'), 0xD83D]);
        assert_eq!(omitted, 1);
        assert!(truncate_output_text(&value, 1).truncated);
    }
}
