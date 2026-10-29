//! Lossless JSON documents for boundaries that can carry JavaScript-only UTF-16 strings.

use std::borrow::Cow;
use std::io::Write;

use indexmap::IndexMap;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer as _, Serialize, Serializer};
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value};

use crate::arguments::JsString;

/// A JSON document that retains escaped unpaired UTF-16 surrogates when necessary.
///
/// Ordinary JSON stays in serde's [`Value`] representation. A lossless tree is built only
/// when serde's normal value parser rejects an otherwise-valid JSON document.
#[derive(Clone, Debug, PartialEq)]
pub struct JsonDocument {
    storage: DocumentStorage,
}

#[derive(Clone, Debug, PartialEq)]
enum DocumentStorage {
    Normal(Value),
    Lossless(JsonNode),
}

#[derive(Clone, Debug, PartialEq)]
enum JsonNode {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsonNode>),
    Object(IndexMap<JsString, JsonNode>),
}

/// A borrowed JSON node inside a [`JsonDocument`].
#[derive(Clone, Copy, Debug)]
pub struct JsonRef<'a> {
    storage: JsonRefStorage<'a>,
}

#[derive(Clone, Copy, Debug)]
enum JsonRefStorage<'a> {
    Normal(&'a Value),
    Lossless(&'a JsonNode),
}

impl JsonDocument {
    /// Parses valid JSON, retaining escaped unpaired UTF-16 surrogates exactly.
    ///
    /// # Errors
    ///
    /// Returns serde's parse error when `input` is not JSON.
    pub fn parse(input: &str) -> Result<Self, serde_json::Error> {
        match serde_json::from_str::<Value>(input) {
            Ok(value) => Ok(Self::from(value)),
            Err(_) => {
                let raw: &RawValue = serde_json::from_str(input)?;
                Ok(Self {
                    storage: DocumentStorage::Lossless(parse_lossless_raw(raw)?),
                })
            }
        }
    }

    /// Builds a JSON string from JavaScript UTF-16 units.
    #[must_use]
    pub fn string(value: JsString) -> Self {
        match value.into_utf8_or_self() {
            Ok(value) => Self::from(value),
            Err(value) => Self {
                storage: DocumentStorage::Lossless(JsonNode::String(value)),
            },
        }
    }

    /// Builds an array, retaining lossless children without routing through [`Value`].
    #[must_use]
    pub fn array(values: impl IntoIterator<Item = Self>) -> Self {
        let mut values = values.into_iter();
        let mut normal = Vec::with_capacity(values.size_hint().0);
        while let Some(value) = values.next() {
            match value.into_value() {
                Ok(value) => normal.push(value),
                Err(value) => {
                    let mut lossless = Vec::with_capacity(normal.len() + 1 + values.size_hint().0);
                    lossless.extend(normal.into_iter().map(node_from_value));
                    lossless.push(value.into_node());
                    lossless.extend(values.map(Self::into_node));
                    return Self {
                        storage: DocumentStorage::Lossless(JsonNode::Array(lossless)),
                    };
                }
            }
        }
        Self::from(Value::Array(normal))
    }

    /// Builds an object, owning field names while retaining lossless children.
    #[must_use]
    pub fn object<'a>(fields: impl IntoIterator<Item = (&'a str, Self)>) -> Self {
        let mut fields = fields.into_iter();
        let mut normal = Map::with_capacity(fields.size_hint().0);
        while let Some((key, value)) = fields.next() {
            match value.into_value() {
                Ok(value) => {
                    normal.insert(key.to_owned(), value);
                }
                Err(value) => {
                    let mut lossless =
                        IndexMap::with_capacity(normal.len() + 1 + fields.size_hint().0);
                    lossless.extend(normal.into_iter().map(|(key, value)| {
                        (JsString::from_owned_string(key), node_from_value(value))
                    }));
                    lossless.insert(JsString::from(key), value.into_node());
                    lossless.extend(
                        fields.map(|(key, value)| (JsString::from(key), value.into_node())),
                    );
                    return Self {
                        storage: DocumentStorage::Lossless(JsonNode::Object(lossless)),
                    };
                }
            }
        }
        Self::from(Value::Object(normal))
    }

    /// Builds an object from JavaScript UTF-16 keys and lossless values.
    /// Ordinary UTF-8 objects retain the efficient serde representation.
    #[must_use]
    pub fn object_lossless(fields: impl IntoIterator<Item = (JsString, Self)>) -> Self {
        let mut fields = fields.into_iter();
        let mut normal = Map::with_capacity(fields.size_hint().0);
        while let Some((key, value)) = fields.next() {
            match (key.into_utf8_or_self(), value.into_value()) {
                (Ok(key), Ok(value)) => {
                    normal.insert(key, value);
                }
                (key, value) => {
                    let mut lossless =
                        IndexMap::with_capacity(normal.len() + 1 + fields.size_hint().0);
                    lossless.extend(normal.into_iter().map(|(key, value)| {
                        (JsString::from_owned_string(key), node_from_value(value))
                    }));
                    let key = match key {
                        Ok(key) => JsString::from_owned_string(key),
                        Err(key) => key,
                    };
                    let value = match value {
                        Ok(value) => node_from_value(value),
                        Err(value) => value.into_node(),
                    };
                    lossless.insert(key, value);
                    lossless.extend(fields.map(|(key, value)| (key, value.into_node())));
                    return Self {
                        storage: DocumentStorage::Lossless(JsonNode::Object(lossless)),
                    };
                }
            }
        }
        Self::from(Value::Object(normal))
    }

    /// Consumes a root object as ordered JavaScript keys and lossless values.
    /// Returns `None` when the root is not an object.
    #[must_use]
    pub fn into_object_fields(self) -> Option<Vec<(JsString, Self)>> {
        match self.storage {
            DocumentStorage::Normal(Value::Object(fields)) => Some(
                fields
                    .into_iter()
                    .map(|(key, value)| (JsString::from_owned_string(key), Self::from(value)))
                    .collect(),
            ),
            DocumentStorage::Lossless(JsonNode::Object(fields)) => Some(
                fields
                    .into_iter()
                    .map(|(key, value)| {
                        (
                            key,
                            Self {
                                storage: DocumentStorage::Lossless(value),
                            },
                        )
                    })
                    .collect(),
            ),
            _ => None,
        }
    }

    /// Consumes enumerable own fields using JavaScript object-spread semantics.
    #[must_use]
    pub fn into_spread_fields(self) -> Vec<(JsString, Self)> {
        match self.storage {
            DocumentStorage::Normal(Value::String(text)) => text
                .encode_utf16()
                .enumerate()
                .map(|(index, unit)| {
                    (
                        JsString::from_owned_string(index.to_string()),
                        Self::string(JsString::from_utf16_units(vec![unit])),
                    )
                })
                .collect(),
            DocumentStorage::Lossless(JsonNode::String(text)) => {
                let units = text.into_utf16_units();
                units
                    .into_iter()
                    .enumerate()
                    .map(|(index, unit)| {
                        (
                            JsString::from_owned_string(index.to_string()),
                            Self::string(JsString::from_utf16_units(vec![unit])),
                        )
                    })
                    .collect()
            }
            DocumentStorage::Normal(Value::Array(values)) => values
                .into_iter()
                .enumerate()
                .map(|(index, value)| {
                    (
                        JsString::from_owned_string(index.to_string()),
                        Self::from(value),
                    )
                })
                .collect(),
            DocumentStorage::Lossless(JsonNode::Array(values)) => values
                .into_iter()
                .enumerate()
                .map(|(index, value)| {
                    (
                        JsString::from_owned_string(index.to_string()),
                        Self {
                            storage: DocumentStorage::Lossless(value),
                        },
                    )
                })
                .collect(),
            storage => Self { storage }.into_object_fields().unwrap_or_default(),
        }
    }

    /// Borrows the ordinary serde value without projecting lossless strings.
    #[must_use]
    pub fn as_value(&self) -> Option<&Value> {
        match &self.storage {
            DocumentStorage::Normal(value) => Some(value),
            DocumentStorage::Lossless(_) => None,
        }
    }

    /// Borrows the root node without allocating a validation projection.
    #[must_use]
    pub fn as_ref(&self) -> JsonRef<'_> {
        let storage = match &self.storage {
            DocumentStorage::Normal(value) => JsonRefStorage::Normal(value),
            DocumentStorage::Lossless(value) => JsonRefStorage::Lossless(value),
        };
        JsonRef { storage }
    }

    /// Projects this document into a serde value for schema validation only.
    ///
    /// Unpaired UTF-16 units become replacement characters in this deliberately lossy view.
    #[must_use]
    pub fn validation_value(&self) -> Cow<'_, Value> {
        match &self.storage {
            DocumentStorage::Normal(value) => Cow::Borrowed(value),
            DocumentStorage::Lossless(value) => Cow::Owned(node_to_value(value)),
        }
    }

    /// Returns a borrowed field from a root object.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<JsonRef<'_>> {
        self.as_ref().get(key)
    }

    /// Removes a root-object field while preserving JavaScript field order.
    pub fn remove(&mut self, key: &str) -> Option<Self> {
        match &mut self.storage {
            DocumentStorage::Normal(Value::Object(fields)) => {
                fields.shift_remove(key).map(Self::from)
            }
            DocumentStorage::Normal(_) => None,
            DocumentStorage::Lossless(JsonNode::Object(fields)) => {
                let index = fields.iter().position(|(field, _)| field.equals_str(key))?;
                fields.shift_remove_index(index).map(|(_, value)| Self {
                    storage: DocumentStorage::Lossless(value),
                })
            }
            DocumentStorage::Lossless(_) => None,
        }
    }

    /// Returns this document's serde value, or the original document when that would lose UTF-16.
    pub fn into_value(self) -> Result<Value, Self> {
        match self.storage {
            DocumentStorage::Normal(value) => Ok(value),
            DocumentStorage::Lossless(_) => Err(self),
        }
    }

    /// Returns whether the root is an object.
    #[must_use]
    pub fn is_object(&self) -> bool {
        self.as_ref().is_object()
    }

    /// Returns whether the root is an array.
    #[must_use]
    pub fn is_array(&self) -> bool {
        self.as_ref().is_array()
    }

    /// Returns an array's elements without projecting UTF-16 strings through serde values.
    #[must_use]
    pub fn into_array_values(self) -> Option<Vec<Self>> {
        match self.storage {
            DocumentStorage::Normal(Value::Array(values)) => {
                Some(values.into_iter().map(Self::from).collect())
            }
            DocumentStorage::Lossless(JsonNode::Array(values)) => Some(
                values
                    .into_iter()
                    .map(|value| Self {
                        storage: DocumentStorage::Lossless(value),
                    })
                    .collect(),
            ),
            _ => None,
        }
    }

    /// Encodes JavaScript's two-space JSON layout, preserving escaped UTF-16 strings.
    #[must_use]
    pub fn to_vec_pretty(&self) -> Vec<u8> {
        match &self.storage {
            DocumentStorage::Normal(value) => crate::json::to_vec_pretty(value),
            DocumentStorage::Lossless(value) => {
                let mut bytes = Vec::new();
                write_pretty_node(&mut bytes, value, 0)
                    .expect("writing JSON to a vector cannot fail");
                bytes
            }
        }
    }

    /// Converts the root with JavaScript's ordinary string coercion.
    #[must_use]
    pub fn to_js_string(&self) -> JsString {
        self.as_ref().to_js_string()
    }

    /// Writes canonical JavaScript JSON directly into `writer`.
    ///
    /// # Errors
    ///
    /// Returns an error when writing the JSON bytes fails.
    pub fn write<W: Write>(&self, mut writer: W) -> serde_json::Result<()> {
        match &self.storage {
            DocumentStorage::Normal(value) => crate::json::write(&mut writer, value),
            DocumentStorage::Lossless(value) => write_node(&mut writer, value),
        }
    }

    /// Encodes canonical JavaScript JSON text.
    #[must_use]
    pub fn to_json_text(&self) -> String {
        let mut bytes = Vec::new();
        self.write(&mut bytes)
            .expect("writing JSON to a vector cannot fail");
        String::from_utf8(bytes).expect("JSON output is always UTF-8")
    }

    fn into_node(self) -> JsonNode {
        match self.storage {
            DocumentStorage::Normal(value) => node_from_value(value),
            DocumentStorage::Lossless(value) => value,
        }
    }
}

