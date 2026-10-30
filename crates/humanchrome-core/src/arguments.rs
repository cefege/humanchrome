//! INVALID_ARGS detail construction and typo suggestions.

use std::fmt::Write;

use serde_json::{Map, Value};

const MAX_RECEIVED_UTF16_UNITS: usize = 200;

/// A JavaScript string represented as UTF-16 code units.
///
/// Rust strings cannot represent an unpaired surrogate, while JavaScript string
/// slicing can create one. This type keeps that observable edge intact until
/// the value is emitted as JSON text.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct JsString {
    storage: JsStringStorage,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum JsStringStorage {
    Utf8(String),
    Utf16(Vec<u16>),
}

#[derive(Clone)]
enum Utf16Units<'a> {
    Utf8(std::str::EncodeUtf16<'a>),
    Utf16(std::iter::Copied<std::slice::Iter<'a, u16>>),
}

impl Iterator for Utf16Units<'_> {
    type Item = u16;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Utf8(units) => units.next(),
            Self::Utf16(units) => units.next(),
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        match self {
            Self::Utf8(units) => units.size_hint(),
            Self::Utf16(units) => units.size_hint(),
        }
    }
}

impl JsString {
    /// Takes ownership of valid Rust text without expanding it to UTF-16.
    #[must_use]
    pub fn from_owned_string(value: String) -> Self {
        Self {
            storage: JsStringStorage::Utf8(value),
        }
    }

    /// Converts valid Rust text without first expanding it to UTF-16.
    #[must_use]
    pub fn from_string(value: &str) -> Self {
        Self::from_owned_string(value.to_owned())
    }

    /// Parses a JSON string literal without replacing unpaired surrogate escapes.
    ///
    /// # Errors
    ///
    /// Returns an error when `literal` is not one JSON string literal.
    pub fn from_json_string_literal(literal: &str) -> Result<Self, JsonStringError> {
        let bytes = literal.as_bytes();
        if bytes.len() < 2 || bytes.first() != Some(&b'"') || bytes.last() != Some(&b'"') {
            return Err(JsonStringError);
        }

        let mut units = Vec::with_capacity(literal.len());
        let mut index = 1;
        let end = bytes.len() - 1;
        while index < end {
            match bytes[index] {
                b'"' | 0..=0x1f => return Err(JsonStringError),
                b'\\' => {
                    index += 1;
                    let Some(&escape) = bytes.get(index) else {
                        return Err(JsonStringError);
                    };
                    match escape {
                        b'"' => units.push(u16::from(b'"')),
                        b'\\' => units.push(u16::from(b'\\')),
                        b'/' => units.push(u16::from(b'/')),
                        b'b' => units.push(0x0008),
                        b'f' => units.push(0x000c),
                        b'n' => units.push(0x000a),
                        b'r' => units.push(0x000d),
                        b't' => units.push(0x0009),
                        b'u' => {
                            let digits = bytes.get(index + 1..index + 5).ok_or(JsonStringError)?;
                            let mut unit = 0_u16;
                            for &digit in digits {
                                unit = (unit << 4) | hex_digit(digit).ok_or(JsonStringError)?;
                            }
                            units.push(unit);
                            index += 4;
                        }
                        _ => return Err(JsonStringError),
                    }
                    index += 1;
                }
                byte if byte < 0x80 => {
                    units.push(u16::from(byte));
                    index += 1;
                }
                _ => {
                    let rest = literal.get(index..end).ok_or(JsonStringError)?;
                    let Some(character) = rest.chars().next() else {
                        return Err(JsonStringError);
                    };
                    let mut encoded = [0_u16; 2];
                    units.extend_from_slice(character.encode_utf16(&mut encoded));
                    index += character.len_utf8();
                }
            }
        }
        Ok(Self::from_utf16_units(units))
    }

    /// Returns the number of JavaScript UTF-16 code units in this string.
    #[must_use]
    pub fn utf16_len(&self) -> usize {
        match &self.storage {
            JsStringStorage::Utf8(value) => value.chars().map(char::len_utf16).sum(),
            JsStringStorage::Utf16(units) => units.len(),
        }
    }

    /// Returns a JavaScript `slice(0, end)` equivalent.
    #[must_use]
    pub fn slice_to(&self, end: usize) -> Self {
        let units = match &self.storage {
            JsStringStorage::Utf8(value) => utf16_prefix(value, end),
            JsStringStorage::Utf16(units) => units[..end.min(units.len())].to_vec(),
        };
        Self::from_utf16_units(units)
    }

