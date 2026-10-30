//! JSON-in-text uses JavaScript number formatting and ordinary-object property ordering.

use serde::{
    Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};
use serde_json::ser::{Formatter, PrettyFormatter};
use serde_json::{Map, Value};
use std::io::{self, Write};

/// Serialize JSON data as `JSON.stringify` does for numbers and integer property keys.
///
/// String escaping remains owned by serde_json; this does not evaluate JavaScript.
#[must_use]
pub fn stringify(value: &Value) -> String {
    let mut bytes = Vec::new();
    write(&mut bytes, value).expect("JSON values serialize without unsupported types");
    String::from_utf8(bytes).expect("JSON serialization writes valid UTF-8")
}

/// Quote a borrowed string without first copying it into a JSON value.
#[must_use]
pub fn quote(value: &str) -> String {
    serde_json::to_string(value).expect("strings always serialize as JSON")
}

/// Serialize borrowed object fields with the same JavaScript property ordering.
#[must_use]
pub fn stringify_object(fields: &Map<String, Value>) -> String {
    let mut bytes = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, JsFormatter);
    JsObject(fields)
        .serialize(&mut serializer)
        .expect("JSON object values serialize");
    String::from_utf8(bytes).expect("JSON serialization writes valid UTF-8")
}

/// Encode `JSON.stringify(value, null, 2)` without cloning or rewriting the value.
#[must_use]
pub fn to_vec_pretty(value: &Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(
        &mut bytes,
        JsPrettyFormatter(PrettyFormatter::new()),
    );
    JsValue(value)
        .serialize(&mut serializer)
        .expect("JSON values serialize");
    bytes
}

/// Write JavaScript-compatible JSON directly into a caller-owned byte buffer.
///
/// # Errors
/// Reports errors from the writer without allocating an intermediate JSON string.
pub fn write<W: Write>(writer: W, value: &Value) -> serde_json::Result<()> {
    let mut serializer = serde_json::Serializer::with_formatter(writer, JsFormatter);
    JsValue(value).serialize(&mut serializer)
}

pub(crate) struct JsValue<'a>(pub(crate) &'a Value);

impl Serialize for JsValue<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Null => serializer.serialize_unit(),
            Value::Bool(value) => serializer.serialize_bool(*value),
            Value::Number(value) => serializer.serialize_f64(
                value
                    .as_f64()
                    .expect("JSON number fits a JavaScript number"),
            ),
            Value::String(value) => serializer.serialize_str(value),
            Value::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(&JsValue(value))?;
                }
                sequence.end()
            }
            Value::Object(fields) => JsObject(fields).serialize(serializer),
        }
    }
}

struct JsObject<'a>(&'a Map<String, Value>);

impl Serialize for JsObject<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = self.0;
        let mut map = serializer.serialize_map(Some(fields.len()))?;
        let mut seen_other = false;
        let mut previous_index = None;
        let already_ordered = fields.keys().all(|key| {
            if let Some(index) = array_index(key) {
                let ordered = !seen_other && previous_index.is_none_or(|previous| previous < index);
                previous_index = Some(index);
                ordered
            } else {
                seen_other = true;
                true
            }
        });
        if already_ordered {
            for (key, value) in fields {
                map.serialize_entry(key, &JsValue(value))?;
            }
        } else {
            let mut numeric: Vec<_> = fields
                .iter()
                .filter_map(|(key, value)| array_index(key).map(|index| (index, key, value)))
                .collect();
            numeric.sort_unstable_by_key(|(index, _, _)| *index);
            for (_, key, value) in numeric {
                map.serialize_entry(key, &JsValue(value))?;
            }
            for (key, value) in fields {
                if array_index(key).is_none() {
                    map.serialize_entry(key, &JsValue(value))?;
                }
            }
        }
        map.end()
    }
}

/// Returns the JavaScript own-property array index, excluding `2^32 - 1`.
#[must_use]
pub fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || key.len() > 10
        || key.len() > 1 && key.starts_with('0')
        || !key.as_bytes().iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

pub(crate) fn number_to_string(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

pub(crate) fn write_number<W: ?Sized + Write>(writer: &mut W, value: f64) -> io::Result<()> {
    writer.write_all(ryu_js::Buffer::new().format(value).as_bytes())
}

struct JsFormatter;
impl serde_json::ser::Formatter for JsFormatter {
    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        write_number(writer, value)
    }
}

// Serde owns indentation and escaping; the shared view owns property order
// and the compact formatter owns JavaScript number rendering in either layout.
struct JsPrettyFormatter(PrettyFormatter<'static>);

impl Formatter for JsPrettyFormatter {
    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        JsFormatter.write_f64(writer, value)
    }
    fn begin_array<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_array(writer)
    }
    fn end_array<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_array(writer)
    }
    fn begin_array_value<W: ?Sized + Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.0.begin_array_value(writer, first)
    }
    fn end_array_value<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_array_value(writer)
    }
    fn begin_object<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_object(writer)
    }
    fn end_object<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_object(writer)
    }
    fn begin_object_key<W: ?Sized + Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.0.begin_object_key(writer, first)
    }
    fn begin_object_value<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_object_value(writer)
    }
    fn end_object_value<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_object_value(writer)
    }
}

#[cfg(test)]
mod tests {
    use super::stringify;
    use serde_json::{Value, json};

    #[test]
    fn integer_float_negative_zero_and_exponents_keep_json_in_text_parity() {
        assert_eq!(
            stringify(&json!([1.0, -0.0, 1e-7, 1e-6, 1e20, 1e21])),
            "[1,0,1e-7,0.000001,100000000000000000000,1e+21]"
        );
        assert_eq!(
            stringify(&json!(9_007_199_254_740_993_u64)),
            "9007199254740992"
        );
    }

    #[test]
    fn numeric_object_keys_precede_insertion_ordered_other_keys() {
        let input: Value = serde_json::from_str(r#"{"tail":1,"10":"ten","2":"two","01":"leading","0":"zero","4294967295":"not-index","1":"one"}"#).expect("test input JSON");
        assert_eq!(
            stringify(&input),
            r#"{"0":"zero","1":"one","2":"two","10":"ten","tail":1,"01":"leading","4294967295":"not-index"}"#
        );
    }
}