impl From<Value> for JsonDocument {
    fn from(value: Value) -> Self {
        Self {
            storage: DocumentStorage::Normal(value),
        }
    }
}

impl From<String> for JsonDocument {
    fn from(value: String) -> Self {
        Self::from(Value::String(value))
    }
}

impl From<&str> for JsonDocument {
    fn from(value: &str) -> Self {
        Self::from(Value::String(value.to_owned()))
    }
}

impl From<bool> for JsonDocument {
    fn from(value: bool) -> Self {
        Self::from(Value::Bool(value))
    }
}

impl Serialize for JsonDocument {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match &self.storage {
            DocumentStorage::Normal(value) => crate::json::JsValue(value).serialize(serializer),
            DocumentStorage::Lossless(_) => {
                let raw = RawValue::from_string(self.to_json_text())
                    .map_err(<S::Error as serde::ser::Error>::custom)?;
                raw.serialize(serializer)
            }
        }
    }
}

impl<'a> From<&'a Value> for JsonRef<'a> {
    fn from(value: &'a Value) -> Self {
        Self {
            storage: JsonRefStorage::Normal(value),
        }
    }
}

impl<'a> JsonRef<'a> {
    /// Returns a borrowed UTF-8 string when the JSON string is well formed.
    #[must_use]
    pub fn as_str(&self) -> Option<&'a str> {
        match self.storage {
            JsonRefStorage::Normal(Value::String(value)) => Some(value),
            JsonRefStorage::Lossless(JsonNode::String(value)) => value.as_utf8(),
            _ => None,
        }
    }

    /// Returns the boolean value when this node is a boolean.
    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        match self.storage {
            JsonRefStorage::Normal(Value::Bool(value)) => Some(*value),
            JsonRefStorage::Lossless(JsonNode::Bool(value)) => Some(*value),
            _ => None,
        }
    }

    /// Returns a JSON number without copying or normalizing its surrounding document.
    #[must_use]
    pub fn as_f64(&self) -> Option<f64> {
        match self.storage {
            JsonRefStorage::Normal(Value::Number(value)) => value.as_f64(),
            JsonRefStorage::Lossless(JsonNode::Number(value)) => Some(*value),
            _ => None,
        }
    }

    /// Returns whether this node is JSON null.
    #[must_use]
    pub fn is_null(&self) -> bool {
        matches!(
            self.storage,
            JsonRefStorage::Normal(Value::Null) | JsonRefStorage::Lossless(JsonNode::Null)
        )
    }

    /// Returns whether this node is a JSON string.
    #[must_use]
    pub fn is_string(&self) -> bool {
        matches!(
            self.storage,
            JsonRefStorage::Normal(Value::String(_))
                | JsonRefStorage::Lossless(JsonNode::String(_))
        )
    }

    /// Returns whether this node is a JSON object.
    #[must_use]
    pub fn is_object(&self) -> bool {
        matches!(
            self.storage,
            JsonRefStorage::Normal(Value::Object(_))
                | JsonRefStorage::Lossless(JsonNode::Object(_))
        )
    }

    /// Returns whether this node is a JSON array.
    #[must_use]
    pub fn is_array(&self) -> bool {
        matches!(
            self.storage,
            JsonRefStorage::Normal(Value::Array(_)) | JsonRefStorage::Lossless(JsonNode::Array(_))
        )
    }

    /// Returns the array length when this node is an array.
    #[must_use]
    pub fn array_len(&self) -> Option<usize> {
        match self.storage {
            JsonRefStorage::Normal(Value::Array(values)) => Some(values.len()),
            JsonRefStorage::Lossless(JsonNode::Array(values)) => Some(values.len()),
            _ => None,
        }
    }

    /// Returns a borrowed field from this object.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<JsonRef<'a>> {
        match self.storage {
            JsonRefStorage::Normal(Value::Object(fields)) => fields.get(key).map(|value| JsonRef {
                storage: JsonRefStorage::Normal(value),
            }),
            JsonRefStorage::Lossless(JsonNode::Object(fields)) => fields
                .iter()
                .find(|(field, _)| field.equals_str(key))
                .map(|(_, value)| JsonRef {
                    storage: JsonRefStorage::Lossless(value),
                }),
            _ => None,
        }
    }

    /// Clones this node into an independent document.
    #[must_use]
    pub fn to_owned(&self) -> JsonDocument {
        match self.storage {
            JsonRefStorage::Normal(value) => JsonDocument::from(value.clone()),
            JsonRefStorage::Lossless(value) => JsonDocument {
                storage: DocumentStorage::Lossless(value.clone()),
            },
        }
    }

    /// Converts this node with JavaScript's ordinary string coercion.
    #[must_use]
    pub fn to_js_string(&self) -> JsString {
        match self.storage {
            JsonRefStorage::Normal(value) => js_string_from_value(value),
            JsonRefStorage::Lossless(value) => js_string_from_node(value),
        }
    }
}