    /// Appends a valid Rust string as JavaScript UTF-16 code units.
    pub fn push_str(&mut self, value: &str) {
        match &mut self.storage {
            JsStringStorage::Utf8(text) => text.push_str(value),
            JsStringStorage::Utf16(units) => units.extend(value.encode_utf16()),
        }
        self.normalize_utf16_storage();
    }

    /// Produces JSON string text, escaping every unpaired surrogate explicitly.
    #[must_use]
    pub fn json_string_literal(&self) -> String {
        match &self.storage {
            JsStringStorage::Utf8(value) => crate::json::quote(value),
            JsStringStorage::Utf16(units) => json_string_from_utf16(units),
        }
    }

    /// Returns the browser TextEncoder byte length without allocating encoded bytes.
    #[must_use]
    pub fn text_encoder_len(&self) -> usize {
        match &self.storage {
            JsStringStorage::Utf8(value) => value.len(),
            JsStringStorage::Utf16(units) => text_encoder_len_utf16(units),
        }
    }

    /// Consumes the string and retains the longest UTF-16 prefix fitting TextEncoder's byte cap.
    #[must_use]
    pub fn into_text_encoder_prefix(self, max_bytes: usize) -> Self {
        match self.storage {
            JsStringStorage::Utf8(mut value) => {
                let mut end = 0;
                let mut unit_count = 0;
                for (index, character) in value.char_indices() {
                    let next = index + character.len_utf8();
                    if next <= max_bytes {
                        end = next;
                        unit_count += character.len_utf16();
                        continue;
                    }
                    if character.len_utf16() == 2 && index + 3 <= max_bytes {
                        let mut units = Vec::with_capacity(unit_count + 1);
                        units.extend(value[..index].encode_utf16());
                        let mut pair = [0; 2];
                        units.push(character.encode_utf16(&mut pair)[0]);
                        return Self::from_utf16_units(units);
                    }
                    break;
                }
                value.truncate(end);
                Self::from_owned_string(value)
            }
            JsStringStorage::Utf16(mut units) => {
                let mut bytes = 0;
                let mut end = 0;
                let mut previous_high = false;
                for (index, &unit) in units.iter().enumerate() {
                    let cost = match unit {
                        0xdc00..=0xdfff if previous_high => 1,
                        0..=0x7f => 1,
                        0x80..=0x7ff => 2,
                        _ => 3,
                    };
                    if bytes + cost > max_bytes {
                        break;
                    }
                    bytes += cost;
                    end = index + 1;
                    previous_high = matches!(unit, 0xd800..=0xdbff);
                }
                units.truncate(end);
                Self::from_utf16_units(units)
            }
        }
    }

    /// Converts to Rust text when the units contain no unpaired surrogate.
    #[must_use]
    pub fn to_string_if_well_formed(&self) -> Option<String> {
        match &self.storage {
            JsStringStorage::Utf8(value) => Some(value.clone()),
            JsStringStorage::Utf16(units) => String::from_utf16(units).ok(),
        }
    }

    /// Borrows the UTF-8 representation when this string has no unpaired surrogate.
    #[must_use]
    pub fn as_utf8(&self) -> Option<&str> {
        match &self.storage {
            JsStringStorage::Utf8(value) => Some(value),
            JsStringStorage::Utf16(_) => None,
        }
    }

    /// Consumes this string when it can be represented by Rust UTF-8.
    #[must_use]
    pub fn into_string_if_well_formed(self) -> Option<String> {
        match self.storage {
            JsStringStorage::Utf8(value) => Some(value),
            JsStringStorage::Utf16(units) => String::from_utf16(&units).ok(),
        }
    }