fn parse_lossless_raw(raw: &RawValue) -> Result<JsonNode, serde_json::Error> {
    match raw.get().as_bytes().first() {
        Some(b'n') => Ok(JsonNode::Null),
        Some(b't') => Ok(JsonNode::Bool(true)),
        Some(b'f') => Ok(JsonNode::Bool(false)),
        Some(b'"') => Ok(JsonNode::String(
            JsString::from_json_string_literal(raw.get())
                .expect("RawValue was validated as a JSON string literal"),
        )),
        Some(b'[') => parse_array(raw),
        Some(b'{') => parse_object(raw),
        Some(_) => {
            let number = match raw.get().parse::<f64>() {
                Ok(number) => number,
                Err(_) if raw.get().starts_with('-') => f64::NEG_INFINITY,
                Err(_) => f64::INFINITY,
            };
            Ok(JsonNode::Number(number))
        }
        None => Err(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "RawValue was empty",
        ))),
    }
}

fn parse_array(raw: &RawValue) -> Result<JsonNode, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_str(raw.get());
    deserializer.deserialize_seq(LosslessArrayVisitor)
}

fn parse_object(raw: &RawValue) -> Result<JsonNode, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_str(raw.get());
    deserializer.deserialize_map(LosslessObjectVisitor)
}