    /// Iterates the original JavaScript code units without allocating or replacing surrogates.
    pub fn utf16_units(&self) -> impl Iterator<Item = u16> + Clone + '_ {
        match &self.storage {
            JsStringStorage::Utf8(value) => Utf16Units::Utf8(value.encode_utf16()),
            JsStringStorage::Utf16(units) => Utf16Units::Utf16(units.iter().copied()),
        }
    }

    /// Consumes this string, reusing existing UTF-16 storage when present.
    #[must_use]
    pub fn into_utf16_units(self) -> Vec<u16> {
        match self.storage {
            JsStringStorage::Utf8(text) => text.encode_utf16().collect(),
            JsStringStorage::Utf16(units) => units,
        }
    }

    pub(crate) fn into_utf8_or_self(self) -> Result<String, Self> {
        match self.storage {
            JsStringStorage::Utf8(value) => Ok(value),
            storage @ JsStringStorage::Utf16(_) => Err(Self { storage }),
        }
    }

    /// Produces Rust text with replacement characters for unpaired surrogates.
    ///
    /// This is appropriate only for diagnostics or lossy validation projections.
    #[must_use]
    pub fn to_string_lossy(&self) -> String {
        match &self.storage {
            JsStringStorage::Utf8(value) => value.clone(),
            JsStringStorage::Utf16(units) => String::from_utf16_lossy(units),
        }
    }

    /// Appends another JavaScript string without losing its UTF-16 units.
    pub fn push_js_string(&mut self, value: &Self) {
        if matches!(&self.storage, JsStringStorage::Utf8(_))
            && matches!(&value.storage, JsStringStorage::Utf16(_))
        {
            let JsStringStorage::Utf8(existing) =
                std::mem::replace(&mut self.storage, JsStringStorage::Utf16(Vec::new()))
            else {
                unreachable!("storage was checked as UTF-8");
            };
            let mut units: Vec<u16> = existing.encode_utf16().collect();
            if let JsStringStorage::Utf16(other) = &value.storage {
                units.extend_from_slice(other);
            }
            self.storage = JsStringStorage::Utf16(units);
            self.normalize_utf16_storage();
            return;
        }

        match (&mut self.storage, &value.storage) {
            (JsStringStorage::Utf8(existing), JsStringStorage::Utf8(other)) => {
                existing.push_str(other);
            }
            (JsStringStorage::Utf16(existing), JsStringStorage::Utf8(other)) => {
                existing.extend(other.encode_utf16());
            }
            (JsStringStorage::Utf16(existing), JsStringStorage::Utf16(other)) => {
                existing.extend_from_slice(other);
            }
            (JsStringStorage::Utf8(_), JsStringStorage::Utf16(_)) => {
                unreachable!("UTF-8 storage was converted above");
            }
        }
        self.normalize_utf16_storage();
    }

    /// Takes ownership of JavaScript code units, retaining every unpaired surrogate.
    #[must_use]
    pub fn from_utf16_units(units: Vec<u16>) -> Self {
        match String::from_utf16(&units) {
            Ok(value) => Self::from_owned_string(value),
            Err(_) => Self {
                storage: JsStringStorage::Utf16(units),
            },
        }
    }

    fn normalize_utf16_storage(&mut self) {
        let JsStringStorage::Utf16(units) = &self.storage else {
            return;
        };
        if let Ok(value) = String::from_utf16(units) {
            self.storage = JsStringStorage::Utf8(value);
        }
    }

    #[must_use]
    pub(crate) fn equals_str(&self, value: &str) -> bool {
        self.as_utf8() == Some(value)
    }

    fn lowercase_utf16(&self) -> Vec<u16> {
        match &self.storage {
            JsStringStorage::Utf8(value) => lowercase_utf16_str(value),
            JsStringStorage::Utf16(units) => {
                let mut lower = Vec::new();
                for decoded in char::decode_utf16(units.iter().copied()) {
                    match decoded {
                        Ok(character) => {
                            for lowercase in character.to_lowercase() {
                                let mut encoded = [0_u16; 2];
                                lower.extend_from_slice(lowercase.encode_utf16(&mut encoded));
                            }
                        }
                        Err(error) => lower.push(error.unpaired_surrogate()),
                    }
                }
                lower
            }
        }
    }
}

impl From<String> for JsString {
    fn from(value: String) -> Self {
        Self::from_owned_string(value)
    }
}

impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self::from_string(value)
    }
}

impl std::fmt::Display for JsString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.storage {
            JsStringStorage::Utf8(value) => formatter.write_str(value),
            JsStringStorage::Utf16(units) => formatter.write_str(&String::from_utf16_lossy(units)),
        }
    }
}

fn lowercase_utf16_str(value: &str) -> Vec<u16> {
    let mut lower = Vec::with_capacity(value.len());
    for character in value.chars() {
        for lowercase in character.to_lowercase() {
            let mut encoded = [0_u16; 2];
            lower.extend_from_slice(lowercase.encode_utf16(&mut encoded));
        }
    }
    lower
}

fn utf16_prefix(value: &str, end: usize) -> Vec<u16> {
    let mut units = Vec::with_capacity(end);
    for character in value.chars() {
        let mut encoded = [0_u16; 2];
        let encoded = character.encode_utf16(&mut encoded);
        let remaining = end.saturating_sub(units.len());
        if remaining == 0 {
            break;
        }
        units.extend_from_slice(&encoded[..remaining.min(encoded.len())]);
        if units.len() == end {
            break;
        }
    }
    units
}

fn json_string_from_utf16(units: &[u16]) -> String {
    let mut json = String::with_capacity(units.len() + 2);
    json.push('"');
    let mut index = 0;
    while let Some(&unit) = units.get(index) {
        match unit {
            0x0008 => json.push_str("\\b"),
            0x0009 => json.push_str("\\t"),
            0x000a => json.push_str("\\n"),
            0x000c => json.push_str("\\f"),
            0x000d => json.push_str("\\r"),
            0x0000..=0x001f => {
                let _ = write!(json, "\\u{unit:04x}");
            }
            0x0022 => json.push_str("\\\""),
            0x005c => json.push_str("\\\\"),
            0xd800..=0xdbff
                if units
                    .get(index + 1)
                    .is_some_and(|low| (0xdc00..=0xdfff).contains(low)) =>
            {
                let low = units[index + 1];
                let scalar =
                    0x1_0000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
                json.push(char::from_u32(scalar).expect("surrogate pair produces a scalar"));
                index += 1;
            }
            0xd800..=0xdfff => {
                let _ = write!(json, "\\u{unit:04x}");
            }
            _ => json.push(char::from_u32(u32::from(unit)).expect("non-surrogate u16 is scalar")),
        }
        index += 1;
    }
    json.push('"');
    json
}

fn text_encoder_len_utf16(units: &[u16]) -> usize {
    let mut bytes = 0;
    let mut index = 0;
    while let Some(&unit) = units.get(index) {
        let scalar = if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|low| (0xdc00..=0xdfff).contains(low))
        {
            index += 1;
            0x1_0000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(units[index]) - 0xdc00)
        } else if (0xd800..=0xdfff).contains(&unit) {
            0xfffd
        } else {
            u32::from(unit)
        };
        bytes += char::from_u32(scalar)
            .expect("valid scalar or replacement character")
            .len_utf8();
        index += 1;
    }
    bytes
}

/// The input was not a valid JSON string literal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JsonStringError;

impl std::fmt::Display for JsonStringError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("invalid JSON string literal")
    }
}

impl std::error::Error for JsonStringError {}

fn hex_digit(byte: u8) -> Option<u16> {
    match byte {
        b'0'..=b'9' => Some(u16::from(byte - b'0')),
        b'a'..=b'f' => Some(u16::from(byte - b'a' + 10)),
        b'A'..=b'F' => Some(u16::from(byte - b'A' + 10)),
        _ => None,
    }
}

/// An INVALID_ARGS `received` value that can retain JavaScript-only strings.
#[derive(Clone, Debug, PartialEq)]
pub enum ReceivedValue {
    /// A JSON value that serde_json can represent without loss.
    Value(Value),
    /// A string that may contain an unpaired surrogate after UTF-16 slicing.
    String(JsString),
}

impl ReceivedValue {
    fn append_json_text(&self, output: &mut String) {
        match self {
            Self::Value(value) => output.push_str(&crate::json::stringify(value)),
            Self::String(value) => output.push_str(&value.json_string_literal()),
        }
    }

    pub(crate) fn into_json_document(self) -> crate::json_document::JsonDocument {
        match self {
            Self::Value(value) => crate::json_document::JsonDocument::from(value),
            Self::String(value) => crate::json_document::JsonDocument::string(value),
        }
    }
}

/// Returns the closest candidate for a lossless JavaScript string, preserving candidate order
/// for ties.
///
/// Candidates are borrowed so callers can combine static and dynamic catalogs without copying
/// every name before ranking.
#[must_use]
pub fn did_you_mean_lossless<'candidate>(
    received: &JsString,
    candidates: impl IntoIterator<Item = &'candidate str>,
    max_distance: usize,
) -> Option<String> {
    did_you_mean_lowercase(received.lowercase_utf16(), candidates, max_distance)
}