struct LosslessArrayVisitor;

impl<'de> Visitor<'de> for LosslessArrayVisitor {
    type Value = JsonNode;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
        while let Some(raw) = sequence.next_element::<&RawValue>()? {
            values.push(parse_lossless_raw(raw).map_err(de::Error::custom)?);
        }
        Ok(JsonNode::Array(values))
    }
}

struct LosslessObjectVisitor;

impl<'de> Visitor<'de> for LosslessObjectVisitor {
    type Value = JsonNode;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON object")
    }

    fn visit_map<A>(self, mut fields: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut object = IndexMap::with_capacity(fields.size_hint().unwrap_or(0));
        while let Some(Wtf8Key(key)) = fields.next_key_seed(Wtf8KeySeed)? {
            let raw: &RawValue = fields.next_value()?;
            object.insert(key, parse_lossless_raw(raw).map_err(de::Error::custom)?);
        }
        Ok(JsonNode::Object(object))
    }
}

struct Wtf8Key(JsString);

struct Wtf8KeySeed;

impl<'de> DeserializeSeed<'de> for Wtf8KeySeed {
    type Value = Wtf8Key;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Wtf8Key::deserialize(deserializer)
    }
}

impl<'de> Deserialize<'de> for Wtf8Key {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_bytes(Wtf8KeyVisitor)
    }
}