/// Returns the closest candidate for valid Rust text, preserving candidate order for ties.
#[must_use]
pub(crate) fn did_you_mean_text<'candidate>(
    received: &str,
    candidates: impl IntoIterator<Item = &'candidate str>,
    max_distance: usize,
) -> Option<String> {
    did_you_mean_lowercase(lowercase_utf16_str(received), candidates, max_distance)
}

/// Returns the closest candidate within `max_distance`, preserving candidate order for ties.
#[must_use]
pub fn did_you_mean(
    received: &Value,
    candidates: &[String],
    max_distance: usize,
) -> Option<String> {
    let Value::String(received) = received else {
        return None;
    };
    did_you_mean_text(
        received,
        candidates.iter().map(String::as_str),
        max_distance,
    )
}

fn did_you_mean_lowercase<'candidate>(
    received: Vec<u16>,
    candidates: impl IntoIterator<Item = &'candidate str>,
    max_distance: usize,
) -> Option<String> {
    let mut best: Option<&str> = None;
    let mut best_distance = max_distance.saturating_add(1);
    for candidate in candidates {
        let lowercase = lowercase_utf16_str(candidate);
        let distance = edit_distance(&received, &lowercase, max_distance);
        if distance < best_distance {
            best_distance = distance;
            best = Some(candidate);
            if distance == 0 {
                break;
            }
        }
    }

    if best_distance <= max_distance {
        best.map(str::to_owned)
    } else {
        None
    }
}