struct Wtf8KeyVisitor;

impl<'de> Visitor<'de> for Wtf8KeyVisitor {
    type Value = Wtf8Key;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON object key")
    }

    fn visit_borrowed_bytes<E>(self, value: &'de [u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        decode_wtf8(value).map(Wtf8Key).map_err(E::custom)
    }

    fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        decode_wtf8(value).map(Wtf8Key).map_err(E::custom)
    }
}

fn decode_wtf8(bytes: &[u8]) -> Result<JsString, &'static str> {
    let mut units = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&first) = bytes.get(index) {
        if first < 0x80 {
            units.push(u16::from(first));
            index += 1;
            continue;
        }

        let width = match first {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return Err("invalid WTF-8 leading byte"),
        };
        let encoded = bytes
            .get(index..index + width)
            .ok_or("truncated WTF-8 sequence")?;
        if !encoded[1..].iter().all(|byte| byte & 0xc0 == 0x80) {
            return Err("invalid WTF-8 continuation byte");
        }

        let scalar = match width {
            2 => (u32::from(first & 0x1f) << 6) | u32::from(encoded[1] & 0x3f),
            3 => {
                (u32::from(first & 0x0f) << 12)
                    | (u32::from(encoded[1] & 0x3f) << 6)
                    | u32::from(encoded[2] & 0x3f)
            }
            4 => {
                (u32::from(first & 0x07) << 18)
                    | (u32::from(encoded[1] & 0x3f) << 12)
                    | (u32::from(encoded[2] & 0x3f) << 6)
                    | u32::from(encoded[3] & 0x3f)
            }
            _ => unreachable!("WTF-8 width is one of 2, 3, or 4"),
        };
        let minimum = match width {
            2 => 0x80,
            3 => 0x800,
            4 => 0x1_0000,
            _ => unreachable!("WTF-8 width is one of 2, 3, or 4"),
        };
        if scalar < minimum || scalar > 0x10_ffff {
            return Err("invalid WTF-8 scalar");
        }
        if scalar <= 0xffff {
            units.push(scalar as u16);
        } else {
            let pair = scalar - 0x1_0000;
            units.push(0xd800 | ((pair >> 10) as u16));
            units.push(0xdc00 | ((pair & 0x03ff) as u16));
        }
        index += width;
    }
    Ok(JsString::from_utf16_units(units))
}

fn node_from_value(value: Value) -> JsonNode {
    match value {
        Value::Null => JsonNode::Null,
        Value::Bool(value) => JsonNode::Bool(value),
        Value::Number(value) => JsonNode::Number(
            value
                .as_f64()
                .expect("serde JSON number converts to a JavaScript number"),
        ),
        Value::String(value) => JsonNode::String(JsString::from(value)),
        Value::Array(values) => JsonNode::Array(values.into_iter().map(node_from_value).collect()),
        Value::Object(fields) => JsonNode::Object(
            fields
                .into_iter()
                .map(|(key, value)| (JsString::from(key), node_from_value(value)))
                .collect(),
        ),
    }
}

fn node_to_value(value: &JsonNode) -> Value {
    match value {
        JsonNode::Null => Value::Null,
        JsonNode::Bool(value) => Value::Bool(*value),
        JsonNode::Number(value) => Number::from_f64(*value).map_or(Value::Null, Value::Number),
        JsonNode::String(value) => Value::String(value.to_string_lossy()),
        JsonNode::Array(values) => Value::Array(values.iter().map(node_to_value).collect()),
        JsonNode::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.to_string_lossy(), node_to_value(value)))
                .collect(),
        ),
    }
}

fn write_node<W: Write>(writer: &mut W, value: &JsonNode) -> serde_json::Result<()> {
    match value {
        JsonNode::Null => write_bytes(writer, b"null"),
        JsonNode::Bool(value) => write_bytes(writer, if *value { b"true" } else { b"false" }),
        JsonNode::Number(value) if value.is_finite() => {
            crate::json::write_number(writer, *value).map_err(serde_json::Error::io)
        }
        JsonNode::Number(_) => write_bytes(writer, b"null"),
        JsonNode::String(value) => write_bytes(writer, value.json_string_literal().as_bytes()),
        JsonNode::Array(values) => {
            write_bytes(writer, b"[")?;
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    write_bytes(writer, b",")?;
                }
                write_node(writer, value)?;
            }
            write_bytes(writer, b"]")
        }
        JsonNode::Object(fields) => write_object(writer, fields),
    }
}