fn edit_distance(left: &[u16], right: &[u16], max_distance: usize) -> usize {
    if left == right {
        return 0;
    }
    if left.len().abs_diff(right.len()) > max_distance {
        return max_distance.saturating_add(1);
    }
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }

    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0; right.len() + 1];
    for (left_index, left_unit) in left.iter().enumerate() {
        current[0] = left_index + 1;
        let mut row_min = current[0];
        for (right_index, right_unit) in right.iter().enumerate() {
            let cost = usize::from(left_unit != right_unit);
            current[right_index + 1] = (current[right_index] + 1)
                .min(previous[right_index + 1] + 1)
                .min(previous[right_index] + cost);
            row_min = row_min.min(current[right_index + 1]);
        }
        if row_min > max_distance {
            return max_distance.saturating_add(1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

/// Truncates a surfaced argument exactly as the TypeScript policy does.
#[must_use]
pub fn truncate_received(value: &Value) -> ReceivedValue {
    match value {
        Value::String(value) => truncate_received_utf8(value),
        Value::Null | Value::Bool(_) | Value::Number(_) => ReceivedValue::Value(value.clone()),
        Value::Array(_) | Value::Object(_) => {
            truncate_received_owned(crate::json::stringify(value))
        }
    }
}

/// Truncates a JavaScript string without replacing unpaired UTF-16 code units.
#[must_use]
pub fn truncate_received_lossless(value: &JsString) -> ReceivedValue {
    value.as_utf8().map_or_else(
        || truncate_received_string(value.clone()),
        truncate_received_utf8,
    )
}

/// Truncates a raw JSON string literal while retaining an unpaired surrogate boundary.
///
/// This is for process parsers that retained the original argument token as a
/// `RawValue`; ordinary callers should pass a [`Value`] to [`truncate_received`].
///
/// # Errors
///
/// Returns an error when `literal` is not a JSON string literal.
pub fn truncate_received_json_string_literal(
    literal: &str,
) -> Result<ReceivedValue, JsonStringError> {
    Ok(truncate_received_string(
        JsString::from_json_string_literal(literal)?,
    ))
}

fn truncate_received_utf8(value: &str) -> ReceivedValue {
    if !utf16_len_exceeds(value, MAX_RECEIVED_UTF16_UNITS) {
        return ReceivedValue::Value(Value::String(value.to_owned()));
    }
    let mut prefix = JsString::from_utf16_units(utf16_prefix(value, MAX_RECEIVED_UTF16_UNITS));
    prefix.push_str("…");
    ReceivedValue::String(prefix)
}

fn truncate_received_owned(value: String) -> ReceivedValue {
    if !utf16_len_exceeds(&value, MAX_RECEIVED_UTF16_UNITS) {
        return ReceivedValue::Value(Value::String(value));
    }
    truncate_received_utf8(&value)
}

fn utf16_len_exceeds(value: &str, limit: usize) -> bool {
    let mut length = 0;
    for character in value.chars() {
        length += character.len_utf16();
        if length > limit {
            return true;
        }
    }
    false
}

fn truncate_received_string(mut value: JsString) -> ReceivedValue {
    if value.utf16_len() > MAX_RECEIVED_UTF16_UNITS {
        value = value.slice_to(MAX_RECEIVED_UTF16_UNITS);
        value.push_str("…");
    }
    ReceivedValue::String(value)
}

/// Arguments used to build an INVALID_ARGS details object.
pub struct BuildInvalidArgsOptions<'a> {
    /// Name of the invalid argument.
    pub arg: &'a str,
    /// Omitted when the original JavaScript value was `undefined`.
    pub received: Option<&'a Value>,
    /// Explicit expected-value description, including explicit JSON null.
    pub expected: Option<&'a Value>,
    /// Overrides the generated typo hint when non-empty.
    pub hint: Option<&'a str>,
    /// Enum candidates that supply `expected` and an automatic hint.
    pub candidates: &'a [String],
    /// Fields assigned after the built-in fields, including overwrites.
    pub extra: Option<&'a Map<String, Value>>,
}

/// A serializable INVALID_ARGS detail object that preserves JavaScript string edges.
#[derive(Clone, Debug, PartialEq)]
pub struct InvalidArgsDetails {
    arg: String,
    received: Option<ReceivedValue>,
    expected: Option<Value>,
    hint: Option<String>,
    extra: Option<Map<String, Value>>,
}

impl InvalidArgsDetails {
    /// Returns JSON object text suitable for nesting inside a tool-error envelope.
    #[must_use]
    pub fn to_json_text(&self) -> String {
        let mut fields: Vec<(String, String)> =
            vec![("arg".to_owned(), crate::json::quote(&self.arg))];
        if let Some(received) = &self.received {
            let mut text = String::new();
            received.append_json_text(&mut text);
            assign_json_field(&mut fields, "received", text);
        }
        if let Some(expected) = &self.expected {
            assign_json_field(&mut fields, "expected", crate::json::stringify(expected));
        }
        if let Some(hint) = &self.hint {
            assign_json_field(&mut fields, "hint", crate::json::quote(hint));
        }
        if let Some(extra) = &self.extra {
            let base_fields = fields.len();
            for (key, value) in extra {
                let text = crate::json::stringify(value);
                if let Some((_, existing)) = fields[..base_fields]
                    .iter_mut()
                    .find(|(field, _)| field == key)
                {
                    *existing = text;
                } else {
                    fields.push((key.clone(), text));
                }
            }
        }

        // Stable sort moves only integer keys; other fields retain insertion order.
        fields.sort_by_key(|(key, _)| {
            crate::json::array_index(key).map_or((true, 0), |index| (false, index))
        });

        let mut output = String::from("{");
        for (index, (key, value)) in fields.into_iter().enumerate() {
            if index != 0 {
                output.push(',');
            }
            output.push_str(&crate::json::quote(&key));
            output.push(':');
            output.push_str(&value);
        }
        output.push('}');
        output
    }
}

impl crate::errors::JsonText for InvalidArgsDetails {
    fn append_json_text(&self, output: &mut String) {
        output.push_str(&self.to_json_text());
    }
}

/// Builds the self-correcting INVALID_ARGS details object.
#[must_use]
pub fn build_invalid_args_details(options: BuildInvalidArgsOptions<'_>) -> InvalidArgsDetails {
    let received = options.received.map(truncate_received);
    let mut hint = options.hint.map(str::to_owned);
    if hint.as_deref().is_none_or(str::is_empty)
        && !options.candidates.is_empty()
        && let Some(suggestion) = options
            .received
            .and_then(|received| did_you_mean(received, options.candidates, 2))
    {
        hint = Some(format!("Did you mean \"{suggestion}\"?"));
    }

    let expected = options.expected.cloned().or_else(|| {
        (!options.candidates.is_empty()).then(|| {
            Value::Object(Map::from_iter([(
                "enum".to_owned(),
                Value::Array(
                    options
                        .candidates
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            )]))
        })
    });

    InvalidArgsDetails {
        arg: options.arg.to_owned(),
        received,
        expected,
        hint,
        extra: options.extra.cloned(),
    }
}

/// Convenience constructor for enum-valued arguments.
#[must_use]
pub fn invalid_args_enum_details(
    arg: &str,
    received: Option<&Value>,
    candidates: &[String],
    extra: Option<&Map<String, Value>>,
) -> InvalidArgsDetails {
    build_invalid_args_details(BuildInvalidArgsOptions {
        arg,
        received,
        expected: None,
        hint: None,
        candidates,
        extra,
    })
}

fn assign_json_field(fields: &mut Vec<(String, String)>, key: &str, value: String) {
    if let Some((_, existing)) = fields.iter_mut().find(|(existing, _)| existing == key) {
        *existing = value;
    } else {
        fields.push((key.to_owned(), value));
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};

    use super::{
        BuildInvalidArgsOptions, JsString, build_invalid_args_details, did_you_mean,
        did_you_mean_lossless, truncate_received_json_string_literal,
    };

    #[test]
    fn suggests_first_closest_case_insensitively() {
        let candidates = vec!["Start".to_owned(), "status".to_owned(), "stop".to_owned()];
        assert_eq!(
            did_you_mean(&Value::String("start".to_owned()), &candidates, 2),
            Some("Start".to_owned())
        );
        assert_eq!(
            did_you_mean(&Value::String("xyz".to_owned()), &candidates, 2),
            None
        );
    }

    #[test]
    fn lossless_suggestions_do_not_treat_a_surrogate_as_a_replacement_character() {
        let received =
            JsString::from_json_string_literal(r#""\ud800""#).expect("valid JSON string");
        let candidates = ["a", "�"];

        assert_eq!(
            did_you_mean_lossless(&received, candidates.iter().copied(), 3),
            Some("a".to_owned())
        );
    }

    #[test]
    fn details_distinguish_omitted_from_explicit_null() {
        let none = build_invalid_args_details(BuildInvalidArgsOptions {
            arg: "mode",
            received: None,
            expected: None,
            hint: None,
            candidates: &[],
            extra: None,
        });
        let null = build_invalid_args_details(BuildInvalidArgsOptions {
            arg: "mode",
            received: Some(&Value::Null),
            expected: Some(&Value::Null),
            hint: None,
            candidates: &[],
            extra: None,
        });
        assert_eq!(none.to_json_text(), r#"{"arg":"mode"}"#);
        assert_eq!(
            null.to_json_text(),
            r#"{"arg":"mode","received":null,"expected":null}"#
        );
    }

    #[test]
    fn extra_fields_have_javascript_assignment_precedence() {
        let candidates = vec!["start".to_owned(), "stop".to_owned()];
        let extra = Map::from_iter([
            ("arg".to_owned(), json!("replacement")),
            ("hint".to_owned(), json!("extra wins")),
        ]);
        let detail = build_invalid_args_details(BuildInvalidArgsOptions {
            arg: "action",
            received: Some(&json!("strat")),
            expected: None,
            hint: None,
            candidates: &candidates,
            extra: Some(&extra),
        });
        assert_eq!(
            detail.to_json_text(),
            r#"{"arg":"replacement","received":"strat","expected":{"enum":["start","stop"]},"hint":"extra wins"}"#
        );
    }

    #[test]
    fn extra_integer_keys_follow_javascript_object_enumeration_order() {
        let extra = Map::from_iter([
            ("10".to_owned(), json!("ten")),
            ("2".to_owned(), json!("two")),
        ]);
        let detail = build_invalid_args_details(BuildInvalidArgsOptions {
            arg: "mode",
            received: None,
            expected: None,
            hint: None,
            candidates: &[],
            extra: Some(&extra),
        });
        assert_eq!(
            detail.to_json_text(),
            r#"{"2":"two","10":"ten","arg":"mode"}"#
        );
    }

    #[test]
    fn truncation_keeps_a_lone_surrogate_as_escaped_json_text() {
        let literal = format!("\"{}\\ud83d\\ude00\"", "x".repeat(199));
        let detail =
            truncate_received_json_string_literal(&literal).expect("valid raw JSON string");
        let mut output = String::new();
        detail.append_json_text(&mut output);
        assert_eq!(output, format!("\"{}\\ud83d…\"", "x".repeat(199)));
    }

    #[test]
    fn json_string_literal_retains_unpaired_surrogates() {
        let string = JsString::from_json_string_literal(r#""\ud800""#).expect("valid JSON literal");
        assert_eq!(string.json_string_literal(), r#""\ud800""#);
    }
}