fn write_pretty_node<W: Write>(
    writer: &mut W,
    value: &JsonNode,
    depth: usize,
) -> serde_json::Result<()> {
    let indent = |writer: &mut W, depth: usize| -> serde_json::Result<()> {
        write_bytes(writer, b"\n")?;
        for _ in 0..depth {
            write_bytes(writer, b"  ")?;
        }
        Ok(())
    };
    match value {
        JsonNode::Array(values) if !values.is_empty() => {
            write_bytes(writer, b"[")?;
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    write_bytes(writer, b",")?;
                }
                indent(writer, depth + 1)?;
                write_pretty_node(writer, value, depth + 1)?;
            }
            indent(writer, depth)?;
            write_bytes(writer, b"]")
        }
        JsonNode::Object(fields) if !fields.is_empty() => {
            write_bytes(writer, b"{")?;
            let mut numeric = fields
                .iter()
                .filter_map(|(key, value)| {
                    key.as_utf8()
                        .and_then(crate::json::array_index)
                        .map(|index| (index, key, value))
                })
                .collect::<Vec<_>>();
            numeric.sort_unstable_by_key(|(index, _, _)| *index);
            let ordered = numeric.iter().map(|(_, key, value)| (*key, *value)).chain(
                fields
                    .iter()
                    .filter(|(key, _)| key.as_utf8().and_then(crate::json::array_index).is_none()),
            );
            for (position, (key, value)) in ordered.enumerate() {
                if position != 0 {
                    write_bytes(writer, b",")?;
                }
                indent(writer, depth + 1)?;
                write_bytes(writer, key.json_string_literal().as_bytes())?;
                write_bytes(writer, b": ")?;
                write_pretty_node(writer, value, depth + 1)?;
            }
            indent(writer, depth)?;
            write_bytes(writer, b"}")
        }
        _ => write_node(writer, value),
    }
}

fn write_object<W: Write>(
    writer: &mut W,
    fields: &IndexMap<JsString, JsonNode>,
) -> serde_json::Result<()> {
    write_bytes(writer, b"{")?;
    let mut saw_non_index = false;
    let mut previous_index = None;
    let ordered = fields.keys().all(|key| {
        if let Some(index) = key.as_utf8().and_then(crate::json::array_index) {
            let ordered = !saw_non_index && previous_index.is_none_or(|previous| previous < index);
            previous_index = Some(index);
            ordered
        } else {
            saw_non_index = true;
            true
        }
    });

    if ordered {
        for (position, (key, value)) in fields.iter().enumerate() {
            write_object_entry(writer, position, key, value)?;
        }
    } else {
        let mut numeric: Vec<_> = fields
            .iter()
            .filter_map(|(key, value)| {
                key.as_utf8()
                    .and_then(crate::json::array_index)
                    .map(|index| (index, key, value))
            })
            .collect();
        numeric.sort_unstable_by_key(|(index, _, _)| *index);
        let mut position = 0;
        for (_, key, value) in numeric {
            write_object_entry(writer, position, key, value)?;
            position += 1;
        }
        for (key, value) in fields {
            if key.as_utf8().and_then(crate::json::array_index).is_none() {
                write_object_entry(writer, position, key, value)?;
                position += 1;
            }
        }
    }
    write_bytes(writer, b"}")
}

fn write_object_entry<W: Write>(
    writer: &mut W,
    position: usize,
    key: &JsString,
    value: &JsonNode,
) -> serde_json::Result<()> {
    if position != 0 {
        write_bytes(writer, b",")?;
    }
    write_bytes(writer, key.json_string_literal().as_bytes())?;
    write_bytes(writer, b":")?;
    write_node(writer, value)
}

fn write_bytes<W: Write>(writer: &mut W, bytes: &[u8]) -> serde_json::Result<()> {
    writer.write_all(bytes).map_err(serde_json::Error::io)
}

fn js_string_from_value(value: &Value) -> JsString {
    match value {
        Value::Null => JsString::from("null"),
        Value::Bool(value) => JsString::from(if *value { "true" } else { "false" }),
        Value::Number(value) => JsString::from(number_to_js_string(
            value
                .as_f64()
                .expect("serde JSON number converts to a JavaScript number"),
        )),
        Value::String(value) => JsString::from(value.as_str()),
        Value::Array(values) => {
            let mut output = JsString::from("");
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push_str(",");
                }
                if !value.is_null() {
                    output.push_js_string(&js_string_from_value(value));
                }
            }
            output
        }
        Value::Object(_) => JsString::from("[object Object]"),
    }
}

fn js_string_from_node(value: &JsonNode) -> JsString {
    match value {
        JsonNode::Null => JsString::from("null"),
        JsonNode::Bool(value) => JsString::from(if *value { "true" } else { "false" }),
        JsonNode::Number(value) => JsString::from(number_to_js_string(*value)),
        JsonNode::String(value) => value.clone(),
        JsonNode::Array(values) => {
            let mut output = JsString::from("");
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push_str(",");
                }
                if !matches!(value, JsonNode::Null) {
                    output.push_js_string(&js_string_from_node(value));
                }
            }
            output
        }
        JsonNode::Object(_) => JsString::from("[object Object]"),
    }
}

fn number_to_js_string(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value == f64::INFINITY {
        "Infinity".to_owned()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".to_owned()
    } else {
        crate::json::number_to_string(value)
    }
}

#[cfg(test)]
mod tests {
    use super::JsonDocument;

    #[test]
    fn round_trips_unpaired_surrogate_values_without_a_lossy_value_projection() {
        let document =
            JsonDocument::parse(r#"{"type":"\u0073tart","payload":"\ud800"}"#).expect("valid JSON");
        assert_eq!(
            document.get("type").and_then(|field| field.as_str()),
            Some("start")
        );
        assert_eq!(
            document
                .get("payload")
                .expect("payload field")
                .to_js_string()
                .json_string_literal(),
            r#""\ud800""#
        );
        assert_eq!(
            document.to_json_text(),
            r#"{"type":"start","payload":"\ud800"}"#
        );
    }

    #[test]
    fn keeps_unpaired_and_replacement_character_keys_distinct() {
        let document = JsonDocument::parse("{\"\\ud800\":1,\"�\":2}").expect("valid JSON");
        assert_eq!(
            document
                .get("�")
                .expect("replacement key")
                .to_owned()
                .to_json_text(),
            "2"
        );
        assert_eq!(document.to_json_text(), "{\"\\ud800\":1,\"�\":2}");
    }

    #[test]
    fn rebuilding_objects_preserves_unknown_utf16_keys_values_and_order() {
        let original = JsonDocument::parse(r#"{"first":1,"\ud800":"\udfff","last":2}"#)
            .expect("valid JSON with unpaired UTF-16");
        let fields = original.into_object_fields().expect("object fields");
        let rebuilt = JsonDocument::object_lossless(fields);
        assert_eq!(
            rebuilt.to_json_text(),
            r#"{"first":1,"\ud800":"\udfff","last":2}"#
        );
    }

    #[test]
    fn duplicate_keys_keep_the_first_position_and_last_value() {
        let document =
            JsonDocument::parse(r#"{"tail":1,"2":"old","x":1,"\u0078":2,"2":"new","\ud800":0}"#)
                .expect("valid JSON");
        assert_eq!(
            document.to_json_text(),
            r#"{"2":"new","tail":1,"x":2,"\ud800":0}"#
        );
    }

    #[test]
    fn lossless_documents_use_canonical_javascript_number_text() {
        let document = JsonDocument::parse(
            r#"{"string":"\ud800","small":1e-7,"large":1e20,"overflow":1e400}"#,
        )
        .expect("valid JSON");
        assert_eq!(
            document.to_json_text(),
            r#"{"string":"\ud800","small":1e-7,"large":100000000000000000000,"overflow":null}"#
        );
    }

    #[test]
    fn pretty_sink_preserves_utf16_keys_numeric_order_and_js_numbers() {
        let document = JsonDocument::parse(r#"{"tail":"\ud800","2":[1e20,{}],"1":"\udfff"}"#)
            .expect("valid JavaScript JSON");
        assert_eq!(
            String::from_utf8(document.to_vec_pretty()).expect("UTF-8 JSON"),
            "{\n  \"1\": \"\\udfff\",\n  \"2\": [\n    100000000000000000000,\n    {}\n  ],\n  \"tail\": \"\\ud800\"\n}"
        );
    }

    #[test]
    fn spreading_strings_retains_individual_utf16_units() {
        for input in [r#""😀""#, r#""\ud800x""#] {
            let document = JsonDocument::parse(input).expect("valid JavaScript string");
            let spread = JsonDocument::object_lossless(document.into_spread_fields());
            let expected = if input == r#""😀""# {
                r#"{"0":"\ud83d","1":"\ude00"}"#
            } else {
                r#"{"0":"\ud800","1":"x"}"#
            };
            assert_eq!(spread.to_json_text(), expected);
        }
    }

    #[test]
    fn malformed_json_is_not_accepted_by_the_lossless_fallback() {
        assert!(JsonDocument::parse(r#"{"payload":"\ud800}"#).is_err());
    }
}
